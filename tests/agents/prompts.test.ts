import { describe, expect, it } from 'vitest';
import { AGENT_ROLES } from '../../src/config/config-schema.js';
import { ANGULAR_GUIDANCE, FORBIDDEN_ACTIONS, outputContractBlock } from '../../src/agents/prompts/shared.js';
import { PROMPT_FINGERPRINTS, promptFingerprint, promptVersionFor, ROLE_TEMPLATES } from '../../src/agents/prompts/templates.js';

describe('prompt templates', () => {
  it('has a versioned template for every §18.1 role', () => {
    for (const role of AGENT_ROLES) {
      expect(ROLE_TEMPLATES[role].text.trim().length, role).toBeGreaterThan(80);
      expect(promptVersionFor(role), role).toMatch(new RegExp(`^${role}@\\d+$`));
    }
  });

  /**
   * §18.6: "Prompt templates are versioned so a comparison never mixes prompt changes with model changes
   * silently." This is the mechanism. When this fails: change `version` in ROLE_TEMPLATES to the next integer for
   * every role the diff lists, then paste the received object into PROMPT_FINGERPRINTS.
   */
  it('fingerprints match the checked-in table, so a template edit cannot ship without a version bump', () => {
    const actual = Object.fromEntries(AGENT_ROLES.map((role) => [role, promptFingerprint(role)]));
    expect(actual).toEqual(PROMPT_FINGERPRINTS);
  });

  it('spells out every git write the agent may not perform (§19, §32 rule 11)', () => {
    const text = FORBIDDEN_ACTIONS.join('\n');
    for (const forbidden of ['git commit', 'git push', 'git add', 'git rebase', 'git reset', 'git tag', 'git stash']) {
      expect(text, forbidden).toContain(forbidden);
    }
    expect(text).toContain('outside');
    expect(text).toContain('publish');
  });

  it('carries §18.4 Angular guidance including the --allow-dirty reason', () => {
    expect(ANGULAR_GUIDANCE).toContain('--allow-dirty');
    expect(ANGULAR_GUIDANCE).toContain('pnpm');
    expect(ANGULAR_GUIDANCE).toContain('CI configuration');
  });

  it('renders the output contract from the role schema, so a schema change reaches the prompt', () => {
    const block = outputContractBlock('triage');
    expect(block).toContain('suspect_repo');
    expect(block).toContain('confidence');
    expect(block).toContain('null');
    expect(outputContractBlock('implementation')).not.toContain('suspect_repo');
    expect(outputContractBlock('checkpoint')).toContain('CONTINUE_WITH_REFINED_TASKS');
  });
});
