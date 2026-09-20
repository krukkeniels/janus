import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCodexAgentRunner } from '../../src/agents/codex/adapter.js';
import { spawnCodex } from '../../src/agents/codex/spawn.js';
import type { CodexSpawn } from '../../src/agents/codex/spawn.js';
import { configSchema } from '../../src/config/config-schema.js';
import { buildAgentTask } from '../../src/agents/task.js';
import { runGit } from '../../src/git/run.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { promptFixture } from '../helpers/agent-fixtures.js';
import { captureFixture, recordProbe } from '../helpers/codex-probe.js';
import { tempDir } from '../helpers/git-fixtures.js';

const ENABLED = process.env['JANUS_REAL_CODEX'] === '1';
const TEN_MINUTES = 600_000;

// `guardrails.max_agent_runtime_minutes` must be at least the largest default role timeout (60, spec §18.1's
// `implementation`/`review` defaults) or the schema's "role timeout may not exceed the ceiling" check
// (config-schema.ts) rejects every other role's default — this config only overrides the two roles the smoke
// test actually drives, so the ceiling has to stay high enough for the rest.
const config = configSchema.parse({
  workflow: { agent_runner: 'codex', ci_provider: 'fake', scm_provider: 'fake' },
  agents: { roles: { review: { timeout_minutes: 5 }, implementation: { timeout_minutes: 10 } } },
  guardrails: { max_agent_runtime_minutes: 60 },
});

const CONTEXT = {
  goal: 'Prove the Codex sandbox works on this machine',
  repository: null,
  planSlice: null,
  currentState: null,
  changeSummary: [],
  inlineDiff: null,
  verificationEvidence: null,
  previousAttempts: [],
  baselineExceptions: [],
};

/**
 * Spec §29 item 5 and `tasks.md` T05: "opt-in real-Codex smoke test (`JANUS_REAL_CODEX=1`) for a read-only echo
 * and a workspace-write scratch install". Skipped by default — CI has no `codex` binary and no Codex credentials.
 * Run it by hand: `JANUS_REAL_CODEX=1 pnpm test:integration`.
 */
