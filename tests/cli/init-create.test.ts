import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { currentBranch, remoteHead, revParse } from '../../src/git/ops.js';
import { readState } from '../../src/state/state-store.js';
import { readEvents } from '../../src/telemetry/events.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { runCli } from '../helpers/run-cli.js';
import { goalFixture } from '../helpers/workspace-fixtures.js';

describe('janus init --goal', () => {
  it('clones repos, creates and pushes the state branch, and checkpoints', async () => {
    const fixture = await goalFixture();
    const workspace = join(tempDir(), 'ws');
    const result = await runCli(['init', '--goal', fixture.goalPath, '--workspace', workspace]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('goal angular-15-to-16: Angular 15 -> 16, 2 repos');
    expect(result.stdout).toContain('repo order: ui-kit, shell');
    expect(result.stdout).toContain(`workspace: ${workspace}`);
    expect(result.stdout).toMatch(/checkpoint: [0-9a-f]{7}/);

    expect(existsSync(join(workspace, 'repos', 'ui-kit', 'README.md'))).toBe(true);
    expect(existsSync(join(workspace, 'repos', 'shell', 'README.md'))).toBe(true);
    expect(existsSync(join(workspace, '.pnpm-store'))).toBe(true);
    expect(existsSync(join(workspace, 'fake'))).toBe(true);
    expect(existsSync(join(workspace, 'janus.lock'))).toBe(false);

    const janusDir = join(workspace, '.janus');
    const state = readState(janusDir);
    expect(state.goal.status).toBe('created');
    expect(state.state_branch).toEqual({ name: 'janus/angular-15-to-16', remote: 'state-repo' });
    expect(state.repos['ui-kit']?.base_commit).toBe(fixture.uiKit.head);
    expect(state.repos['shell']?.base_commit).toBe(fixture.shell.head);
    expect(readFileSync(join(janusDir, 'goal.yaml'), 'utf8')).toBe(fixture.goalText);
    expect(existsSync(join(janusDir, 'config.yaml'))).toBe(true);
    expect(existsSync(join(janusDir, 'handover.md'))).toBe(true);
    expect(readFileSync(join(janusDir, 'decisions.md'), 'utf8')).toContain('## Workspace created');
    expect(readEvents(janusDir).map((event) => event['type'])).toEqual(['goal.created']);

    expect(await currentBranch(janusDir)).toBe('janus/angular-15-to-16');
    const head = await revParse(janusDir, 'HEAD');
    expect(await remoteHead(janusDir, 'origin', 'janus/angular-15-to-16')).toBe(head);
    expect(await currentBranch(join(workspace, 'repos', 'shell'))).toBe('main');
  });

  it('refuses a non-empty workspace directory', async () => {
    const fixture = await goalFixture();
    const workspace = join(tempDir(), 'ws');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'leftover.txt'), 'x');
    const result = await runCli(['init', '--goal', fixture.goalPath, '--workspace', workspace]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('exists and is not empty');
  });

  it('fails clearly when no config.yaml sits next to the goal and none is given', async () => {
    const fixture = await goalFixture();
    rmSync(fixture.configPath);
    const result = await runCli(['init', '--goal', fixture.goalPath, '--workspace', join(tempDir(), 'ws')]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('config.yaml not found next to the goal file');
  });

  it('exits 13 when another janus process holds the lock', async () => {
    const fixture = await goalFixture();
    const workspace = join(tempDir(), 'ws');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'janus.lock'), JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
    const result = await runCli(['init', '--goal', fixture.goalPath, '--workspace', workspace]);
    expect(result.code).toBe(ExitCode.Locked);
    expect(result.stderr).toContain('locked by pid');
  });
});
