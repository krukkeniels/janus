import { describe, expect, it } from 'vitest';
import { ALL_POLICY_CHECKS } from '../../src/policy/registry.js';
import { POLICY_CHECK_IDS } from '../../src/policy/types.js';
import { policyContext } from '../helpers/policy-fixtures.js';

describe('ALL_POLICY_CHECKS', () => {
  it('registers exactly the declared check ids, once each', () => {
    expect(ALL_POLICY_CHECKS.map((check) => check.id).sort()).toEqual([...POLICY_CHECK_IDS].sort());
  });

  it('gives every check a non-empty title', () => {
    for (const check of ALL_POLICY_CHECKS) {
      expect(check.title.length, `check ${check.id} has no title`).toBeGreaterThan(0);
    }
  });

  it('lets every check run against an empty diff without throwing', async () => {
    const ctx = policyContext({ files: [], allowedScope: ['**'] });
    for (const check of ALL_POLICY_CHECKS) {
      const findings = await check.run(ctx);
      expect(findings ?? [], `check ${check.id} found something in an empty diff`).toEqual([]);
    }
  });

  it('never returns a finding whose check id is not its own', async () => {
    const ctx = policyContext({
      allowedScope: ['src/**'],
      files: [{ path: '.github/ci.yml', added: ["xit('x', () => {});"] }],
    });
    for (const check of ALL_POLICY_CHECKS) {
      for (const finding of (await check.run(ctx)) ?? []) {
        expect(finding.check).toBe(check.id);
      }
    }
  });
});
