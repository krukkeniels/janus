import { ConfigError } from '../../config/errors.js';
import { formatIdentity, parseIdent } from '../../git/identity.js';
import { stateBranchName, stateRemote } from '../../workspace/remotes.js';
import { skipped } from '../types.js';
import type { DoctorCheck, DoctorObservation } from '../types.js';
import { lastLine } from './codex.js';

const GIT_TIMEOUT_MS = 15_000;
const NO_WORKSPACE = 'run janus doctor from inside a janus workspace, or run janus init first';

/**
 * Spec §8: approvals are attributed to the git committer identity, and §2 of the checkpoint rule commits on the
 * state branch as that identity. `git var GIT_COMMITTER_IDENT` is what git itself resolves, so it covers
 * `user.name`/`user.email` and the `GIT_COMMITTER_*` environment overrides in one call.
 */
export const gitIdentityCheck: DoctorCheck = {
  id: 'git.identity',
  title: 'git knows who you are',
  run: async (ctx) => {
    const cwd = ctx.paths?.root ?? '.';
    const result = await ctx.run({ bin: 'git', args: ['var', 'GIT_COMMITTER_IDENT'], cwd, timeoutMs: GIT_TIMEOUT_MS });
    const remediation =
      'set both: git config --global user.name "Your Name" && git config --global user.email "you@example.com"';
    if (result.spawnFailed || result.exitCode !== 0) {
      return [
        {
          id: 'git.identity',
          title: gitIdentityCheck.title,
          status: 'fail',
          detail: result.spawnFailed ? 'git is not on PATH' : lastLine(result.stderr) || `git var exited ${String(result.exitCode)}`,
          remediation: result.spawnFailed ? 'install git and put it on PATH' : remediation,
        },
      ];
    }
    const identity = parseIdent(result.stdout.trim());
    if (identity === null) {
      return [
        {
          id: 'git.identity',
          title: gitIdentityCheck.title,
          status: 'fail',
          detail: `git var GIT_COMMITTER_IDENT printed something unparseable: ${result.stdout.trim()}`,
          remediation,
        },
      ];
    }
    return [{ id: 'git.identity', title: gitIdentityCheck.title, status: 'pass', detail: formatIdentity(identity), remediation: null }];
  },
};

/**
 * Spec §28: "Secrets: `JANUS_TEAMCITY_TOKEN`, `JANUS_BITBUCKET_TOKEN`." Only the variables the **configured**
 * providers actually need are checked — a fake-provider workspace needs none, which is how Janus is developed.
 *
 * §32 rule 12: the finding reports the variable **name** and whether it is set. It never reports the value, its
 * length, or any prefix of it.
 */
export const tokensCheck: DoctorCheck = {
  id: 'tokens',
  title: 'the tokens the configured providers need are present',
  run: async (ctx) => {
    if (ctx.config === null) {
      return [skipped('tokens', tokensCheck.title, 'no config.yaml: doctor is not running inside a workspace', NO_WORKSPACE)];
    }
    const required: Array<{ variable: string; why: string }> = [];
    if (ctx.config.workflow.ci_provider === 'teamcity') {
      required.push({ variable: ctx.config.teamcity.token_env, why: 'workflow.ci_provider is "teamcity"' });
    }
    if (ctx.config.workflow.scm_provider === 'bitbucket-server') {
      required.push({ variable: ctx.config.bitbucket.token_env, why: 'workflow.scm_provider is "bitbucket-server"' });
    }
    if (required.length === 0) {
      return [
        skipped(
          'tokens',
          tokensCheck.title,
          `no token is required: ci_provider is "${ctx.config.workflow.ci_provider}" and scm_provider is "${ctx.config.workflow.scm_provider}"`,
          'nothing to do; tokens become required when a real provider is configured (§28)',
        ),
      ];
    }
    const findings: DoctorObservation[] = [];
    for (const { variable, why } of required) {
      const value = ctx.env[variable];
      const present = value !== undefined && value.trim() !== '';
      findings.push({
        id: `tokens[${variable}]`,
        title: `${variable} is set`,
        status: present ? 'pass' : 'fail',
        detail: present ? `set (${why})` : `not set, and it is required because ${why}`,
        remediation: present ? null : `export ${variable}=<your access token> in the shell that runs janus; it is never written to .janus/ (§28, §32 rule 12)`,
      });
    }
    return findings;
  },
};

/**
 * Spec §33: "The VCS root branch spec includes `ai/*` and excludes `janus/*`." §31 item 33: doctor detects "a
 * missing `janus/*` branch exclusion".
 *
 * Janus cannot read a VCS root's branch spec — TeamCity is a work-network system and the §3.2 `CiProvider`
 * interface has no call for it. What it can see is the condition that makes the exclusion necessary: the state
 * branch living inside a product repository, so every checkpoint pushes a `janus/<goal-id>` branch into a
 * repository whose CI watches branches. That is a `warn`, with both remedies named.
 */
export const branchSpecCheck: DoctorCheck = {
  id: 'state.branch_spec',
  title: 'the state branch will not trigger product CI',
  run: async (ctx) => {
    if (ctx.config === null || ctx.goal === null) {
      return [skipped('state.branch_spec', branchSpecCheck.title, 'no config.yaml or goal.yaml: doctor is not running inside a workspace', NO_WORKSPACE)];
    }
    const branch = stateBranchName(ctx.goal.id);
    let remote;
    try {
      remote = stateRemote(ctx.goal, ctx.config);
    } catch (error) {
      const detail = error instanceof ConfigError ? error.message : error instanceof Error ? error.message : String(error);
      return [
        {
          id: 'state.branch_spec',
          title: branchSpecCheck.title,
          status: 'warn',
          detail: `cannot tell where the state branch lives: ${detail}`,
          remediation: 'set state.clone_url (or state.repo plus bitbucket.url) in .janus/config.yaml so the state remote resolves (§28)',
        },
      ];
    }
    if (remote.remoteName === 'state-repo') {
      return [
        {
          id: 'state.branch_spec',
          title: branchSpecCheck.title,
          status: 'pass',
          detail: `the state branch ${branch} lives in the dedicated state repository ${remote.url}`,
          remediation: null,
        },
      ];
    }
    return [
      {
        id: 'state.branch_spec',
        title: branchSpecCheck.title,
        status: 'warn',
        detail: `the state branch ${branch} lives in the product repository ${remote.remoteName}, whose CI watches branches`,
        remediation: `exclude janus/* from that repository's VCS root branch spec, keeping ai/* included (needs edit access to that shared CI config) — or give the goal a dedicated state repository via state.repo / state.clone_url in .janus/config.yaml (a new repo to create and own, but no shared CI config to touch) (§33)`,
      },
    ];
  },
};
