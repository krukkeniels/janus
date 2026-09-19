import { configSchema } from './config-schema.js';
import type { JanusConfig } from './config-schema.js';
import { ConfigError, formatZodIssues } from './errors.js';
import { readYamlFile } from './yaml.js';

export function parseConfig(raw: unknown, source: string): JanusConfig {
  const result = configSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(source, formatZodIssues(result.error));
  }
  return result.data;
}

export function loadConfig(path: string): JanusConfig {
  return parseConfig(readYamlFile(path), path);
}

export type TokenService = 'teamcity' | 'bitbucket';

export function resolveToken(
  config: JanusConfig,
  service: TokenService,
  env: Record<string, string | undefined>,
): string {
  const variable = config[service].token_env;
  const value = env[variable];
  if (value === undefined || value === '') {
    throw new ConfigError(`${service} token`, [`environment variable ${variable} is not set`]);
  }
  return value;
}
