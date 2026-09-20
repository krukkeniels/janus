import { spawn } from 'node:child_process';

/** How long a timed-out child gets to exit on SIGTERM before it is SIGKILLed. */
export const SIGKILL_GRACE_MS = 5_000;

export interface CodexSpawnRequest {
  /** The binary to run; `codex` in production, `process.execPath` in the spawn tests. */
  bin: string;
  args: string[];
  cwd: string;
  /** The complete environment for the child. The caller decides what to inherit; nothing is added here. */
  env: Record<string, string>;
  /** The prompt, written to the child's stdin and then closed (§18.4 invokes `codex exec ... - < prompt.md`). */
  stdin: string;
  /** `agents.roles.<role>.timeout_minutes`, in milliseconds. */
  timeoutMs: number;
  /**
   * Overrides {@link SIGKILL_GRACE_MS}. Only ever set by the escalation test, which needs a child that ignores
   * SIGTERM to be SIGKILLed without waiting the real 5s grace period.
   */
  sigkillGraceMs?: number;
}

export interface CodexSpawnResult {
  exitCode: number | null;
  signal: string | null;
  /** Everything the child wrote to stdout: the `--json` event stream. */
  jsonl: string;
  stderr: string;
  timedOut: boolean;
  /** True when the binary could not be started at all (for example it is not on PATH). */
  spawnFailed: boolean;
  durationMs: number;
}

/** The seam every adapter test replaces. */
export type CodexSpawn = (request: CodexSpawnRequest) => Promise<CodexSpawnResult>;

/**
 * Runs one child process to completion, never rejecting: a missing binary, a non-zero exit, and a timeout are all
 * outcomes the adapter turns into an `AgentResult`, not exceptions.
 *
 * Spec §18.4: "kills the process at timeout". The kill is SIGTERM first so Codex can tear its sandbox down, then
 * SIGKILL after a grace period. Whatever the child had already written is kept, so the partial JSONL is still
 * available for the usage parser and the evidence file.
 */
export const spawnCodex: CodexSpawn = (request) =>
  new Promise<CodexSpawnResult>((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const child = spawn(request.bin, request.args, { cwd: request.cwd, env: request.env, stdio: ['pipe', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, request.sigkillGraceMs ?? SIGKILL_GRACE_MS);
    }, request.timeoutMs);

    const finish = (result: Omit<CodexSpawnResult, 'durationMs' | 'jsonl' | 'stderr' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      resolve({ ...result, jsonl: stdout, stderr, timedOut, durationMs: Date.now() - started });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      stderr += error.message;
      finish({ exitCode: null, signal: null, spawnFailed: true });
    });
    child.on('close', (code, signal) => {
      finish({ exitCode: code, signal, spawnFailed: false });
    });
    // The child may exit before the whole prompt is written; that is an outcome, not a crash.
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.stdin);
  });
