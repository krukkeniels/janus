import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { ConfigError } from './errors.js';

export function readYamlFile(path: string): unknown {
  if (!existsSync(path)) {
    throw new ConfigError(path, ['file not found']);
  }
  const text = readFileSync(path, 'utf8');
  try {
    return parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(path, [`invalid YAML: ${message}`]);
  }
}
