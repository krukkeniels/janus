import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentRole } from '../../config/config-schema.js';
import { validateAgentResult } from '../../agents/output-schema.js';
import type { AgentResult } from '../../agents/output-schema.js';
import type { AgentOutcome, AgentRunFailure, AgentTask, AgentTokenUsage } from '../../agents/types.js';
import { outcomeSummary } from '../../agents/types.js';
import { runGit } from '../../git/run.js';
import { REPORTS_DIR } from '../../state/files.js';
import type { WorkspacePaths } from '../../workspace/layout.js';
import type { AgentRunner } from '../types.js';
import { FAKE_AGENTS_FILE, readFakeStore, writeFakeStore } from './store.js';

/**
 * One scripted answer. Spec §18.5: "Scripted by role and attempt number; applies prepared patches, writes prepared
 * reports, returns prepared results; state persisted under `fake/agents.json`."
 */
export interface FakeAgentScriptEntry {
  status: AgentResult['status'];
  summary: string;
  /** A unified diff applied to the assigned repo's **working tree**. Never a commit: §32 rule 11. */
  patch?: string;
  /** Files written under `.janus/reports/<run-id>/`, keyed by relative path. */
  reports?: Record<string, string>;
  /** Overrides merged over the generated §18.3 result. Validated against the role schema before it is returned. */
  result?: Partial<AgentResult>;
  tokens?: AgentTokenUsage;
  durationMs?: number;
  /**
   * An adapter-level failure to simulate (timeout, invalid output, ...).
   *
   * Mirrors the real Codex adapter (commit `4a6e3e7`): when `result` is also set, both are returned — a failed run
   * can still have produced a validated answer, which is what `evidence.ts` needs to write to the audit trail.
   * Omit `result` to simulate a failure that produced no answer at all.
   */
  failure?: AgentRunFailure;
}

export interface FakeAgentCall {
  run_id: string;
  role: AgentRole;
  repo: string | null;
  attempt: number;
  at: string;
  status: AgentResult['status'];
  applied_patch: boolean;
  wrote_reports: string[];
}

/** The contents of `<workspace>/fake/agents.json` (spec §18.5). */
export interface FakeAgentStore {
  /** Answers per role, indexed by `attempt - 1`. A role that runs out falls back to a generated `completed`. */
  script: Partial<Record<AgentRole, FakeAgentScriptEntry[]>>;
  /** Every call made in this workspace, across processes. */
  calls: FakeAgentCall[];
}

export function emptyFakeAgentStore(): FakeAgentStore {
  return { script: {}, calls: [] };
}

/** Seeds the script before a run and clears any recorded calls. */
export function seedFakeAgents(fakeDir: string, script: FakeAgentStore['script']): void {
  writeFakeStore(fakeDir, FAKE_AGENTS_FILE, { script, calls: [] } satisfies FakeAgentStore);
}

export function readFakeAgents(fakeDir: string): FakeAgentStore {
  return readFakeStore(fakeDir, FAKE_AGENTS_FILE, emptyFakeAgentStore());
}

export interface FakeAgentRunnerInput {
  paths: WorkspacePaths;
  now(): Date;
}

function baseResult(role: AgentRole, status: AgentResult['status'], summary: string): AgentResult {
  return {
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
    recommended_next_action: `fake ${role} agent has nothing further to recommend`,
    handover: { current_state: summary, next_action: '', risks: [] },
  };
}

/**
 * Spec §18.5's scripted runner.
 *
 * It applies a patch with `git apply`, which writes the working tree and index but **no ref**, so T04's reflog
 * audit (§31.29) still sees zero git writes during an agent run — exactly as a real Codex agent, which edits files
 * and never commits.
 */
export function createFakeAgentRunner(input: FakeAgentRunnerInput): AgentRunner {
  const { paths } = input;
  return {
    name: 'fake',
    run: async (task: AgentTask): Promise<AgentOutcome> => {
      const store = readFakeAgents(paths.fakeDir);
      const index = Math.max(task.attempt, 1) - 1;
      const scripted = store.script[task.role]?.[index];
      const status = scripted?.status ?? 'completed';
      const summary = scripted?.summary ?? `fake ${task.role} agent attempt ${index + 1} completed`;

      let appliedPatch = false;
      if (scripted?.patch !== undefined && scripted.patch !== '') {
        if (task.repo === null) {
          throw new Error(`fake agent script for role ${task.role} attempt ${index + 1} has a patch but the task has no repo`);
        }
        const patchFile = join(paths.fakeDir, 'patches', `${task.runId}.patch`);
        mkdirSync(dirname(patchFile), { recursive: true });
        writeFileSync(patchFile, scripted.patch.endsWith('\n') ? scripted.patch : `${scripted.patch}\n`);
        await runGit(paths.repoDir(task.repo), ['apply', '--whitespace=nowarn', patchFile]);
        appliedPatch = true;
      }

      const wroteReports: string[] = [];
      if (scripted?.reports !== undefined) {
        const dir = join(paths.janusDir, REPORTS_DIR, task.runId);
        for (const [name, contents] of Object.entries(scripted.reports)) {
          const path = join(dir, name);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, contents);
          wroteReports.push(name);
        }
      }

      const failure = scripted?.failure ?? null;
      // A scripted failure suppresses `result` unless the script also names one: the real adapter (commit
      // `4a6e3e7`) keeps the validated answer alongside a failure, since it is the only surviving copy for the
      // evidence trail once the run is done. `failure === null` covers the ordinary success path.
      let result: AgentResult | null = null;
      if (failure === null || scripted?.result !== undefined) {
        const merged = { ...baseResult(task.role, status, summary), ...(scripted?.result ?? {}) };
        const validated = validateAgentResult(task.role, merged);
        if (!validated.ok) {
          throw new Error(
            `fake agent script for role ${task.role} attempt ${index + 1} is not a valid ${task.role} result: ${validated.errors.join('; ')}`,
          );
        }
        result = validated.result;
      }

      store.calls.push({
        run_id: task.runId,
        role: task.role,
        repo: task.repo,
        attempt: task.attempt,
        at: input.now().toISOString(),
        status: failure === null ? status : 'failed',
        applied_patch: appliedPatch,
        wrote_reports: wroteReports,
      });
      writeFakeStore(paths.fakeDir, FAKE_AGENTS_FILE, store);

      return {
        runId: task.runId,
        status: failure === null ? status : 'failed',
        summary: outcomeSummary(result, failure),
        result,
        failure,
        tokens: scripted?.tokens ?? null,
        durationMs: scripted?.durationMs ?? 0,
        exitCode: failure === null ? 0 : null,
        signal: failure?.kind === 'timeout' ? 'SIGTERM' : null,
        timedOut: failure?.kind === 'timeout',
        runnerVersion: null,
        promptBytes: null,
        truncations: [],
        jsonlTruncated: false,
        stderrTruncated: false,
      };
    },
  };
}
