import type { JanusConfig } from '../config/config-schema.js';
import type { Goal } from '../config/goal-schema.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import type { CommandRunner } from './exec.js';
import type { DoctorFs } from './fs.js';
import type { HttpProbe } from './http.js';

/**
 * Spec §31 item 33: "`janus doctor` detects a non-working sandbox, a read-only pnpm store, and a missing
 * `janus/*` branch exclusion." Four statuses, because those three are not the same kind of problem: a dead
 * sandbox is a `fail`, an unwritable store is a `fail`, and a branch spec Janus cannot see from here is a `warn`.
 * `skip` is for a check that does not apply — a fake provider, a workspace-less invocation.
 */
export const DOCTOR_STATUSES = ['pass', 'warn', 'fail', 'skip'] as const;

export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];

export interface DoctorFinding {
  /** Stable, machine-readable, dotted. `--json` consumers (and the §35 operator skill) key on it. Unique. */
  id: string;
  /** One short human phrase. Never contains a value that could be a secret (§32 rule 12). */
  title: string;
  status: DoctorStatus;
  /** What was observed. May quote a command's stderr; never a token value. */
  detail: string;
  /** What the operator should do. `null` is allowed only for `pass`; `runDoctor` enforces that. */
  remediation: string | null;
  duration_ms: number;
}

/** What a check returns; `runDoctor` stamps the duration. */
export type DoctorObservation = Omit<DoctorFinding, 'duration_ms'>;

/**
 * Everything a check may touch. Nothing else: no direct `process.env`, `child_process`, `fetch` or `node:fs`.
 * That is what makes every check unit-testable with no `codex`, no `git`, no `pnpm` and no network — which
 * matters more than usual here, because Bitbucket Server and TeamCity are unreachable from the machine Janus is
 * developed on.
 *
 * `config`, `goal` and `paths` are null when doctor runs outside a workspace (§35 runs it before `janus init`).
 */
export interface DoctorCheckContext {
  config: JanusConfig | null;
  goal: Goal | null;
  paths: WorkspacePaths | null;
  env: Record<string, string | undefined>;
  run: CommandRunner;
  http: HttpProbe;
  fs: DoctorFs;
  now(): Date;
}

export interface DoctorCheck {
  /** Prefix of every finding this check produces; a check that fans out suffixes it (`codex.model[gpt-5.6-sol]`). */
  id: string;
  title: string;
  run(ctx: DoctorCheckContext): Promise<DoctorObservation[]>;
}

/** A check violated the contract: a duplicate id, or a non-`pass` finding with no remediation. */
export class DoctorContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoctorContractError';
  }
}

/** The one place a check says "this does not apply here", so the phrasing stays identical across checks. */
export function skipped(id: string, title: string, detail: string, remediation: string): DoctorObservation {
  return { id, title, status: 'skip', detail, remediation };
}
