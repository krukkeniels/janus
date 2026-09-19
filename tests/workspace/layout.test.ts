import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { createWorkspaceDirs, ensureEmptyOrMissing, workspacePaths } from '../../src/workspace/layout.js';
import { tempDir } from '../helpers/git-fixtures.js';

describe('workspacePaths', () => {
  it('derives every path from an absolute root', () => {
    const root = join(tempDir(), 'ws');
    const paths = workspacePaths(root);
    expect(paths.root).toBe(root);
    expect(paths.janusDir).toBe(join(root, '.janus'));
    expect(paths.reposDir).toBe(join(root, 'repos'));
    expect(paths.repoDir('shell')).toBe(join(root, 'repos', 'shell'));
    expect(paths.fakeDir).toBe(join(root, 'fake'));
    expect(paths.pnpmStoreDir).toBe(join(root, '.pnpm-store'));
    expect(paths.lockFile).toBe(join(root, 'janus.lock'));
  });

  it('resolves a relative root against the process cwd', () => {
    expect(workspacePaths('rel').root).toBe(join(process.cwd(), 'rel'));
  });
});

describe('createWorkspaceDirs', () => {
  it('creates repos, fake, and pnpm store directories but not .janus', () => {
    const paths = workspacePaths(join(tempDir(), 'ws'));
    createWorkspaceDirs(paths);
    expect(existsSync(paths.reposDir)).toBe(true);
    expect(existsSync(paths.fakeDir)).toBe(true);
    expect(existsSync(paths.pnpmStoreDir)).toBe(true);
    expect(existsSync(paths.janusDir)).toBe(false);
  });
});

describe('ensureEmptyOrMissing', () => {
  it('accepts a missing or empty directory', () => {
    const missing = join(tempDir(), 'missing');
    expect(() => ensureEmptyOrMissing(missing)).not.toThrow();
    const empty = join(tempDir(), 'empty');
    mkdirSync(empty);
    expect(() => ensureEmptyOrMissing(empty)).not.toThrow();
  });

  it('rejects a non-empty directory with a ConfigError naming it', () => {
    const full = join(tempDir(), 'full');
    mkdirSync(full);
    writeFileSync(join(full, 'x'), 'x');
    expect(() => ensureEmptyOrMissing(full)).toThrowError(ConfigError);
    expect(() => ensureEmptyOrMissing(full)).toThrowError(/exists and is not empty/);
  });

  it('treats a directory containing only janus.lock as empty', () => {
    const dir = join(tempDir(), 'locked');
    mkdirSync(dir);
    writeFileSync(join(dir, 'janus.lock'), '{}');
    expect(() => ensureEmptyOrMissing(dir)).not.toThrow();
  });
});
