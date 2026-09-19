import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { goalSchema } from '../../src/config/goal-schema.js';
import { clone, commitAll, remoteHead, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { checkpoint, StateBranchDivergedError } from '../../src/state/checkpoint.js';
import { DECISIONS_HEADER } from '../../src/state/decisions.js';
import { DECISIONS_FILE, HANDOVER_FILE } from '../../src/state/files.js';
import { createInitialState } from '../../src/state/state-schema.js';
import { readState } from '../../src/state/state-store.js';
import { initStateRepo } from '../../src/workspace/state-branch.js';
import { validGoal } from '../fixtures/valid-goal.js';
import { createBareRepo, tempDir } from '../helpers/git-fixtures.js';

const goal = goalSchema.parse(validGoal);
const branch = 'janus/angular-15-to-16';

async function stateRepo() {
  const bare = await createBareRepo('state', branch);
  const janusDir = join(tempDir(), '.janus');
  await initStateRepo({ janusDir, branch, remoteUrl: bare, files: { [DECISIONS_FILE]: DECISIONS_HEADER } });
  const state = createInitialState({ goal, stateBranch: { name: branch, remote: 'state-repo' }, now: new Date('2026-09-19T12:00:00.000Z') });
  return { bare, janusDir, state };
}

describe('checkpoint', () => {
  it('writes state and handover, appends the decision, commits, and pushes fast-forward', async () => {
    const { janusDir, state } = await stateRepo();
    const now = new Date('2026-09-19T12:05:00.000Z');
    const result = await checkpoint({
      janusDir,
      state,
      goal,
      message: 'chore(janus): initialize workspace',
      push: true,
      decision: { at: now.toISOString(), by: 'janus init', title: 'Workspace created', body: 'first' },
      now,
    });
    expect(result.pushed).toBe(true);
    expect(result.commit).toBe(await revParse(janusDir, 'HEAD'));
    expect(await remoteHead(janusDir, 'origin', branch)).toBe(result.commit);
    expect(readState(janusDir).telemetry.last_updated_at).toBe('2026-09-19T12:05:00.000Z');
    expect(readFileSync(join(janusDir, HANDOVER_FILE), 'utf8')).toContain('Generated 2026-09-19T12:05:00.000Z');
    expect(readFileSync(join(janusDir, DECISIONS_FILE), 'utf8')).toContain('## Workspace created');
    expect(await runGit(janusDir, ['status', '--porcelain'])).toBe('');
    expect(await runGit(janusDir, ['log', '-1', '--format=%s'])).toBe('chore(janus): initialize workspace');
  });

  it('commits without pushing when asked', async () => {
    const { janusDir, state } = await stateRepo();
    const result = await checkpoint({ janusDir, state, goal, message: 'chore(janus): local only', push: false });
    expect(result.pushed).toBe(false);
    expect(await remoteHead(janusDir, 'origin', branch)).toBeNull();
    expect(existsSync(join(janusDir, HANDOVER_FILE))).toBe(true);
  });

  it('fails with StateBranchDivergedError when the remote moved', async () => {
    const { bare, janusDir, state } = await stateRepo();
    await checkpoint({ janusDir, state, goal, message: 'chore(janus): one', push: true });
    const other = join(tempDir(), 'other');
    await clone(bare, other, { branch });
    await commitAll(other, 'chore(janus): elsewhere', { allowEmpty: true });
    await runGit(other, ['push', '-q', 'origin', branch]);
    await expect(checkpoint({ janusDir, state, goal, message: 'chore(janus): two', push: true })).rejects.toBeInstanceOf(
      StateBranchDivergedError,
    );
  });
});
