import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * One line of the T06 spike log (spec §29 item 4). The log is JSONL so a probe's numbers survive a crashed run and
 * can be transcribed into `docs/spikes/prompt-spike.md` without re-reading terminal scrollback.
 *
 * `data` holds only numbers, booleans and short strings the probe measured. It must never hold a token, a Codex
 * session id, or raw stderr that has not been read by a human first (§32 rule 12).
 */
export interface ProbeRecord {
  /** Short probe id, matching the table in `docs/spikes/prompt-spike.md` — `R1`, `R2`, `A1`, `A2`, `S1`, `S2`. */
  probe: string;
  /** The open question this probe answers, in one line. */
  question: string;
  /** `pass`/`fail` when the probe asserted something; `observed` when it only measured. */
  outcome: 'pass' | 'fail' | 'observed';
  detail: string;
  data: Record<string, unknown>;
  recorded_at: string;
}

/**
 * Where probe records go. Deliberately never inside the repository: the log carries absolute home paths and Codex
 * session ids, and a stray `pnpm test:integration` must not dirty the working tree.
 */
export function probeLogPath(): string {
  const configured = process.env['JANUS_SPIKE_LOG'];
  if (configured !== undefined && configured.trim() !== '') return configured;
  return join(tmpdir(), `janus-spike-${String(process.pid)}.jsonl`);
}

export function recordProbe(record: Omit<ProbeRecord, 'recorded_at'>): string {
  const path = probeLogPath();
  mkdirSync(dirname(path), { recursive: true });
  const line: ProbeRecord = { ...record, recorded_at: new Date().toISOString() };
  appendFileSync(path, `${JSON.stringify(line)}\n`);
  return path;
}
