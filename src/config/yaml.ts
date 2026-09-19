import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { ConfigError } from './errors.js';

export function readYamlFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(path, ['file not found']);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(path, [`cannot read file: ${message}`]);
  }
  try {
    return parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(path, [`invalid YAML: ${message}`]);
  }
}
