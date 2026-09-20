import type { CiProvider } from '../types.js';
import { FAKE_CI_FILE, readFakeStore, writeFakeStore } from './store.js';

/** The key a seeded build is stored under: one build per repo, revision, and build type. */
export function buildKey(repo: string, revision: string, buildTypeId: string): string {
  return `${repo}@${revision}#${buildTypeId}`;
}

export interface FakeCiCall {
  repo: string;
  revision: string;
  build_type_id: string;
  at: string;
  found: string | null;
}

/** The contents of `<workspace>/fake/ci.json`. T09 extends this with outcomes, digests, and triggered builds. */
export interface FakeCiStore {
  /** `buildKey(...)` -> build id. */
  builds: Record<string, string>;
  calls: FakeCiCall[];
}

export function emptyFakeCiStore(): FakeCiStore {
  return { builds: {}, calls: [] };
}

/** Seeds the builds the fake will find, clearing any recorded calls. */
export function seedFakeBuilds(fakeDir: string, builds: Record<string, string>): void {
  const store: FakeCiStore = { builds, calls: [] };
  writeFakeStore(fakeDir, FAKE_CI_FILE, store);
}

export function readFakeCi(fakeDir: string): FakeCiStore {
  return readFakeStore(fakeDir, FAKE_CI_FILE, emptyFakeCiStore());
}

export interface FakeCiProviderInput {
  fakeDir: string;
  now(): Date;
}

/**
 * Spec §3.2 `fake` CI provider, persisted under `fake/ci.json`.
 *
 * T09 replaces it with the full provider (trigger, wait, classify, digest) and the contract suite that
 * `teamcity`, `local`, and `fake` all pass. Like every fake, it never invokes git.
 */
export function createFakeCiProvider(input: FakeCiProviderInput): CiProvider {
  return {
    name: 'fake',
    findBuild: async (repo, revision, buildTypeId) => {
      const store = readFakeCi(input.fakeDir);
      const found = store.builds[buildKey(repo, revision, buildTypeId)] ?? null;
      store.calls.push({ repo, revision, build_type_id: buildTypeId, at: input.now().toISOString(), found });
      writeFakeStore(input.fakeDir, FAKE_CI_FILE, store);
      return found;
    },
  };
}
