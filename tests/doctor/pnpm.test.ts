import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { pnpmStoreCheck } from '../../src/doctor/checks/pnpm.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { doctorContext, stubFs, stubRunner } from '../helpers/doctor-fixtures.js';

const paths = workspacePaths('/tmp/janus-doctor-pnpm');
const workspaceStore = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } });
const globalStore = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' }, agents: { pnpm_store: 'global' } });

describe('pnpmStoreCheck', () => {
  it('passes when the workspace store is writable, and never shells out to pnpm', async () => {
    const ctx = doctorContext({ config: workspaceStore, paths, fs: stubFs() });
    const [finding] = await pnpmStoreCheck.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(finding?.detail).toContain(join(paths.root, '.pnpm-store'));
  });

  it('fails with the exact write error when the workspace store cannot be written', async () => {
    const ctx = doctorContext({ config: workspaceStore, paths, fs: stubFs({ writableError: "EROFS: read-only file system, open '/x'" }) });
    const [finding] = await pnpmStoreCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('EROFS');
    expect(finding?.remediation).toContain('npm_config_store_dir');
  });

  it('resolves the global store with `pnpm store path` and probes that instead', async () => {
    let args: string[] = [];
    const ctx = doctorContext({
      config: globalStore,
      paths,
      run: stubRunner([
        {
          match: (r) => {
            args = r.args;
            return r.bin === 'pnpm';
          },
          result: { stdout: '/home/dev/.local/share/pnpm/store/v10\n' },
        },
      ]),
      fs: stubFs(),
    });
    const [finding] = await pnpmStoreCheck.run(ctx);
    expect(args).toEqual(['store', 'path']);
    expect(finding?.status).toBe('pass');
    expect(finding?.detail).toContain('/home/dev/.local/share/pnpm/store/v10');
  });

  it('fails when `pnpm store path` cannot run at all', async () => {
    const ctx = doctorContext({
      config: globalStore,
      paths,
      run: stubRunner([{ match: (r) => r.bin === 'pnpm', result: { spawnFailed: true, exitCode: null, stderr: 'spawn pnpm ENOENT' } }]),
    });
    const [finding] = await pnpmStoreCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('pnpm');
  });

  it('skips outside a workspace, where there is no store to check', async () => {
    const [finding] = await pnpmStoreCheck.run(doctorContext({ config: null, paths: null }));
    expect(finding?.status).toBe('skip');
    expect(finding?.remediation).toContain('janus init');
  });
});
