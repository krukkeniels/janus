import { spawn } from 'node:child_process';

/** How long a timed-out child gets to exit on SIGTERM before it is SIGKILLed. */
export const SIGKILL_GRACE_MS = 5_000;

/**
 * Ceiling on buffered stdout (the `--json` event stream). Generous on purpose: a long Angular-upgrade turn's
 * JSONL — reasoning text, full `pnpm test` output embedded in `command_execution` items, file-change lists — is
 * not small, and this must never trip on a real run. It exists only to stop a chatty or looping agent from
 * exhausting memory before the timeout's kill path ever fires. `turn.completed` (carrying `usage`) is always the
 * *last* line of the stream, so once this caps, the **tail** is kept and the head is dropped — losing early
 * reasoning/output text is an acceptable trade for keeping the usage event `parseCodexUsage` depends on.
 */
export const JSONL_CAP_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Ceiling on buffered stderr. Smaller than stdout: stderr is diagnostic noise plus, usually, the error that
 * preceded a bad exit — which lands at the end — so the tail is kept here too. */
export const STDERR_CAP_BYTES = 1 * 1024 * 1024; // 1 MiB

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
  /** Overrides {@link JSONL_CAP_BYTES}. Only ever set by the truncation test, so it can prove the tail-keeping
   * behavior without writing 10 MiB of filler. */
  jsonlCapBytes?: number;
  /** Overrides {@link STDERR_CAP_BYTES}, for the same reason. */
  stderrCapBytes?: number;
}

export interface CodexSpawnResult {
  exitCode: number | null;
  signal: string | null;
  /** Everything the child wrote to stdout, capped at {@link JSONL_CAP_BYTES} keeping the tail: the `--json`
   * event stream. */
  jsonl: string;
  /** True when `jsonl` was capped and so is missing its earliest lines. */
  jsonlTruncated: boolean;
  stderr: string;
  /** True when `stderr` was capped and so is missing its earliest lines. */
  stderrTruncated: boolean;
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
    const jsonlCap = request.jsonlCapBytes ?? JSONL_CAP_BYTES;
    const stderrCap = request.stderrCapBytes ?? STDERR_CAP_BYTES;
    let stdout = '';
    let stdoutTruncated = false;
    let stderr = '';
    let stderrTruncated = false;
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

    const finish = (
      result: Omit<CodexSpawnResult, 'durationMs' | 'jsonl' | 'jsonlTruncated' | 'stderr' | 'stderrTruncated' | 'timedOut'>,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      resolve({
        ...result,
        jsonl: stdout,
        jsonlTruncated: stdoutTruncated,
        stderr,
        stderrTruncated,
        timedOut,
        durationMs: Date.now() - started,
      });
    };

    // Keeps only the last `capBytes` of `current + chunk`. `turn.completed` (and any error text) is always the
    // last thing written, so capping from the front — dropping the oldest data — keeps what later parsing needs.
    const appendCapped = (current: string, chunk: string, capBytes: number): { text: string; truncated: boolean } => {
      const combined = current + chunk;
      if (combined.length <= capBytes) return { text: combined, truncated: false };
      return { text: combined.slice(combined.length - capBytes), truncated: true };
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const { text, truncated } = appendCapped(stdout, chunk.toString('utf8'), jsonlCap);
      stdout = text;
      stdoutTruncated = stdoutTruncated || truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const { text, truncated } = appendCapped(stderr, chunk.toString('utf8'), stderrCap);
      stderr = text;
      stderrTruncated = stderrTruncated || truncated;
    });
    child.on('error', (error: Error) => {
      const { text, truncated } = appendCapped(stderr, error.message, stderrCap);
      stderr = text;
      stderrTruncated = stderrTruncated || truncated;
      finish({ exitCode: null, signal: null, spawnFailed: true });
    });
    child.on('close', (code, signal) => {
      finish({ exitCode: code, signal, spawnFailed: false });
    });
    // The child may exit before the whole prompt is written; that is an outcome, not a crash.
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.stdin);
  });
