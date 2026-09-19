import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENTS_FILE } from '../../src/state/files.js';
import { appendEvent, readEvents } from '../../src/telemetry/events.js';
import { tempDir } from '../helpers/git-fixtures.js';

describe('telemetry events', () => {
  it('appends one JSON line per event with a timestamp first', () => {
    const janusDir = tempDir();
    const now = new Date('2026-09-19T12:00:00.000Z');
    const recorded = appendEvent(janusDir, { type: 'goal.created', goal_id: 'g' }, now);
    appendEvent(janusDir, { type: 'stage.entered', stage: 'preparing' }, now);
    expect(recorded).toEqual({ timestamp: '2026-09-19T12:00:00.000Z', type: 'goal.created', goal_id: 'g' });
    const lines = readFileSync(join(janusDir, EVENTS_FILE), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toEqual(recorded);
    expect(readEvents(janusDir).map((event) => event['type'])).toEqual(['goal.created', 'stage.entered']);
  });

  it('reads an empty list when no events exist', () => {
    expect(readEvents(tempDir())).toEqual([]);
  });
});
