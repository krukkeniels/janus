import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { ciReachabilityCheck, scmReachabilityCheck } from '../../src/doctor/checks/providers.js';
import { fetchProbe } from '../../src/doctor/http.js';
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

  it('skips when there is no config.yaml (doctor runs outside a workspace)', async () => {
    const ctx = doctorContext({ config: null, env: {} });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('skip');
    expect(finding?.remediation).toContain('janus init');
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

  it('fails with a network remediation when the host never answers', async () => {
    const ctx = doctorContext({
      config: teamcity,
      env: { JANUS_BITBUCKET_TOKEN: 'bb' },
      http: stubHttp({ ok: false, status: null, error: 'getaddrinfo ENOTFOUND bitbucket.example.internal' }),
    });
    const [finding] = await scmReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('ENOTFOUND');
    expect(finding?.remediation).toContain('network');
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

describe('ctx.http throwing is converted to a graceful fail (§32 rule 12, and no escaped exception)', () => {
  it('a thrown error becomes a fail with a concrete, network-pointing remediation, not an escaped exception', async () => {
    const ctx = doctorContext({
      config: teamcity,
      env: { JANUS_TEAMCITY_TOKEN: 't' },
      http: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('ECONNRESET');
    expect(finding?.remediation).toContain('network');
  });

  it('redacts a credential embedded in the thrown error message too, not only in result.error', async () => {
    // Not a realistic-looking token: a placeholder to prove redaction, not a credential shape.
    const credentialConfig = configSchema.parse({
      workflow: { ci_provider: 'teamcity', scm_provider: 'fake' },
      teamcity: { url: 'https://ci-bot:xxxxxxxx@teamcity.example.internal' },
    });
    const ctx = doctorContext({
      config: credentialConfig,
      env: { JANUS_TEAMCITY_TOKEN: 't' },
      http: async () => {
        throw new Error('connect failed to https://ci-bot:xxxxxxxx@teamcity.example.internal/app/rest/server');
      },
    });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    const serialised = JSON.stringify(finding);
    expect(serialised).not.toContain('ci-bot');
    expect(serialised).not.toContain('xxxxxxxx');
  });
});

/**
 * C-1 regression: `fetch()` rejects a credentialed URL at Request-construction time, before any DNS lookup or
 * connection, with a `TypeError` whose message quotes the whole raw URL back verbatim. `fetchProbe` (the real,
 * non-test `HttpProbe`) catches that into `result.error` — a returned value, not a thrown one — so it lands in
 * `detail` via the `status === null` branch, which is the *only* branch a credentialed URL can ever reach. These
 * tests exercise the real `fetchProbe`, not `stubHttp`, because a synthetic `error` string never reproduces this:
 * it only proves redaction of a label the check built itself, not of a string `fetch()` derived from the raw URL.
 */
describe('the real fetchProbe rejects a credentialed URL before touching the network (C-1 regression)', () => {
  // .invalid is reserved by RFC 2606 to never resolve; irrelevant here anyway, since fetch() rejects before any
  // lookup is attempted. Not a realistic-looking token: a placeholder to prove redaction, not a credential shape.
  const credentialedUrl = 'https://ci-bot:xxxxxxxx@example.invalid/app/rest/server';

  it('fetchProbe never makes a network request for a credentialed URL, and its own result.error embeds the raw credential (proving the check must redact it)', async () => {
    const started = Date.now();
    const result = await fetchProbe({ url: credentialedUrl, headers: {}, timeoutMs: 50 });
    const elapsedMs = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).not.toBeNull();
    // The message names the reason as "credentials", which is how we know this is the synchronous
    // Request-construction rejection and not a network attempt that happened to fail fast (e.g. ENOTFOUND) —
    // and well under the 50ms timeout confirms no connection or DNS lookup was attempted either.
    expect(result.error).toContain('credentials');
    expect(elapsedMs).toBeLessThan(1000);
    // Unredacted, fetch()'s own message embeds the whole raw URL, including the placeholder credential — this
    // is exactly the leak C-1 reported: `result.error` is not safe to use verbatim.
    expect(result.error).toContain('xxxxxxxx');
  });

  it('ciReachabilityCheck redacts that credential before it reaches the finding, using the real fetchProbe (no network)', async () => {
    const credentialConfig = configSchema.parse({
      workflow: { ci_provider: 'teamcity', scm_provider: 'fake' },
      teamcity: { url: 'https://ci-bot:xxxxxxxx@example.invalid' },
    });
    const ctx = doctorContext({ config: credentialConfig, env: { JANUS_TEAMCITY_TOKEN: 't' }, http: fetchProbe });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    const serialised = JSON.stringify(finding);
    expect(serialised).not.toContain('xxxxxxxx');
    expect(serialised).not.toContain('ci-bot');
    expect(finding?.detail).toContain('example.invalid');
  });

  it('scmReachabilityCheck redacts that credential too, using the real fetchProbe (no network)', async () => {
    const credentialConfig = configSchema.parse({
      workflow: { ci_provider: 'teamcity', scm_provider: 'bitbucket-server' },
      teamcity: { url: 'https://teamcity.example.internal' },
      bitbucket: { url: 'https://scm-bot:xxxxxxxx@example.invalid' },
    });
    const ctx = doctorContext({ config: credentialConfig, env: { JANUS_BITBUCKET_TOKEN: 't' }, http: fetchProbe });
    const [finding] = await scmReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    const serialised = JSON.stringify(finding);
    expect(serialised).not.toContain('xxxxxxxx');
    expect(serialised).not.toContain('scm-bot');
    expect(finding?.detail).toContain('example.invalid');
  });
});
