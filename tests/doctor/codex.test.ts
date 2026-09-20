import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { codexBinaryCheck, codexLoginCheck, codexModelsCheck, distinctModels } from '../../src/doctor/checks/codex.js';
import { doctorContext, stubRunner } from '../helpers/doctor-fixtures.js';

const isVersion = (bin: string, args: string[]): boolean => bin === 'codex' && args[0] === '--version';
const isLogin = (bin: string, args: string[]): boolean => bin === 'codex' && args[0] === 'login';
const isExec = (bin: string, args: string[]): boolean => bin === 'codex' && args[0] === 'exec';

describe('codexBinaryCheck', () => {
  it('passes and reports the version', async () => {
    const ctx = doctorContext({ run: stubRunner([{ match: (r) => isVersion(r.bin, r.args), result: { stdout: 'codex-cli 0.146.0\n' } }]) });
    expect(await codexBinaryCheck.run(ctx)).toEqual([
      { id: 'codex.binary', title: codexBinaryCheck.title, status: 'pass', detail: 'codex-cli 0.146.0', remediation: null },
    ]);
  });

  it('fails with an install remediation when the binary is not on PATH', async () => {
    const ctx = doctorContext({
      run: stubRunner([{ match: (r) => isVersion(r.bin, r.args), result: { spawnFailed: true, exitCode: null, stderr: 'spawn codex ENOENT' } }]),
    });
    const [finding] = await codexBinaryCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('ENOENT');
    expect(finding?.remediation).toContain('PATH');
  });

  it('fails when the binary is there but exits non-zero', async () => {
    const ctx = doctorContext({
      run: stubRunner([{ match: (r) => isVersion(r.bin, r.args), result: { exitCode: 127, stderr: 'illegal instruction' } }]),
    });
    const [finding] = await codexBinaryCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('127');
    expect(finding?.remediation).not.toBeNull();
  });
});

describe('codexLoginCheck', () => {
  it('passes when codex reports a login', async () => {
    const ctx = doctorContext({
      run: stubRunner([{ match: (r) => isLogin(r.bin, r.args), result: { stdout: 'Logged in using ChatGPT\n' } }]),
    });
    const [finding] = await codexLoginCheck.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(finding?.detail).toBe('Logged in using ChatGPT');
  });

  it('fails with a `codex login` remediation when it is not logged in', async () => {
    const ctx = doctorContext({
      run: stubRunner([{ match: (r) => isLogin(r.bin, r.args), result: { exitCode: 1, stdout: 'Not logged in\n', stderr: '' } }]),
    });
    const [finding] = await codexLoginCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('codex login');
    // §28: "Codex authentication is handled outside Janus" — the remediation must not suggest a config change.
    expect(finding?.remediation).not.toContain('config.yaml');
  });
});

describe('distinctModels', () => {
  it('collects every model the active profile can reach, including ladder entries, once each', () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      model_profiles: {
        default: {
          '*': { model: 'gpt-5.6-sol', effort: 'high' },
          implementation: { model: 'gpt-5.6-sol', effort: 'xhigh' },
          debug: { model: 'gpt-5.6-sol', effort: 'high', ladder: ['gpt-5.6-sol', 'gpt-5.6-sol:xhigh', 'gpt-5.6-mini'] },
        },
        other: { '*': { model: 'never-probed', effort: 'low' } },
      },
    });
    expect(distinctModels(config, 'default')).toEqual([
      { model: 'gpt-5.6-sol', effort: 'high' },
      { model: 'gpt-5.6-mini', effort: 'high' },
    ]);
    expect(distinctModels(config, 'other')).toEqual([{ model: 'never-probed', effort: 'low' }]);
  });
});

describe('codexModelsCheck', () => {
  it('probes each distinct model once, read-only, outside a repo, and passes when codex accepts it', async () => {
    const seen: string[][] = [];
    const ctx = doctorContext({
      run: stubRunner([
        {
          match: (r) => {
            if (!isExec(r.bin, r.args)) return false;
            seen.push(r.args);
            return true;
          },
          result: { exitCode: 0, stdout: 'ok\n', stderr: 'OpenAI Codex v0.146.0\n' },
        },
      ]),
    });
    const findings = await codexModelsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe('codex.model[gpt-5.6-sol]');
    expect(findings[0]?.status).toBe('pass');
    expect(seen[0]).toContain('--skip-git-repo-check');
    expect(seen[0]).toContain('-s');
    expect(seen[0]).toContain('read-only');
    expect(seen[0]).toContain('-m');
    expect(seen[0]).toContain('gpt-5.6-sol');
    expect(seen[0]).toContain('model_reasoning_effort=high');
    expect(seen[0]).not.toContain('--add-dir');
  });

  it('fails the one model codex rejects and keeps the others passing', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      model_profiles: { default: { '*': { model: 'good-model', effort: 'high' }, debug: { model: 'bad-model', effort: 'high' } } },
    });
    const ctx = doctorContext({
      config,
      run: stubRunner([
        { match: (r) => r.args.includes('good-model'), result: { exitCode: 0 } },
        {
          match: (r) => r.args.includes('bad-model'),
          result: { exitCode: 1, stderr: 'OpenAI Codex v0.146.0\nstream error: model `bad-model` is not supported\n' },
        },
      ]),
    });
    const findings = await codexModelsCheck.run(ctx);
    expect(findings.map((f) => `${f.id}=${f.status}`)).toEqual(['codex.model[good-model]=pass', 'codex.model[bad-model]=fail']);
    const bad = findings[1];
    expect(bad?.detail).toContain('is not supported');
    // The banner line must not be what the operator is shown; the error is the last line.
    expect(bad?.detail).not.toContain('OpenAI Codex v0.146.0');
    expect(bad?.remediation).toContain('model_profiles');
  });

  it('skips when doctor was not run inside a workspace, because there is no config to read models from', async () => {
    const findings = await codexModelsCheck.run(doctorContext({ config: null }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe('skip');
    expect(findings[0]?.remediation).toContain('janus init');
  });
});
