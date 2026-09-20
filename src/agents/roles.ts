import type { AgentRole } from '../config/config-schema.js';

/** Spec §3.3: the three sandbox classes. The class decides the `-s` value, the network flag, the cwd, and the writable roots. */
export const SANDBOX_CLASSES = ['code-writing', 'report-writing', 'read-only'] as const;

export type SandboxClass = (typeof SANDBOX_CLASSES)[number];

/** Spec §3.3's table, one entry per §18.1 role. */
export const ROLE_CLASSES: Readonly<Record<AgentRole, SandboxClass>> = {
  discovery: 'report-writing',
  integration_discovery: 'report-writing',
  planning: 'report-writing',
  replanning: 'report-writing',
  qa: 'report-writing',
  implementation: 'code-writing',
  debug: 'code-writing',
  fix: 'code-writing',
  sync_conflict: 'code-writing',
  checkpoint: 'read-only',
  review: 'read-only',
  triage: 'read-only',
};

export function sandboxClassFor(role: AgentRole): SandboxClass {
  return ROLE_CLASSES[role];
}

/** Only code-writing roles receive an INLINE DIFF (§18.2) and a writable repository (§3.3). */
export function isCodeWriting(role: AgentRole): boolean {
  return ROLE_CLASSES[role] === 'code-writing';
}
