import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { ConfigError, formatZodIssues } from '../config/errors.js';
import { readYamlFile } from '../config/yaml.js';
import { STATE_FILE } from './files.js';
import { stateSchema } from './state-schema.js';
import type { JanusState } from './state-schema.js';

export function statePath(janusDir: string): string {
  return join(janusDir, STATE_FILE);
}

export function readState(janusDir: string): JanusState {
  const path = statePath(janusDir);
  const result = stateSchema.safeParse(readYamlFile(path) ?? {});
  if (!result.success) {
    throw new ConfigError(path, formatZodIssues(result.error));
  }
  return result.data;
}

/** Writes the state to a temp file in the same directory and renames it into place, so readers never see a partial file. */
export function writeState(janusDir: string, state: JanusState): void {
  const path = statePath(janusDir);
  const temp = `${path}.tmp`;
  writeFileSync(temp, stringify(state, { lineWidth: 0 }));
  renameSync(temp, path);
}
