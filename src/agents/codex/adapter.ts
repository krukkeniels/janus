import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunner } from '../../providers/types.js';
import type { WorkspacePaths } from '../../workspace/layout.js';
import { validateAgentResult } from '../output-schema.js';
import { truncateUtf8Tail } from '../render.js';
import type { RenderedPrompt } from '../render.js';
import type { AgentOutcome, AgentRunFailure, AgentTask } from '../types.js';
import { outcomeSummary } from '../types.js';
import { parseCodexUsage } from './jsonl.js';
import { spawnCodex } from './spawn.js';
import type { CodexSpawn } from './spawn.js';

export interface CodexAdapterInput {
  paths: WorkspacePaths;
  /** The process seam. Tests replace it with a replay of a recorded run; production uses `spawnCodex`. */
  spawn?: CodexSpawn;
  /** The binary name; overridable for the opt-in real-Codex smoke test. */
  bin?: string;
}

/** `process.env` with every `undefined` value dropped, so it satisfies `CodexSpawnRequest.env: Record<string, string>`. */
function currentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Spec §18.4's invocation, in its order:
 *
 * ```text
 * codex exec -C <cwd> -s <read-only|workspace-write> \
 *   -c sandbox_workspace_write.network_access=<bool> \
 *   --add-dir <root> ... \
 *   --output-schema <schema.json> --json -o <last-message.json> --ephemeral \
 *   [-m <model>] [-c model_reasoning_effort=<x>] - < prompt.md
 * ```
 *
 * `resume` is never passed. `--skip-git-repo-check` is passed only when `task.skipGitRepoCheck` is set, which
 * `planSandbox` does for the read-only class alone (§18.4 as amended by T06 probe R2). The network flag is passed
 * only for `workspace-write`, because it configures that sandbox; `read-only` and `danger-full-access` do not
 * take it.
 */
export function buildCodexArgs(task: AgentTask, files: { schemaPath: string; lastMessagePath: string }): string[] {
  const args = ['exec', '-C', task.cwd, '-s', task.sandbox];
  if (task.sandbox === 'workspace-write') {
    args.push('-c', `sandbox_workspace_write.network_access=${String(task.network)}`);
  }
  if (task.skipGitRepoCheck) args.push('--skip-git-repo-check');
  for (const root of task.writableRoots) args.push('--add-dir', root);
  args.push('--output-schema', files.schemaPath, '--json', '-o', files.lastMessagePath, '--ephemeral');
  args.push('-m', task.model.model, '-c', `model_reasoning_effort=${task.model.effort}`);
  args.push('-');
  return args;
}

/**
 * How much of a failed run's stderr reaches `AgentRunFailure.detail`, which `evidence.ts` writes under
 * `evidence/agents/` and the CLI prints. `spawn.ts` caps the captured stream at `STDERR_CAP_BYTES` (1 MiB); a
 * megabyte of a Codex authentication error is both unreadable and the likeliest place a credential appears, and
 * spec line 661 wants a redaction pass before anything is written under `evidence/`. Bounding it is not that pass
 * — T09's digest redaction is — but it keeps an unbounded, unreviewed stream off the state branch (§32 rule 12).
 */
const STDERR_DETAIL_BYTES = 2048;

/** The **last** 2 KiB of stderr: an error's operative text (the message, the stack's innermost frame) is at the end. */
function stderrDetail(stderr: string): string {
  const trimmed = stderr.trim();
  const cut = truncateUtf8Tail(trimmed, STDERR_DETAIL_BYTES);
  if (cut.omittedBytes === 0) return trimmed;
  return (
    `[janus kept the last ${STDERR_DETAIL_BYTES} bytes of ${cut.totalBytes} bytes of stderr; the rest is not ` +
    `recorded, because it is unredacted]\n${cut.text}`
  );
}

function readLastMessage(path: string): { ok: true; value: unknown } | { ok: false; detail: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, detail: 'codex wrote no final message file; the run produced no answer to validate' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `codex final message is not JSON: ${message}` };
  }
}

/**
 * Spec §18.4's Codex adapter.
 *
 * The child inherits `process.env` plus the sandbox plan's additions, because Codex authenticates from the
 * environment and §28 says "Codex authentication is handled outside Janus". No environment **value** is ever
 * written to evidence, a prompt, or a log (§32 rule 12) — `AgentEvidence.env_keys` records names only.
 */
