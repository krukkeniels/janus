import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLadderEntry } from '../../agents/models.js';
import type { Effort, JanusConfig } from '../../config/config-schema.js';
import { skipped } from '../types.js';
import type { DoctorCheck, DoctorObservation } from '../types.js';

export const CODEX_BIN = 'codex';

const VERSION_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 30_000;
/** A one-token probe still pays Codex's ~14.5k-token instruction preamble and a full round trip. */
const MODEL_PROBE_TIMEOUT_MS = 180_000;

const NO_WORKSPACE = 'run janus doctor from inside a janus workspace, or run janus init first';

/**
 * The operative line of a failed command. Codex prints a multi-line banner (`OpenAI Codex v0.146.0`, `workdir`,
 * `model`, ...) to **stderr** on every run, success or not, so the first line is never the error; the error is at
 * the end. Observed in T06 probe R2.
 */
export function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines[lines.length - 1] ?? '';
}

export const codexBinaryCheck: DoctorCheck = {
  id: 'codex.binary',
  title: 'codex CLI is installed',
  run: async (ctx) => {
    const result = await ctx.run({ bin: CODEX_BIN, args: ['--version'], cwd: tmpdir(), timeoutMs: VERSION_TIMEOUT_MS });
    if (result.spawnFailed) {
      return [
        {
          id: 'codex.binary',
          title: codexBinaryCheck.title,
          status: 'fail',
          detail: `could not start "${CODEX_BIN}": ${lastLine(result.stderr)}`,
          remediation: 'install the Codex CLI and put it on PATH, then re-run janus doctor',
        },
      ];
    }
    if (result.exitCode !== 0) {
      return [
        {
          id: 'codex.binary',
          title: codexBinaryCheck.title,
          status: 'fail',
          detail: `"${CODEX_BIN} --version" exited ${String(result.exitCode)}: ${lastLine(result.stderr)}`,
          remediation: 'reinstall the Codex CLI; the binary on PATH does not run on this machine',
        },
      ];
    }
    return [{ id: 'codex.binary', title: codexBinaryCheck.title, status: 'pass', detail: result.stdout.trim(), remediation: null }];
  },
};

/** Anywhere in the output, case-insensitive — an explicit negative Codex can print. Checked before any positive match. */
const NOT_LOGGED_IN = /not\s+(?:logged\s+in|authenticated)/i;

/**
 * A line is an affirmative login status only when it starts with "logged in" and is not immediately followed by
 * `:` or `?` (allowing whitespace in between) — which rules out "Logged in: false" and "logged in? no", both of
 * which satisfy a bare `/^logged in\b/i` prefix check but are not affirmative.
 */
const AFFIRMATIVE_LOGIN_LINE = /^logged in(?!\s*[:?])/i;

/**
 * Fail-safe, not a bare substring or a whole-string anchor:
 *
 * 1. An explicit negative shape ("not logged in", "not authenticated") anywhere in the output returns `false`
 *    immediately, regardless of what else is present. A bare substring check on the *positive* phrase alone was
 *    the original bug — `'not logged in'.includes('logged in')` is `true` — so the negative shape is checked
 *    first and wins.
 * 2. Otherwise, each line is checked independently for an affirmative status line. Codex prints a banner
 *    (`OpenAI Codex v0.146.0`, ...) ahead of the actual status on at least some invocations, so anchoring against
 *    the *whole string* (`^` matching only the very first character) would miss a real "Logged in ..." line that
 *    isn't first. Per-line anchoring finds it wherever it sits.
 * 3. Anything else — no negative shape, no affirmative line — is `false`. An unrecognised shape must fail loudly,
 *    not pass by default.
 */
function isLoggedIn(output: string): boolean {
  if (NOT_LOGGED_IN.test(output)) return false;
  return output
    .split('\n')
    .map((line) => line.trim())
    .some((line) => AFFIRMATIVE_LOGIN_LINE.test(line));
}

export const codexLoginCheck: DoctorCheck = {
  id: 'codex.login',
  title: 'codex is authenticated',
  run: async (ctx) => {
    const result = await ctx.run({ bin: CODEX_BIN, args: ['login', 'status'], cwd: tmpdir(), timeoutMs: LOGIN_TIMEOUT_MS });
    const output = result.stdout.trim() === '' ? lastLine(result.stderr) : result.stdout.trim();
    if (result.spawnFailed || result.exitCode !== 0 || !isLoggedIn(output)) {
      return [
        {
          id: 'codex.login',
          title: codexLoginCheck.title,
          status: 'fail',
          detail: output === '' ? `"${CODEX_BIN} login status" exited ${String(result.exitCode)}` : output,
          // §28: "Codex authentication is handled outside Janus" — nothing in config.yaml fixes this.
          remediation: 'run `codex login` and complete the sign-in, then re-run janus doctor',
        },
      ];
    }
    return [{ id: 'codex.login', title: codexLoginCheck.title, status: 'pass', detail: output, remediation: null }];
  },
};

