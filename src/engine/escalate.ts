import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckpointResult } from '../state/checkpoint.js';
import { ESCALATION_FILE } from '../state/files.js';
import { BUDGET_NAMES } from '../state/state-schema.js';
import type { GoalStatus, JanusState } from '../state/state-schema.js';
import type { GuardrailHit } from './budgets.js';
import { enterStage } from './engine.js';
import type { Engine } from './engine.js';

export interface EscalationInput {
  reason: string;
  repo: string | null;
  guardrail: GuardrailHit | null;
}

export interface EscalationResult {
  from: GoalStatus;
  file: string;
  checkpoint: CheckpointResult;
}

/**
 * Spec §25: records the escalation and moves the goal to `escalated`. Writes a stub `escalation.md`; the full
 * package renderer (digests, agent summaries) arrives with T13 and replaces `renderEscalationStub`.
 */
export async function escalate(engine: Engine, input: EscalationInput): Promise<EscalationResult> {
  const { state, paths } = engine.workspace;
  const from = state.goal.status;
  const now = engine.now();
  if (input.guardrail !== null) {
    engine.emit({
      type: 'guardrail.hit',
      guardrail: input.guardrail.guardrail,
      value: input.guardrail.value,
      limit: input.guardrail.limit,
      detail: input.guardrail.detail,
    });
  }
  const file = join(paths.janusDir, ESCALATION_FILE);
  writeFileSync(file, renderEscalationStub(state, input, now));
  engine.emit({
    type: 'escalation.created',
    reason: input.reason,
    stage: from,
    repo: input.repo,
    work_package: state.execution.current_work_package,
  });
  enterStage(engine, 'escalated');
  engine.warn(`escalated from ${from}: ${input.reason}`);
  const result = await engine.checkpoint(`chore(janus): escalate from ${from}`, {
    at: now.toISOString(),
    by: 'janus',
    title: 'Escalated',
    body: `${input.reason}\n\nStage: ${from}. See escalation.md.`,
  });
  return { from, file, checkpoint: result };
}

export function renderEscalationStub(state: JanusState, input: EscalationInput, now: Date): string {
  const guardrail =
    input.guardrail === null
      ? 'none'
      : `${input.guardrail.guardrail} ${input.guardrail.value}/${input.guardrail.limit} (${input.guardrail.detail})`;
  const lines = [
    '# Escalation',
    '',
    `Created ${now.toISOString()} from stage \`${state.goal.status}\` of goal ${state.goal.id}.`,
    '',
    '## Reason',
    '',
    input.reason,
    '',
    '## Context',
    '',
    `- Repo: ${input.repo ?? '-'}`,
    `- Work package: ${state.execution.current_work_package ?? '-'}`,
    `- Verification group: ${state.execution.current_verification_group ?? '-'}`,
    `- Guardrail: ${guardrail}`,
    '',
    '## Budget snapshot',
    '',
    '| Budget | Value |',
    '|---|---|',
    ...BUDGET_NAMES.map((name) => `| ${name} | ${state.execution.budgets[name]} |`),
    '',
    '## Next',
    '',
    'Read the reason above, decide a direction, and run `janus escalation resolve --direction "..."` (planned in T13).',
    'This is a stub package; the full escalation renderer with digests and agent summaries arrives with T13.',
    '',
  ];
  return lines.join('\n');
}
