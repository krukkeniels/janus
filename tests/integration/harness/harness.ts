import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { CliOverrides } from '../../../src/cli/context.js';
import { ExitCode } from '../../../src/cli/exit-codes.js';
import { remoteHead, revParse } from '../../../src/git/ops.js';
import { createFakeAgentRunner, seedFakeAgents } from '../../../src/providers/fake/agent-runner.js';
import type { FakeAgentStore } from '../../../src/providers/fake/agent-runner.js';
import { createFakeCiProvider } from '../../../src/providers/fake/ci.js';
import { createFakeScmProvider } from '../../../src/providers/fake/scm.js';
import type { AgentRunner, Providers } from '../../../src/providers/types.js';
import { EVIDENCE_DIR } from '../../../src/state/files.js';
import type { JanusState } from '../../../src/state/state-schema.js';
import { readState } from '../../../src/state/state-store.js';
import { readEvents } from '../../../src/telemetry/events.js';
import type { RecordedEvent } from '../../../src/telemetry/events.js';
import { workspacePaths } from '../../../src/workspace/layout.js';
import { stateBranchName } from '../../../src/workspace/remotes.js';
import { tempDir } from '../../helpers/git-fixtures.js';
import { runCli } from '../../helpers/run-cli.js';
import type { CliResult } from '../../helpers/run-cli.js';
import { graphFixture } from '../../helpers/workspace-fixtures.js';
import type { GraphFixture, RepoGraphSpec } from '../../helpers/workspace-fixtures.js';
import { auditAgentRunner, formatGitWrites } from './git-audit.js';
import type { AgentGitWrite, AuditTarget } from './git-audit.js';

export interface HarnessOptions {
  goalId?: string;
  /** Seeds `fake/agents.json` (spec §18.5) before the first run. */
  agents?: FakeAgentStore['script'];
  /** Fixed clock for the fakes, so their persisted stores are deterministic. */
  now?: () => Date;
  /** Replaces the fake agent runner; the audit wrapper is applied to whatever is passed. */
  agentRunner?: AgentRunner;
  /**
   * Opts this harness out of the automatic §31.29 check, for a test that deliberately makes an agent write.
   * Everything else gets the check for free, so forgetting `expectNoAgentGitWrites` cannot silently drop it.
   */
  expectAgentGitWrites?: true;
}

export interface Harness {
  fixture: GraphFixture;
  root: string;
  janusDir: string;
  fakeDir: string;
  stateBranch: string;
  /** The audited provider bag the CLI is given on every `run`. */
  providers: Providers;
  /** Spec §31.29: git writes observed while an agent was in flight. Empty on a healthy run. */
  agentGitWrites: AgentGitWrite[];
  auditTargets: AuditTarget[];
  /**
   * Runs the CLI in the workspace with the audited providers injected.
   *
   * `providers` is deliberately not overridable: replacing the bag here would swap out the audited agent runner,
   * and every §31.29 check after it would pass without auditing anything. Supply a custom runner through
   * `HarnessOptions.agentRunner` instead, which is wrapped by the audit.
   */
  run(argv: string[], overrides?: Omit<CliOverrides, 'providers'>): Promise<CliResult>;
  state(): JanusState;
  events(): RecordedEvent[];
  /** Reads `.janus/evidence/<relativePath>`, failing with the directory listing when it is missing. */
  evidence(relativePath: string): string;
  cleanup(): void;
}

/**
 * Spec §29 item 3: a goal workspace built from N temporary git repositories with a `depends_on` graph, a bare
 * remote per repo, a bare state remote, and the persisted fakes, with every `AgentRunner.run()` bracketed by the
 * §31.29 reflog audit. `janus init` has already run when this resolves.
 *
 * Audit target labels: product repos are `repos/<name>`, their remotes are `remote:<name>`, the state checkout is
 * `.janus`, and the state remote is `state-remote` — deliberately outside the `remote:<name>` namespace, so a
 * product repo literally named `state` (whose remote label would be `remote:state`) can never collide with it.
 * `captureRefLogs` throws `duplicate audit target label: <label>` on a collision, so labels must stay unique by
 * construction, not by convention.
 */
