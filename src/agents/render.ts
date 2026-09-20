import { isGeneratedPath, SECTION_ORDER } from './context.js';
import type { ChangeSummaryEntry, ContextPackage } from './context.js';
import { FORBIDDEN_ACTIONS } from './prompts/shared.js';
import { promptVersionFor, ROLE_TEMPLATES } from './prompts/templates.js';
import { isCodeWriting } from './roles.js';

export class ContextPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextPackageError';
  }
}

export class ContextTooLargeError extends Error {
  constructor(bytes: number, limit: number) {
    super(
      `context package is ${bytes} bytes after every safe reduction, over the ${limit}-byte agents.max_context_bytes; ` +
        'raise agents.max_context_bytes or give the agent a smaller plan slice. Janus refuses to truncate GOAL, ' +
        'REPOSITORY, APPROVED PLAN SLICE, GUARDRAILS AND FORBIDDEN ACTIONS, ANGULAR GUIDANCE, BUDGET or OUTPUT CONTRACT.',
    );
    this.name = 'ContextTooLargeError';
  }
}

export interface RenderLimits {
  /** `agents.max_context_bytes`. */
  maxContextBytes: number;
  /** `agents.max_inline_diff_bytes`. */
  maxInlineDiffBytes: number;
}

export interface RenderedPrompt {
  text: string;
  /** The role's prompt template version, stamped on evidence and events (§18.6). */
  version: string;
  bytes: number;
  /** One line per reduction that was applied, recorded in the evidence file. */
  truncations: string[];
}

export function truncationMarker(what: string, omitted: number, total: number, key: string): string {
  return `... [janus truncated the ${what}: ${omitted} of ${total} bytes omitted at ${key}] ...`;
}

/** Cuts at the last newline inside the budget, falling back to a byte cut that never splits a code point. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; omittedBytes: number; totalBytes: number } {
  const buffer = Buffer.from(text, 'utf8');
  const totalBytes = buffer.byteLength;
  if (totalBytes <= maxBytes) return { text, omittedBytes: 0, totalBytes };
  const head = buffer.subarray(0, Math.max(maxBytes, 0));
  const newline = head.lastIndexOf(0x0a);
  const cut = newline > 0 ? newline + 1 : head.byteLength;
  const kept = buffer.subarray(0, cut).toString('utf8').replace(/�+$/u, '');
  return { text: kept, omittedBytes: totalBytes - Buffer.byteLength(kept, 'utf8'), totalBytes };
}

/**
 * Keeps the *last* `maxBytes` bytes rather than the first — for LATEST VERIFICATION EVIDENCE, where the useful
 * content (the compiler error, the failing assertion, the stack) sits at the end of a CI log, not the start.
 * Advances forward from the raw byte cut to the next UTF-8 character boundary so a multi-byte code point at the
 * front of the kept slice is never split; a continuation byte (top two bits `10`) is never a valid start.
 */
export function truncateUtf8Tail(text: string, maxBytes: number): { text: string; omittedBytes: number; totalBytes: number } {
  const buffer = Buffer.from(text, 'utf8');
  const totalBytes = buffer.byteLength;
  if (totalBytes <= maxBytes) return { text, omittedBytes: 0, totalBytes };
  const start = totalBytes - Math.max(maxBytes, 0);
  let boundary = start;
  while (boundary < totalBytes && ((buffer.at(boundary) ?? 0) >> 6) === 0b10) boundary++;
  const kept = buffer.subarray(boundary).toString('utf8');
  return { text: kept, omittedBytes: totalBytes - Buffer.byteLength(kept, 'utf8'), totalBytes };
}

function section(name: string, body: string): string {
  return `## ${name}\n\n${body.trim() === '' ? '(none)' : body}`;
}

function renderChangeSummary(entries: ChangeSummaryEntry[], limit: number): { body: string; truncation: string | null } {
  if (entries.length === 0) return { body: '', truncation: null };
  const kept = entries.slice(0, limit);
  const lines = kept.map(
    (entry) => `+${entry.added} -${entry.removed} ${entry.path}${entry.generated ? ' (generated; never inlined)' : ''}`,
  );
  if (kept.length === entries.length) return { body: lines.join('\n'), truncation: null };
  const note = `... [janus truncated the change summary: ${entries.length - kept.length} of ${entries.length} files omitted]`;
  return { body: [...lines, note].join('\n'), truncation: note };
}

