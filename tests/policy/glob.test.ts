import { describe, expect, it } from 'vitest';
import { matchesAnyGlob, matchesGlob } from '../../src/policy/glob.js';

describe('matchesGlob', () => {
  it('matches an exact path', () => {
    expect(matchesGlob('package.json', 'package.json')).toBe(true);
    expect(matchesGlob('package.json', 'projects/lib/package.json')).toBe(false);
  });

  it('treats a trailing double star as everything underneath', () => {
    expect(matchesGlob('.teamcity/**', '.teamcity/settings.kts')).toBe(true);
    expect(matchesGlob('.teamcity/**', '.teamcity/a/b/c.kts')).toBe(true);
    expect(matchesGlob('.teamcity/**', '.teamcityrc')).toBe(false);
    expect(matchesGlob('src/**', 'src/app/app.component.ts')).toBe(true);
  });

  it('lets a leading double star stand in for zero or more leading segments', () => {
    expect(matchesGlob('**/*.spec.ts', 'a.spec.ts')).toBe(true);
    expect(matchesGlob('**/*.spec.ts', 'src/app/a.spec.ts')).toBe(true);
    expect(matchesGlob('**/*.spec.ts', 'src/app/a.ts')).toBe(false);
  });

  it('keeps a single star inside one path segment', () => {
    expect(matchesGlob('tsconfig*.json', 'tsconfig.app.json')).toBe(true);
    expect(matchesGlob('tsconfig*.json', 'tsconfig.json')).toBe(true);
    expect(matchesGlob('*.json', 'src/a.json')).toBe(false);
  });

  it('matches exactly one character for a question mark', () => {
    expect(matchesGlob('jest.config.?s', 'jest.config.js')).toBe(true);
    expect(matchesGlob('jest.config.?s', 'jest.config.mjs')).toBe(false);
  });

  it('treats regex metacharacters in the pattern as literals', () => {
    expect(matchesGlob('a+b.txt', 'a+b.txt')).toBe(true);
    expect(matchesGlob('a+b.txt', 'aab.txt')).toBe(false);
    expect(matchesGlob('a.txt', 'axtxt')).toBe(false);
  });

  it('matches paths with spaces and non-ASCII characters', () => {
    expect(matchesGlob('src/**', 'src/with space.ts')).toBe(true);
    expect(matchesGlob('src/**', 'src/æøå.ts')).toBe(true);
  });
});

describe('matchesAnyGlob', () => {
  it('is false for an empty pattern list', () => {
    expect(matchesAnyGlob([], 'src/a.ts')).toBe(false);
  });

  it('is true when any pattern matches', () => {
    expect(matchesAnyGlob(['package.json', 'src/**'], 'src/a.ts')).toBe(true);
  });
});
