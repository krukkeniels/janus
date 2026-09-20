import type { DoctorCheck } from '../doctor/types.js';
import type { StepRegistry } from '../engine/steps.js';
import type { Providers } from '../providers/types.js';
import { ExitCode } from './exit-codes.js';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
}

/** Test seams. `steps` replaces the production step registry of `janus run`; `providers` replaces the provider bag;
 * `doctorChecks` replaces `janus doctor`'s registry so a CLI test never shells out to codex, git or pnpm. */
export interface CliOverrides {
  steps?: StepRegistry;
  providers?: Providers;
  doctorChecks?: readonly DoctorCheck[];
}

export interface CliContext extends CliOverrides {
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

export function createContext(io: CliIo, overrides: CliOverrides = {}): CliContext {
  return { io, exitCode: ExitCode.Ok, ...overrides };
}
