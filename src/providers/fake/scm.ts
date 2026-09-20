import type { ScmProvider } from '../types.js';
import { FAKE_SCM_FILE, readFakeStore, writeFakeStore } from './store.js';

/** The account the fake SCM reports; §3.2 uses it to skip Janus's own comments. */
export const FAKE_SCM_USER = 'janus-fake';

export interface FakeScmCall {
  kind: 'currentUser' | 'ensureBranch';
  repo: string | null;
  branch: string | null;
  at: string;
}

/** The contents of `<workspace>/fake/scm.json`. T10 extends this with pull requests, activity, and comments. */
export interface FakeScmStore {
  user: string;
  /** repo -> branch name -> the base it was created from. */
  branches: Record<string, Record<string, string>>;
  calls: FakeScmCall[];
}

export function emptyFakeScmStore(): FakeScmStore {
  return { user: FAKE_SCM_USER, branches: {}, calls: [] };
}

export function readFakeScm(fakeDir: string): FakeScmStore {
  return readFakeStore(fakeDir, FAKE_SCM_FILE, emptyFakeScmStore());
}

export interface FakeScmProviderInput {
  fakeDir: string;
  now(): Date;
}

/**
 * Spec §3.2 `fake` SCM provider, persisted under `fake/scm.json`.
 *
 * T10 replaces it with the full provider. `ensureBranch` only records that a branch should exist: it must never
 * run git, because the orchestrator — not the SCM provider and never an agent — owns every git write (§32 rule 11).
 */
export function createFakeScmProvider(input: FakeScmProviderInput): ScmProvider {
  const record = (store: FakeScmStore, call: FakeScmCall): void => {
    store.calls.push(call);
    writeFakeStore(input.fakeDir, FAKE_SCM_FILE, store);
  };
  return {
    name: 'fake',
    currentUser: async () => {
      const store = readFakeScm(input.fakeDir);
      record(store, { kind: 'currentUser', repo: null, branch: null, at: input.now().toISOString() });
      return store.user;
    },
    ensureBranch: async (repo, name, base) => {
      const store = readFakeScm(input.fakeDir);
      const branches = store.branches[repo] ?? {};
      if (!(name in branches)) branches[name] = base;
      store.branches[repo] = branches;
      record(store, { kind: 'ensureBranch', repo, branch: name, at: input.now().toISOString() });
    },
  };
}
