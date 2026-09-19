import { checkoutBranch, currentBranch, fastForward, fetch, isAncestor, revParse, tryRevParse } from '../git/ops.js';
import type { Engine } from './engine.js';

export type LocalDrift = 'none' | 'fast_forward' | 'non_fast_forward' | 'missing';
export type RemoteRelation = 'absent' | 'in_sync' | 'ahead_fast_forwarded' | 'behind' | 'diverged';

export interface RepoReconciliation {
  repo: string;
  recordedHead: string | null;
  /** The head Janus now considers current (adopted into state unless the entry escalates). */
  head: string | null;
  localDrift: LocalDrift;
  remote: RemoteRelation;
  baseMoved: boolean;
  remoteBase: string;
}

export interface ReconcileResult {
  repos: RepoReconciliation[];
  escalations: RepoReconciliation[];
  /** True when at least one `head_commit` was adopted; the caller checkpoints. */
  changed: boolean;
}

export function needsEscalation(entry: RepoReconciliation): boolean {
  return entry.localDrift === 'non_fast_forward' || entry.localDrift === 'missing' || entry.remote === 'diverged';
}

/**
 * Spec §7 rule 2. For every repo: fetch, compare the local goal branch to `head_commit`, relate it to the remote goal
 * branch, and note base-branch movement. Fast-forwards are adopted; anything else on a goal branch escalates.
 */
export async function reconcileRepos(engine: Engine): Promise<ReconcileResult> {
  const { state, goal, repoOrder, paths } = engine.workspace;
  const reposByName = new Map(goal.repos.map((repo) => [repo.name, repo]));
  const repos: RepoReconciliation[] = [];
  let changed = false;
  for (const name of repoOrder) {
    const repo = reposByName.get(name);
    const repoState = state.repos[name];
    if (!repo || !repoState) continue;
    const dir = paths.repoDir(name);
    await fetch(dir, 'origin');
    const remoteBase = await revParse(dir, `refs/remotes/origin/${repo.base_branch}`);
    const entry: RepoReconciliation = {
      repo: name,
      recordedHead: repoState.head_commit,
      head: repoState.head_commit,
      localDrift: 'none',
      remote: 'absent',
      baseMoved: repoState.base_commit !== null && remoteBase !== repoState.base_commit,
      remoteBase,
    };
    if (repoState.head_commit !== null) {
      const recorded = repoState.head_commit;
      const local = await tryRevParse(dir, `refs/heads/${repoState.goal_branch}`);
      if (local === null) {
        entry.localDrift = 'missing';
      } else {
        if (local !== recorded) {
          entry.localDrift = (await isAncestor(dir, recorded, local)) ? 'fast_forward' : 'non_fast_forward';
        }
        if (entry.localDrift !== 'non_fast_forward') {
          entry.head = local;
          entry.remote = await relateToRemote(dir, repoState.goal_branch, local);
          if (entry.remote === 'ahead_fast_forwarded') entry.head = await revParse(dir, `refs/heads/${repoState.goal_branch}`);
        }
      }
      if (!needsEscalation(entry) && entry.head !== null && entry.head !== recorded) {
        repoState.head_commit = entry.head;
        changed = true;
      }
    }
    const noteworthy = entry.localDrift !== 'none' || entry.baseMoved || entry.remote === 'ahead_fast_forwarded' || entry.remote === 'behind' || entry.remote === 'diverged';
    if (noteworthy) {
      engine.emit({
        type: 'repo.drift',
        repo: name,
        local_drift: entry.localDrift,
        remote: entry.remote,
        base_moved: entry.baseMoved,
        recorded_head: entry.recordedHead,
        head: entry.head,
        remote_base: remoteBase,
      });
      engine.warn(describeDrift(entry));
    }
    repos.push(entry);
  }
  return { repos, escalations: repos.filter(needsEscalation), changed };
}

/** Relates the local goal branch head to `origin/<branch>`, fast-forwarding the local branch when the remote is strictly ahead. */
async function relateToRemote(dir: string, branch: string, local: string): Promise<RemoteRelation> {
  const remote = await tryRevParse(dir, `refs/remotes/origin/${branch}`);
  if (remote === null) return 'absent';
  if (remote === local) return 'in_sync';
  if (await isAncestor(dir, local, remote)) {
    if ((await currentBranch(dir)) !== branch) await checkoutBranch(dir, branch);
    await fastForward(dir, remote);
    return 'ahead_fast_forwarded';
  }
  if (await isAncestor(dir, remote, local)) return 'behind';
  return 'diverged';
}

function short(sha: string | null): string {
  return sha === null ? '-' : sha.slice(0, 7);
}

export function describeDrift(entry: RepoReconciliation): string {
  const parts: string[] = [];
  const recorded = short(entry.recordedHead);
  if (entry.localDrift === 'fast_forward') parts.push(`local goal branch moved ahead of recorded head ${recorded} (fast-forward, adopted ${short(entry.head)})`);
  if (entry.localDrift === 'non_fast_forward') parts.push(`local goal branch no longer contains recorded head ${recorded} (non-fast-forward)`);
  if (entry.localDrift === 'missing') parts.push(`local goal branch is missing (recorded head ${recorded})`);
  if (entry.remote === 'ahead_fast_forwarded') parts.push(`remote goal branch was ahead; local branch fast-forwarded to ${short(entry.head)}`);
  if (entry.remote === 'behind') parts.push('local goal branch has commits the remote does not (unpushed)');
  if (entry.remote === 'diverged') parts.push('remote goal branch diverged from the local one');
  if (entry.baseMoved) parts.push(`base branch moved to ${short(entry.remoteBase)} (the sync step will merge it)`);
  return `${entry.repo}: ${parts.join('; ')}`;
}
