import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, isProcessAlive, releaseLock, WorkspaceLockedError } from '../../src/workspace/lock.js';
import { tempDir } from '../helpers/git-fixtures.js';

function deadPid(): number {
  const child = spawnSync('true');
  if (child.pid === undefined) throw new Error('could not spawn a process');
  return child.pid;
}

describe('acquireLock', () => {
  it('writes pid and timestamp and releases cleanly', () => {
    const lockFile = join(tempDir(), 'janus.lock');
    const now = new Date('2026-09-19T10:00:00.000Z');
    const result = acquireLock(lockFile, now, 4242);
    expect(result.reclaimed).toBeNull();
    expect(JSON.parse(readFileSync(lockFile, 'utf8'))).toEqual({ pid: 4242, acquired_at: '2026-09-19T10:00:00.000Z' });
    releaseLock(lockFile);
    expect(existsSync(lockFile)).toBe(false);
    expect(() => releaseLock(lockFile)).not.toThrow();
  });

  it('refuses when the holder is alive', () => {
    const lockFile = join(tempDir(), 'janus.lock');
    acquireLock(lockFile, new Date(), process.pid);
    try {
      acquireLock(lockFile, new Date(), 1);
      expect.unreachable('expected WorkspaceLockedError');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceLockedError);
      const locked = error as WorkspaceLockedError;
      expect(locked.holder.pid).toBe(process.pid);
      expect(locked.message).toContain(`locked by pid ${process.pid}`);
    }
  });

  it('reclaims a lock whose holder is dead and reports it', () => {
    const lockFile = join(tempDir(), 'janus.lock');
    const stale = deadPid();
    expect(isProcessAlive(stale)).toBe(false);
    writeFileSync(lockFile, JSON.stringify({ pid: stale, acquired_at: '2026-01-01T00:00:00.000Z' }));
    const result = acquireLock(lockFile, new Date(), process.pid);
    expect(result.reclaimed).toEqual({ pid: stale, acquired_at: '2026-01-01T00:00:00.000Z' });
    expect(JSON.parse(readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
  });

  it('reclaims a corrupt lock file', () => {
    const lockFile = join(tempDir(), 'janus.lock');
    writeFileSync(lockFile, 'not json');
    const result = acquireLock(lockFile, new Date(), process.pid);
    expect(result.reclaimed).toBeNull();
    expect(JSON.parse(readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
  });
});