/**
 * Every `(model)` the active §18.6 profile can reach: the `*` entry, every explicit role entry, and every ladder
 * entry (efforts encoded in a ladder entry are split off by `parseLadderEntry`). Deduplicated by model, because a
 * model id is either accepted or not — the effort does not change that, and each probe costs a real round trip.
 * Insertion order is kept so the report is stable.
 */
export function distinctModels(config: JanusConfig, profile: string): Array<{ model: string; effort: Effort }> {
  const entries = config.model_profiles[profile];
  if (entries === undefined) return [];
  const seen = new Map<string, Effort>();
  for (const spec of Object.values(entries)) {
    if (!seen.has(spec.model)) seen.set(spec.model, spec.effort);
    for (const rung of spec.ladder ?? []) {
      const parsed = parseLadderEntry(rung, spec.effort);
      if (!seen.has(parsed.model)) seen.set(parsed.model, parsed.effort);
    }
  }
  return [...seen].map(([model, effort]) => ({ model, effort }));
}

/**
 * Spec §18.6: "`janus doctor` verifies each configured model is accepted by Codex with a one-token probe."
 *
 * Read-only, no writable roots, in a scratch directory that is not a git repository — which is exactly the §3.3
 * read-only shape, and works only because §18.4 now allows `--skip-git-repo-check` for that class (T06 probe R2).
 * Note the cost: Codex's own instruction preamble is ~14.5k input tokens per probe, so this check is the most
 * expensive thing doctor does.
 */
export const codexModelsCheck: DoctorCheck = {
  id: 'codex.model',
  title: 'every configured model is accepted by Codex',
  run: async (ctx) => {
    if (ctx.config === null) {
      return [skipped('codex.model', codexModelsCheck.title, 'no config.yaml: doctor is not running inside a workspace', NO_WORKSPACE)];
    }
    const profile = ctx.config.workflow_models.profile;
    const models = distinctModels(ctx.config, profile);
    if (models.length === 0) {
      return [
        skipped(
          'codex.model',
          codexModelsCheck.title,
          `model profile "${profile}" names no models`,
          `define model_profiles.${profile} in .janus/config.yaml (§18.6)`,
        ),
      ];
    }

    let scratch: string;
    try {
      // Through the `DoctorFs` seam, not a direct `node:fs` call — `DoctorCheckContext` forbids direct `node:fs`
      // so every check stays unit-testable with no real I/O. `mkdtemp` is the one `DoctorFs` method that can
      // throw, so an unwritable temp filesystem is caught here and turned into a graceful `fail` finding instead
      // of an uncaught exception that would take down the rest of `runDoctor`.
      scratch = ctx.fs.mkdtemp(join(tmpdir(), 'janus-doctor-model-'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        {
          id: 'codex.model',
          title: codexModelsCheck.title,
          status: 'fail',
          detail: `could not create a scratch directory for the model probe: ${message}`,
          remediation: 'ensure the system temp directory is writable, then re-run janus doctor',
        },
      ];
    }
    try {
      const findings: DoctorObservation[] = [];
      for (const { model, effort } of models) {
        const id = `codex.model[${model}]`;
        const result = await ctx.run({
          bin: CODEX_BIN,
          args: [
            'exec',
            '-C',
            scratch,
            '-s',
            'read-only',
            '--skip-git-repo-check',
            '--ephemeral',
            '-m',
            model,
            '-c',
            `model_reasoning_effort=${effort}`,
            '-c',
            'model_max_output_tokens=1',
            '-',
          ],
          cwd: scratch,
          stdin: 'Reply with the single word ok and nothing else.',
          timeoutMs: MODEL_PROBE_TIMEOUT_MS,
        });
        if (result.exitCode === 0 && !result.spawnFailed && !result.timedOut) {
          findings.push({
            id,
            title: `model ${model} (effort ${effort}) is accepted`,
            status: 'pass',
            detail: `one-token probe succeeded (profile "${profile}"; ~14.5k input tokens)`,
            remediation: null,
          });
          continue;
        }
        const detail = result.timedOut
          ? `one-token probe timed out after ${String(MODEL_PROBE_TIMEOUT_MS / 1000)}s`
          : lastLine(result.stderr) || `codex exec exited ${String(result.exitCode)}`;
        findings.push({
          id,
          title: `model ${model} (effort ${effort}) is accepted`,
          status: 'fail',
          detail,
          remediation: `Codex would not run "${model}"; correct it in .janus/config.yaml under model_profiles.${profile}, or pick a profile whose models your account can use (§18.6)`,
        });
      }
      return findings;
    } finally {
      try {
        // Through the `DoctorFs` seam, not a direct `node:fs` call — same reasoning as `mkdtemp` above. A
        // cleanup failure here (EPERM, EBUSY, a lingering open handle) must not escape `run()`: the probe's real
        // result, pushed onto `findings` above, already stands on its own merits and a scratch dir that will not
        // delete is not itself a reason to fail the check.
        ctx.fs.rmrf(scratch);
      } catch {
        // best-effort cleanup only; deliberately swallowed
      }
    }
  },
};
