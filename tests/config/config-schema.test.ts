import { describe, expect, it } from 'vitest';
import { AGENT_ROLES, configSchema } from '../../src/config/config-schema.js';
import { formatZodIssues } from '../../src/config/errors.js';

function issuesOf(input: unknown): string[] {
  const result = configSchema.safeParse(input);
  return result.success ? [] : formatZodIssues(result.error);
}

describe('configSchema', () => {
  it('applies every default to a config that only selects fake providers', () => {
    const config = configSchema.parse({
      workflow: { agent_runner: 'fake', ci_provider: 'fake', scm_provider: 'fake' },
    });
    expect(config.workflow.create_prs_early).toBe(true);
    expect(config.teamcity.poll_interval_seconds).toBe(30);
    expect(config.teamcity.token_env).toBe('JANUS_TEAMCITY_TOKEN');
    expect(config.bitbucket.token_env).toBe('JANUS_BITBUCKET_TOKEN');
    expect(config.agents.max_parallel).toBe(4);
    expect(config.agents.roles.implementation.timeout_minutes).toBe(60);
    expect(config.agents.roles.checkpoint.timeout_minutes).toBe(20);
    expect(config.discovery.areas).toEqual(['deps-and-build', 'tests-and-e2e', 'architecture-and-ci']);
    expect(config.workflow_models.profile).toBe('default');
    expect(config.model_profiles.default?.['*']?.model).toBe('gpt-5.6-sol');
    expect(config.guardrails.max_ci_fix_attempts).toBe(5);
    expect(config.guardrails.max_infra_retries).toBe(1);
    expect(config.digest.max_bytes).toBe(65536);
    expect(config.digest.redact).toBe(true);
    expect(config.policy.forbidden_paths).toEqual(['.teamcity/**', '.github/**']);
    expect(config.experiment.id).toBeNull();
    expect(config.telemetry.price_table).toBeNull();
  });

  it('defaults providers to codex, teamcity, and bitbucket-server and then requires urls', () => {
    const issues = issuesOf({});
    expect(issues).toContain('teamcity.url: required when workflow.ci_provider is "teamcity"');
    expect(issues).toContain('bitbucket.url: required when workflow.scm_provider is "bitbucket-server"');
  });

  it('accepts real providers when urls are present', () => {
    const issues = issuesOf({
      teamcity: { url: 'https://teamcity.example.internal' },
      bitbucket: { url: 'https://bitbucket.example.internal' },
    });
    expect(issues).toEqual([]);
  });

  it('rejects unknown keys anywhere', () => {
    const issues = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake', bogus: 1 },
    });
    expect(issues.some((issue) => issue.startsWith('workflow: Unrecognized key'))).toBe(true);
  });

  it('rejects a selected model profile that does not exist', () => {
    const issues = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      workflow_models: { profile: 'missing' },
    });
    expect(issues).toContain('workflow_models.profile: model profile "missing" is not defined in model_profiles');
  });

  it('requires every model profile to have a "*" fallback', () => {
    const issues = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      model_profiles: { default: { implementation: { model: 'gpt-5.6-sol' } } },
    });
    expect(issues).toContain('model_profiles.default: must define a "*" entry used for roles without an explicit model');
  });

  it('rejects a role timeout above max_agent_runtime_minutes', () => {
    const issues = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      agents: { roles: { implementation: { timeout_minutes: 90 } } },
      guardrails: { max_agent_runtime_minutes: 60 },
    });
    expect(issues).toContain('agents.roles.implementation.timeout_minutes: must not exceed guardrails.max_agent_runtime_minutes (60)');
  });

  it('rejects an unknown role name inside a model profile', () => {
    const issues = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      model_profiles: { default: { '*': { model: 'x' }, tester: { model: 'y' } } },
    });
    expect(issues.some((issue) => issue.startsWith('model_profiles.default.tester'))).toBe(true);
  });

  it('does not cascade timeout-ceiling noise when max_agent_runtime_minutes itself is invalid', () => {
    const issues = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      guardrails: { max_agent_runtime_minutes: 0 },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.startsWith('guardrails.max_agent_runtime_minutes')).toBe(true);
  });

  it('does not cascade a profile-existence issue when workflow_models.profile itself is invalid', () => {
    const issues = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      workflow_models: { profile: '' },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.startsWith('workflow_models.profile')).toBe(true);
  });

  it('knows the twelve §18.1 agent roles and gives each a default timeout', () => {
    const config = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } });
    expect(AGENT_ROLES).toEqual([
      'discovery',
      'integration_discovery',
      'planning',
      'replanning',
      'implementation',
      'debug',
      'fix',
      'sync_conflict',
      'checkpoint',
      'review',
      'triage',
      'qa',
    ]);
    expect(config.agents.roles.integration_discovery.timeout_minutes).toBe(30);
    expect(config.agents.roles.replanning.timeout_minutes).toBe(45);
    for (const role of AGENT_ROLES) {
      expect(config.agents.roles[role].timeout_minutes).toBeGreaterThan(0);
    }
  });

  it('accepts a model profile entry for a newly added role and rejects an unknown one', () => {
    const ok = configSchema.safeParse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      model_profiles: { default: { '*': { model: 'm' }, replanning: { model: 'm', effort: 'low' } } },
    });
    expect(ok.success).toBe(true);
    const bad = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      model_profiles: { default: { '*': { model: 'm' }, integration: { model: 'm' } } },
    });
    expect(bad.some((issue) => issue.startsWith('model_profiles.default.integration'))).toBe(true);
  });

  it('applies the runtime ceiling to the new roles too', () => {
    const issues = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      agents: { roles: { replanning: { timeout_minutes: 90 } } },
    });
    expect(issues).toContain('agents.roles.replanning.timeout_minutes: must not exceed guardrails.max_agent_runtime_minutes (60)');
  });
});
