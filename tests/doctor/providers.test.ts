import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { ciReachabilityCheck, scmReachabilityCheck } from '../../src/doctor/checks/providers.js';
import type { HttpProbeRequest } from '../../src/doctor/http.js';
import { doctorContext, stubHttp } from '../helpers/doctor-fixtures.js';

const teamcity = configSchema.parse({
  workflow: { ci_provider: 'teamcity', scm_provider: 'bitbucket-server' },
  teamcity: { url: 'https://teamcity.example.internal' },
  bitbucket: { url: 'https://bitbucket.example.internal' },
});

describe('ciReachabilityCheck', () => {
  it('skips for the fake provider', async () => {
    const [finding] = await ciReachabilityCheck.run(doctorContext());
    expect(finding?.status).toBe('skip');
    expect(finding?.detail).toContain('fake');
  });

  it('skips for the local provider, which reaches nothing', async () => {
    const config = configSchema.parse({ workflow: { ci_provider: 'local', scm_provider: 'fake' } });
    const [finding] = await ciReachabilityCheck.run(doctorContext({ config }));
    expect(finding?.status).toBe('skip');
    expect(finding?.detail).toContain('local');
  });

  it('passes for a TeamCity that answers, and never puts the token in the finding', async () => {
    let seen: HttpProbeRequest | undefined;
    const ctx = doctorContext({
      config: teamcity,
      env: { JANUS_TEAMCITY_TOKEN: 'tc-secret-value' },
      http: async (request) => {
        seen = request;
        return { ok: true, status: 200, error: null };
      },
    });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(seen?.url).toBe('https://teamcity.example.internal/app/rest/server');
    expect(seen?.headers['Authorization']).toBe('Bearer tc-secret-value');
    expect(JSON.stringify(finding)).not.toContain('tc-secret-value');
  });

  it('fails with a token remediation on 401', async () => {
    const ctx = doctorContext({ config: teamcity, env: { JANUS_TEAMCITY_TOKEN: 't' }, http: stubHttp({ ok: false, status: 401 }) });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('401');
    expect(finding?.remediation).toContain('JANUS_TEAMCITY_TOKEN');
  });

  it('fails with a network remediation when the host never answers', async () => {
    const ctx = doctorContext({
      config: teamcity,
      env: { JANUS_TEAMCITY_TOKEN: 't' },
      http: stubHttp({ ok: false, status: null, error: 'getaddrinfo ENOTFOUND teamcity.example.internal' }),
    });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('ENOTFOUND');
    expect(finding?.remediation).toContain('network');
  });

  it('fails with a URL-check remediation on a non-2xx, non-auth response', async () => {
    const ctx = doctorContext({ config: teamcity, env: { JANUS_TEAMCITY_TOKEN: 't' }, http: stubHttp({ ok: false, status: 503 }) });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('503');
    expect(finding?.remediation).toContain('config.yaml');
  });

  it('skips when the token is not set, because tokens[...] already reports that', async () => {
    const ctx = doctorContext({ config: teamcity, env: {} });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('skip');
    expect(finding?.remediation).toContain('JANUS_TEAMCITY_TOKEN');
  });
});

describe('scmReachabilityCheck', () => {
  it('skips for the fake provider', async () => {
    const [finding] = await scmReachabilityCheck.run(doctorContext());
    expect(finding?.status).toBe('skip');
  });

  it('passes for a Bitbucket Server that answers', async () => {
    let url = '';
    const ctx = doctorContext({
      config: teamcity,
      env: { JANUS_BITBUCKET_TOKEN: 'bb' },
      http: async (request) => {
        url = request.url;
        return { ok: true, status: 200, error: null };
      },
    });
    const [finding] = await scmReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(url).toBe('https://bitbucket.example.internal/rest/api/1.0/projects?limit=1');
  });

  it('fails on 403 and names the token variable', async () => {
    const ctx = doctorContext({ config: teamcity, env: { JANUS_BITBUCKET_TOKEN: 'bb' }, http: stubHttp({ ok: false, status: 403 }) });
    const [finding] = await scmReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('JANUS_BITBUCKET_TOKEN');
  });

  it('skips when there is no config.yaml (doctor runs outside a workspace)', async () => {
    const ctx = doctorContext({ config: null, env: {} });
    const [finding] = await scmReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('skip');
    expect(finding?.remediation).toContain('janus init');
  });
});

describe('URL credentials never reach a report field (§32 rule 12)', () => {
  // Not a realistic-looking token: this is a placeholder to prove redaction, not a credential shape.
  const credentialConfig = configSchema.parse({
    workflow: { ci_provider: 'teamcity', scm_provider: 'bitbucket-server' },
    teamcity: { url: 'https://ci-bot:xxxxxxxx@teamcity.example.internal' },
    bitbucket: { url: 'https://scm-bot:xxxxxxxx@bitbucket.example.internal' },
  });

  it('strips the userinfo from a passing CI probe', async () => {
    const ctx = doctorContext({
      config: credentialConfig,
      env: { JANUS_TEAMCITY_TOKEN: 't' },
      http: stubHttp({ ok: true, status: 200 }),
    });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('pass');
    const serialised = JSON.stringify(finding);
    expect(serialised).not.toContain('ci-bot');
    expect(serialised).not.toContain('xxxxxxxx');
    expect(finding?.detail).toContain('teamcity.example.internal');
  });

  it('strips the userinfo from an unreachable-host failure', async () => {
    const ctx = doctorContext({
      config: credentialConfig,
      env: { JANUS_TEAMCITY_TOKEN: 't' },
      http: stubHttp({ ok: false, status: null, error: 'getaddrinfo ENOTFOUND teamcity.example.internal' }),
    });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    const serialised = JSON.stringify(finding);
    expect(serialised).not.toContain('ci-bot');
    expect(serialised).not.toContain('xxxxxxxx');
  });

  it('strips the userinfo from a non-2xx SCM failure', async () => {
    const ctx = doctorContext({
      config: credentialConfig,
      env: { JANUS_BITBUCKET_TOKEN: 't' },
      http: stubHttp({ ok: false, status: 500 }),
    });
    const [finding] = await scmReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    const serialised = JSON.stringify(finding);
    expect(serialised).not.toContain('scm-bot');
    expect(serialised).not.toContain('xxxxxxxx');
    expect(finding?.detail).toContain('bitbucket.example.internal');
  });
});
