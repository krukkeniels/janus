import type { AgentRole } from '../../config/config-schema.js';
import type { AgentRunOutcome, AgentRunRequest, AgentRunner } from '../types.js';
import { FAKE_AGENTS_FILE, readFakeStore, writeFakeStore } from './store.js';

/**
 * One scripted answer.
 *
 * T05 replaces this with the full §18.5 script: prepared patches applied to the repo, prepared reports written
 * under `.janus/reports/<run-id>/`, and prepared results validated against the §18.3 output schema.
 */
export interface FakeAgentScriptEntry {
  status: AgentRunOutcome['status'];
  summary: string;
}

export interface FakeAgentCall {
  run_id: string;
  role: AgentRole;
  repo: string | null;
  at: string;
  status: AgentRunOutcome['status'];
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
    run: async (request: AgentRunRequest): Promise<AgentRunOutcome> => {
      const store = readFakeAgents(input.fakeDir);
      const attempt = store.calls.filter((call) => call.role === request.role).length;
      const scripted = store.script[request.role]?.[attempt];
      const outcome: AgentRunOutcome = {
        runId: request.runId,
        status: scripted?.status ?? 'completed',
        summary: scripted?.summary ?? `fake ${request.role} agent attempt ${attempt + 1} completed`,
      };
      store.calls.push({
        run_id: request.runId,
        role: request.role,
        repo: request.repo,
        at: input.now().toISOString(),
        status: outcome.status,
      });
      writeFakeStore(input.fakeDir, FAKE_AGENTS_FILE, store);
      return outcome;
    },
  };
}
