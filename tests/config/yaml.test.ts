import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { readYamlFile } from '../../src/config/yaml.js';

function tempDirOnly(): string {
  return mkdtempSync(join(tmpdir(), 'janus-yaml-dir-'));
}

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'janus-yaml-'));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('readYamlFile', () => {
  it('parses a YAML document', () => {
    const path = tempFile('a.yaml', 'workflow:\n  ci_provider: local\n');
    expect(readYamlFile(path)).toEqual({ workflow: { ci_provider: 'local' } });
  });

  it('returns null for an empty file', () => {
    expect(readYamlFile(tempFile('empty.yaml', ''))).toBeNull();
  });

  it('throws ConfigError naming the file when it is missing', () => {
    expect(() => readYamlFile('/nonexistent/config.yaml')).toThrowError(ConfigError);
    expect(() => readYamlFile('/nonexistent/config.yaml')).toThrowError(/file not found/);
  });

  it('throws ConfigError with the parser message for invalid YAML', () => {
    const path = tempFile('bad.yaml', 'a: [1, 2\n');
    expect(() => readYamlFile(path)).toThrowError(ConfigError);
  });

  it('throws ConfigError naming the file when the path is a directory', () => {
    const dir = tempDirOnly();
    expect(() => readYamlFile(dir)).toThrowError(ConfigError);
    expect(() => readYamlFile(dir)).toThrowError(/cannot read file/);
  });
});
