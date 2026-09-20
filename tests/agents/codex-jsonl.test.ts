import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCodexUsage } from '../../src/agents/codex/jsonl.js';

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, '..', 'fixtures', 'codex', name), 'utf8');

describe('parseCodexUsage', () => {
  it('reads turn.completed.usage from a recorded stream (§18.4)', () => {
    expect(parseCodexUsage(fixture('implementation-success.jsonl'))).toEqual({
      input: 184_320,
      cached_input: 172_032,
      output: 9_184,
      reasoning: 7_040,
      total: 193_504,
    });
  });

  it('reads reasoning tokens from the nested output_tokens_details shape', () => {
    expect(parseCodexUsage(fixture('usage-nested.jsonl'))).toEqual({
      input: 4_096,
      cached_input: 0,
      output: 512,
      reasoning: 384,
      total: 4_608,
    });
  });

  it('survives a stream the timeout kill cut mid-line and reports no usage', () => {
    expect(parseCodexUsage(fixture('timeout-partial.jsonl'))).toBeNull();
  });

  it('returns null for an empty stream and takes the last turn.completed when there are several', () => {
    expect(parseCodexUsage('')).toBeNull();
    const two = [
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"total_tokens":2}}',
      '{"type":"turn.completed","usage":{"input_tokens":9,"cached_input_tokens":0,"output_tokens":9,"total_tokens":18}}',
    ].join('\n');
    expect(parseCodexUsage(two)?.input).toBe(9);
  });

  it('derives total from input + output when the real stream omits total_tokens (T06 probe R1)', () => {
    const line =
      '{"type":"turn.completed","usage":{"input_tokens":14468,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":19,"reasoning_output_tokens":0}}';
    expect(parseCodexUsage(line)).toEqual({
      input: 14_468,
      cached_input: 0,
      output: 19,
      reasoning: 0,
      total: 14_487,
    });
  });

  it('still prefers an explicit total_tokens when the stream carries one', () => {
    const line = '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":3,"total_tokens":99}}';
    expect(parseCodexUsage(line)?.total).toBe(99);
  });

  it('defaults a missing counter to zero and a missing reasoning count to null', () => {
    expect(parseCodexUsage('{"type":"turn.completed","usage":{"input_tokens":5}}')).toEqual({
      input: 5,
      cached_input: 0,
      output: 0,
      reasoning: null,
      total: 5,
    });
  });

  it('parses the captured real stream and reports a non-zero total (T06 probe R1)', () => {
    const usage = parseCodexUsage(fixture('real-workspace-write.jsonl'));
    expect(usage).not.toBeNull();
    expect(usage?.input).toBeGreaterThan(0);
    expect(usage?.total).toBe((usage?.input ?? 0) + (usage?.output ?? 0));
  });
});
