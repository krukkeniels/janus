import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCodexAgentRunner } from '../../src/agents/codex/adapter.js';
import { spawnCodex } from '../../src/agents/codex/spawn.js';
import type { CodexSpawn } from '../../src/agents/codex/spawn.js';
import { configSchema } from '../../src/config/config-schema.js';
import type { AgentRole } from '../../src/config/config-schema.js';
import { buildAgentTask } from '../../src/agents/task.js';
import { isCodeWriting } from '../../src/agents/roles.js';
import { ALL_CHECKS, buildDoctorContext } from '../../src/doctor/index.js';
import { doctorJson, runDoctor } from '../../src/doctor/report.js';
import { runGit } from '../../src/git/run.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { promptFixture } from '../helpers/agent-fixtures.js';
import { captureFixture, recordProbe } from '../helpers/codex-probe.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { createHarness } from './harness/harness.js';

const ENABLED = process.env['JANUS_REAL_CODEX'] === '1';
const TEN_MINUTES = 600_000;
const FORTY_FIVE_MINUTES = 2_700_000;
const SPIKE_APP = process.env['JANUS_SPIKE_APP'] ?? join(homedir(), 'janus-spike', 'ng15-app');
const NODE18_BIN = process.env['JANUS_SPIKE_NODE18_BIN'] ?? join(homedir(), '.nvm', 'versions', 'node', 'v18.20.8', 'bin');

// `guardrails.max_agent_runtime_minutes` must be at least the largest default role timeout (60, spec §18.1's
// `implementation`/`review` defaults) or the schema's "role timeout may not exceed the ceiling" check
// (config-schema.ts) rejects every other role's default — this config only overrides the two roles the smoke
// test actually drives, so the ceiling has to stay high enough for the rest.
const config = configSchema.parse({
  workflow: { agent_runner: 'codex', ci_provider: 'fake', scm_provider: 'fake' },
  agents: { roles: { review: { timeout_minutes: 5 }, implementation: { timeout_minutes: 10 } } },
  guardrails: { max_agent_runtime_minutes: 60 },
});

