import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { addRemote, clone, initRepo, revParse } from '../git/ops.js';

export interface InitStateRepoInput {
  janusDir: string;
  branch: string;
  remoteUrl: string;
  /** Relative path -> content. Written but not committed; the first checkpoint commits. */
  files: Record<string, string>;
}

/** Creates `.janus/` as a brand-new repository whose only branch is the state branch, with `origin` pointing at the state remote. */
export async function initStateRepo(input: InitStateRepoInput): Promise<void> {
  mkdirSync(input.janusDir, { recursive: true });
  await initRepo(input.janusDir, input.branch);
  await addRemote(input.janusDir, 'origin', input.remoteUrl);
  for (const [relative, content] of Object.entries(input.files)) {
    const path = join(input.janusDir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

export interface OpenStateRepoInput {
  janusDir: string;
  branch: string;
  remoteUrl: string;
}

/** Clones only the state branch into `.janus/` and returns its head sha. */
export async function openStateRepo(input: OpenStateRepoInput): Promise<string> {
  mkdirSync(dirname(input.janusDir), { recursive: true });
  await clone(input.remoteUrl, input.janusDir, { branch: input.branch, singleBranch: true });
  return revParse(input.janusDir, 'HEAD');
}
