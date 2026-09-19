import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendDecision, DECISIONS_HEADER } from '../../src/state/decisions.js';
import { DECISIONS_FILE } from '../../src/state/files.js';
import { tempDir } from '../helpers/git-fixtures.js';

describe('appendDecision', () => {
  it('appends a dated block after existing content', () => {
    const janusDir = tempDir();
    writeFileSync(join(janusDir, DECISIONS_FILE), DECISIONS_HEADER);
    appendDecision(janusDir, {
      at: '2026-09-19T12:00:00.000Z',
      by: 'janus init',
      title: 'Workspace created',
      body: 'State branch janus/x on state-repo.',
    });
    const text = readFileSync(join(janusDir, DECISIONS_FILE), 'utf8');
    expect(text.startsWith(DECISIONS_HEADER)).toBe(true);
    expect(text).toContain('## Workspace created (2026-09-19T12:00:00.000Z)');
    expect(text).toContain('By: janus init');
    expect(text.trimEnd().endsWith('State branch janus/x on state-repo.')).toBe(true);
  });

  it('creates the file with the header when it does not exist', () => {
    const janusDir = tempDir();
    appendDecision(janusDir, { at: '2026-09-19T12:00:00.000Z', by: 'human', title: 'T', body: 'B' });
    const text = readFileSync(join(janusDir, DECISIONS_FILE), 'utf8');
    expect(text.startsWith(DECISIONS_HEADER)).toBe(true);
    expect(text).toContain('## T (2026-09-19T12:00:00.000Z)');
  });
});
