import { describe, expect, it } from 'vitest';
import { SECRET_PATTERNS, secretsCheck } from '../../src/policy/checks/secrets.js';
import { policyContext } from '../helpers/policy-fixtures.js';

const GITHUB_TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const FIREBASE_LOOKING_KEY = 'AIzaSyDOCAbC123dEf456GhI789jKl01234';
const SLACK_BOT_TOKEN = 'xoxb-1234567890123-1234567890123-abcdefghijklmnopqrstuvwxyz0123456789';
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('secretsCheck', () => {
  it('passes a diff with no secret-shaped text', async () => {
    const ctx = policyContext({ files: [{ path: 'src/app.ts', added: ['const apiBase = "https://api.example.com";'] }] });
    expect(await secretsCheck.run(ctx)).toEqual([]);
  });

  it('flags a GitHub token', async () => {
    const ctx = policyContext({ files: [{ path: '.env.local', added: [`GITHUB_TOKEN=${GITHUB_TOKEN}`] }] });
    const findings = await secretsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('secrets.detected');
    expect(findings?.[0]?.path).toBe('.env.local');
    expect(findings?.[0]?.line).toBe(1);
  });

  it('NEVER records the secret itself, in any field', async () => {
    const ctx = policyContext({ files: [{ path: '.env.local', added: [`GITHUB_TOKEN=${GITHUB_TOKEN}`] }] });
    const finding = (await secretsCheck.run(ctx))?.[0];
    expect(finding?.evidence).toBeNull();
    expect(JSON.stringify(finding)).not.toContain(GITHUB_TOKEN);
  });

  it('flags an AWS access key id, a private key header and a credentialed URL', async () => {
    const ctx = policyContext({
      files: [
        {
          path: 'config.ts',
          added: [
            `const key = '${AWS_KEY}';`,
            '-----BEGIN RSA PRIVATE KEY-----',
            "const repo = 'https://svc:hunter2hunter2@git.example.internal/a.git';",
          ],
        },
      ],
    });
    const findings = await secretsCheck.run(ctx);
    expect(findings).toHaveLength(3);
    expect(JSON.stringify(findings)).not.toContain('hunter2hunter2');
    expect(JSON.stringify(findings)).not.toContain(AWS_KEY);
  });

  it('flags a long quoted assignment to a credential-shaped name', async () => {
    const ctx = policyContext({ files: [{ path: 'src/a.ts', added: ["  password: 'correct-horse-battery-staple',"] }] });
    expect(await secretsCheck.run(ctx)).toHaveLength(1);
  });

  it('does not flag a short or env-var-sourced value', async () => {
    const ctx = policyContext({
      files: [{ path: 'src/a.ts', added: ["  token: process.env['JANUS_BITBUCKET_TOKEN'],", "  password: '',"] }],
    });
    expect(await secretsCheck.run(ctx)).toEqual([]);
  });

  it('does not flag a camelCase apiKey — a Firebase web apiKey is designed to be public', async () => {
    const ctx = policyContext({
      files: [{ path: 'src/environments/environment.ts', added: [`  apiKey: '${FIREBASE_LOOKING_KEY}',`] }],
    });
    expect(await secretsCheck.run(ctx)).toEqual([]);
  });

  it('still flags a snake_case api_key assignment', async () => {
    const ctx = policyContext({ files: [{ path: 'src/a.ts', added: [`  api_key: '${FIREBASE_LOOKING_KEY}',`] }] });
    const findings = await secretsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.detail).toContain('credential-shaped assignment');
  });

  it('flags a Slack bot token', async () => {
    const ctx = policyContext({ files: [{ path: 'src/a.ts', added: [`const t = '${SLACK_BOT_TOKEN}';`] }] });
    const findings = await secretsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.detail).toContain('Slack token');
    expect(JSON.stringify(findings)).not.toContain(SLACK_BOT_TOKEN);
  });

  it('does not flag a short string that merely starts with a Slack-shaped prefix', async () => {
    const ctx = policyContext({ files: [{ path: 'src/a.ts', added: ["const sku = 'xoxb-a1';"] }] });
    expect(await secretsCheck.run(ctx)).toEqual([]);
  });

  it('flags a JSON web token', async () => {
    const ctx = policyContext({ files: [{ path: 'src/a.ts', added: [`const t = '${JWT}';`] }] });
    const findings = await secretsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.detail).toContain('JSON web token');
    expect(JSON.stringify(findings)).not.toContain(JWT);
  });

  it('does not flag a two-segment base64url-looking string that is not a three-segment JWT', async () => {
    const twoSegments = JWT.slice(0, JWT.lastIndexOf('.'));
    const ctx = policyContext({ files: [{ path: 'src/a.ts', added: [`const t = '${twoSegments}';`] }] });
    expect(await secretsCheck.run(ctx)).toEqual([]);
  });

  it('only looks at added lines', async () => {
    const ctx = policyContext({ files: [{ path: '.env.local', removed: [`GITHUB_TOKEN=${GITHUB_TOKEN}`] }] });
    expect(await secretsCheck.run(ctx)).toEqual([]);
  });

  it('reports one finding per line even when several patterns match it', async () => {
    const ctx = policyContext({ files: [{ path: 'a.ts', added: [`const a = '${GITHUB_TOKEN}'; const b = '${AWS_KEY}';`] }] });
    expect(await secretsCheck.run(ctx)).toHaveLength(1);
  });

  it('every pattern carries a label', () => {
    expect(SECRET_PATTERNS.every((pattern) => pattern.label.length > 0)).toBe(true);
  });
});