export async function createHarness(specs: RepoGraphSpec[], options: HarnessOptions = {}): Promise<Harness> {
  const fixture = await graphFixture(specs, options.goalId === undefined ? {} : { goalId: options.goalId });
  const workspaceParent = tempDir('janus-harness-');

  // Registered immediately after the only two temp-resource-creating calls above, and before any fallible setup
  // step (`janus init`, `workspacePaths`, the audit target build), so a thrown error during setup still leaves
  // vitest holding a cleanup callback for this test — nothing created so far is left on disk.
  const cleanup = (): void => {
    if (process.env['JANUS_KEEP_TMP'] === '1') return;
    for (const dir of [workspaceParent, ...fixture.tempRoots]) {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  onTestFinished(() => {
    cleanup();
  });

  const root = join(workspaceParent, 'ws');
  const init = await runCli(['init', '--goal', fixture.goalPath, '--workspace', root]);
  if (init.code !== ExitCode.Ok) {
    throw new Error(`harness: janus init failed (${init.code})\n${init.stdout}\n${init.stderr}`);
  }

  const paths = workspacePaths(root);
  const now = options.now ?? (() => new Date());
  if (options.agents !== undefined) seedFakeAgents(paths.fakeDir, options.agents);

  const auditTargets: AuditTarget[] = [
    { label: '.janus', dir: paths.janusDir },
    ...fixture.names.map((name) => ({ label: `repos/${name}`, dir: paths.repoDir(name) })),
    ...fixture.names.map((name) => {
      const remote = fixture.repos[name];
      if (remote === undefined) throw new Error(`harness: no remote for ${name}`);
      return { label: `remote:${name}`, dir: remote.bare };
    }),
    { label: 'state-remote', dir: fixture.stateBare },
  ];

  const agentGitWrites: AgentGitWrite[] = [];
  if (options.expectAgentGitWrites !== true) {
    // Spec §31.29 holds by default, not when a test remembers to ask for it. Registered AFTER the cleanup
    // callback above: vitest runs `onTestFinished` callbacks last-registered-first, so this one reports while the
    // workspace is still on disk (the message itself only needs the labels and shas already in `agentGitWrites`).
    onTestFinished(() => {
      assertNoAgentGitWrites(agentGitWrites);
    });
  }
  const inner = options.agentRunner ?? createFakeAgentRunner({ fakeDir: paths.fakeDir, now });
  const providers: Providers = {
    agent: auditAgentRunner(inner, auditTargets, agentGitWrites),
    ci: createFakeCiProvider({ fakeDir: paths.fakeDir, now }),
    scm: createFakeScmProvider({ fakeDir: paths.fakeDir, now }),
  };

  const harness: Harness = {
    fixture,
    root: paths.root,
    janusDir: paths.janusDir,
    fakeDir: paths.fakeDir,
    stateBranch: stateBranchName(fixture.goalId),
    providers,
    agentGitWrites,
    auditTargets,
    run: (argv, overrides = {}) => runCli(argv, { cwd: paths.root }, { providers, ...overrides }),
    state: () => readState(paths.janusDir),
    events: () => readEvents(paths.janusDir),
    evidence: (relativePath) => {
      const path = join(paths.janusDir, EVIDENCE_DIR, relativePath);
      if (!existsSync(path)) {
        const dir = dirname(path);
        const listing = existsSync(dir) ? readdirSync(dir).join(', ') : '(the directory does not exist)';
        throw new Error(`no evidence file ${relativePath}; ${dir} holds: ${listing}`);
      }
      return readFileSync(path, 'utf8');
    },
    cleanup,
  };
  return harness;
}

function assertNoAgentGitWrites(writes: readonly AgentGitWrite[]): void {
  if (writes.length === 0) return;
  throw new Error(
    `spec §31.29 violated: ${writes.length} git ref update(s) happened while an agent was running:\n${formatGitWrites(writes)}`,
  );
}

/**
 * Spec §31.29: fails with every offending reflog entry when any agent performed a git write.
 *
 * `createHarness` already runs this check when the test finishes, unless `expectAgentGitWrites` opted out; this
 * stays exported so a test can assert the property at a specific point, or name it for the reader.
 */
export function expectNoAgentGitWrites(harness: Harness): void {
  assertNoAgentGitWrites(harness.agentGitWrites);
}

/** Spec §7: the state branch checkout and its bare remote are at the same commit. */
export async function expectStatePushed(harness: Harness): Promise<void> {
  const head = await revParse(harness.janusDir, 'HEAD');
  const remote = await remoteHead(harness.janusDir, 'origin', harness.stateBranch);
  if (remote !== head) {
    throw new Error(`state branch ${harness.stateBranch}: local HEAD ${head} but remote ${remote ?? '(absent)'}`);
  }
}