/** A2 runs a real Angular major upgrade; 10 minutes is not enough and the §20 ceiling has to rise with it. */
const angularConfig = configSchema.parse({
  workflow: { agent_runner: 'codex', ci_provider: 'fake', scm_provider: 'fake' },
  agents: { roles: { implementation: { timeout_minutes: 45 } } },
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
 * A workspace shaped like a real one for the S2 probes: `.janus/` is a git checkout (§5, and probe S1a's finding),
 * `repos/ui-kit` is a tiny TypeScript library with one deliberate defect for the debug role, and `.pnpm-store`
 * exists so the code-writing plan's second writable root is real.
 */
async function spikeWorkspace(prefix: string): Promise<ReturnType<typeof workspacePaths>> {
  const paths = workspacePaths(tempDir(prefix));
  mkdirSync(paths.janusDir, { recursive: true });
  await runGit(paths.janusDir, ['init', '-q', '-b', 'janus/probe']);
  mkdirSync(paths.pnpmStoreDir, { recursive: true });

  const repo = paths.repoDir('ui-kit');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'ui-kit', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`,
  );
  // `sum` is wrong on purpose: the debug role gets a digest naming the failing test and must fix the source.
  writeFileSync(join(repo, 'src', 'sum.js'), 'export function sum(a, b) {\n  return a - b;\n}\n');
  writeFileSync(
    join(repo, 'src', 'sum.test.js'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert';",
      "import { sum } from './sum.js';",
      '',
      "test('sum adds', () => {",
      '  assert.strictEqual(sum(2, 3), 5);',
      '});',
      '',
    ].join('\n'),
  );
  await runGit(repo, ['init', '-q', '-b', 'main']);
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-q', '-m', 'ui-kit baseline']);
  return paths;
}

/** The four roles `tasks.md` T06 names, with the slice each one is given. */
const S2_ROLES: ReadonlyArray<{ role: AgentRole; planSlice: string; verificationEvidence: string | null }> = [
  {
    role: 'discovery',
    planSlice:
      'Survey ../../repos/ui-kit for an Angular major upgrade. Write one markdown file per area you were asked about into your working directory, naming the files you read.',
    verificationEvidence: null,
  },
  {
    role: 'planning',
    planSlice:
      'Write plan.md and plan.yaml into your working directory for upgrading ../../repos/ui-kit one major version. One work package, with an allowed_scope wide enough for CLI migrations and the lockfile.',
    verificationEvidence: null,
  },
  {
    role: 'implementation',
    planSlice: 'wp-01-ui-kit: add a `product(a, b)` function to src/sum.js and a test for it in src/sum.test.js. Change nothing else.',
    verificationEvidence: null,
  },
  {
    role: 'debug',
    planSlice: 'wp-01-ui-kit: the test below fails. Find the cause and fix the source, not the test.',
    verificationEvidence: [
      'build: ui-kit #41, status FAILURE, classification tests_failed',
      'failed test: src/sum.test.js > sum adds',
      "  AssertionError: Expected values to be strictly equal: -1 !== 5",
      '    at src/sum.test.js:6:10',
    ].join('\n'),
  },
];

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

      // T06 Task 3 flagged that this run's token usage was not recorded anywhere observable outside the
      // process (task-3-report.md, "Concerns / notes for the controller"). This is the same real-Codex turn
      // the assertions below already pay for — recording it here closes that gap without a second invocation,
      // so the read-only sandbox class is not a hole in the probe log's cost picture alongside S2's four roles.
      recordProbe({
        probe: 'S2-read-only',
        question: 'What does a read-only-class turn cost (§3.3 checkpoint/review/triage), for comparison with S2 report-writing/code-writing roles?',
        outcome: outcome.failure === null ? 'observed' : 'fail',
        detail: outcome.failure === null ? outcome.summary : `${outcome.failure.kind}: ${outcome.failure.detail}`,
        data: {
          role: 'review',
          sandbox_class: task.sandboxClass,
          sandbox: task.sandbox,
          model: task.model.model,
          effort: task.model.effort,
          status: outcome.status,
          tokens: outcome.tokens,
          duration_ms: outcome.durationMs,
        },
      });

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

  /**
   * T06 probe R2 (open question 1): does real Codex refuse a read-only run outside a git work tree, and which of
   * the three weighed options fixes it? Raw `spawnCodex` on purpose: this probes the binary, not the adapter, and
   * a refusal happens before any model call so all four variants together cost at most two cheap turns.
   */
  it(
    'probe R2: reports whether codex refuses a read-only run outside a git repository',
    async () => {
      const plain = tempDir('janus-probe-r2-plain-');
      const initialized = tempDir('janus-probe-r2-git-');
      mkdirSync(plain, { recursive: true });
      mkdirSync(initialized, { recursive: true });
      await runGit(initialized, ['init', '-q', '-b', 'main']);

      const readOnly = async (cwd: string, extra: string[]): Promise<{ exitCode: number | null; stderr: string }> => {
        const result = await spawnCodex({
          bin: 'codex',
          args: ['exec', '-C', cwd, '-s', 'read-only', ...extra, '--ephemeral', '-'],
          cwd,
          env: { ...process.env } as Record<string, string>,
          stdin: 'Reply with the single word pong and nothing else.',
          timeoutMs: 120_000,
        });
        return { exitCode: result.exitCode, stderr: result.stderr.trim().split('\n')[0] ?? '' };
      };

      const bare = await readOnly(plain, []);
      const withFlag = await readOnly(plain, ['--skip-git-repo-check']);
      const inRepo = await readOnly(initialized, []);
      const trusted = await readOnly(plain, ['-c', `projects."${plain}".trust_level="trusted"`]);

      recordProbe({
        probe: 'R2',
        question: 'Does codex exec -s read-only refuse outside a git work tree, and what fixes it?',
        outcome: bare.exitCode === 0 ? 'pass' : 'fail',
        detail: `bare exit ${String(bare.exitCode)}: ${bare.stderr}`,
        data: {
          bare_exit: bare.exitCode,
          bare_stderr_first_line: bare.stderr,
          with_skip_flag_exit: withFlag.exitCode,
          in_git_repo_exit: inRepo.exitCode,
          trust_level_override_exit: trusted.exitCode,
        },
      });

      // The state this plan was written against. If any of these now differs, the §18.4 ruling must be revisited
      // before Step 5 — say so in the report and stop.
      expect(bare.exitCode).not.toBe(0);
      expect(bare.stderr).toContain('--skip-git-repo-check');
      expect(withFlag.exitCode).toBe(0);
      expect(inRepo.exitCode).toBe(0);
      expect(trusted.exitCode).not.toBe(0);
    },
    TEN_MINUTES,
  );

  /**
   * T06 probe S1a: a report-writing role (§3.3) under `workspace-write`, network off, cwd
   * `.janus/reports/<run-id>/`, that directory its only writable root. Also records whether that cwd passes
   * Codex's git-work-tree check — it does in production because `.janus` is a single-branch clone (§5), so the
   * probe builds it as one.
   */
  it(
    'probe S1a: a report-writing agent writes into its report directory and nowhere else',
    async () => {
      const paths = workspacePaths(tempDir('janus-probe-s1a-'));
      mkdirSync(paths.janusDir, { recursive: true });
      // Mirrors §5: `.janus/` is a git checkout in every real workspace.
      await runGit(paths.janusDir, ['init', '-q', '-b', 'janus/probe']);
      const sibling = paths.repoDir('ui-kit');
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, 'package.json'), `${JSON.stringify({ name: 'ui-kit', version: '1.0.0' }, null, 2)}\n`);

      const runner = createCodexAgentRunner({ paths });
      const task = buildAgentTask({
        runId: 'probe-s1a',
        role: 'discovery',
        repo: null,
        attempt: 1,
        paths,
        config,
        profile: 'default',
        globalPnpmStore: null,
        context: {
          ...CONTEXT,
          goal: 'Survey ui-kit for an Angular major upgrade',
          planSlice:
            'Read ../../repos/ui-kit/package.json, then write a file named deps-and-build.md in your working directory whose first line is "# deps-and-build". Do not create any other file.',
        },
        guardrails: [],
        budget: '(probe S1a)',
      });
      expect(task.cwd).toBe(join(paths.janusDir, 'reports', 'probe-s1a'));
      expect(task.writableRoots).toEqual([task.cwd]);
      expect(task.network).toBe(false);
      expect(task.skipGitRepoCheck).toBe(false);
      mkdirSync(task.cwd, { recursive: true });

      const outcome = await runner.run(task, promptFixture(task));
      const report = join(task.cwd, 'deps-and-build.md');
      const wroteReport = existsSync(report);
      const escaped = existsSync(join(sibling, 'deps-and-build.md'));

      recordProbe({
        probe: 'S1a',
        question: 'Does a report-writing role write into .janus/reports/<run-id>/ under workspace-write with network off?',
        outcome: wroteReport && !escaped && outcome.failure === null ? 'pass' : 'fail',
        detail: outcome.failure === null ? outcome.summary : `${outcome.failure.kind}: ${outcome.failure.detail}`,
        data: {
          wrote_report: wroteReport,
          wrote_outside_report_dir: escaped,
          could_read_sibling_repo: outcome.result?.summary.toLowerCase().includes('ui-kit') ?? false,
          tokens: outcome.tokens,
          duration_ms: outcome.durationMs,
        },
      });

      expect(outcome.failure, JSON.stringify(outcome.failure)).toBeNull();
      expect(wroteReport).toBe(true);
      expect(escaped).toBe(false);
    },
    TEN_MINUTES,
  );

  /**
   * T06 probe S1b: §18.4's default — "Janus sets `npm_config_store_dir=<workspace>/.pnpm-store` in every
   * code-writing agent's environment so a single writable root suffices ... No `.npmrc` is written, because pnpm
   * reads `.npmrc` only from a project root."
   */
  it(
    'probe S1b: a code-writing agent installs through the workspace pnpm store and writes no .npmrc',
    async () => {
      const paths = workspacePaths(tempDir('janus-probe-s1b-'));
      const repo = paths.repoDir('scratch');
      mkdirSync(repo, { recursive: true });
      mkdirSync(paths.pnpmStoreDir, { recursive: true });
      writeFileSync(
        join(repo, 'package.json'),
        `${JSON.stringify(
          { name: 'scratch', version: '0.0.0', private: true, dependencies: { 'is-odd': '3.0.1', 'is-even': '1.0.0' } },
          null,
          2,
        )}\n`,
      );
      await runGit(repo, ['init', '-q', '-b', 'main']);
      await runGit(repo, ['add', 'package.json']);
      await runGit(repo, ['commit', '-q', '-m', 'scratch']);
      const headBefore = await runGit(repo, ['rev-parse', 'HEAD']);

      const runner = createCodexAgentRunner({ paths });
      const task = buildAgentTask({
        runId: 'probe-s1b',
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
        budget: '(probe S1b)',
      });
      expect(task.env['npm_config_store_dir']).toBe(paths.pnpmStoreDir);
      expect(task.writableRoots).toEqual([repo, paths.pnpmStoreDir]);

      const outcome = await runner.run(task, promptFixture(task));
      const storeEntries = existsSync(paths.pnpmStoreDir) ? readdirSync(paths.pnpmStoreDir) : [];
      const npmrcInRepo = existsSync(join(repo, '.npmrc'));
      const npmrcInWorkspace = existsSync(join(paths.root, '.npmrc'));

      recordProbe({
        probe: 'S1b',
        question: 'Does npm_config_store_dir alone make the workspace store the single extra writable root, with no .npmrc?',
        outcome: storeEntries.length > 0 && !npmrcInRepo && !npmrcInWorkspace ? 'pass' : 'fail',
        detail: outcome.failure === null ? outcome.summary : `${outcome.failure.kind}: ${outcome.failure.detail}`,
        data: {
          store_entries: storeEntries.length,
          npmrc_in_repo: npmrcInRepo,
          npmrc_in_workspace: npmrcInWorkspace,
          node_modules: existsSync(join(repo, 'node_modules')),
          tokens: outcome.tokens,
          duration_ms: outcome.durationMs,
        },
      });

      expect(outcome.failure, JSON.stringify(outcome.failure)).toBeNull();
      expect(existsSync(join(repo, 'node_modules'))).toBe(true);
      expect(storeEntries.length).toBeGreaterThan(0);
      expect(npmrcInRepo).toBe(false);
      expect(npmrcInWorkspace).toBe(false);
      // §32 rule 11 again, on a run that really did install packages.
      expect(await runGit(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    },
    TEN_MINUTES,
  );

  /**
   * T06 probe A2: can a code-writing agent, inside the T05 sandbox plan, run the Angular 15 -> 16 upgrade on a
   * dirty tree? Uses a copy of the spike app so the pristine one stays reusable, and prepends Node 18 to PATH
   * because Angular CLI 15 refuses Node 24 (`^14.20 || ^16.14 || ^18.10`).
   */
  it(
    'probe A2: a code-writing agent runs ng update --allow-dirty and leaves the tree dirty and uncommitted',
    async () => {
      if (!existsSync(SPIKE_APP) || !existsSync(NODE18_BIN)) {
        recordProbe({
          probe: 'A2',
          question: 'Can a code-writing agent run ng update --allow-dirty inside the sandbox plan?',
          outcome: 'fail',
          detail: `missing prerequisite: app=${SPIKE_APP} exists=${String(existsSync(SPIKE_APP))}, node18=${NODE18_BIN} exists=${String(existsSync(NODE18_BIN))}`,
          data: {},
        });
        throw new Error(`probe A2 needs ${SPIKE_APP} and ${NODE18_BIN}; see docs/spikes/prompt-spike.md runbook`);
      }

      const paths = workspacePaths(tempDir('janus-probe-a2-'));
      const repo = paths.repoDir('ng15-app');
      mkdirSync(paths.reposDir, { recursive: true });
      mkdirSync(paths.pnpmStoreDir, { recursive: true });
      cpSync(SPIKE_APP, repo, {
        recursive: true,
        filter: (src) => !/[/\\](node_modules|\.angular|dist|\.git)([/\\]|$)/u.test(src),
      });
      await runGit(repo, ['init', '-q', '-b', 'main']);
      await runGit(repo, ['add', '-A']);
      await runGit(repo, ['commit', '-q', '-m', 'spike baseline']);
      // §18.4: the tree is intentionally uncommitted when an agent starts.
      writeFileSync(join(repo, 'src', 'main.ts'), `${readFileSync(join(repo, 'src', 'main.ts'), 'utf8')}\n// janus spike: intentionally uncommitted\n`);
      const headBefore = await runGit(repo, ['rev-parse', 'HEAD']);

      const previousPath = process.env['PATH'] ?? '';
      process.env['PATH'] = `${NODE18_BIN}:${previousPath}`;
      let outcome;
      try {
        const runner = createCodexAgentRunner({ paths });
        const task = buildAgentTask({
          runId: 'probe-a2',
          role: 'implementation',
          repo: 'ng15-app',
          attempt: 1,
          paths,
          config: angularConfig,
          profile: 'default',
          globalPnpmStore: null,
          context: {
            ...CONTEXT,
            goal: 'Upgrade this application from Angular 15 to Angular 16',
            repository: 'ng15-app (application), base branch main, no dependencies',
            planSlice:
              'wp-01-ng15-app-angular16: run `pnpm install`, then `npx ng update @angular/core@16 @angular/cli@16 --allow-dirty`, then `npx ng build`. Report every file the migration changed. Change nothing beyond what the migration changes plus whatever `ng build` needs to pass.',
          },
          guardrails: ['files outside this repository are out of scope'],
          budget: '(probe A2)',
        });
        expect(task.timeoutMinutes).toBe(45);
        outcome = await runner.run(task, promptFixture(task));
      } finally {
        process.env['PATH'] = previousPath;
      }

      const status = await runGit(repo, ['status', '--porcelain']);
      const changedFiles = status.split('\n').filter((line) => line.trim() !== '').length;
      const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
      const core = pkg.dependencies?.['@angular/core'] ?? '(absent)';

      recordProbe({
        probe: 'A2',
        question: 'Can a code-writing agent run ng update --allow-dirty inside the sandbox plan?',
        outcome: outcome.failure === null && core.includes('16') ? 'pass' : 'fail',
        detail: outcome.failure === null ? outcome.summary : `${outcome.failure.kind}: ${outcome.failure.detail}`,
        data: {
          angular_core_after: core,
          changed_files: changedFiles,
          changes_made_reported: outcome.result?.changes_made.length ?? null,
          status_completed: outcome.status,
          tokens: outcome.tokens,
          duration_ms: outcome.durationMs,
          head_moved: (await runGit(repo, ['rev-parse', 'HEAD'])) !== headBefore,
        },
      });

      expect(outcome.failure, JSON.stringify(outcome.failure)).toBeNull();
      expect(core).toContain('16');
      expect(changedFiles).toBeGreaterThan(1);
      // §32 rule 11, on the most realistic run in the whole spike.
      expect(await runGit(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
      expect(await runGit(repo, ['reflog', 'show', '--format=%H', 'HEAD'])).toBe(headBefore);
    },
    FORTY_FIVE_MINUTES,
  );

  /**
   * T06 probe S2: does each role answer with a result that passes its generated §18.3 schema, and what does a
   * turn cost? Four separate `it`s (via `it.each`) so one role's failure does not hide the other three, and so a
   * single role can be re-run with `-t 'probe S2: debug'`.
   */
  it.each(S2_ROLES)(
    'probe S2: $role answers a schema-valid result and its cost is recorded',
    async ({ role, planSlice, verificationEvidence }) => {
      const paths = await spikeWorkspace(`janus-probe-s2-${role}-`);
      const repo = isCodeWriting(role) ? 'ui-kit' : null;
      const runner = createCodexAgentRunner({ paths });
      const task = buildAgentTask({
        runId: `probe-s2-${role}`,
        role,
        repo,
        attempt: 1,
        paths,
        config,
        profile: 'default',
        globalPnpmStore: null,
        context: {
          ...CONTEXT,
          goal: 'Upgrade ui-kit one Angular major version',
          repository: repo === null ? null : 'ui-kit (library), base branch main, no dependencies',
          planSlice,
          verificationEvidence,
          changeSummary: role === 'debug' ? [{ path: 'src/sum.js', added: 1, removed: 1, generated: false }] : [],
        },
        guardrails: ['files outside this repository are out of scope'],
        budget: 'ci_fix_attempts: 0 of 5',
      });
      if (task.sandboxClass === 'report-writing') mkdirSync(task.cwd, { recursive: true });
      const prompt = promptFixture(task);

      const outcome = await runner.run(task, prompt);
      const result = outcome.result;

      recordProbe({
        probe: `S2-${role}`,
        question: 'Does this role answer with a schema-valid §18.3 result, and what does one turn cost?',
        outcome: outcome.failure === null && result !== null ? 'pass' : 'fail',
        detail: outcome.failure === null ? outcome.summary : `${outcome.failure.kind}: ${outcome.failure.detail}`,
        data: {
          role,
          sandbox_class: task.sandboxClass,
          sandbox: task.sandbox,
          model: task.model.model,
          effort: task.model.effort,
          prompt_version: task.promptVersion,
          prompt_bytes: prompt.bytes,
          truncations: prompt.truncations,
          schema_valid: outcome.failure?.kind !== 'invalid_output',
          status: outcome.status,
          changes_made: result?.changes_made.length ?? null,
          findings: result?.findings.length ?? null,
          expected_temporary_failure: result?.expected_temporary_failure ?? null,
          handover_present: result?.handover !== undefined,
          tokens: outcome.tokens,
          duration_ms: outcome.durationMs,
        },
      });

      // An `invalid_output` failure is the finding this probe exists to catch: keep the detail, which carries the
      // exact zod messages `validateAgentResult` produced, and let the test fail loudly.
      expect(outcome.failure, JSON.stringify(outcome.failure)).toBeNull();
      expect(result).not.toBeNull();
      expect(result?.handover.next_action.length).toBeGreaterThan(0);
      expect(outcome.tokens?.total).toBeGreaterThan(0);
    },
    FORTY_FIVE_MINUTES,
  );

  /**
   * T07 probe D1: `janus doctor`'s real registry against a real fake-provider workspace. Everything that can pass
   * on this machine must pass.
   *
   * `state.branch_spec` is a `pass`, not a `warn`: `graphFixture` (`tests/helpers/workspace-fixtures.ts`) always
   * writes `state: { clone_url: stateBare }` into the harness's `config.yaml`, so `stateRemote` resolves to a
   * dedicated state repository (`remoteName: 'state-repo'`) — this was an incorrect assumption in the original
   * plan (it expected the harness to have no dedicated state repo), caught by actually running the real registry
   * end to end here, exactly the kind of integration-level surprise T07 was written to expect. Doctor itself is
   * correct: it reports what `stateRemote` actually resolves to. `codex.probe.ng_update` and the provider checks
   * still skip, because this harness has no Angular repository and both providers are fakes.
   */
  it(
    'probe D1: janus doctor reports no failure in a fake-provider workspace',
    async () => {
      const harness = await createHarness([{ name: 'ui-kit', kind: 'library' as const }], {});
      const report = await runDoctor(ALL_CHECKS, buildDoctorContext({ cwd: harness.root, env: process.env, now: () => new Date() }));

      const byId = new Map(report.checks.map((finding) => [finding.id, finding]));
      recordProbe({
        probe: 'D1',
        question: 'Does janus doctor pass on this machine against a fake-provider workspace?',
        outcome: report.summary.fail === 0 ? 'pass' : 'fail',
        detail: `${String(report.summary.pass)} ok, ${String(report.summary.warn)} warn, ${String(report.summary.fail)} fail, ${String(report.summary.skip)} skip`,
        data: { statuses: Object.fromEntries([...byId].map(([id, finding]) => [id, finding.status])) },
      });

      expect(byId.get('codex.binary')?.status).toBe('pass');
      expect(byId.get('codex.login')?.status).toBe('pass');
      expect(byId.get('codex.probe.read_only')?.status).toBe('pass');
      expect(byId.get('codex.probe.workspace_write')?.status).toBe('pass');
      expect(byId.get('pnpm.store')?.status).toBe('pass');
      // graphFixture always gives the harness a dedicated state repo (see the doc comment above).
      expect(byId.get('state.branch_spec')?.status).toBe('pass');
      expect(byId.get('codex.probe.ng_update')?.status).toBe('skip');
      expect(byId.get('provider.ci')?.status).toBe('skip');
      expect(byId.get('provider.scm')?.status).toBe('skip');
      expect(report.summary.fail, doctorJson(report)).toBe(0);
    },
    FORTY_FIVE_MINUTES,
  );
});
