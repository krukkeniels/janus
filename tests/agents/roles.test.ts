import { describe, expect, it } from 'vitest';
import { AGENT_ROLES } from '../../src/config/config-schema.js';
import { isCodeWriting, ROLE_CLASSES, sandboxClassFor, SANDBOX_CLASSES } from '../../src/agents/roles.js';

describe('agent roles and sandbox classes', () => {
  it('assigns every §18.1 role to one of the three §3.3 classes', () => {
    for (const role of AGENT_ROLES) {
      expect(SANDBOX_CLASSES).toContain(sandboxClassFor(role));
    }
    expect(Object.keys(ROLE_CLASSES).sort()).toEqual([...AGENT_ROLES].sort());
  });

  it('matches the §3.3 table exactly', () => {
    const byClass = (wanted: string): string[] =>
      AGENT_ROLES.filter((role) => ROLE_CLASSES[role] === wanted).sort();
    expect(byClass('code-writing')).toEqual(['debug', 'fix', 'implementation', 'sync_conflict']);
    expect(byClass('report-writing')).toEqual(['discovery', 'integration_discovery', 'planning', 'qa', 'replanning']);
    expect(byClass('read-only')).toEqual(['checkpoint', 'review', 'triage']);
  });

  it('isCodeWriting is true exactly for the code-writing class', () => {
    expect(isCodeWriting('implementation')).toBe(true);
    expect(isCodeWriting('review')).toBe(false);
    expect(isCodeWriting('discovery')).toBe(false);
  });
});
