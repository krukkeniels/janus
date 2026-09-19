import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { registerAgent } from './agent.js';
import { registerApprove } from './approve.js';
import { registerCi } from './ci.js';
import { registerDoctor } from './doctor.js';
import { registerEscalation } from './escalation.js';
import { registerInit } from './init.js';
import { registerReject } from './reject.js';
import { registerReview } from './review.js';
import { registerRun } from './run.js';
import { registerStatus } from './status.js';
import { registerTelemetry } from './telemetry.js';

export function registerCommands(program: Command, ctx: CliContext): void {
  registerInit(program, ctx);
  registerRun(program, ctx);
  registerStatus(program, ctx);
  registerApprove(program, ctx);
  registerReject(program, ctx);
  registerEscalation(program, ctx);
  registerReview(program, ctx);
  registerDoctor(program, ctx);
  registerAgent(program, ctx);
  registerCi(program, ctx);
  registerTelemetry(program, ctx);
}
