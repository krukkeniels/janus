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
    expect(finding?.remediation).not.toBeNull();
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
});
