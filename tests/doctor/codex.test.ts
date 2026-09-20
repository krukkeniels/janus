import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { codexBinaryCheck, codexLoginCheck, codexModelsCheck, distinctModels } from '../../src/doctor/checks/codex.js';
import { doctorContext, stubFs, stubRunner } from '../helpers/doctor-fixtures.js';

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
    expect(finding?.remediation).toContain('reinstall');
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

  it('fails when codex exits 0 but reports it is not logged in (the "not logged in" substring trap)', async () => {
    // 'not logged in'.includes('logged in') is true, so a naive substring check false-passes this. exitCode is
    // deliberately 0 here so the exit-code disjunct cannot mask the bug the way the exitCode:1 test above does.
    const ctx = doctorContext({
      run: stubRunner([{ match: (r) => isLogin(r.bin, r.args), result: { exitCode: 0, stdout: 'Not logged in\n', stderr: '' } }]),
    });
    const [finding] = await codexLoginCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('codex login');
  });

  it('passes when an affirmative status line follows a banner line (whole-string anchor would miss it)', async () => {
    const ctx = doctorContext({
      run: stubRunner([
        { match: (r) => isLogin(r.bin, r.args), result: { exitCode: 0, stdout: 'OpenAI Codex v0.146.0\nLogged in using ChatGPT\n' } },
      ]),
    });
    const [finding] = await codexLoginCheck.run(ctx);
    expect(finding?.status).toBe('pass');
  });

  it('fails when a negative status line follows a banner line', async () => {
    const ctx = doctorContext({
      run: stubRunner([{ match: (r) => isLogin(r.bin, r.args), result: { exitCode: 0, stdout: 'OpenAI Codex v0.146.0\nNot logged in\n' } }]),
    });
    const [finding] = await codexLoginCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('codex login');
  });

  it('fails on "Logged in: false", which a bare `/^logged in\\b/i` prefix check would false-positive on', async () => {
    const ctx = doctorContext({
      run: stubRunner([{ match: (r) => isLogin(r.bin, r.args), result: { exitCode: 0, stdout: 'Logged in: false\n' } }]),
    });
    const [finding] = await codexLoginCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('codex login');
  });

  it('fails on an unrecognised status body, rather than passing by default', async () => {
    const ctx = doctorContext({
      run: stubRunner([{ match: (r) => isLogin(r.bin, r.args), result: { exitCode: 0, stdout: 'some unexpected codex output\n' } }]),
    });
    const [finding] = await codexLoginCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('codex login');
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
    // Decision 14: bound the probe's own cost, not just its prompt — "one-token probe" must be enforced, not just asked for.
    expect(seen[0]).toContain('model_max_output_tokens=1');
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

  it('fails gracefully, instead of throwing out of run(), when the scratch directory cannot be created', async () => {
    const ctx = doctorContext({
      fs: stubFs({ mkdtempError: 'EACCES: permission denied, mkdtemp' }),
      run: stubRunner([{ match: (r) => isExec(r.bin, r.args), result: { exitCode: 0 } }]),
    });
    const findings = await codexModelsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe('fail');
    expect(findings[0]?.detail).toContain('EACCES');
    expect(findings[0]?.remediation).not.toBeNull();
    expect(findings[0]?.remediation).toContain('writable');
  });

  it('still resolves with the real probe finding when cleanup of the scratch directory fails', async () => {
    // A scratch dir that will not delete (EBUSY, a lingering open handle, ...) must not turn a real probe result
    // into an uncaught exception out of run() — the probe already succeeded or failed on its own merits.
    const ctx = doctorContext({
      fs: stubFs({ rmrfError: 'EBUSY: resource busy or locked, rmdir' }),
      run: stubRunner([{ match: (r) => isExec(r.bin, r.args), result: { exitCode: 0 } }]),
    });
    const findings = await codexModelsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe('codex.model[gpt-5.6-sol]');
    expect(findings[0]?.status).toBe('pass');
  });
});
