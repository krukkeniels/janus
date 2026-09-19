import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAll, currentBranch, push, remoteHead } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { initStateRepo, openStateRepo } from '../../src/workspace/state-branch.js';
import { createBareRepo, tempDir } from '../helpers/git-fixtures.js';

describe('initStateRepo', () => {
  it('creates a repo on the state branch with origin and the given files, uncommitted', async () => {
    const bare = await createBareRepo('state', 'janus/g');
    const janusDir = join(tempDir(), '.janus');
    await initStateRepo({ janusDir, branch: 'janus/g', remoteUrl: bare, files: { 'goal.yaml': 'id: g\n', 'telemetry/events.jsonl': '' } });
    expect(await currentBranch(janusDir)).toBe('janus/g');
    expect(await runGit(janusDir, ['remote', 'get-url', 'origin'])).toBe(bare);
    expect(readFileSync(join(janusDir, 'goal.yaml'), 'utf8')).toBe('id: g\n');
    expect(existsSync(join(janusDir, 'telemetry', 'events.jsonl'))).toBe(true);
    expect(await runGit(janusDir, ['status', '--porcelain'])).toContain('goal.yaml');
    await expect(runGit(janusDir, ['rev-parse', 'HEAD'])).rejects.toThrow();
  });
});

describe('openStateRepo', () => {
  it('clones only the state branch and returns its head', async () => {
    const bare = await createBareRepo('state', 'janus/g');
    const source = join(tempDir(), '.janus');
    await initStateRepo({ janusDir: source, branch: 'janus/g', remoteUrl: bare, files: { 'state.yaml': 'version: 2\n' } });
    const sha = await commitAll(source, 'chore(janus): first');
    await push(source, 'origin', 'janus/g', { setUpstream: true });
    writeFileSync(join(source, 'other.txt'), 'x\n');
    await runGit(source, ['checkout', '-q', '-b', 'other']);
    await commitAll(source, 'chore(janus): other branch');
    await push(source, 'origin', 'other');

    const target = join(tempDir(), '.janus');
    expect(await openStateRepo({ janusDir: target, branch: 'janus/g', remoteUrl: bare })).toBe(sha);
    expect(await currentBranch(target)).toBe('janus/g');
    expect(readFileSync(join(target, 'state.yaml'), 'utf8')).toBe('version: 2\n');
    expect(await runGit(target, ['branch', '-r'])).not.toContain('origin/other');
    expect(await remoteHead(target, 'origin', 'janus/g')).toBe(sha);
  });
});
