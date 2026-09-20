import type { Command } from 'commander';
import { ALL_CHECKS, buildDoctorContext } from '../../doctor/index.js';
import { doctorExitCode, doctorJson, renderDoctorHuman, runDoctor } from '../../doctor/report.js';
import type { CliContext } from '../context.js';
import type { ExitCode } from '../exit-codes.js';

interface DoctorOptions {
  json?: boolean;
}

export function registerDoctor(program: Command, ctx: CliContext): void {
  program
    .command('doctor')
    .description('Check codex, git, tokens, sandbox, and provider reachability')
    .option('--json', 'machine-readable output')
    .action(async (options: DoctorOptions) => {
      ctx.exitCode = await doctorCommand(ctx, options);
    });
}

/**
 * Spec §18.4 (the three real probes), §18.6 (one-token model probe), §31 item 33 (a dead sandbox, a read-only
 * pnpm store, a missing `janus/*` exclusion), `tasks.md` T07.
 *
 * Exit code: 1 when any check failed, 0 otherwise — a `warn` or a `skip` is information, not a failure. The whole
 * report is printed either way, because the operator needs the passing checks to interpret the failing ones.
 */
async function doctorCommand(ctx: CliContext, options: DoctorOptions): Promise<ExitCode> {
  const context = buildDoctorContext({ cwd: ctx.io.cwd, env: ctx.io.env, now: () => new Date() });
  const report = await runDoctor(ctx.doctorChecks ?? ALL_CHECKS, context);
  ctx.io.stdout(options.json === true ? doctorJson(report) : renderDoctorHuman(report));
  return doctorExitCode(report);
}
