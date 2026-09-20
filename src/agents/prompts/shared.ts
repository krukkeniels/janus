import type { AgentRole } from '../../config/config-schema.js';
import type { JsonSchema } from '../json-schema.js';
import { outputSchemaFor } from '../output-schema.js';

/**
 * Spec §19: "As in v1, with these additions to 'may not'", plus §32 rule 11. Rendered verbatim into GUARDRAILS
 * AND FORBIDDEN ACTIONS (§18.2) for every role, in every class.
 *
 * Order: the §19 additions first (git writes, writable-root and forbidden-path boundaries, no direct publish, the
 * sync-conflict scope restriction), then v1's unchanged "may not" list, verbatim from
 * `angular-ai-development-workflow-v1.md` §19.
 */
export const FORBIDDEN_ACTIONS: string[] = [
  // §19 (v2 additions to v1's "may not" list)
  'Never run a git write command: no `git commit`, `git add`, `git push`, `git rebase`, `git merge`, `git reset`, `git checkout -b`, `git tag`, `git stash`, `git cherry-pick`, or any other command that moves a ref or rewrites history. Janus commits your work; you only edit files (§32 rule 11: "Agents never commit, push, or otherwise rewrite Git history").',
  'Never modify a file outside the assigned repository or the assigned report directory.',
  'Never change a file under a forbidden path.',
  'Never publish a package directly.',
  'During a sync-conflict task, resolve merge conflicts only; make no other change.',
  // v1 §19 "may not", unchanged by v2
  'Never change product behavior.',
  'Never change acceptance criteria.',
  'Never materially change architecture.',
  'Never expand business scope.',
  'Never upgrade a package beyond the target Angular major.',
  'Never weaken test expectations.',
  'Never remove a failing test to obtain green CI.',
  'Never skip a test to obtain green CI.',
  'Never disable a quality check.',
  'Never change TeamCity configuration to obtain green.',
  'Never create a new baseline exception.',
  'Never merge a pull request.',
];

/** Spec §18.4: "Angular guidance injected into code-writing prompts", rendered as ANGULAR GUIDANCE (§18.2). */
export const ANGULAR_GUIDANCE = [
  'Use the repository’s own package manager, pnpm. Never switch package managers and never hand-edit a lockfile.',
  'Run `ng update` with `--allow-dirty`: the working tree is intentionally uncommitted, because Janus commits, not you.',
  'Expect CLI migrations to touch files across the whole repository. That is normal and in scope.',
  'Never edit CI configuration.',
].join('\n');

function typeName(node: Record<string, unknown>): string {
  const type = node['type'];
  const rendered = Array.isArray(type) ? type.join(' | ') : String(type);
  const enumValues = node['enum'];
  if (Array.isArray(enumValues)) return `${rendered} (one of: ${enumValues.join(', ')})`;
  if (rendered.startsWith('array')) {
    const items = node['items'];
    const itemType = typeof items === 'object' && items !== null ? typeName(items as Record<string, unknown>) : 'string';
    return `${rendered} of ${itemType}`;
  }
  return rendered;
}

/**
 * Spec §18.2 OUTPUT CONTRACT, rendered from the role's generated JSON Schema so a schema change always reaches
 * the prompt. §18.3/§14: every property is required; `null` is how "not applicable" is expressed.
 */
export function outputContractBlock(role: AgentRole): string {
  const schema: JsonSchema = outputSchemaFor(role);
  const properties = schema['properties'];
  if (typeof properties !== 'object' || properties === null) throw new Error(`role ${role} has no output properties`);
  const lines = Object.entries(properties as Record<string, Record<string, unknown>>).map(
    ([key, node]) => `- \`${key}\`: ${typeName(node)}`,
  );
  return [
    'Answer with a single JSON object matching the schema you were given, and nothing else.',
    'Every field below is required. Use `null` (or an empty list) where a field does not apply; never omit a field.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * The fingerprint input for the half of every prompt that does not depend on the role. Editing any shared block
 * changes this, which changes every role's fingerprint, which forces every role's version to be bumped — which is
 * correct, because the rendered prompt really did change for all of them (§18.6).
 */
export const SHARED_BLOCK_TEXT = `${FORBIDDEN_ACTIONS.join('\n')}\n---\n${ANGULAR_GUIDANCE}`;