function assertNoGeneratedFilesInDiff(diff: string): void {
  for (const line of diff.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    for (const path of line.split(' ').slice(2)) {
      const stripped = path.replace(/^[ab]\//u, '');
      if (isGeneratedPath(stripped)) {
        throw new ContextPackageError(
          `inline diff contains the generated file ${stripped}; spec §18.2 says lockfiles and generated files are ` +
            'listed in CHANGE SUMMARY but never inlined. Remove it from the diff before building the context package.',
        );
      }
    }
  }
}

interface Reduction {
  inlineDiffBytes: number;
  previousAttempts: number;
  evidenceBytes: number;
  changeSummaryEntries: number;
}

const UNBOUNDED = Number.POSITIVE_INFINITY;

function assemble(pkg: ContextPackage, reduction: Reduction): { text: string; truncations: string[] } {
  const truncations: string[] = [];
  const bodies = new Map<string, string>();

  bodies.set('GOAL', pkg.goal);
  bodies.set('REPOSITORY', pkg.repository ?? '');
  bodies.set('APPROVED PLAN SLICE', pkg.planSlice ?? '');
  bodies.set('CURRENT STATE', pkg.currentState ?? '');

  const summary = renderChangeSummary(pkg.changeSummary, reduction.changeSummaryEntries);
  bodies.set('CHANGE SUMMARY', summary.body);
  if (summary.truncation !== null) truncations.push(summary.truncation);

  if (!isCodeWriting(pkg.role)) {
    bodies.set(
      'INLINE DIFF',
      'No diff is inlined for this role. You have read access to the whole workspace: run `git diff` yourself ' +
        'in the repositories named in CHANGE SUMMARY (spec §18.2).',
    );
  } else if (pkg.inlineDiff === null || pkg.inlineDiff === '') {
    bodies.set('INLINE DIFF', '');
  } else {
    assertNoGeneratedFilesInDiff(pkg.inlineDiff);
    const cut = truncateUtf8(pkg.inlineDiff, reduction.inlineDiffBytes);
    if (cut.omittedBytes === 0) {
      bodies.set('INLINE DIFF', cut.text);
    } else {
      const marker = truncationMarker('inline diff', cut.omittedBytes, cut.totalBytes, 'agents.max_inline_diff_bytes');
      bodies.set('INLINE DIFF', `${cut.text}\n${marker}`);
      truncations.push(marker);
    }
  }

  const evidence = truncateUtf8Tail(pkg.verificationEvidence ?? '', reduction.evidenceBytes);
  if (evidence.omittedBytes === 0) {
    bodies.set('LATEST VERIFICATION EVIDENCE', evidence.text);
  } else {
    const marker = truncationMarker(
      'verification evidence',
      evidence.omittedBytes,
      evidence.totalBytes,
      'agents.max_context_bytes',
    );
    // Tail-truncated: the omitted bytes are the head, so the marker leads the kept text rather than trailing it.
    bodies.set('LATEST VERIFICATION EVIDENCE', `${marker}\n${evidence.text}`);
    truncations.push(marker);
  }

  const attempts = Number.isFinite(reduction.previousAttempts)
    ? pkg.previousAttempts.slice(-reduction.previousAttempts)
    : pkg.previousAttempts;
  if (attempts.length < pkg.previousAttempts.length) {
    const note = `... [janus kept the ${attempts.length} most recent of ${pkg.previousAttempts.length} previous attempts at agents.max_context_bytes]`;
    bodies.set('PREVIOUS ATTEMPTS', [note, ...attempts.map((line) => `- ${line}`)].join('\n'));
    truncations.push(note);
  } else {
    bodies.set('PREVIOUS ATTEMPTS', attempts.map((line) => `- ${line}`).join('\n'));
  }

  bodies.set('KNOWN BASELINE EXCEPTIONS', pkg.baselineExceptions.map((line) => `- ${line}`).join('\n'));
  bodies.set(
    'GUARDRAILS AND FORBIDDEN ACTIONS',
    [...FORBIDDEN_ACTIONS, ...pkg.guardrails].map((line) => `- ${line}`).join('\n'),
  );
  bodies.set('ANGULAR GUIDANCE', pkg.angularGuidance);
  bodies.set('BUDGET', pkg.budget);
  bodies.set('OUTPUT CONTRACT', pkg.outputContract);

  const sections = SECTION_ORDER.map((name) => section(name, bodies.get(name) ?? ''));
  const text = [`# TASK: ${pkg.role}`, '', ROLE_TEMPLATES[pkg.role].text, '', ...sections].join('\n\n');
  return { text, truncations };
}

/**
 * Spec §18.2: the thirteen sections in one order, preceded by the role's task instruction and nothing else — in
 * particular no previous agent's reasoning, only the one-paragraph summaries in PREVIOUS ATTEMPTS.
 *
 * When the assembled prompt exceeds `agents.max_context_bytes`, reductions are applied in this fixed order,
 * re-measuring after each and stopping as soon as it fits: inline diff to zero, previous attempts to the most
 * recent three, then to one, verification evidence to its last 4096 bytes (a byte-safe tail cut via
 * `truncateUtf8Tail`, since the useful part of a CI log — the error, the assertion, the stack — sits at the end),
 * change summary to its first 200 files. GOAL, REPOSITORY, APPROVED PLAN SLICE, GUARDRAILS AND FORBIDDEN ACTIONS,
 * ANGULAR GUIDANCE, BUDGET and OUTPUT CONTRACT are never reduced: a prompt missing its guardrails is worse than a
 * run that fails loudly.
 */
export function renderContextPackage(pkg: ContextPackage, limits: RenderLimits): RenderedPrompt {
  const stages: Reduction[] = [
    {
      inlineDiffBytes: limits.maxInlineDiffBytes,
      previousAttempts: UNBOUNDED,
      evidenceBytes: UNBOUNDED,
      changeSummaryEntries: UNBOUNDED,
    },
    { inlineDiffBytes: 0, previousAttempts: UNBOUNDED, evidenceBytes: UNBOUNDED, changeSummaryEntries: UNBOUNDED },
    { inlineDiffBytes: 0, previousAttempts: 3, evidenceBytes: UNBOUNDED, changeSummaryEntries: UNBOUNDED },
    { inlineDiffBytes: 0, previousAttempts: 1, evidenceBytes: UNBOUNDED, changeSummaryEntries: UNBOUNDED },
    { inlineDiffBytes: 0, previousAttempts: 1, evidenceBytes: 4096, changeSummaryEntries: UNBOUNDED },
    { inlineDiffBytes: 0, previousAttempts: 1, evidenceBytes: 4096, changeSummaryEntries: 200 },
  ];
  let bytes = 0;
  for (const stage of stages) {
    const assembled = assemble(pkg, stage);
    bytes = Buffer.byteLength(assembled.text, 'utf8');
    if (bytes <= limits.maxContextBytes) {
      return { text: assembled.text, version: promptVersionFor(pkg.role), bytes, truncations: assembled.truncations };
    }
  }
  throw new ContextTooLargeError(bytes, limits.maxContextBytes);
}
