import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { goalSchema } from '../../src/config/goal-schema.js';
import { branchSpecCheck, gitIdentityCheck, tokensCheck } from '../../src/doctor/checks/repo.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { doctorContext, stubRunner } from '../helpers/doctor-fixtures.js';
import { validGoal } from '../fixtures/valid-goal.js';

const goal = goalSchema.parse(validGoal);
const paths = workspacePaths('/tmp/janus-doctor-repo');

describe('gitIdentityCheck', () => {
  it('passes and reports the identity git resolved', async () => {
    const ctx = doctorContext({
      run: stubRunner([{ match: (r) => r.bin === 'git', result: { stdout: 'Martin <martin@example.com> 1758369600 +0200\n' } }]),
    });
    const [finding] = await gitIdentityCheck.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(finding?.detail).toBe('Martin <martin@example.com>');
  });

  it("fails when git cannot tell who you are, and names both config keys", async () => {
    const ctx = doctorContext({
      run: stubRunner([
        {
          match: (r) => r.bin === 'git',
          result: { exitCode: 128, stderr: "fatal: unable to auto-detect email address (got 'dev@box.(none)')" },
        },
      ]),
    });
    const [finding] = await gitIdentityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('auto-detect email');
    expect(finding?.remediation).toContain('user.name');
    expect(finding?.remediation).toContain('user.email');
  });

  it('fails when git prints something it cannot parse as an identity', async () => {
    const ctx = doctorContext({ run: stubRunner([{ match: (r) => r.bin === 'git', result: { stdout: 'nonsense\n' } }]) });
    const [finding] = await gitIdentityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('user.name');
    expect(finding?.remediation).toContain('user.email');
  });
});

