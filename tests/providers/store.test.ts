import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_AGENTS_FILE, fakeStorePath, readFakeStore, writeFakeStore } from '../../src/providers/fake/store.js';
import { tempDir } from '../helpers/git-fixtures.js';

describe('fake provider store', () => {
  it('round-trips through <workspace>/fake/<file> and creates the directory', () => {
    const fakeDir = join(tempDir('janus-fake-'), 'fake');
    expect(readFakeStore(fakeDir, FAKE_AGENTS_FILE, { calls: 0 })).toEqual({ calls: 0 });
    writeFakeStore(fakeDir, FAKE_AGENTS_FILE, { calls: 3 });
    expect(existsSync(fakeStorePath(fakeDir, FAKE_AGENTS_FILE))).toBe(true);
    expect(readFakeStore(fakeDir, FAKE_AGENTS_FILE, { calls: 0 })).toEqual({ calls: 3 });
    expect(JSON.parse(readFileSync(fakeStorePath(fakeDir, FAKE_AGENTS_FILE), 'utf8'))).toEqual({
      version: 1,
      data: { calls: 3 },
    });
  });

  it('falls back instead of throwing on a corrupt or foreign-version file', () => {
    const fakeDir = join(tempDir('janus-fake-'), 'fake');
    writeFakeStore(fakeDir, FAKE_AGENTS_FILE, { calls: 1 });
    writeFileSync(fakeStorePath(fakeDir, FAKE_AGENTS_FILE), '{ not json');
    expect(readFakeStore(fakeDir, FAKE_AGENTS_FILE, { calls: 0 })).toEqual({ calls: 0 });
    writeFileSync(fakeStorePath(fakeDir, FAKE_AGENTS_FILE), JSON.stringify({ version: 2, data: { calls: 9 } }));
    expect(readFakeStore(fakeDir, FAKE_AGENTS_FILE, { calls: 0 })).toEqual({ calls: 0 });
  });
});
