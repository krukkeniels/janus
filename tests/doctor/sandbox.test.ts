import { describe, expect, it } from 'vitest';
import { goalSchema } from '../../src/config/goal-schema.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { angularRepo, codexReadOnlyProbe, codexWorkspaceWriteProbe, ngUpdateProbe, userNamespacesCheck } from '../../src/doctor/checks/sandbox.js';
import { doctorContext, stubFs, stubRunner } from '../helpers/doctor-fixtures.js';
import { validGoal } from '../fixtures/valid-goal.js';

const MAX_NS = '/proc/sys/user/max_user_namespaces';
const CLONE = '/proc/sys/kernel/unprivileged_userns_clone';

describe('userNamespacesCheck', () => {
  it('passes when the kernel allows unprivileged user namespaces', async () => {
    const ctx = doctorContext({ fs: stubFs({ files: { [MAX_NS]: '236542\n', [CLONE]: '1\n' } }) });
    const [finding] = await userNamespacesCheck.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(finding?.detail).toContain('236542');
  });

  it('fails when max_user_namespaces is zero, and says how to raise it', async () => {
    const ctx = doctorContext({ fs: stubFs({ files: { [MAX_NS]: '0\n' } }) });
    const [finding] = await userNamespacesCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('max_user_namespaces');
    expect(finding?.remediation).toContain('allow_unsandboxed');
  });

  it('fails when unprivileged_userns_clone is disabled', async () => {
    const ctx = doctorContext({ fs: stubFs({ files: { [MAX_NS]: '10000\n', [CLONE]: '0\n' } }) });
    const [finding] = await userNamespacesCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('unprivileged_userns_clone');
  });

  it('skips when the sysctl is not readable at all, rather than claiming a broken sandbox', async () => {
    const [finding] = await userNamespacesCheck.run(doctorContext({ fs: stubFs() }));
    expect(finding?.status).toBe('skip');
    expect(finding?.remediation).not.toBeNull();
  });
});

describe('codexReadOnlyProbe', () => {
  it('passes, and runs read-only with the git-repo check skipped and no writable root (§18.4, T06 probe R2)', async () => {
    let args: string[] = [];
    const ctx = doctorContext({
      run: stubRunner([
        {
          match: (r) => {
            args = r.args;
            return r.bin === 'codex';
          },
          result: { exitCode: 0, stdout: 'pong\n' },
        },
      ]),
    });
    const [finding] = await codexReadOnlyProbe.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(args).toContain('read-only');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--ephemeral');
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('-m');
  });

  it('fails with the sandbox remediation when codex refuses to start', async () => {
    const ctx = doctorContext({
      run: stubRunner([
        { match: (r) => r.bin === 'codex', result: { exitCode: 1, stderr: 'sandbox error: failed to create user namespace: EPERM' } },
      ]),
    });
    const [finding] = await codexReadOnlyProbe.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('EPERM');
    expect(finding?.remediation).toContain('sandbox.user_namespaces');
  });

  it('fails gracefully, instead of throwing out of run(), when the scratch directory cannot be created', async () => {
    const ctx = doctorContext({ fs: stubFs({ mkdtempError: 'EACCES: permission denied, mkdtemp' }) });
    const [finding] = await codexReadOnlyProbe.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('EACCES');
    expect(finding?.remediation).not.toBeNull();
    expect(finding?.remediation).toContain('writable');
  });
});

