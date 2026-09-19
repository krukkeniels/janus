import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { validGoal } from '../fixtures/valid-goal.js';
import { runCli } from '../helpers/run-cli.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'janus-init-'));
}

describe('janus init --goal', () => {
  it('validates the goal and then requires a config file', async () => {
    const dir = tempDir();
    const goalPath = join(dir, 'goal.yaml');
    writeFileSync(goalPath, stringify(validGoal));
    const result = await runCli(['init', '--goal', goalPath]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('config.yaml not found next to the goal file');
  });

  it('exits 2 and names the field when the goal is invalid', async () => {
    const dir = tempDir();
    const goalPath = join(dir, 'goal.yaml');
    writeFileSync(goalPath, stringify({ ...validGoal, target_version: '18' }));
    const result = await runCli(['init', '--goal', goalPath]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('target_version: must be exactly one major above source_version');
  });

  it('exits 2 when the goal file is missing', async () => {
    const result = await runCli(['init', '--goal', '/nonexistent/goal.yaml']);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('file not found');
  });

  it('also validates --config when given', async () => {
    const dir = tempDir();
    const goalPath = join(dir, 'goal.yaml');
    const configPath = join(dir, 'config.yaml');
    writeFileSync(goalPath, stringify(validGoal));
    writeFileSync(configPath, 'workflow:\n  ci_provider: bogus\n');
    const result = await runCli(['init', '--goal', goalPath, '--config', configPath]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('workflow.ci_provider');
  });

  it('exits 2 when neither --goal nor --resume is given', async () => {
    const result = await runCli(['init']);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('either --goal <file> or --resume <state-remote> is required');
  });
});
