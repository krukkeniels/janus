import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { resetHard, workingTreeDiff } from '../git/tree.js';
import { AGENTS_EVIDENCE_DIR } from '../state/files.js';
import { emptyInFlight } from '../state/state-schema.js';
import { incrementBudget } from './budgets.js';
import type { BudgetIncrement } from './budgets.js';
import type { Engine } from './engine.js';

export interface InFlightRecovery {
  step: string;
  kind: 'agent' | 'other';
  patchFile: string | null;
  budget: BudgetIncrement | null;
}

/**
 * Spec §7 rule 3. When the previous process died mid-step: an agent run's uncommitted diff is saved as evidence, the
 * repo is reset, and the run counts against its budget; every other step simply runs again (CI and E2E waits resume
 * on the build id recorded in state). Clears `in_flight`; the caller checkpoints.
 */
export async function recoverInFlight(engine: Engine): Promise<InFlightRecovery | null> {
  const { state, paths, config } = engine.workspace;
  const inFlight = state.execution.in_flight;
  if (inFlight.step === null) return null;
  const step = inFlight.step;
  const started = inFlight.started_at ?? 'unknown time';
  let kind: InFlightRecovery['kind'] = 'other';
  let patchFile: string | null = null;
  let budget: BudgetIncrement | null = null;
  let detail = '';
  if (inFlight.agent_run_id !== null) {
    kind = 'agent';
    const runId = inFlight.agent_run_id;
    if (inFlight.repo !== null) {
      const dir = paths.repoDir(inFlight.repo);
      const diff = await workingTreeDiff(dir);
      if (diff.patch !== '') {
        patchFile = join(paths.janusDir, AGENTS_EVIDENCE_DIR, `${runId}.interrupted.patch`);
        mkdirSync(dirname(patchFile), { recursive: true });
        writeFileSync(patchFile, diff.patch);
      }
      await resetHard(dir);
      detail = `agent work in ${inFlight.repo} was ${patchFile === null ? 'absent' : 'saved and discarded'}; `;
    }
    engine.emit({
      type: 'agent.finished',
      run_id: runId,
      role: null,
      repo: inFlight.repo,
      status: 'interrupted',
      model: null,
      effort: null,
      prompt_version: null,
      profile: null,
      experiment_id: null,
      tokens: null,
      duration_ms: null,
      failure: 'interrupted',
      step,
      patch: patchFile === null ? null : relative(paths.janusDir, patchFile),
    });
    if (inFlight.budget !== null) {
      budget = incrementBudget({ state, config, emit: engine.emit }, inFlight.budget, `agent run ${runId} interrupted during ${step}`);
    }
  }
  engine.warn(`previous run died during step "${step}" (started ${started}); ${detail}the step will run again`);
  state.execution.in_flight = emptyInFlight();
  return { step, kind, patchFile, budget };
}