describe('codexWorkspaceWriteProbe', () => {
  it('passes when the scratch install leaves node_modules behind', async () => {
    let args: string[] = [];
    let env: Record<string, string> | undefined;
    const ctx = doctorContext({
      run: stubRunner([
        { match: (r) => r.bin === 'git', result: { exitCode: 0 } },
        {
          match: (r) => {
            args = r.args;
            env = r.env;
            return r.bin === 'codex';
          },
          result: { exitCode: 0 },
        },
      ]),
      fs: { ...stubFs(), exists: (path) => path.endsWith('node_modules') },
    });
    const [finding] = await codexWorkspaceWriteProbe.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(args).toContain('workspace-write');
    expect(args.join(' ')).toContain('sandbox_workspace_write.network_access=true');
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(2);
    expect(env?.['npm_config_store_dir']).toMatch(/\.pnpm-store$/u);
  });

  it('fails when the run exits 0 but installed nothing, because that is the store being unwritable', async () => {
    const ctx = doctorContext({
      run: stubRunner([
        { match: (r) => r.bin === 'git', result: { exitCode: 0 } },
        { match: (r) => r.bin === 'codex', result: { exitCode: 0 } },
      ]),
      fs: { ...stubFs(), exists: () => false },
    });
    const [finding] = await codexWorkspaceWriteProbe.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('node_modules');
    expect(finding?.remediation).toContain('pnpm.store');
  });

  it('fails gracefully, instead of throwing out of run(), when the scratch directory cannot be created', async () => {
    const ctx = doctorContext({ fs: stubFs({ mkdtempError: 'ENOSPC: no space left on device, mkdtemp' }) });
    const [finding] = await codexWorkspaceWriteProbe.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('ENOSPC');
    expect(finding?.remediation).not.toBeNull();
    expect(finding?.remediation).toContain('writable');
  });

  it('still resolves with the real probe finding when cleanup of the scratch directory fails', async () => {
    const ctx = doctorContext({
      run: stubRunner([
        { match: (r) => r.bin === 'git', result: { exitCode: 0 } },
        { match: (r) => r.bin === 'codex', result: { exitCode: 0 } },
      ]),
      fs: { ...stubFs({ rmrfError: 'EBUSY: resource busy or locked, rmdir' }), exists: (path) => path.endsWith('node_modules') },
    });
    const [finding] = await codexWorkspaceWriteProbe.run(ctx);
    expect(finding?.status).toBe('pass');
  });
});

describe('ngUpdateProbe', () => {
  const paths = workspacePaths('/tmp/janus-doctor-ng');
  const goal = goalSchema.parse(validGoal);
  const angularPkg = JSON.stringify({ devDependencies: { '@angular/cli': '15.2.11' } });

  it('skips when no repository in the goal has the Angular CLI', async () => {
    const ctx = doctorContext({ paths, goal, fs: stubFs({ files: {} }) });
    const [finding] = await ngUpdateProbe.run(ctx);
    expect(finding?.status).toBe('skip');
    expect(finding?.detail).toContain('Angular');
  });

  it('passes when ng update accepts --allow-dirty in the first Angular repo', async () => {
    const repo = paths.repoDir('ui-kit');
    let args: string[] = [];
    const ctx = doctorContext({
      paths,
      goal,
      fs: stubFs({ files: { [`${repo}/package.json`]: angularPkg } }),
      run: stubRunner([
        {
          match: (r) => {
            args = r.args;
            return r.bin === 'pnpm';
          },
          result: { exitCode: 0, stdout: 'We analyzed your package.json\n' },
        },
      ]),
    });
    const [finding] = await ngUpdateProbe.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(args).toEqual(['exec', 'ng', 'update', '--allow-dirty', '--dry-run']);
  });

  it('fails with a Node-version remediation when the Angular CLI rejects the running Node', async () => {
    const repo = paths.repoDir('ui-kit');
    const ctx = doctorContext({
      paths,
      goal,
      fs: stubFs({ files: { [`${repo}/package.json`]: angularPkg } }),
      run: stubRunner([
        {
          match: (r) => r.bin === 'pnpm',
          result: { exitCode: 1, stderr: 'Node.js version v24.5.0 detected.\nThe Angular CLI requires a minimum Node.js version of v14.20.' },
        },
      ]),
    });
    const [finding] = await ngUpdateProbe.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('Node');
  });
});

describe('angularRepo', () => {
  it('returns null when doctor is not running inside a workspace', () => {
    const goal = goalSchema.parse(validGoal);
    const ctx = doctorContext({ paths: null, goal, fs: stubFs() });
    expect(angularRepo(ctx)).toBeNull();
  });
});
