import { describe, expect, it } from 'vitest';
import { AGENT_ROLES } from '../../src/config/config-schema.js';
import { asFixResult, outputSchemaFor, resultSchemaFor, validateAgentResult } from '../../src/agents/output-schema.js';

const MINIMUM = {
  status: 'completed',
  summary: 'upgraded ui-kit to Angular 16',
  changes_made: ['package.json: raised @angular/core to 16.2.12'],
  findings: [],
  evidence: ['reports/run-0001/ng-update.log'],
  new_tasks: [],
  expected_temporary_failure: false,
  predicted_failures: null,
  plan_change_required: false,
  architecture_change_required: false,
  behavior_change_required: false,
  recommended_next_action: 'run the PR build',
  handover: { current_state: 'ui-kit builds on 16', next_action: 'commit and push', risks: ['peer deps'] },
};

describe('agent output schemas', () => {
  it('accepts the §18.3 minimum shape for every role', () => {
    for (const role of AGENT_ROLES) {
      const extra = extrasFor(role);
      const outcome = validateAgentResult(role, { ...MINIMUM, ...extra });
      expect(outcome.ok, `${role}: ${outcome.ok ? '' : outcome.errors.join('; ')}`).toBe(true);
    }
  });

  it('rejects a result that omits any single required field, for every role', () => {
    for (const role of AGENT_ROLES) {
      const full: Record<string, unknown> = { ...MINIMUM, ...extrasFor(role) };
      for (const key of Object.keys(full)) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped deliberately, to build `without`
        const { [key]: _dropped, ...without } = full;
        const outcome = validateAgentResult(role, without);
        expect(outcome.ok, `${role} still accepted a result without "${key}"`).toBe(false);
      }
    }
  });

  it('rejects an unknown property, because Codex strict schemas forbid extras, for every role', () => {
    for (const role of AGENT_ROLES) {
      const outcome = validateAgentResult(role, { ...MINIMUM, ...extrasFor(role), mood: 'confident' });
      expect(outcome.ok, role).toBe(false);
      if (outcome.ok) throw new Error(`${role}: expected a rejection`);
      expect(outcome.errors.join('\n'), role).toContain('mood');
    }
  });

  it('generates a JSON Schema whose required list is exactly the zod shape, for every role', () => {
    for (const role of AGENT_ROLES) {
      const json = outputSchemaFor(role);
      expect(json['required'], role).toEqual(Object.keys(resultSchemaFor(role).shape));
      expect(json['additionalProperties'], role).toBe(false);
      expect(json['type'], role).toBe('object');
      expect(json['title'], role).toBe(`janus-${role}-result`);
    }
  });

  it('allows null exactly where §18.3 makes a field conditional', () => {
    const json = outputSchemaFor('implementation');
    const properties = json['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['predicted_failures']?.['type']).toEqual(['array', 'null']);
    expect(properties['summary']?.['type']).toBe('string');
    expect(validateAgentResult('implementation', { ...MINIMUM, predicted_failures: ['AppComponent > renders'] }).ok).toBe(true);
  });

  it('gives the four roles the spec names extra fields their stage needs', () => {
    expect(Object.keys(resultSchemaFor('checkpoint').shape)).toContain('outcome');
    expect(Object.keys(resultSchemaFor('triage').shape)).toEqual(
      expect.arrayContaining(['suspect_repo', 'confidence', 'rationale']),
    );
    expect(Object.keys(resultSchemaFor('fix').shape)).toContain('no_change_needed');
    const reviewFindings = (outputSchemaFor('review')['properties'] as Record<string, Record<string, unknown>>)['findings'];
    const item = reviewFindings?.['items'] as Record<string, unknown>;
    expect(item['required']).toEqual(['repo', 'file', 'severity', 'category', 'description', 'suggested_action']);
  });
});

describe('asFixResult', () => {
  it('narrows a validated fix result to its no_change_needed field', () => {
    const validated = validateAgentResult('fix', { ...MINIMUM, ...extrasFor('fix'), no_change_needed: true });
    if (!validated.ok) throw new Error(validated.errors.join('; '));
    expect(asFixResult(validated.result)?.no_change_needed).toBe(true);
  });

  it('returns null for a base result that is not a fix result', () => {
    const validated = validateAgentResult('implementation', MINIMUM);
    if (!validated.ok) throw new Error(validated.errors.join('; '));
    expect(asFixResult(validated.result)).toBeNull();
  });

  it('returns null for no result at all', () => {
    expect(asFixResult(null)).toBeNull();
  });
});

function extrasFor(role: string): Record<string, unknown> {
  switch (role) {
    case 'checkpoint':
      return { outcome: 'PASS' };
    case 'triage':
      return { suspect_repo: 'ui-kit', confidence: 'high', rationale: 'the failing spec lives in ui-kit' };
    case 'fix':
      return { no_change_needed: false };
    case 'review':
      return {
        findings: [
          {
            repo: 'ui-kit',
            file: 'src/lib/button.ts',
            severity: 'major',
            category: 'behaviour',
            description: 'the disabled input is no longer honoured',
            suggested_action: 'restore the disabled binding',
          },
        ],
      };
    default:
      return {};
  }
}
