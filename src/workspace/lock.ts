import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export interface LockInfo {
  pid: number;
  acquired_at: string;
}

export class WorkspaceLockedError extends Error {
  readonly lockFile: string;
  readonly holder: LockInfo;

  constructor(lockFile: string, holder: LockInfo) {
    super(`workspace is locked by pid ${holder.pid} since ${holder.acquired_at} (${lockFile})`);
    this.name = 'WorkspaceLockedError';
    this.lockFile = lockFile;
    this.holder = holder;
  }
}

export interface AcquireResult {
  /** The stale lock that was reclaimed, if any. The caller should warn about it. */
  reclaimed: LockInfo | null;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Creates the lock file atomically. A lock held by a live process throws; a dead or corrupt one is reclaimed. */
export function acquireLock(lockFile: string, now: Date = new Date(), pid: number = process.pid): AcquireResult {
  const info: LockInfo = { pid, acquired_at: now.toISOString() };
  let reclaimed: LockInfo | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockFile, JSON.stringify(info), { flag: 'wx' });
      return { reclaimed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readLock(lockFile);
      if (holder !== null && isProcessAlive(holder.pid)) {
        throw new WorkspaceLockedError(lockFile, holder);
      }
      reclaimed = holder;
      unlinkSync(lockFile);
    }
  }
  throw new Error(`could not acquire lock ${lockFile}`);
}

export function releaseLock(lockFile: string): void {
  try {
    unlinkSync(lockFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function readLock(lockFile: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(lockFile, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid === 'number' && typeof parsed.acquired_at === 'string') {
      return { pid: parsed.pid, acquired_at: parsed.acquired_at };
    }
    return null;
  } catch {
    return null;
  }
}
