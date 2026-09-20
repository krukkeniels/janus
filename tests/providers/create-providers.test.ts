import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { createProviders, ProviderNotImplementedError } from '../../src/providers/index.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { tempDir } from '../helpers/git-fixtures.js';

const paths = () => workspacePaths(tempDir('janus-providers-'));
const now = () => new Date('2026-09-20T12:00:00.000Z');

function config(workflow: Record<string, string>) {
  return configSchema.parse({ workflow, teamcity: { url: 'https://tc.invalid' }, bitbucket: { url: 'https://bb.invalid' } });
}

describe('createProviders', () => {
  it('builds the three fakes rooted at the workspace fake/ directory', () => {
    const providers = createProviders({
      config: config({ agent_runner: 'fake', ci_provider: 'fake', scm_provider: 'fake' }),
      paths: paths(),
      now,
    });
    expect(providers.agent.name).toBe('fake');
    expect(providers.ci.name).toBe('fake');
    expect(providers.scm.name).toBe('fake');
  });

  it('names the task that will implement each real provider', () => {
    const attempt = (workflow: Record<string, string>): ProviderNotImplementedError => {
      try {
        createProviders({ config: config(workflow), paths: paths(), now });
      } catch (error) {
        if (error instanceof ProviderNotImplementedError) return error;
        throw error;
      }
      throw new Error('expected createProviders to throw');
    };

    const agent = attempt({ agent_runner: 'codex', ci_provider: 'fake', scm_provider: 'fake' });
    expect(agent.task).toBe('T05');
    expect(agent.message).toContain('agent runner "codex" is not implemented yet (planned in T05)');
    expect(agent.message).toContain('workflow.agent_runner: fake');

    expect(attempt({ agent_runner: 'fake', ci_provider: 'teamcity', scm_provider: 'fake' }).task).toBe('T09');
    expect(attempt({ agent_runner: 'fake', ci_provider: 'local', scm_provider: 'fake' }).task).toBe('T09');
    expect(attempt({ agent_runner: 'fake', ci_provider: 'fake', scm_provider: 'bitbucket-server' }).task).toBe('T10');
  });
});
