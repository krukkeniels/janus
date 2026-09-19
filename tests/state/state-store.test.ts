import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { goalSchema } from '../../src/config/goal-schema.js';
import { STATE_FILE } from '../../src/state/files.js';
import { createInitialState } from '../../src/state/state-schema.js';
import { readState, writeState } from '../../src/state/state-store.js';
import { validGoal } from '../fixtures/valid-goal.js';
import { tempDir } from '../helpers/git-fixtures.js';

function freshState() {
  return createInitialState({
    goal: goalSchema.parse(validGoal),
    stateBranch: { name: 'janus/angular-15-to-16', remote: 'state-repo' },
    now: new Date('2026-09-19T12:00:00.000Z'),
  });
}

describe('state store', () => {
  it('writes YAML and reads back an equal state', () => {
    const janusDir = tempDir();
    const state = freshState();
    writeState(janusDir, state);
    expect(readFileSync(join(janusDir, STATE_FILE), 'utf8')).toContain('version: 2');
    expect(readState(janusDir)).toEqual(state);
  });

  it('leaves no temp file behind', () => {
    const janusDir = tempDir();
    writeState(janusDir, freshState());
    expect(readdirSync(janusDir)).toEqual([STATE_FILE]);
  });

  it('reports a missing state file as ConfigError', () => {
    const janusDir = tempDir();
    expect(() => readState(janusDir)).toThrowError(ConfigError);
    expect(existsSync(join(janusDir, STATE_FILE))).toBe(false);
  });

  it('reports schema violations with the field path', () => {
    const janusDir = tempDir();
    writeFileSync(join(janusDir, STATE_FILE), 'version: 3\n');
    try {
      readState(janusDir);
      expect.unreachable('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.some((issue) => issue.startsWith('version:'))).toBe(true);
    }
  });
});
