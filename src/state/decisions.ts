import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DECISIONS_FILE } from './files.js';

export const DECISIONS_HEADER = '# Decisions\n\nAppend-only log of significant decisions and their reasons.\n';

export interface DecisionEntry {
  at: string;
  by: string;
  title: string;
  body: string;
}

export function appendDecision(janusDir: string, entry: DecisionEntry): void {
  const path = join(janusDir, DECISIONS_FILE);
  if (!existsSync(path)) {
    writeFileSync(path, DECISIONS_HEADER);
  }
  const block = `\n## ${entry.title} (${entry.at})\n\nBy: ${entry.by}\n\n${entry.body.trim()}\n`;
  appendFileSync(path, block);
}
