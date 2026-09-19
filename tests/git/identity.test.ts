import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatIdentity, gitIdentity, parseIdent } from '../../src/git/identity.js';
import { initRepo } from '../../src/git/ops.js';
import { tempDir } from '../helpers/git-fixtures.js';

describe('parseIdent', () => {
  it('parses the output of git var', () => {
    expect(parseIdent('Janus Test <janus@test.invalid> 1789000000 +0200')).toEqual({ name: 'Janus Test', email: 'janus@test.invalid' });
    expect(parseIdent('A B C <a@b.c> 1 -0000')).toEqual({ name: 'A B C', email: 'a@b.c' });
  });

  it('rejects malformed or empty identities', () => {
    expect(parseIdent('')).toBeNull();
    expect(parseIdent('nobody')).toBeNull();
    expect(parseIdent(' <a@b.c> 1 +0000')).toBeNull();
    expect(parseIdent('Name <> 1 +0000')).toBeNull();
  });

  it('formats as Name <email>', () => {
    expect(formatIdentity({ name: 'Janus Test', email: 'janus@test.invalid' })).toBe('Janus Test <janus@test.invalid>');
  });
});

describe('gitIdentity', () => {
  it('reads the committer identity git would use in a repo', async () => {
    const dir = join(tempDir(), 'repo');
    mkdirSync(dir);
    await initRepo(dir, 'main');
    expect(await gitIdentity(dir)).toEqual({ name: 'Janus Test', email: 'janus@test.invalid' });
  });
});
