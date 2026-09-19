import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeDrift, reconcileRepos } from '../../src/engine/reconcile.js';
import { checkoutBranch, clone, commitAll, currentBranch, push, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import { createGoalBranch, initWorkspace, testEngine } from '../helpers/engine-fixtures.js';
import type { WorkspaceFixture } from '../helpers/engine-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';

const goalBranch = 'ai/angular-15-to-16';

async function reconcile(ws: WorkspaceFixture) {
  const workspace = await openWorkspace(ws.root);
  try {
    const { engine, warnings } = testEngine(workspace);
    const result = await reconcileRepos(engine);
    return { result, warnings, state: workspace.state };
  } finally {
    workspace.release();
  }
}

function entry(result: Awaited<ReturnType<typeof reconcile>>, repo: string) {
  const found = result.result.repos.find((item) => item.repo === repo);
  if (!found) throw new Error(`no reconciliation entry for ${repo}`);
  return found;
}

describe('reconcileRepos', () => {
  it('reports nothing for a fresh workspace without goal branches', async () => {
    const ws = await initWorkspace();
    const result = await reconcile(ws);
    expect(result.result.changed).toBe(false);
    expect(result.result.escalations).toEqual([]);
    expect(entry(result, 'ui-kit')).toMatchObject({ recordedHead: null, head: null, localDrift: 'none', remote: 'absent', baseMoved: false, remoteBase: ws.fixture.uiKit.head });
    expect(result.warnings).toEqual([]);
    expect(readEvents(ws.janusDir).some((event) => event['type'] === 'repo.drift')).toBe(false);
  });

  it('is quiet when the local head matches the recorded head and the remote', async () => {
    const ws = await initWorkspace();
    const head = await createGoalBranch(ws, 'ui-kit');
    const result = await reconcile(ws);
    expect(entry(result, 'ui-kit')).toMatchObject({ recordedHead: head, head, localDrift: 'none', remote: 'in_sync' });
    expect(result.result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('adopts a local fast-forward of the recorded head and notes the unpushed commits', async () => {
    const ws = await initWorkspace();
    const recorded = await createGoalBranch(ws, 'ui-kit');
    const dir = join(ws.root, 'repos', 'ui-kit');
    const newer = await commitAll(dir, 'feat(ui-kit): more', { allowEmpty: true });
    const result = await reconcile(ws);
    expect(entry(result, 'ui-kit')).toMatchObject({ recordedHead: recorded, head: newer, localDrift: 'fast_forward', remote: 'behind' });
    expect(result.state.repos['ui-kit']?.head_commit).toBe(newer);
    expect(result.result.changed).toBe(true);
    expect(result.result.escalations).toEqual([]);
    expect(result.warnings[0]).toContain('ui-kit: local goal branch moved ahead of recorded head');
    const drift = readEvents(ws.janusDir).find((event) => event['type'] === 'repo.drift');
    expect(drift).toMatchObject({ repo: 'ui-kit', local_drift: 'fast_forward', remote: 'behind', base_moved: false, recorded_head: recorded, head: newer });
  });

  it('fast-forwards the local branch when the remote goal branch moved ahead', async () => {
    const ws = await initWorkspace();
    const recorded = await createGoalBranch(ws, 'ui-kit');
    const other = join(tempDir(), 'other');
    await clone(ws.fixture.uiKit.bare, other, { branch: goalBranch });
    const remote = await commitAll(other, 'feat(ui-kit): from elsewhere', { allowEmpty: true });
    await push(other, 'origin', goalBranch);
    const result = await reconcile(ws);
    expect(entry(result, 'ui-kit')).toMatchObject({ recordedHead: recorded, head: remote, localDrift: 'none', remote: 'ahead_fast_forwarded' });
    const dir = join(ws.root, 'repos', 'ui-kit');
    expect(await revParse(dir, 'HEAD')).toBe(remote);
    expect(await currentBranch(dir)).toBe(goalBranch);
    expect(result.state.repos['ui-kit']?.head_commit).toBe(remote);
    expect(result.result.changed).toBe(true);
  });

  it('escalates when the local goal branch no longer contains the recorded head', async () => {
    const ws = await initWorkspace();
    const recorded = await createGoalBranch(ws, 'ui-kit');
    const dir = join(ws.root, 'repos', 'ui-kit');
    await runGit(dir, ['reset', '-q', '--hard', 'HEAD~1']);
    const rewritten = await commitAll(dir, 'feat(ui-kit): rewritten', { allowEmpty: true });
    const result = await reconcile(ws);
    const uiKit = entry(result, 'ui-kit');
    expect(uiKit.localDrift).toBe('non_fast_forward');
    expect(result.result.escalations).toEqual([uiKit]);
    expect(result.state.repos['ui-kit']?.head_commit).toBe(recorded);
    expect(result.result.changed).toBe(false);
    expect(describeDrift(uiKit)).toContain('non-fast-forward');
    expect(await revParse(dir, 'HEAD')).toBe(rewritten);
  });

  it('escalates when the local goal branch is missing', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    const dir = join(ws.root, 'repos', 'ui-kit');
    await checkoutBranch(dir, 'main');
    await runGit(dir, ['branch', '-q', '-D', goalBranch]);
    const result = await reconcile(ws);
    expect(entry(result, 'ui-kit').localDrift).toBe('missing');
    expect(result.result.escalations).toHaveLength(1);
  });

  it('escalates when the remote goal branch diverged', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    const other = join(tempDir(), 'other');
    await clone(ws.fixture.uiKit.bare, other, { branch: goalBranch });
    await runGit(other, ['reset', '-q', '--hard', 'HEAD~1']);
    await commitAll(other, 'feat(ui-kit): rewritten remotely', { allowEmpty: true });
    await runGit(other, ['push', '-q', '--force', 'origin', goalBranch]);
    const result = await reconcile(ws);
    expect(entry(result, 'ui-kit')).toMatchObject({ localDrift: 'none', remote: 'diverged' });
    expect(result.result.escalations).toHaveLength(1);
    expect(result.result.changed).toBe(false);
  });

  it('only notes a moved base branch', async () => {
    const ws = await initWorkspace();
    const head = await createGoalBranch(ws, 'ui-kit');
    await runGit(ws.fixture.uiKit.work, ['commit', '-q', '--allow-empty', '-m', 'chore: base moves on']);
    await runGit(ws.fixture.uiKit.work, ['push', '-q', ws.fixture.uiKit.bare, 'main']);
    const movedBase = await revParse(ws.fixture.uiKit.work, 'HEAD');
    const result = await reconcile(ws);
    expect(entry(result, 'ui-kit')).toMatchObject({ head, localDrift: 'none', remote: 'in_sync', baseMoved: true, remoteBase: movedBase });
    expect(result.result.escalations).toEqual([]);
    expect(result.result.changed).toBe(false);
    expect(result.state.repos['ui-kit']?.base_commit).toBe(ws.fixture.uiKit.head);
    expect(result.warnings).toEqual([`ui-kit: base branch moved to ${movedBase.slice(0, 7)} (the sync step will merge it)`]);
  });
});
