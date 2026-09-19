import { describe, expect, it } from 'vitest';
import { parseDuration } from '../../src/cli/duration.js';
import { ConfigError } from '../../src/config/errors.js';

describe('parseDuration', () => {
  it('parses ms, s, m, and h', () => {
    expect(parseDuration('500ms', '--max-wait')).toBe(500);
    expect(parseDuration('30s', '--max-wait')).toBe(30_000);
    expect(parseDuration('45m', '--max-wait')).toBe(2_700_000);
    expect(parseDuration('2h', '--max-wait')).toBe(7_200_000);
    expect(parseDuration(' 1m ', '--max-wait')).toBe(60_000);
  });

  it('rejects anything else with the option name', () => {
    for (const bad of ['', '45', 'm', '1.5h', '-1m', '1d']) {
      expect(() => parseDuration(bad, '--max-wait')).toThrow(ConfigError);
      expect(() => parseDuration(bad, '--max-wait')).toThrow(`--max-wait: 1 problem(s)`);
    }
  });
});
