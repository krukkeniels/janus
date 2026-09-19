import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EVENTS_FILE } from '../state/files.js';

export interface TelemetryEvent {
  type: string;
  [key: string]: unknown;
}

export interface RecordedEvent extends TelemetryEvent {
  timestamp: string;
}

/** Appends one event as a JSON line under `.janus/telemetry/`. Telemetry never controls correctness (spec §27). */
export function appendEvent(janusDir: string, event: TelemetryEvent, now: Date = new Date()): RecordedEvent {
  const path = join(janusDir, EVENTS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const recorded: RecordedEvent = { timestamp: now.toISOString(), ...event };
  appendFileSync(path, `${JSON.stringify(recorded)}\n`);
  return recorded;
}

export function readEvents(janusDir: string): RecordedEvent[] {
  const path = join(janusDir, EVENTS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedEvent);
}
