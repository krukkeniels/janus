import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { loadConfig, parseConfig, resolveToken } from '../../src/config/load-config.js';

function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'janus-config-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, content);
  return path;
}

describe('parseConfig', () => {
  it('treats null as an empty config', () => {
    expect(() => parseConfig(null, 'config.yaml')).toThrowError(ConfigError);
    const config = parseConfig({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } }, 'config.yaml');
    expect(config.workflow.ci_provider).toBe('fake');
  });

  it('wraps schema issues in ConfigError naming the source', () => {
    try {
      parseConfig({ agents: { max_parallel: 0 }, workflow: { ci_provider: 'fake', scm_provider: 'fake' } }, 'my.yaml');
      expect.unreachable('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.source).toBe('my.yaml');
      expect(configError.issues.some((issue) => issue.startsWith('agents.max_parallel:'))).toBe(true);
    }
  });
});

describe('loadConfig', () => {
  it('loads a file and applies defaults', () => {
    const path = tempFile('workflow:\n  ci_provider: local\n  scm_provider: fake\n');
    const config = loadConfig(path);
    expect(config.workflow.ci_provider).toBe('local');
    expect(config.guardrails.max_ci_fix_attempts).toBe(5);
  });

  it('reports the path when the file is invalid', () => {
    const path = tempFile('workflow:\n  ci_provider: nope\n');
    expect(() => loadConfig(path)).toThrowError(new RegExp(path.replace(/[/\\]/g, '.')));
  });
});

describe('resolveToken', () => {
  const config = parseConfig(
    {
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      teamcity: { token_env: 'MY_TC_TOKEN' },
    },
    'config.yaml',
  );

  it('reads the configured environment variable', () => {
    expect(resolveToken(config, 'teamcity', { MY_TC_TOKEN: 'secret' })).toBe('secret');
    expect(resolveToken(config, 'bitbucket', { JANUS_BITBUCKET_TOKEN: 'bb' })).toBe('bb');
  });

  it('throws ConfigError naming the variable when unset or empty', () => {
    expect(() => resolveToken(config, 'teamcity', {})).toThrowError(/MY_TC_TOKEN is not set/);
    expect(() => resolveToken(config, 'teamcity', { MY_TC_TOKEN: '' })).toThrowError(ConfigError);
  });
});
