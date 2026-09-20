import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENTS_FILE } from '../../src/state/files.js';
import { appendEvent, EVENT_TYPES, readEvents } from '../../src/telemetry/events.js';
import type { TelemetryEvent } from '../../src/telemetry/events.js';
import { tempDir } from '../helpers/git-fixtures.js';

describe('telemetry events', () => {
  it('appends one JSON line per event with a timestamp first', () => {
    const janusDir = tempDir();
    const now = new Date('2026-09-19T12:00:00.000Z');
    const recorded = appendEvent(janusDir, { type: 'goal.created', goal_id: 'g', repos: ['ui-kit'] }, now);
    appendEvent(janusDir, { type: 'stage.entered', stage: 'preparing', from: 'created' }, now);
    expect(recorded).toEqual({ timestamp: '2026-09-19T12:00:00.000Z', type: 'goal.created', goal_id: 'g', repos: ['ui-kit'] });
    const lines = readFileSync(join(janusDir, EVENTS_FILE), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toEqual(recorded);
    expect(readEvents(janusDir).map((event) => event['type'])).toEqual(['goal.created', 'stage.entered']);
  });

  it('reads an empty list when no events exist', () => {
    expect(readEvents(tempDir())).toEqual([]);
  });

  it('lists every §27 event type this version can emit, including the three agent events', () => {
    expect(EVENT_TYPES).toContain('agent.started');
    expect(EVENT_TYPES).toContain('agent.finished');
    expect(EVENT_TYPES).toContain('agent.model_switch');
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it('narrows on the discriminant so a consumer reaches §27 dimensions without a cast', () => {
    const events: TelemetryEvent[] = [
      {
        type: 'agent.finished',
        run_id: 'run-0001',
        role: 'implementation',
        repo: 'ui-kit',
        status: 'completed',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        prompt_version: 'implementation@1',
        profile: 'default',
        experiment_id: 'exp-1',
        tokens: { input: 100, cached_input: 40, output: 20, reasoning: 8, total: 120 },
        duration_ms: 4200,
        exit_code: 0,
        failure: null,
        step: null,
        patch: null,
      },
    ];
    const first = events[0];
    if (first === undefined || first.type !== 'agent.finished') throw new Error('expected agent.finished');
    expect(first.tokens?.reasoning).toBe(8);
    expect(first.prompt_version).toBe('implementation@1');
  });
});
