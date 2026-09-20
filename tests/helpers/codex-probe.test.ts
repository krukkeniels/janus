import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeLogPath, recordProbe } from './codex-probe.js';

const KEY = 'JANUS_SPIKE_LOG';
let previous: string | undefined;

beforeEach(() => {
  previous = process.env[KEY];
});

afterEach(() => {
  if (previous === undefined) delete process.env[KEY];
  else process.env[KEY] = previous;
});

describe('recordProbe', () => {
  it('appends one JSON line per probe to the configured log', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'janus-probe-')), 'probe-log.jsonl');
    process.env[KEY] = log;

    const returned = recordProbe({
      probe: 'R1',
      question: 'what does turn.completed.usage really look like?',
      outcome: 'observed',
      detail: 'no total_tokens key',
      data: { input_tokens: 14_468 },
    });
    recordProbe({ probe: 'R2', question: 'does read-only refuse outside a repo?', outcome: 'fail', detail: 'refused', data: {} });

    expect(returned).toBe(log);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(first['probe']).toBe('R1');
    expect(first['outcome']).toBe('observed');
    expect((first['data'] as Record<string, unknown>)['input_tokens']).toBe(14_468);
    expect(typeof first['recorded_at']).toBe('string');
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ probe: 'R2', outcome: 'fail' });
  });

  it('falls back to a temp file, never into the repository, when JANUS_SPIKE_LOG is unset', () => {
    delete process.env[KEY];
    const path = probeLogPath();
    expect(path.startsWith(tmpdir())).toBe(true);
    expect(path).toContain(`janus-spike-${String(process.pid)}`);
  });
});
