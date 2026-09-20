import { spawnCodex } from '../agents/codex/spawn.js';

export interface CommandRequest {
  bin: string;
  args: string[];
  cwd: string;
  /** The complete environment for the child. Omitted means "inherit the current process's". */
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
}

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the binary could not be started at all — usually "not on PATH". */
  spawnFailed: boolean;
  durationMs: number;
}

/** The seam every doctor test replaces. Production is {@link runCommand}. */
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

/** `process.env` with every `undefined` dropped, so it satisfies `Record<string, string>`. */
export function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Runs one child process to completion, never rejecting — a missing binary, a non-zero exit and a timeout are all
 * findings, not exceptions.
 *
 * Deliberately a thin rename over `spawnCodex` rather than a second `child_process` implementation: that one
 * already has the SIGTERM-then-SIGKILL timeout path, the output caps and the "never reject" contract, and it is
 * covered by `tests/agents/codex-spawn.test.ts`. Its `jsonl` field is just "everything on stdout".
 */
export const runCommand: CommandRunner = async (request) => {
  const result = await spawnCodex({
    bin: request.bin,
    args: request.args,
    cwd: request.cwd,
    env: request.env ?? processEnv(),
    stdin: request.stdin ?? '',
    timeoutMs: request.timeoutMs,
  });
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.jsonl,
    stderr: result.stderr,
    timedOut: result.timedOut,
    spawnFailed: result.spawnFailed,
    durationMs: result.durationMs,
  };
};
