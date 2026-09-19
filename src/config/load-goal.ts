import { ConfigError, formatZodIssues } from './errors.js';
import { goalSchema } from './goal-schema.js';
import { validateGoal } from './validate-goal.js';
import type { ValidatedGoal } from './validate-goal.js';
import { readYamlFile } from './yaml.js';

export function loadGoal(path: string): ValidatedGoal {
  const raw = readYamlFile(path);
  const result = goalSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(path, formatZodIssues(result.error));
  }
  return validateGoal(result.data, path);
}