describe.skipIf(!ENABLED)('real codex smoke test', () => {
  it(
    'answers a read-only task with a schema-valid result',
    async () => {
      const paths = workspacePaths(tempDir('janus-real-codex-ro-'));
      mkdirSync(paths.root, { recursive: true });
      const runner = createCodexAgentRunner({ paths });
      const task = buildAgentTask({
        runId: 'smoke-read-only',
        role: 'review',
        repo: null,
        attempt: 1,
        paths,
        config,
        profile: 'default',
        globalPnpmStore: null,
        context: {
          ...CONTEXT,
          planSlice: 'Answer with status "completed" and the single word "pong" as the summary. Change nothing.',
        },
        guardrails: [],
        budget: '(smoke test)',
      });
      expect(task.sandbox).toBe('read-only');

      const outcome = await runner.run(task, promptFixture(task));
      expect(outcome.failure, JSON.stringify(outcome.failure)).toBeNull();
      expect(outcome.status).toBe('completed');
      expect(outcome.result?.summary.length).toBeGreaterThan(0);
      expect(outcome.tokens?.input).toBeGreaterThan(0);
      expect(outcome.runnerVersion).not.toBeNull();
    },
    TEN_MINUTES,
  );

  it(
    'installs into a workspace-write scratch project and moves no git ref',
    async () => {
      const paths = workspacePaths(tempDir('janus-real-codex-ww-'));
      const repo = paths.repoDir('scratch');
      mkdirSync(repo, { recursive: true });
      mkdirSync(paths.pnpmStoreDir, { recursive: true });
      writeFileSync(
        join(repo, 'package.json'),
        `${JSON.stringify({ name: 'scratch', version: '0.0.0', private: true, dependencies: { 'is-odd': '3.0.1' } }, null, 2)}\n`,
      );
      await runGit(repo, ['init', '-q', '-b', 'main']);
      await runGit(repo, ['add', 'package.json']);
      await runGit(repo, ['commit', '-q', '-m', 'scratch']);
      const headBefore = await runGit(repo, ['rev-parse', 'HEAD']);

      const runner = createCodexAgentRunner({ paths });
      const task = buildAgentTask({
        runId: 'smoke-workspace-write',
        role: 'implementation',
        repo: 'scratch',
        attempt: 1,
        paths,
        config,
        profile: 'default',
        globalPnpmStore: null,
        context: {
          ...CONTEXT,
          planSlice: 'Run `pnpm install` in this directory so node_modules exists. Change nothing else. Do not commit.',
        },
        guardrails: [],
        budget: '(smoke test)',
      });
      expect(task.sandbox).toBe('workspace-write');
      expect(task.env['npm_config_store_dir']).toBe(paths.pnpmStoreDir);

      const outcome = await runner.run(task, promptFixture(task));
      expect(outcome.failure, JSON.stringify(outcome.failure)).toBeNull();
      expect(existsSync(join(repo, 'node_modules'))).toBe(true);
      // §32 rule 11: the agent edited the tree and moved nothing.
      expect(await runGit(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
      expect(await runGit(repo, ['reflog', 'show', '--format=%H', 'HEAD'])).toBe(headBefore);
    },
    TEN_MINUTES,
  );

  /**
   * T06 probe R1 (open question 2): what does the real `--json` stream look like, and does `parseCodexUsage` read
   * it correctly? Wraps the real `spawnCodex` so the stream can be kept, without adding anything to production.
   */
  it(
    'probe R1: captures a real JSONL stream and reports its turn.completed.usage keys',
    async () => {
      const paths = workspacePaths(tempDir('janus-probe-r1-'));
      const repo = paths.repoDir('scratch');
      mkdirSync(repo, { recursive: true });
      mkdirSync(paths.pnpmStoreDir, { recursive: true });
      writeFileSync(
        join(repo, 'package.json'),
        `${JSON.stringify({ name: 'scratch', version: '0.0.0', private: true, dependencies: { 'is-odd': '3.0.1' } }, null, 2)}\n`,
      );
      await runGit(repo, ['init', '-q', '-b', 'main']);
      await runGit(repo, ['add', 'package.json']);
      await runGit(repo, ['commit', '-q', '-m', 'scratch']);

      let captured = '';
      const capturing: CodexSpawn = async (request) => {
        const result = await spawnCodex(request);
        if (request.args[0] === 'exec') captured = result.jsonl;
        return result;
      };

      const runner = createCodexAgentRunner({ paths, spawn: capturing });
      const task = buildAgentTask({
        runId: 'probe-r1',
        role: 'implementation',
        repo: 'scratch',
        attempt: 1,
        paths,
        config,
        profile: 'default',
        globalPnpmStore: null,
        context: {
          ...CONTEXT,
          planSlice: 'Run `pnpm install` in this directory so node_modules exists. Change nothing else. Do not commit.',
        },
        guardrails: [],
        budget: '(probe R1)',
      });

      const outcome = await runner.run(task, promptFixture(task));
      expect(captured.length).toBeGreaterThan(0);

      const types: string[] = [];
      let usageKeys: string[] = [];
      let unparseable = 0;
      for (const line of captured.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          unparseable += 1;
          continue;
        }
        types.push(String(event['type']));
        if (event['type'] === 'turn.completed') {
          const usage = event['usage'];
          if (typeof usage === 'object' && usage !== null) usageKeys = Object.keys(usage as Record<string, unknown>);
        }
      }

      const fixture = captureFixture('real-workspace-write.jsonl', captured, { [paths.root]: '<workspace>' });
      recordProbe({
        probe: 'R1',
        question: 'What is the real shape of the codex --json stream and of turn.completed.usage?',
        outcome: 'observed',
        detail: `codex ${outcome.runnerVersion ?? 'unknown'}; ${String(types.length)} events, ${String(unparseable)} unparseable`,
        data: {
          event_types: [...new Set(types)].sort(),
          usage_keys: usageKeys,
          parsed_tokens: outcome.tokens,
          fixture_written: fixture,
        },
      });

      // What this plan was written against; a deviation is a finding, not a test bug — write it down before fixing it.
      expect(types).toContain('thread.started');
      expect(types).toContain('turn.completed');
      expect(usageKeys).toContain('input_tokens');
      expect(usageKeys).toContain('output_tokens');
      expect(outcome.tokens).not.toBeNull();
    },
    TEN_MINUTES,
  );
});
