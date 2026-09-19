import type { ExitCode } from './exit-codes.js';
import { ExitCode as Codes } from './exit-codes.js';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
}

export interface CliContext {
  io: CliIo;
  exitCode: ExitCode;
}

export function defaultIo(): CliIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    env: process.env,
    cwd: process.cwd(),
  };
}

export function createContext(io: CliIo): CliContext {
  return { io, exitCode: Codes.Ok };
}
