import { describe, expect, it } from 'vitest';
import { isGeneratedPath, SECTION_ORDER } from '../../src/agents/context.js';
import { ContextPackageError, ContextTooLargeError, renderContextPackage, truncateUtf8 } from '../../src/agents/render.js';
import { contextPackageFixture } from '../helpers/agent-fixtures.js';

const LIMITS = { maxContextBytes: 200_000, maxInlineDiffBytes: 60_000 };

function headings(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3));
}

describe('renderContextPackage', () => {
  it('renders the thirteen §18.2 sections in the spec order, after the role task preamble', () => {
    const rendered = renderContextPackage(contextPackageFixture('implementation'), LIMITS);
    expect(headings(rendered.text)).toEqual([...SECTION_ORDER]);
    expect(rendered.text.startsWith('# TASK: implementation')).toBe(true);
    expect(rendered.text.indexOf('# TASK: implementation')).toBeLessThan(rendered.text.indexOf('## GOAL'));
    expect(rendered.version).toMatch(/^implementation@\d+$/);
    expect(rendered.bytes).toBe(Buffer.byteLength(rendered.text, 'utf8'));
    expect(rendered.truncations).toEqual([]);
  });

  it('renders an empty section as (none) rather than dropping it', () => {
    const rendered = renderContextPackage(
      contextPackageFixture('implementation', { planSlice: null, previousAttempts: [], baselineExceptions: [] }),
      LIMITS,
    );
    expect(headings(rendered.text)).toEqual([...SECTION_ORDER]);
    expect(rendered.text).toContain('## APPROVED PLAN SLICE\n\n(none)');
  });

  it('inlines a diff only for code-writing roles and tells the others to run git diff themselves', () => {
    const pkg = contextPackageFixture('implementation', { inlineDiff: 'diff --git a/x.ts b/x.ts\n+const a = 1;\n' });
    expect(renderContextPackage(pkg, LIMITS).text).toContain('+const a = 1;');

    const review = renderContextPackage({ ...pkg, role: 'review' }, LIMITS);
    expect(review.text).not.toContain('+const a = 1;');
    expect(review.text).toContain('run `git diff` yourself');
    expect(review.text).toContain('## CHANGE SUMMARY');
  });

  it('lists generated files in the change summary but marks them as never inlined (§18.2)', () => {
    const pkg = contextPackageFixture('implementation', {
      changeSummary: [
        { path: 'package.json', added: 12, removed: 3, generated: false },
        { path: 'pnpm-lock.yaml', added: 980, removed: 240, generated: true },
      ],
    });
    const text = renderContextPackage(pkg, LIMITS).text;
    expect(text).toContain('+12 -3 package.json');
    expect(text).toContain('+980 -240 pnpm-lock.yaml (generated; never inlined)');
  });

  it('refuses an inline diff that still contains a generated file', () => {
    const pkg = contextPackageFixture('implementation', {
      inlineDiff: 'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n+  foo: 1\n',
    });
    expect(() => renderContextPackage(pkg, LIMITS)).toThrow(ContextPackageError);
    expect(() => renderContextPackage(pkg, LIMITS)).toThrow('pnpm-lock.yaml');
  });

  it('truncates the inline diff at max_inline_diff_bytes with a marker naming the config key', () => {
    const diff = `diff --git a/big.ts b/big.ts\n${'+// filler line\n'.repeat(4000)}`;
    const rendered = renderContextPackage(contextPackageFixture('implementation', { inlineDiff: diff }), {
      maxContextBytes: 200_000,
      maxInlineDiffBytes: 1_000,
    });
    expect(rendered.text).toContain('[janus truncated the inline diff:');
    expect(rendered.text).toContain('agents.max_inline_diff_bytes]');
    expect(rendered.truncations.join('\n')).toContain('agents.max_inline_diff_bytes');
  });

  it('degrades in a fixed order when the whole prompt exceeds max_context_bytes', () => {
    const pkg = contextPackageFixture('implementation', {
      inlineDiff: `diff --git a/big.ts b/big.ts\n${'+// x\n'.repeat(2000)}`,
      previousAttempts: Array.from({ length: 9 }, (_, index) => `attempt ${index + 1}: ${'detail '.repeat(400)}`),
    });
    const rendered = renderContextPackage(pkg, { maxContextBytes: 12_000, maxInlineDiffBytes: 60_000 });
    expect(Buffer.byteLength(rendered.text, 'utf8')).toBeLessThanOrEqual(12_000);
    expect(rendered.truncations[0]).toContain('inline diff');
    expect(rendered.truncations.some((line) => line.includes('previous attempts'))).toBe(true);
    expect(rendered.text).toContain('## GUARDRAILS AND FORBIDDEN ACTIONS');
    expect(rendered.text).toContain('## OUTPUT CONTRACT');
  });

  it('throws rather than ship a prompt without its guardrails when nothing can be dropped', () => {
    const pkg = contextPackageFixture('implementation', { goal: 'g'.repeat(50_000) });
    expect(() => renderContextPackage(pkg, { maxContextBytes: 4_000, maxInlineDiffBytes: 1_000 })).toThrow(
      ContextTooLargeError,
    );
    expect(() => renderContextPackage(pkg, { maxContextBytes: 4_000, maxInlineDiffBytes: 1_000 })).toThrow(
      'agents.max_context_bytes',
    );
  });
});

describe('truncateUtf8', () => {
  it('returns the text untouched when it fits', () => {
    expect(truncateUtf8('hello', 10)).toEqual({ text: 'hello', omittedBytes: 0, totalBytes: 5 });
  });

  it('cuts at the last newline inside the budget', () => {
    expect(truncateUtf8('aaa\nbbb\nccc\n', 9).text).toBe('aaa\nbbb\n');
  });

  it('never splits a multi-byte character', () => {
    const text = 'éééé';
    const cut = truncateUtf8(text, 5);
    expect(Buffer.byteLength(cut.text, 'utf8')).toBeLessThanOrEqual(5);
    expect(cut.text).not.toContain('�');
    expect(cut.omittedBytes).toBeGreaterThan(0);
  });
});

describe('isGeneratedPath', () => {
  it('knows the lockfiles §18.2 says are listed but never inlined', () => {
    expect(isGeneratedPath('pnpm-lock.yaml')).toBe(true);
    expect(isGeneratedPath('packages/ui/package-lock.json')).toBe(true);
    expect(isGeneratedPath('yarn.lock')).toBe(true);
    expect(isGeneratedPath('src/app/app.component.ts')).toBe(false);
  });
});