describe('tokensCheck', () => {
  const real = configSchema.parse({
    workflow: { ci_provider: 'teamcity', scm_provider: 'bitbucket-server' },
    teamcity: { url: 'https://teamcity.example.internal' },
    bitbucket: { url: 'https://bitbucket.example.internal' },
  });

  it('passes for each set variable and never prints its value (§32 rule 12)', async () => {
    const ctx = doctorContext({
      config: real,
      env: { JANUS_TEAMCITY_TOKEN: 'tc-secret-value', JANUS_BITBUCKET_TOKEN: 'bb-secret-value' },
    });
    const findings = await tokensCheck.run(ctx);
    expect(findings.map((f) => f.id)).toEqual(['tokens[JANUS_TEAMCITY_TOKEN]', 'tokens[JANUS_BITBUCKET_TOKEN]']);
    expect(findings.every((f) => f.status === 'pass')).toBe(true);
    const text = JSON.stringify(findings);
    expect(text).not.toContain('tc-secret-value');
    expect(text).not.toContain('bb-secret-value');
  });

  it('fails the missing one and treats an empty value as missing', async () => {
    const ctx = doctorContext({ config: real, env: { JANUS_TEAMCITY_TOKEN: '   ' } });
    const findings = await tokensCheck.run(ctx);
    expect(findings.map((f) => `${f.id}=${f.status}`)).toEqual(['tokens[JANUS_TEAMCITY_TOKEN]=fail', 'tokens[JANUS_BITBUCKET_TOKEN]=fail']);
    expect(findings[0]?.remediation).toContain('JANUS_TEAMCITY_TOKEN');
  });

  it('skips entirely when both providers are fakes, because no token is required', async () => {
    const findings = await tokensCheck.run(doctorContext({ env: {} }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe('tokens');
    expect(findings[0]?.status).toBe('skip');
  });

  it('skips outside a workspace, before it can even ask which providers are configured', async () => {
    const findings = await tokensCheck.run(doctorContext({ config: null, env: {} }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe('tokens');
    expect(findings[0]?.status).toBe('skip');
    expect(findings[0]?.remediation).toContain('janus init');
  });
});

describe('branchSpecCheck', () => {
  it('passes when a dedicated state repository is configured', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      bitbucket: { url: 'https://bitbucket.example.internal' },
      state: { repo: { project: 'FE', slug: 'janus-state' } },
    });
    const [finding] = await branchSpecCheck.run(doctorContext({ config, goal, paths }));
    expect(finding?.status).toBe('pass');
    expect(finding?.detail).toContain('janus-state');
  });

  it('redacts a credentialed state.clone_url on the pass path, where it would otherwise print on every healthy run (§32 rule 12)', async () => {
    // `state.clone_url` is a free `z.string().min(1)`, and a service-account clone URL with the credential inline
    // is an ordinary way to configure one. This is the `pass` branch, so it reaches the human report, `--json`
    // and the §35 operator skill on every healthy run. The placeholders below are obviously fake by design: they
    // exist to prove redaction, not to look like a credential worth copying.
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      state: { clone_url: 'https://svcuser:PLACEHOLDER-NOT-A-REAL-PAT@bitbucket.example.internal/scm/fe/state.git#token=PLACEHOLDER-FRAGMENT' },
    });
    const [finding] = await branchSpecCheck.run(doctorContext({ config, goal, paths }));
    expect(finding?.status).toBe('pass');
    const serialised = JSON.stringify(finding);
    expect(serialised).not.toContain('PLACEHOLDER-NOT-A-REAL-PAT');
    expect(serialised).not.toContain('PLACEHOLDER-FRAGMENT');
    expect(serialised).not.toContain('svcuser');
    // The host and path survive, so the finding still says which repository the state branch lives in.
    expect(finding?.detail).toContain('bitbucket.example.internal/scm/fe/state.git');
    expect(finding?.detail).toContain('janus/angular-15-to-16');
  });

  it('warns, names the product repository and the branch, and offers both ways out (§33, §31.33)', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'teamcity', scm_provider: 'fake' },
      teamcity: { url: 'https://teamcity.example.internal' },
      bitbucket: { url: 'https://bitbucket.example.internal' },
    });
    const [finding] = await branchSpecCheck.run(doctorContext({ config, goal, paths }));
    expect(finding?.status).toBe('warn');
    expect(finding?.detail).toContain('ui-kit');
    expect(finding?.detail).toContain('janus/angular-15-to-16');
    expect(finding?.remediation).toContain('janus/*');
    expect(finding?.remediation).toContain('state.repo');
  });

  it('skips outside a workspace', async () => {
    const [finding] = await branchSpecCheck.run(doctorContext({ config: null, goal: null }));
    expect(finding?.status).toBe('skip');
    expect(finding?.remediation).toContain('janus init');
  });

  it('reports warn, not an uncaught exception, when stateRemote cannot resolve the remote (ConfigError)', async () => {
    // state.repo is set but bitbucket.url is not configured, so stateRemote's own resolution throws
    // ConfigError('config.yaml', ['state.clone_url: required because bitbucket.url is not configured']) before
    // it ever returns. Confirm that premise directly, then confirm the check turns it into a graceful finding
    // instead of letting it escape run() (where runDoctor's generic handler would misreport it as a doctor bug).
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      state: { repo: { project: 'FE', slug: 'janus-state' } },
    });
    expect(config.bitbucket.url).toBeUndefined();
    const { stateRemote } = await import('../../src/workspace/remotes.js');
    const { ConfigError } = await import('../../src/config/errors.js');
    expect(() => stateRemote(goal, config)).toThrow(ConfigError);
    expect(() => stateRemote(goal, config)).toThrow('state.clone_url: required because bitbucket.url is not configured');

    const [finding] = await branchSpecCheck.run(doctorContext({ config, goal, paths }));
    expect(finding?.status).toBe('warn');
    expect(finding?.detail).toContain('cannot tell where the state branch lives');
    expect(finding?.detail).toContain('state.clone_url');
    expect(finding?.remediation).toContain('state.clone_url');
    expect(finding?.remediation).toContain('bitbucket.url');
  });
});
