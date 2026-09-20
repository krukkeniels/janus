/** File names inside the `.janus/` state checkout (spec §5). */
export const STATE_FILE = 'state.yaml';
export const GOAL_FILE = 'goal.yaml';
export const CONFIG_FILE = 'config.yaml';
export const HANDOVER_FILE = 'handover.md';
export const DECISIONS_FILE = 'decisions.md';
export const EVENTS_FILE = 'telemetry/events.jsonl';
export const ESCALATION_FILE = 'escalation.md';
export const EVIDENCE_DIR = 'evidence';
/** Spec §5: `reports/<run-id>/` — raw agent-written reports before the orchestrator files them. */
export const REPORTS_DIR = 'reports';
/** Spec §5: `evidence/agents/<run-id>.yaml` — validated result, token usage, duration. */
export const AGENTS_EVIDENCE_DIR = 'evidence/agents';
/** Spec §14: `evidence/policy/<attempt-id>.yaml` — the policy report, and `<attempt-id>.patch` on a reset. */
export const POLICY_EVIDENCE_DIR = 'evidence/policy';
