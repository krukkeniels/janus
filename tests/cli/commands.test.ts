import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { runCli } from '../helpers/run-cli.js';

const stubbed: string[][] = [
  ['run'],
  ['run', '--until', 'planning', '--max-wait', '45m', '--dry-run', '--model-profile', 'fast-first'],
  ['status'],
  ['status', '--json', '--telemetry'],
  ['approve', 'plan', '--commit', 'abc123'],
  ['approve', 'plan', '--commit', 'abc123', '--exception', 'ex-1', '--exception', 'ex-2'],
  ['approve', 'revised-plan', '--commit', 'abc123'],
  ['reject', 'plan', '--reason', 'wrong order'],
  ['escalation', 'show'],
  ['escalation', 'show', '--json'],
  ['escalation', 'resolve', '--direction', 'split the shell package'],
  ['review', 'sync'],
  ['doctor'],
  ['doctor', '--json'],
  ['agent', 'run', 'debug', '--task', 'task.yaml'],
  ['ci', 'wait', '--repo', 'shell', '--build', '42'],
  ['ci', 'trigger', '--repo', 'shell'],
  ['ci', 'digest', '--repo', 'shell', '--build', '42'],
  ['telemetry', 'export'],
  ['telemetry', 'export', '--csv'],
  ['telemetry', 'compare', 'a.jsonl', 'b.jsonl'],
];

describe('command stubs', () => {
  it.each(stubbed)('%s exits 3 with a not-implemented message', async (...argv) => {
    const result = await runCli(argv);
    expect(result.code).toBe(ExitCode.NotImplemented);
    expect(result.stderr).toMatch(/not implemented yet \(planned in T\d\d\)/);
  });

  it('rejects approve plan without --commit', async () => {
    const result = await runCli(['approve', 'plan']);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain("required option '--commit <sha>' not specified");
  });

  it('rejects reject plan without --reason', async () => {
    const result = await runCli(['reject', 'plan']);
    expect(result.code).toBe(ExitCode.UsageError);
  });

  it('rejects escalation resolve without --direction', async () => {
    const result = await runCli(['escalation', 'resolve']);
    expect(result.code).toBe(ExitCode.UsageError);
  });

  it('lists every top-level command in help', async () => {
    const result = await runCli(['--help']);
    for (const name of ['init', 'run', 'status', 'approve', 'reject', 'escalation', 'review', 'doctor', 'agent', 'ci', 'telemetry']) {
      expect(result.stdout).toContain(name);
    }
  });
});
