import { Command, CommanderError } from 'commander';
import { ConfigError } from '../config/errors.js';
import { GateError } from '../engine/gates.js';
import { ProviderNotImplementedError } from '../providers/index.js';
import { StateBranchDivergedError } from '../state/checkpoint.js';
import { WorkspaceLockedError } from '../workspace/lock.js';
import { registerCommands } from './commands/index.js';
import { createContext, defaultIo } from './context.js';
import type { CliContext, CliIo, CliOverrides } from './context.js';
import { ExitCode } from './exit-codes.js';
import { VERSION } from './version.js';

export function buildProgram(ctx: CliContext): Command {
  const program = new Command('janus');
  program
    .description('Agent-driven, resumable orchestrator for multi-repo Angular major upgrades')
    .version(VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => ctx.io.stdout(text),
      writeErr: (text) => ctx.io.stderr(text),
    })
    .showHelpAfterError('(run "janus --help" for usage)');
  registerCommands(program, ctx);
  return program;
}

const HELP_CODES = new Set(['commander.helpDisplayed', 'commander.help', 'commander.version']);

export function exitCodeForError(error: unknown, io: CliIo): ExitCode {
  if (error instanceof CommanderError) {
    return HELP_CODES.has(error.code) ? ExitCode.Ok : ExitCode.UsageError;
  }
  if (error instanceof WorkspaceLockedError) {
    io.stderr(`janus: ${error.message}\n`);
    return ExitCode.Locked;
  }
  if (error instanceof StateBranchDivergedError) {
    io.stderr(`janus: ${error.message}\n`);
    io.stderr(
      'janus: reconcile with: git -C .janus fetch origin && git -C .janus log --oneline HEAD...FETCH_HEAD, then merge (never force-push) so the branch has one line of history, and run janus again\n',
    );
    return ExitCode.UnexpectedError;
  }
  if (error instanceof ConfigError) {
    io.stderr(`janus: ${error.message}\n`);
    return ExitCode.UsageError;
  }
  if (error instanceof GateError) {
    io.stderr(`janus: ${error.message}\n`);
    return ExitCode.UsageError;
  }
  if (error instanceof ProviderNotImplementedError) {
    io.stderr(`janus: ${error.message}\n`);
    return ExitCode.NotImplemented;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.stderr(`janus: ${message}\n`);
  return ExitCode.UnexpectedError;
}

export async function main(argv: string[], io: CliIo = defaultIo(), overrides: CliOverrides = {}): Promise<ExitCode> {
  const ctx = createContext(io, overrides);
  const program = buildProgram(ctx);
  if (argv.length === 0) {
    program.outputHelp();
    return ExitCode.Ok;
  }
  try {
    await program.parseAsync(argv, { from: 'user' });
    return ctx.exitCode;
  } catch (error) {
    return exitCodeForError(error, io);
  }
}
