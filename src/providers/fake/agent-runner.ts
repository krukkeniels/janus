import type { AgentRole } from '../../config/config-schema.js';
import type { AgentOutcome, AgentResult, AgentTask } from '../../agents/types.js';
import { outcomeSummary } from '../../agents/types.js';
import type { AgentRunner } from '../types.js';
import { FAKE_AGENTS_FILE, readFakeStore, writeFakeStore } from './store.js';

/**
 * One scripted answer.
 *
 * T05 replaces this with the full §18.5 script: prepared patches applied to the repo, prepared reports written
 * under `.janus/reports/<run-id>/`, and prepared results validated against the §18.3 output schema.
 */
export interface FakeAgentScriptEntry {
  status: AgentResult['status'];
  summary: string;
}

export interface FakeAgentCall {
  run_id: string;
  role: AgentRole;
  repo: string | null;
  at: string;
  status: AgentResult['status'];
}

/** The contents of `<workspace>/fake/agents.json` (spec §18.5). */
export interface FakeAgentStore {
  /** Answers consumed in order per role; a role that runs out falls back to a generated `completed`. */
  script: Partial<Record<AgentRole, FakeAgentScriptEntry[]>>;
  /** Every call made in this workspace, so a second `janus run` continues where the first stopped. */
  calls: FakeAgentCall[];
}

export function emptyFakeAgentStore(): FakeAgentStore {
  return { script: {}, calls: [] };
}

/** Seeds the script before a run and clears any recorded calls. */
export function seedFakeAgents(fakeDir: string, script: FakeAgentStore['script']): void {
  const store: FakeAgentStore = { script, calls: [] };
  writeFakeStore(fakeDir, FAKE_AGENTS_FILE, store);
}

export function readFakeAgents(fakeDir: string): FakeAgentStore {
  return readFakeStore(fakeDir, FAKE_AGENTS_FILE, emptyFakeAgentStore());
}

export interface FakeAgentRunnerInput {
  /** `WorkspacePaths.fakeDir`. */
  fakeDir: string;
  now(): Date;
}

/**
 * Spec §18.5: scripted by role and attempt number, state persisted under `fake/agents.json`.
 *
 * It writes nothing but that one file and never invokes git, which is what makes the §31.29 reflog audit
 * meaningful: a git write observed while this runner is in flight is a real violation, not fixture noise.
 */
export function createFakeAgentRunner(input: FakeAgentRunnerInput): AgentRunner {
  return {
    name: 'fake',
    run: async (task: AgentTask): Promise<AgentOutcome> => {
      const store = readFakeAgents(input.fakeDir);
      const attempt = store.calls.filter((call) => call.role === task.role).length;
      const scripted = store.script[task.role]?.[attempt];
      const status = scripted?.status ?? 'completed';
      const summary = scripted?.summary ?? `fake ${task.role} agent attempt ${attempt + 1} completed`;
      const result: AgentResult = {
        status,
        summary,
        changes_made: [],
        findings: [],
        evidence: [],
        new_tasks: [],
        expected_temporary_failure: false,
        predicted_failures: null,
        plan_change_required: false,
        architecture_change_required: false,
        behavior_change_required: false,
        recommended_next_action: '',
        handover: { current_state: summary, next_action: '', risks: [] },
      };
      store.calls.push({
        run_id: task.runId,
        role: task.role,
        repo: task.repo,
        at: input.now().toISOString(),
        status,
      });
      writeFakeStore(input.fakeDir, FAKE_AGENTS_FILE, store);
      return {
        runId: task.runId,
        status,
        summary: outcomeSummary(result, null),
        result,
        failure: null,
        tokens: null,
        durationMs: 0,
        exitCode: 0,
        signal: null,
        timedOut: false,
        runnerVersion: null,
        promptBytes: null,
        truncations: [],
      };
    },
  };
}
