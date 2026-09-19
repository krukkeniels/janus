import { ConfigError } from '../config/errors.js';
import { GitError, runGit } from './run.js';

export interface GitIdentity {
  name: string;
  email: string;
}

/** Parses `Name <email> <timestamp> <tz>` as printed by `git var`. */
export function parseIdent(ident: string): GitIdentity | null {
  const match = /^(.+?) <([^>]+)> \d+ [+-]\d{4}$/.exec(ident);
  if (match === null) return null;
  const [, name = '', email = ''] = match;
  if (name.trim() === '' || email.trim() === '') return null;
  return { name, email };
}

export function formatIdentity(identity: GitIdentity): string {
  return `${identity.name} <${identity.email}>`;
}

/** The committer identity git resolves in `cwd` (user.name/user.email or GIT_COMMITTER_*). Approvals are attributed to it (spec §8). */
export async function gitIdentity(cwd: string): Promise<GitIdentity> {
  let ident: string;
  try {
    ident = await runGit(cwd, ['var', 'GIT_COMMITTER_IDENT']);
  } catch (error) {
    if (error instanceof GitError) {
      throw new ConfigError('git identity', [`git cannot determine who you are (${error.stderr.trim()}); set git config user.name and user.email`]);
    }
    throw error;
  }
  const parsed = parseIdent(ident);
  if (parsed === null) throw new ConfigError('git identity', [`unexpected output from git var GIT_COMMITTER_IDENT: ${ident}`]);
  return parsed;
}
