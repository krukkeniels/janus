import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { runGit } from '../../src/git/run.js';
import { acquireLock, WorkspaceLockedError } from '../../src/workspace/lock.js';
import { findWorkspaceRoot, isWorkspaceRoot, openWorkspace } from '../../src/workspace/open-workspace.js';
import { initWorkspace } from '../helpers/engine-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';

/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync('true');
  if (child.pid === undefined) throw new Error('could not spawn a process');
  return child.pid;
}

describe('findWorkspaceRoot', () => {
  it('finds the root from the root itself and from a nested directory', async () => {
    const ws = await initWorkspace();
    expect(isWorkspaceRoot(ws.root)).toBe(true);
    expect(findWorkspaceRoot(ws.root)).toBe(ws.root);
    expect(findWorkspaceRoot(join(ws.root, 'repos', 'ui-kit'))).toBe(ws.root);
  });

  it('fails outside a workspace', () => {
    const dir = tempDir();
    expect(() => findWorkspaceRoot(dir)).toThrow(ConfigError);
    expect(() => findWorkspaceRoot(dir)).toThrow('not inside a janus workspace');
  });
});

describe('openWorkspace', () => {
  it('locks, loads state, goal, config, and repo order, and releases', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      expect(existsSync(join(ws.root, 'janus.lock'))).toBe(true);
      expect(workspace.paths.root).toBe(ws.root);
      expect(workspace.state.goal.id).toBe(ws.fixture.goalId);
      expect(workspace.goal.id).toBe(ws.fixture.goalId);
      expect(workspace.repoOrder).toEqual(['ui-kit', 'shell']);
      expect(workspace.config.workflow.ci_provider).toBe('fake');
      expect(workspace.stateRemoteUrl).toBe(ws.fixture.stateBare);
      expect(workspace.reclaimedLock).toBeNull();
    } finally {
      workspace.release();
    }
    expect(existsSync(join(ws.root, 'janus.lock'))).toBe(false);
    workspace.release(); // idempotent
  });

  it('refuses a workspace held by a live process', async () => {
    const ws = await initWorkspace();
    const first = await openWorkspace(ws.root);
    try {
      await expect(openWorkspace(ws.root)).rejects.toBeInstanceOf(WorkspaceLockedError);
    } finally {
      first.release();
    }
  });

  it('reclaims a stale lock and reports it', async () => {
    const ws = await initWorkspace();
    const pid = deadPid();
    acquireLock(join(ws.root, 'janus.lock'), new Date('2026-09-19T00:00:00.000Z'), pid);
    const workspace = await openWorkspace(ws.root);
    try {
      expect(workspace.reclaimedLock?.pid).toBe(pid);
    } finally {
      workspace.release();
    }
  });

  it('refuses a directory that is not a workspace without leaving a lock behind', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.janus'));
    await expect(openWorkspace(dir)).rejects.toThrow('not a janus workspace');
    expect(existsSync(join(dir, 'janus.lock'))).toBe(false);
  });

  it('refuses .janus on the wrong branch and releases the lock', async () => {
    const ws = await initWorkspace();
    await runGit(ws.janusDir, ['checkout', '-q', '-b', 'scratch']);
    await expect(openWorkspace(ws.root)).rejects.toThrow('.janus is on branch scratch, expected janus/angular-15-to-16');
    expect(existsSync(join(ws.root, 'janus.lock'))).toBe(false);
  });

  it('refuses .janus whose origin is not the configured state remote', async () => {
    const ws = await initWorkspace();
    await runGit(ws.janusDir, ['remote', 'set-url', 'origin', '/nowhere/state.git']);
    await expect(openWorkspace(ws.root)).rejects.toThrow('.janus origin is /nowhere/state.git, expected the state remote');
    expect(existsSync(join(ws.root, 'janus.lock'))).toBe(false);
  });
});
