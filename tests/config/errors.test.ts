import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, formatZodIssues } from '../../src/config/errors.js';

describe('ConfigError', () => {
  it('lists every issue in its message', () => {
    const error = new ConfigError('config.yaml', ['teamcity.url: required', 'agents.max_parallel: must be positive']);
    expect(error.name).toBe('ConfigError');
    expect(error.source).toBe('config.yaml');
    expect(error.issues).toHaveLength(2);
    expect(error.message).toBe(
      'config.yaml: 2 problem(s)\n  - teamcity.url: required\n  - agents.max_parallel: must be positive',
    );
  });
});

describe('formatZodIssues', () => {
  it('joins paths with dots and uses <root> for top-level issues', () => {
    const schema = z.object({ a: z.object({ b: z.number() }) }).strict();
    const result = schema.safeParse({ a: { b: 'x' }, extra: 1 });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issues = formatZodIssues(result.error);
    expect(issues).toContain('a.b: Expected number, received string');
    expect(issues.some((issue) => issue.startsWith("<root>: Unrecognized key(s) in object: 'extra'"))).toBe(true);
  });
});
