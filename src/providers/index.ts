import { createCodexAgentRunner } from '../agents/codex/adapter.js';
import type { JanusConfig } from '../config/config-schema.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import { createFakeAgentRunner } from './fake/agent-runner.js';
import { createFakeCiProvider } from './fake/ci.js';
import { createFakeScmProvider } from './fake/scm.js';
import type { Providers } from './types.js';

/** A provider `config.yaml` selects that no task has implemented yet. Maps to exit 3, like a placeholder step. */
export class ProviderNotImplementedError extends Error {
  /** The task that will implement it, for the operator's message. */
  readonly task: string;

  constructor(what: string, task: string, fallback: string) {
    super(`${what} is not implemented yet (planned in ${task}); set ${fallback} in .janus/config.yaml to use the fake`);
    this.name = 'ProviderNotImplementedError';
    this.task = task;
  }
}

export interface CreateProvidersInput {
  config: JanusConfig;
  paths: WorkspacePaths;
  now(): Date;
}

/**
 * Spec §3.2: builds the provider bag for one `janus run` from `workflow.*`. Every fake persists under
 * `<workspace>/fake/` (§5). Real adapters arrive with T05 (Codex), T09 (TeamCity and `local`), and T10 (Bitbucket).
 */
export function createProviders(input: CreateProvidersInput): Providers {
  const { workflow } = input.config;
  const fakeDir = input.paths.fakeDir;
  if (workflow.ci_provider !== 'fake') {
    throw new ProviderNotImplementedError(`CI provider "${workflow.ci_provider}"`, 'T09', 'workflow.ci_provider: fake');
  }
  if (workflow.scm_provider !== 'fake') {
    throw new ProviderNotImplementedError(`SCM provider "${workflow.scm_provider}"`, 'T10', 'workflow.scm_provider: fake');
  }
  const agent =
    workflow.agent_runner === 'codex'
      ? createCodexAgentRunner({ paths: input.paths })
      : createFakeAgentRunner({ paths: input.paths, now: input.now });
  return {
    agent,
    ci: createFakeCiProvider({ fakeDir, now: input.now }),
    scm: createFakeScmProvider({ fakeDir, now: input.now }),
  };
}

export type { AgentOutcome, AgentRunner, AgentTask, CiProvider, Providers, ScmProvider } from './types.js';
