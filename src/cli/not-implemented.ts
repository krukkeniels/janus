import type { CliContext } from './context.js';
import { ExitCode } from './exit-codes.js';

export function notImplemented(ctx: CliContext, what: string, task: string): ExitCode {
  ctx.io.stderr(`janus: ${what} is not implemented yet (planned in ${task}).\n`);
  return ExitCode.NotImplemented;
}
