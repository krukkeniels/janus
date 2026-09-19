import { z } from 'zod';

export const AGENT_ROLES = [
  'implementation',
  'debug',
  'fix',
  'sync_conflict',
  'discovery',
  'planning',
  'checkpoint',
  'review',
  'triage',
  'qa',
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export const DEFAULT_DISCOVERY_AREAS = ['deps-and-build', 'tests-and-e2e', 'architecture-and-ci'];

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

const roleTimeout = (minutes: number) =>
  z.object({ timeout_minutes: positiveInt.default(minutes) }).strict().default({});

const modelSpecSchema = z
  .object({
    model: z.string().min(1),
    effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('high'),
    ladder: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export type ModelSpec = z.infer<typeof modelSpecSchema>;

const modelProfileSchema = z.record(z.string(), modelSpecSchema).superRefine((profile, ctx) => {
  for (const role of Object.keys(profile)) {
    if (role !== '*' && !(AGENT_ROLES as readonly string[]).includes(role)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [role], message: `unknown agent role; expected "*" or one of ${AGENT_ROLES.join(', ')}` });
    }
  }
  if (!('*' in profile)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must define a "*" entry used for roles without an explicit model' });
  }
});

const priceSchema = z
  .object({
    input_per_million: z.number().nonnegative(),
    cached_input_per_million: z.number().nonnegative(),
    output_per_million: z.number().nonnegative(),
    reasoning_per_million: z.number().nonnegative(),
  })
  .strict();

export const configSchema = z
  .object({
    workflow: z
      .object({
        agent_runner: z.enum(['codex', 'fake']).default('codex'),
        ci_provider: z.enum(['teamcity', 'local', 'fake']).default('teamcity'),
        scm_provider: z.enum(['bitbucket-server', 'fake']).default('bitbucket-server'),
        create_prs_early: z.boolean().default(true),
      })
      .strict()
      .default({}),
    state: z
      .object({
        repo: z.object({ project: z.string().min(1), slug: z.string().min(1) }).strict().optional(),
        clone_url: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    teamcity: z
      .object({
        url: z.string().url().optional(),
        token_env: z.string().min(1).default('JANUS_TEAMCITY_TOKEN'),
        poll_interval_seconds: positiveInt.default(30),
        appearance_timeout_minutes: positiveInt.default(5),
        build_timeout_minutes: positiveInt.default(90),
        e2e_timeout_minutes: positiveInt.default(240),
      })
      .strict()
      .default({}),
    bitbucket: z
      .object({
        url: z.string().url().optional(),
        token_env: z.string().min(1).default('JANUS_BITBUCKET_TOKEN'),
        required_reviewers: z.array(z.string().min(1)).default([]),
        clone_url_template: z.string().min(1).default('{url}/scm/{project}/{slug}.git'),
      })
      .strict()
      .default({}),
    local_ci: z
      .object({
        repos: z
          .record(
            z.string(),
            z
              .object({
                install: z.string().min(1).optional(),
                build: z.string().min(1).optional(),
                test: z.string().min(1).optional(),
                lint: z.string().min(1).optional(),
              })
              .strict(),
          )
          .default({}),
        e2e: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    discovery: z
      .object({ areas: z.array(z.string().min(1)).min(1).default(DEFAULT_DISCOVERY_AREAS) })
      .strict()
      .default({}),
    agents: z
      .object({
        max_parallel: positiveInt.default(4),
        max_context_bytes: positiveInt.default(200_000),
        max_inline_diff_bytes: positiveInt.default(60_000),
        pnpm_store: z.enum(['workspace', 'global']).default('workspace'),
        allow_unsandboxed: z.boolean().default(false),
        roles: z
          .object({
            implementation: roleTimeout(60),
            debug: roleTimeout(45),
            fix: roleTimeout(45),
            sync_conflict: roleTimeout(30),
            discovery: roleTimeout(30),
            planning: roleTimeout(45),
            checkpoint: roleTimeout(20),
            review: roleTimeout(60),
            triage: roleTimeout(20),
            qa: roleTimeout(30),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    workflow_models: z.object({ profile: z.string().min(1).default('default') }).strict().default({}),
    model_profiles: z
      .record(z.string(), modelProfileSchema)
      .default({ default: { '*': { model: 'gpt-5.6-sol', effort: 'high' } } }),
    experiment: z
      .object({
        id: z.string().min(1).nullable().default(null),
        hypothesis: z.string().nullable().default(null),
        notes: z.string().nullable().default(null),
      })
      .strict()
      .default({}),
    policy: z
      .object({
        forbidden_test_patterns: z
          .array(z.string().min(1))
          .default(['xit(', 'xdescribe(', 'fit(', 'fdescribe(', '.skip(', '.only(']),
        forbidden_paths: z.array(z.string().min(1)).default(['.teamcity/**', '.github/**']),
        max_test_count_decrease_percent: z.number().min(0).max(100).default(0),
        allow_test_file_deletion: z.boolean().default(false),
      })
      .strict()
      .default({}),
    digest: z
      .object({
        max_tests: positiveInt.default(50),
        log_tail_lines: positiveInt.default(400),
        max_error_windows: positiveInt.default(10),
        max_bytes: positiveInt.default(65_536),
        redact: z.boolean().default(true),
      })
      .strict()
      .default({}),
    guardrails: z
      .object({
        max_ci_fix_attempts: positiveInt.default(5),
        max_e2e_fix_attempts: positiveInt.default(3),
        max_ai_review_cycles: positiveInt.default(3),
        max_no_progress_iterations: positiveInt.default(2),
        max_work_packages_without_green: positiveInt.default(3),
        max_policy_violations_per_package: positiveInt.default(2),
        max_sync_conflict_attempts: positiveInt.default(2),
        max_infra_retries: nonNegativeInt.default(1),
        max_agent_runtime_minutes: positiveInt.default(60),
        max_changed_files: positiveInt.nullable().default(null),
        max_diff_lines: positiveInt.nullable().default(null),
        max_goal_runtime_hours: positiveInt.nullable().default(null),
      })
      .strict()
      .default({}),
    telemetry: z
      .object({ price_table: z.record(z.string(), priceSchema).nullable().default(null) })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    const ciProviders = ['teamcity', 'local', 'fake'] as const;
    const scmProviders = ['bitbucket-server', 'fake'] as const;
    if (
      (ciProviders as readonly string[]).includes(config.workflow.ci_provider) &&
      config.workflow.ci_provider === 'teamcity' &&
      config.teamcity.url === undefined
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['teamcity', 'url'], message: 'required when workflow.ci_provider is "teamcity"' });
    }
    if (
      (scmProviders as readonly string[]).includes(config.workflow.scm_provider) &&
      config.workflow.scm_provider === 'bitbucket-server' &&
      config.bitbucket.url === undefined
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bitbucket', 'url'], message: 'required when workflow.scm_provider is "bitbucket-server"' });
    }
    if (config.workflow_models.profile.length > 0 && !(config.workflow_models.profile in config.model_profiles)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workflow_models', 'profile'],
        message: `model profile "${config.workflow_models.profile}" is not defined in model_profiles`,
      });
    }
    const ceiling = config.guardrails.max_agent_runtime_minutes;
    if (Number.isInteger(ceiling) && ceiling > 0) {
      for (const role of AGENT_ROLES) {
        if (config.agents.roles[role].timeout_minutes > ceiling) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['agents', 'roles', role, 'timeout_minutes'],
            message: `must not exceed guardrails.max_agent_runtime_minutes (${ceiling})`,
          });
        }
      }
    }
  });

export type JanusConfig = z.infer<typeof configSchema>;
