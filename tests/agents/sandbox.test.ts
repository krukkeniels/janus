import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { planSandbox, SandboxPlanError, unsandboxedNote } from '../../src/agents/sandbox.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { tempDir } from '../helpers/git-fixtures.js';

const base = { workflow: { ci_provider: 'fake', scm_provider: 'fake' } };
const config = (overrides: Record<string, unknown> = {}) => configSchema.parse({ ...base, ...overrides });
const paths = () => workspacePaths(tempDir('janus-sandbox-'));

describe('planSandbox', () => {
  it('gives a code-writing role a writable repo, network on, and the workspace pnpm store (§3.3, §18.4)', () => {
    const p = paths();
    const plan = planSandbox({ role: 'implementation', runId: 'run-0001', repo: 'ui-kit', paths: p, config: config(), globalPnpmStore: null });
    expect(plan.sandbox).toBe('workspace-write');
    expect(plan.network).toBe(true);
    expect(plan.cwd).toBe(p.repoDir('ui-kit'));
    expect(plan.writableRoots).toEqual([p.repoDir('ui-kit'), p.pnpmStoreDir]);
    expect(plan.env).toEqual({ npm_config_store_dir: p.pnpmStoreDir });
  });

  it('adds the global store and the user cache as writable roots when agents.pnpm_store is global', () => {
    const p = paths();
    const plan = planSandbox({
      role: 'debug',
      runId: 'run-0002',
      repo: 'shell',
      paths: p,
      config: config({ agents: { pnpm_store: 'global' } }),
      globalPnpmStore: '/home/dev/.local/share/pnpm/store/v3',
    });
    expect(plan.writableRoots).toEqual([p.repoDir('shell'), '/home/dev/.local/share/pnpm/store/v3', join(homedir(), '.cache')]);
    expect(plan.env).toEqual({});
  });

  it('refuses the global store when nobody resolved `pnpm store path`', () => {
    expect(() =>
      planSandbox({ role: 'fix', runId: 'r', repo: 'ui-kit', paths: paths(), config: config({ agents: { pnpm_store: 'global' } }), globalPnpmStore: null }),
    ).toThrow(SandboxPlanError);
  });

  it('gives a report-writing role its own report directory and network off, without creating it (planning stays I/O-free)', () => {
    const p = paths();
    const plan = planSandbox({ role: 'discovery', runId: 'run-0003', repo: null, paths: p, config: config(), globalPnpmStore: null });
    expect(plan.sandbox).toBe('workspace-write');
    expect(plan.network).toBe(false);
    expect(plan.cwd).toBe(join(p.janusDir, 'reports', 'run-0003'));
    expect(plan.writableRoots).toEqual([plan.cwd]);
    expect(existsSync(plan.cwd)).toBe(false);
  });

  it('gives a read-only role the workspace root and no writable root', () => {
    const p = paths();
    const plan = planSandbox({ role: 'review', runId: 'run-0004', repo: null, paths: p, config: config(), globalPnpmStore: null });
    expect(plan.sandbox).toBe('read-only');
    expect(plan.network).toBe(false);
    expect(plan.cwd).toBe(p.root);
    expect(plan.writableRoots).toEqual([]);
  });

  it('requires a repo for a code-writing role', () => {
    expect(() =>
      planSandbox({ role: 'implementation', runId: 'r', repo: null, paths: paths(), config: config(), globalPnpmStore: null }),
    ).toThrow('code-writing role "implementation" needs a repo');
  });

  it('refuses a run id that is not a single path segment, so it cannot escape the reports directory', () => {
    expect(() =>
      planSandbox({ role: 'discovery', runId: 'a/../..', repo: null, paths: paths(), config: config(), globalPnpmStore: null }),
    ).toThrow(SandboxPlanError);
  });

  it('overrides every class with danger-full-access when agents.allow_unsandboxed is true (§18.4)', () => {
    const p = paths();
    const unsandboxed = config({ agents: { allow_unsandboxed: true } });
    const plan = planSandbox({ role: 'review', runId: 'r', repo: null, paths: p, config: unsandboxed, globalPnpmStore: null });
    expect(plan.sandbox).toBe('danger-full-access');
    expect(plan.writableRoots).toEqual([]);
    expect(unsandboxedNote(unsandboxed)).toContain('danger-full-access');
    expect(unsandboxedNote(config())).toBeNull();
  });

  it('asks for --skip-git-repo-check for the read-only class only (§18.4 as amended by T06 probe R2)', () => {
    const p = paths();
    const common = { runId: 'run-0009', paths: p, config: config(), globalPnpmStore: null };
    expect(planSandbox({ ...common, role: 'review', repo: null }).skipGitRepoCheck).toBe(true);
    expect(planSandbox({ ...common, role: 'checkpoint', repo: null }).skipGitRepoCheck).toBe(true);
    expect(planSandbox({ ...common, role: 'triage', repo: null }).skipGitRepoCheck).toBe(true);
    expect(planSandbox({ ...common, role: 'discovery', repo: null }).skipGitRepoCheck).toBe(false);
    expect(planSandbox({ ...common, role: 'implementation', repo: 'ui-kit' }).skipGitRepoCheck).toBe(false);
  });

  it('keeps the flag for a read-only role even when allow_unsandboxed turns it into danger-full-access', () => {
    const p = paths();
    const plan = planSandbox({
      role: 'review',
      runId: 'run-0010',
      repo: null,
      paths: p,
      config: config({ agents: { allow_unsandboxed: true } }),
      globalPnpmStore: null,
    });
    expect(plan.sandbox).toBe('danger-full-access');
    expect(plan.cwd).toBe(p.root);
    // The cwd is unchanged, so the git-work-tree refusal is unchanged; the flag is about the cwd, not the sandbox.
    expect(plan.skipGitRepoCheck).toBe(true);
  });
});
