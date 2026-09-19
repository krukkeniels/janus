import { ConfigError } from '../config/errors.js';
import type { JanusConfig } from '../config/config-schema.js';
import type { Goal, GoalRepo } from '../config/goal-schema.js';

export interface StateRemote {
  /** Clone URL of the repository that holds the state branch. */
  url: string;
  /** `state-repo` for a dedicated repository, otherwise the name of the goal repo that hosts the branch. */
  remoteName: string;
}

export function stateBranchName(goalId: string): string {
  return `janus/${goalId}`;
}

/** Clone URL for a goal repo: explicit `clone_url`, else the bitbucket template rendered with the lowercase project key. */
export function repoCloneUrl(repo: GoalRepo, config: JanusConfig): string {
  if (repo.clone_url !== undefined) return repo.clone_url;
  if (config.bitbucket.url === undefined) {
    throw new ConfigError('goal.yaml', [`repos.${repo.name}.clone_url: required because bitbucket.url is not configured`]);
  }
  return renderTemplate(config, repo.scm.project, repo.scm.slug);
}

/** Where the state branch lives: `state.clone_url`, else `state.repo` through the template, else the first goal repo. */
export function stateRemote(goal: Goal, config: JanusConfig): StateRemote {
  if (config.state.clone_url !== undefined) {
    return { url: config.state.clone_url, remoteName: 'state-repo' };
  }
  if (config.state.repo !== undefined) {
    if (config.bitbucket.url === undefined) {
      throw new ConfigError('config.yaml', ['state.clone_url: required because bitbucket.url is not configured']);
    }
    return { url: renderTemplate(config, config.state.repo.project, config.state.repo.slug), remoteName: 'state-repo' };
  }
  const first = goal.repos[0];
  if (!first) {
    throw new ConfigError('goal.yaml', ['repos: at least one repo is required to host the state branch']);
  }
  return { url: repoCloneUrl(first, config), remoteName: first.name };
}

function renderTemplate(config: JanusConfig, project: string, slug: string): string {
  const base = (config.bitbucket.url ?? '').replace(/\/+$/, '');
  return config.bitbucket.clone_url_template
    .replace('{url}', base)
    .replace('{project}', project.toLowerCase())
    .replace('{slug}', slug);
}
