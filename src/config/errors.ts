import type { ZodError } from 'zod';

export class ConfigError extends Error {
  readonly source: string;
  readonly issues: string[];

  constructor(source: string, issues: string[]) {
    const lines = issues.map((issue) => `  - ${issue}`).join('\n');
    super(`${source}: ${issues.length} problem(s)\n${lines}`);
    this.name = 'ConfigError';
    this.source = source;
    this.issues = issues;
  }
}

export function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${path}: ${issue.message}`;
  });
}
