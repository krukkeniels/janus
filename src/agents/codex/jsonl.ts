import type { AgentTokenUsage } from '../../telemetry/events.js';

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function reasoningOf(usage: Record<string, unknown>): number | null {
  const flat = usage['reasoning_output_tokens'];
  if (typeof flat === 'number' && Number.isFinite(flat)) return flat;
  const details = usage['output_tokens_details'];
  if (typeof details === 'object' && details !== null) {
    const nested = (details as Record<string, unknown>)['reasoning_tokens'];
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
  }
  return null;
}

/**
 * T06 probe R1: codex-cli 0.146.0 emits `turn.completed.usage` **without** a `total_tokens` key —
 * `{"input_tokens":14468,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":19,"reasoning_output_tokens":0}`.
 * Reading a missing key as 0 made every real run record `total: 0`, which would have silently zeroed §18.6's
 * cost comparison. An explicit `total_tokens` still wins when a version emits one.
 *
 * `cached_input_tokens` is a subset of `input_tokens` and `reasoning_output_tokens` a subset of `output_tokens`,
 * so the sum is `input + output` and not a four-way total. `cache_write_input_tokens` is deliberately not
 * modelled: §18.6's comparison names input, cached, output and reasoning, and nothing consumes the fifth.
 */
function totalOf(fields: Record<string, unknown>, input: number, output: number): number {
  const explicit = fields['total_tokens'];
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  return input + output;
}

/**
 * Spec §18.4: "The adapter parses `turn.completed.usage`."
 *
 * Only the usage block is read from the stream; the final message comes from the `-o <last-message.json>` file, so
 * a stream the timeout kill cut mid-line costs nothing but the token counts. Unparseable lines are skipped rather
 * than thrown on, and the last `turn.completed` wins.
 *
 * Two reasoning-token spellings are accepted because Codex has emitted both. The fixtures were refreshed against
 * codex-cli 0.146.0 by T06 probe R1; `tests/fixtures/codex/real-workspace-write.jsonl` is a captured stream.
 */
export function parseCodexUsage(jsonl: string): AgentTokenUsage | null {
  let usage: AgentTokenUsage | null = null;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (record['type'] !== 'turn.completed') continue;
    const block = record['usage'];
    if (typeof block !== 'object' || block === null) continue;
    const fields = block as Record<string, unknown>;
    const input = count(fields['input_tokens']);
    const output = count(fields['output_tokens']);
    usage = {
      input,
      cached_input: count(fields['cached_input_tokens']),
      output,
      reasoning: reasoningOf(fields),
      total: totalOf(fields, input, output),
    };
  }
  return usage;
}
