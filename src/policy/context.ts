import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JanusConfig } from '../config/config-schema.js';
import { GitError, runGit } from '../git/run.js';
import type { DiffAnalysis } from './diff.js';
import type { PolicyCheckContext } from './types.js';

export interface BuildPolicyContextInput {
  /** The repository work tree the diff came from. */
  cwd: string;
  analysis: DiffAnalysis;
  config: JanusConfig;
  /** `goal.target_version` as a number. */
  targetVersion: number;
  /** The work package's `allowed_scope` (§12), or null before a plan is approved. */
  allowedScope: readonly string[] | null;
  /** §14: "violation unless the package allows it". Defaults to `config.policy.allow_test_file_deletion`. */
  allowTestFileDeletion?: boolean;
}

/**
 * The production `PolicyCheckContext`: the two file-content seams are `git show HEAD:<path>` and an ordinary
 * read of the work tree.
 *
 * `HEAD:${path}` is safe for every path git can report, including one starting with `-`, because the `HEAD:`
 * prefix means the argument never begins with a dash. A path that did not exist at HEAD makes `git show` exit
 * 128, which is read as "absent" rather than propagated — that is the normal case for a newly added test file.
 */
export function buildPolicyContext(input: BuildPolicyContextInput): PolicyCheckContext {
  return {
    analysis: input.analysis,
    config: input.config,
    targetVersion: input.targetVersion,
    allowedScope: input.allowedScope,
    allowTestFileDeletion: input.allowTestFileDeletion ?? input.config.policy.allow_test_file_deletion,
    readHead: async (path) => {
      try {
        return await runGit(input.cwd, ['show', `HEAD:${path}`]);
      } catch (error) {
        if (error instanceof GitError && error.exitCode === 128) return null;
        throw error;
      }
    },
    readWorking: async (path) => {
      try {
        return await readFile(join(input.cwd, path), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  };
}