export function createCodexAgentRunner(input: CodexAdapterInput): AgentRunner {
  const spawn = input.spawn ?? spawnCodex;
  const bin = input.bin ?? 'codex';
  let version: string | null = null;

  const resolveVersion = async (): Promise<string | null> => {
    if (version !== null) return version;
    const probe = await spawn({ bin, args: ['--version'], cwd: input.paths.root, env: currentEnv(), stdin: '', timeoutMs: 30_000 });
    version = probe.spawnFailed || probe.exitCode !== 0 ? null : probe.jsonl.trim();
    return version;
  };

  return {
    name: 'codex',
    // `prompt` is rendered once by `runAgent`, for every runner (§18.2); the adapter never renders its own, so a
    // fake-driven scenario and a Codex-driven one hit the same size limit and record the same `prompt_bytes`.
    run: async (task: AgentTask, prompt: RenderedPrompt): Promise<AgentOutcome> => {
      const scratch = mkdtempSync(join(tmpdir(), `janus-codex-${task.runId}-`));
      try {
        const schemaPath = join(scratch, 'schema.json');
        const lastMessagePath = join(scratch, 'last-message.json');
        writeFileSync(schemaPath, `${JSON.stringify(task.outputSchema, null, 2)}\n`);

        const runnerVersion = await resolveVersion();
        const result = await spawn({
          bin,
          args: buildCodexArgs(task, { schemaPath, lastMessagePath }),
          cwd: task.cwd,
          env: { ...currentEnv(), ...task.env },
          stdin: prompt.text,
          timeoutMs: task.timeoutMinutes * 60_000,
        });

        const tokens = parseCodexUsage(result.jsonl);
        const message = result.spawnFailed ? { ok: false as const, detail: 'codex did not start' } : readLastMessage(lastMessagePath);
        const validated = message.ok ? validateAgentResult(task.role, message.value) : null;
        const answer = validated !== null && validated.ok ? validated.result : null;

        // Precedence, deliberately: a timeout beats everything, because whatever the child wrote (including a
        // seemingly valid answer) came from a run that Janus itself killed before it could finish. A failed
        // spawn is next — there is no child to have produced anything. Then a signal kill (OOM, an external
        // SIGKILL, the sandbox itself dying) or a plain non-zero exit *with no usable answer*: these are process-
        // level failures. A signal kill overrides even a validating answer — "killed mid-work" is not something
        // a schema-shaped answer on disk can retract — but a plain non-zero exit does not, because a fresh
        // `mkdtemp` per run makes a stale answer impossible, so a validating answer really is this run's. Only
        // once the process exited 0 (or non-zero with a valid answer) do the answer-shaped failures apply: first
        // a missing/unparseable last-message file, then a schema violation. A valid, schema-passing answer from
        // a process that exited cleanly of a signal is never a failure, whatever the exit code — §18.3 cares
        // about the answer, and Codex exits non-zero for conditions the answer already describes.
        let failure: AgentRunFailure | null = null;
        if (result.timedOut) {
          failure = {
            kind: 'timeout',
            detail: `codex exec exceeded the ${task.timeoutMinutes} minutes allowed for role ${task.role} (agents.roles.${task.role}.timeout_minutes) and was killed`,
          };
        } else if (result.spawnFailed) {
          failure = {
            kind: 'spawn_failed',
            detail: `could not start "${bin}": ${stderrDetail(result.stderr)}; run janus doctor to check the Codex installation`,
          };
        } else if (result.signal !== null || (answer === null && result.exitCode !== 0)) {
          const detail =
            result.signal !== null
              ? `codex exec was killed by ${result.signal}: ${stderrDetail(result.stderr)}`
              : `codex exec exited ${String(result.exitCode)}: ${stderrDetail(result.stderr)}`;
          failure = { kind: 'nonzero_exit', detail };
        } else if (!message.ok) {
          failure = { kind: 'invalid_output', detail: message.detail };
        } else if (validated !== null && !validated.ok) {
          failure = {
            kind: 'invalid_output',
            detail: `codex answered with JSON that does not match the ${task.role} output schema: ${validated.errors.join('; ')}`,
          };
        }

        // `result` always carries whatever validated, even when `failure` is set: §18.4 records "the validated
        // final message" unconditionally, and the scratch cleanup above deletes `last-message.json` once this
        // returns, so `result` is the only place a timed-out or signal-killed run's answer survives for the
        // evidence file's audit trail. Failure is signalled by `status`/`failure` (and, per `outcomeSummary`,
        // by `summary`), never by discarding the answer.
        return {
          runId: task.runId,
          status: failure === null && answer !== null ? answer.status : 'failed',
          summary: outcomeSummary(answer, failure),
          result: answer,
          failure,
          tokens,
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          runnerVersion,
          jsonlTruncated: result.jsonlTruncated,
          stderrTruncated: result.stderrTruncated,
        };
      } finally {
        if (process.env['JANUS_KEEP_TMP'] !== '1') rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
}
