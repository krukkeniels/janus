import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Spec §18.5 names this file. */
export const FAKE_AGENTS_FILE = 'agents.json';
export const FAKE_CI_FILE = 'ci.json';
export const FAKE_SCM_FILE = 'scm.json';

interface StoreFile<T> {
  version: 1;
  data: T;
}

export function fakeStorePath(fakeDir: string, file: string): string {
  return join(fakeDir, file);
}

/**
 * Reads `<workspace>/fake/<file>` (spec §3.2: every `janus run` is a new process, so fakes persist here).
 * A missing, unreadable, corrupt, or foreign-version file yields `fallback` — a fake is never allowed to be the
 * reason a run crashes.
 */
export function readFakeStore<T>(fakeDir: string, file: string, fallback: T): T {
  let parsed: Partial<StoreFile<T>>;
  try {
    parsed = JSON.parse(readFileSync(fakeStorePath(fakeDir, file), 'utf8')) as Partial<StoreFile<T>>;
  } catch {
    return fallback;
  }
  if (parsed.version !== 1 || parsed.data === undefined) return fallback;
  return parsed.data;
}

/** Writes through a temp file and renames it into place, so an interrupted run never leaves half a store behind. */
export function writeFakeStore<T>(fakeDir: string, file: string, data: T): void {
  mkdirSync(fakeDir, { recursive: true });
  const path = fakeStorePath(fakeDir, file);
  const temp = `${path}.tmp`;
  const wrapper: StoreFile<T> = { version: 1, data };
  writeFileSync(temp, `${JSON.stringify(wrapper, null, 2)}\n`);
  renameSync(temp, path);
}
