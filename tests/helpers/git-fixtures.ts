import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../../src/git/run.js';

export function tempDir(prefix = 'janus-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface RemoteFixture {
  /** Bare repository usable as a clone URL. */
  bare: string;
  /** Working clone the bare repo was created from. */
  work: string;
  /** Sha of the single commit on the branch. */
  head: string;
}

/** A working repo with one commit on `branch`, plus a bare clone of it to serve as the remote. */
export async function createRemoteWithCommit(name: string, branch = 'main'): Promise<RemoteFixture> {
  const root = tempDir(`janus-remote-${name}-`);
  const work = join(root, 'work');
  const bare = join(root, `${name}.git`);
  mkdirSync(work);
  await runGit(work, ['init', '-q', '-b', branch]);
  writeFileSync(join(work, 'README.md'), `# ${name}\n`);
  await runGit(work, ['add', '-A']);
  await runGit(work, ['commit', '-q', '-m', 'chore(init): initial commit']);
  const head = await runGit(work, ['rev-parse', 'HEAD']);
  await runGit(root, ['clone', '-q', '--bare', work, bare]);
  return { bare, work, head };
}

/** An empty bare repository whose HEAD points at `branch`. */
export async function createBareRepo(name: string, branch = 'main'): Promise<string> {
  const root = tempDir(`janus-bare-${name}-`);
  const bare = join(root, `${name}.git`);
  await runGit(root, ['init', '-q', '--bare', '-b', branch, bare]);
  return bare;
}
