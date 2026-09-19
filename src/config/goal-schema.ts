import { z } from 'zod';

export const REPO_KINDS = ['library', 'app', 'shell', 'remote'] as const;
export type RepoKind = (typeof REPO_KINDS)[number];

const kebab = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be kebab-case (lowercase letters, digits, dashes)');

const majorVersion = z.string().regex(/^\d+$/, 'must be a major version number like "16"');

const scmRefSchema = z.object({ project: z.string().min(1), slug: z.string().min(1) }).strict();

const repoSchema = z
  .object({
    name: kebab,
    kind: z.enum(REPO_KINDS),
    scm: scmRefSchema,
    base_branch: z.string().min(1),
    package_name: z.string().min(1).optional(),
    ci: z
      .object({
        pr_build_type_id: z.string().min(1),
        publish_build_type_id: z.string().min(1).optional(),
        release_build_type_id: z.string().min(1).optional(),
      })
      .strict(),
    depends_on: z.array(kebab).default([]),
    coupled_with: z.array(kebab).default([]),
    loads_remotes: z.array(kebab).default([]),
  })
  .strict();

export const goalSchema = z
  .object({
    id: kebab,
    source_version: majorVersion,
    target_version: majorVersion,
    title: z.string().min(1),
    repos: z.array(repoSchema).min(1),
    acknowledged_outside_goal: z
      .array(z.object({ repo: kebab, reason: z.string().min(1) }).strict())
      .default([]),
    e2e: z
      .object({
        build_type_id: z.string().min(1),
        branch_params: z.record(z.string(), z.string().min(1)).default({}),
        extra_params: z.record(z.string(), z.string()).default({}),
        suite_repo_map: z.record(z.string(), z.string().min(1)).default({}),
      })
      .strict(),
    success_criteria: z.array(z.string().min(1)).default([]),
    non_goals: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((goal, ctx) => {
    const numeric = /^\d+$/;
    if (!numeric.test(goal.source_version) || !numeric.test(goal.target_version)) {
      return; // the field-level regex already reported the problem
    }
    const expected = String(Number(goal.source_version) + 1);
    if (goal.target_version !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target_version'],
        message: `must be exactly one major above source_version (expected "${expected}")`,
      });
    }
  });

export type Goal = z.infer<typeof goalSchema>;
export type GoalRepo = Goal['repos'][number];
