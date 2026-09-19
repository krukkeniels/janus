import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigError } from '../config/errors.js';

export interface WorkspacePaths {
  root: string;
  janusDir: string;
  reposDir: string;
  fakeDir: string;
  pnpmStoreDir: string;
  lockFile: string;
  repoDir(name: string): string;
}

/** Absolute paths of everything in a goal workspace (spec §5). */
export function workspacePaths(root: string): WorkspacePaths {
  const absolute = resolve(root);
  const reposDir = join(absolute, 'repos');
  return {
    root: absolute,
    janusDir: join(absolute, '.janus'),
    reposDir,
    fakeDir: join(absolute, 'fake'),
    pnpmStoreDir: join(absolute, '.pnpm-store'),
    lockFile: join(absolute, 'janus.lock'),
    repoDir: (name) => join(reposDir, name),
  };
}

/** Creates the plain directories of a workspace. `.janus/` is created by the state-branch module because it is a git checkout. */
export function createWorkspaceDirs(paths: WorkspacePaths): void {
  for (const dir of [paths.root, paths.reposDir, paths.fakeDir, paths.pnpmStoreDir]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function ensureEmptyOrMissing(root: string): void {
  if (!existsSync(root)) return;
  const entries = readdirSync(root).filter((entry) => entry !== 'janus.lock');
  if (entries.length > 0) {
    throw new ConfigError(root, ['workspace directory exists and is not empty']);
  }
}
