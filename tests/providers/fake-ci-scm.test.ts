import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildKey, createFakeCiProvider, readFakeCi, seedFakeBuilds } from '../../src/providers/fake/ci.js';
import { createFakeScmProvider, readFakeScm } from '../../src/providers/fake/scm.js';
import { tempDir } from '../helpers/git-fixtures.js';

const clock = () => new Date('2026-09-20T11:00:00.000Z');

describe('createFakeCiProvider', () => {
  it('finds a seeded build, answers null otherwise, and records every lookup', async () => {
    const fakeDir = join(tempDir('janus-fake-'), 'fake');
    seedFakeBuilds(fakeDir, { [buildKey('ui-kit', 'a'.repeat(40), 'Fe_UiKit_Build')]: 'build-17' });
    const ci = createFakeCiProvider({ fakeDir, now: clock });

    expect(await ci.findBuild('ui-kit', 'a'.repeat(40), 'Fe_UiKit_Build')).toBe('build-17');
    expect(await ci.findBuild('ui-kit', 'b'.repeat(40), 'Fe_UiKit_Build')).toBeNull();

    const store = readFakeCi(fakeDir);
    expect(store.calls.map((call) => call.found)).toEqual(['build-17', null]);
    expect(store.calls[0]).toEqual({
      repo: 'ui-kit',
      revision: 'a'.repeat(40),
      build_type_id: 'Fe_UiKit_Build',
      at: '2026-09-20T11:00:00.000Z',
      found: 'build-17',
    });
  });
});

describe('createFakeScmProvider', () => {
  it('reports a stable user and remembers branches across processes without touching git', async () => {
    const fakeDir = join(tempDir('janus-fake-'), 'fake');
    const scm = createFakeScmProvider({ fakeDir, now: clock });

    expect(await scm.currentUser()).toBe('janus-fake');
    await scm.ensureBranch('ui-kit', 'ai/angular-15-to-16', 'main');
    await scm.ensureBranch('ui-kit', 'ai/angular-15-to-16', 'other-base');

    const later = createFakeScmProvider({ fakeDir, now: clock });
    await later.ensureBranch('shell', 'ai/angular-15-to-16', 'main');

    const store = readFakeScm(fakeDir);
    // The first base wins: ensureBranch is "make it exist", not "move it".
    expect(store.branches).toEqual({
      'ui-kit': { 'ai/angular-15-to-16': 'main' },
      shell: { 'ai/angular-15-to-16': 'main' },
    });
    expect(store.calls.map((call) => call.kind)).toEqual(['currentUser', 'ensureBranch', 'ensureBranch', 'ensureBranch']);
  });
});
