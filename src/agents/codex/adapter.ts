import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JanusConfig } from '../../config/config-schema.js';
import type { AgentRunner } from '../../providers/types.js';
import type { WorkspacePaths } from '../../workspace/layout.js';
import { validateAgentResult } from '../output-schema.js';
import { renderContextPackage } from '../render.js';
import type { AgentOutcome, AgentRunFailure, AgentTask } from '../types.js';
import { outcomeSummary } from '../types.js';
import { parseCodexUsage } from './jsonl.js';
import { spawnCodex } from './spawn.js';
import type { CodexSpawn } from './spawn.js';

export interface CodexAdapterInput {
  paths: WorkspacePaths;
  config: JanusConfig;
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
 * `resume` and `--skip-git-repo-check` are never passed. The network flag is passed only for `workspace-write`,
 * because it configures that sandbox; `read-only` and `danger-full-access` do not take it.
 */
export function buildCodexArgs(task: AgentTask, files: { schemaPath: string; lastMessagePath: string }): string[] {
  const args = ['exec', '-C', task.cwd, '-s', task.sandbox];
  if (task.sandbox === 'workspace-write') {
    args.push('-c', `sandbox_workspace_write.network_access=${String(task.network)}`);
  }
  for (const root of task.writableRoots) args.push('--add-dir', root);
  args.push('--output-schema', files.schemaPath, '--json', '-o', files.lastMessagePath, '--ephemeral');
  args.push('-m', task.model.model, '-c', `model_reasoning_effort=${task.model.effort}`);
  args.push('-');
  return args;
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
    run: async (task: AgentTask): Promise<AgentOutcome> => {
      const rendered = renderContextPackage(task.context, {
        maxContextBytes: input.config.agents.max_context_bytes,
        maxInlineDiffBytes: input.config.agents.max_inline_diff_bytes,
      });
      // Not cleaned up after the run: `-o` and `--output-schema` are file paths Codex (and, in tests, the replay)
      // write to, and both the caller and tests read `lastMessagePath`/`schemaPath` only after `spawn` resolves.
      // Each is a small (schema + one JSON answer) per-run artifact under the OS tmpdir, left for the OS/CI image's
      // own lifecycle to reclaim — the same tradeoff `mkdtempSync` callers elsewhere in this repo make.
      const scratch = mkdtempSync(join(tmpdir(), `janus-codex-${task.runId}-`));
      const schemaPath = join(scratch, 'schema.json');
      const lastMessagePath = join(scratch, 'last-message.json');
      writeFileSync(schemaPath, `${JSON.stringify(task.outputSchema, null, 2)}\n`);

      const runnerVersion = await resolveVersion();
      const result = await spawn({
        bin,
        args: buildCodexArgs(task, { schemaPath, lastMessagePath }),
        cwd: task.cwd,
        env: { ...currentEnv(), ...task.env },
        stdin: rendered.text,
        timeoutMs: task.timeoutMinutes * 60_000,
      });

      const tokens = parseCodexUsage(result.jsonl);
      const message = result.spawnFailed ? { ok: false as const, detail: 'codex did not start' } : readLastMessage(lastMessagePath);
      const validated = message.ok ? validateAgentResult(task.role, message.value) : null;
      const answer = validated !== null && validated.ok ? validated.result : null;

      // Precedence, deliberately: a timeout beats everything, because whatever the child wrote (including a
      // seemingly valid answer) came from a run that was killed before it could finish. A failed spawn is next —
      // there is no child to have produced anything. After that, a non-zero exit beats a missing or invalid
      // answer: when the process itself reports failure, that is the more actionable diagnosis (a crash, a
      // sandbox denial, a killed subprocess) than "no answer" or "bad JSON", which are just its symptoms. Only
      // once the process exited 0 do the answer-shaped failures apply: first a missing/unparseable last-message
      // file, then a schema violation. A valid, schema-passing answer is never a failure, whatever the exit code
      // — §18.3 cares about the answer, and Codex exits non-zero for conditions the answer already describes.
      let failure: AgentRunFailure | null = null;
      if (result.timedOut) {
        failure = {
          kind: 'timeout',
          detail: `codex exec exceeded the ${task.timeoutMinutes} minutes allowed for role ${task.role} (agents.roles.${task.role}.timeout_minutes) and was killed`,
        };
      } else if (result.spawnFailed) {
        failure = {
          kind: 'spawn_failed',
          detail: `could not start "${bin}": ${result.stderr.trim()}; run janus doctor to check the Codex installation`,
        };
      } else if (answer === null && result.exitCode !== 0) {
        failure = { kind: 'nonzero_exit', detail: `codex exec exited ${String(result.exitCode)}: ${result.stderr.trim()}` };
      } else if (!message.ok) {
        failure = { kind: 'invalid_output', detail: message.detail };
      } else if (validated !== null && !validated.ok) {
        failure = {
          kind: 'invalid_output',
          detail: `codex answered with JSON that does not match the ${task.role} output schema: ${validated.errors.join('; ')}`,
        };
      }

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
        promptBytes: rendered.bytes,
        truncations: rendered.truncations,
        jsonlTruncated: result.jsonlTruncated,
        stderrTruncated: result.stderrTruncated,
      };
    },
  };
}
