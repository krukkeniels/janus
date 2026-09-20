import { UNSANDBOXED_NOTE } from '../agents/sandbox.js';
import type { Goal } from '../config/goal-schema.js';
import type { JanusState } from '../state/state-schema.js';

export interface RenderHandoverOptions {
  /** `agents.allow_unsandboxed`; §18.4 requires it recorded in every checkpoint. */
  allowUnsandboxed: boolean;
}

/** The human-readable handover regenerated at every checkpoint (spec §5, §7). state.yaml stays authoritative. */
export function renderHandover(
  state: JanusState,
  goal: Goal,
  now: Date,
  options: RenderHandoverOptions = { allowUnsandboxed: false },
): string {
  const lines: string[] = [];
  lines.push(`# Handover: ${goal.title}`, '');
  lines.push(
    `Generated ${now.toISOString()} by Janus. Rewritten at every checkpoint; state.yaml is the authoritative view.`,
    '',
  );
  lines.push('## Where we are', '');
  lines.push(`- Goal: ${state.goal.id} (Angular ${goal.source_version} -> ${goal.target_version})`);
  lines.push(`- Status: ${state.goal.status}`);
  lines.push(`- State branch: ${state.state_branch.name} on ${state.state_branch.remote}`);
  lines.push(`- Current work package: ${state.execution.current_work_package ?? 'none'}`);
  lines.push(`- Gate: ${state.gate.type === null ? 'none' : `${state.gate.type} (${state.gate.status})`}`, '');
  lines.push('## Repositories', '');
  lines.push('| Repo | Goal branch | Base commit | Head commit | PR | Merged |');
  lines.push('|---|---|---|---|---|---|');
  for (const repo of goal.repos) {
    const repoState = state.repos[repo.name];
    if (!repoState) continue;
    lines.push(
      `| ${repo.name} | ${repoState.goal_branch} | ${short(repoState.base_commit)} | ${short(repoState.head_commit)} | ${repoState.pr.url ?? '-'} | ${repoState.merged ? 'yes' : 'no'} |`,
    );
  }
  if (options.allowUnsandboxed) {
    lines.push('', '## Sandbox', '', `> ${UNSANDBOXED_NOTE}`);
  }
  lines.push('', '## Next action', '', nextAction(state), '');
  return lines.join('\n');
}

function short(sha: string | null): string {
  return sha === null ? '-' : sha.slice(0, 7);
}

function nextAction(state: JanusState): string {
  switch (state.goal.status) {
    case 'created':
      return 'Run `janus run` to start prepare and discovery.';
    case 'awaiting_plan_approval':
      return 'Review .janus/plan.md and run `janus approve plan --commit <sha>`.';
    case 'escalated':
      return 'Read .janus/escalation.md and run `janus escalation resolve --direction "..."`.';
    case 'completed':
      return 'Goal complete. Nothing to do.';
    default:
      return 'Run `janus run` to continue.';
  }
}
