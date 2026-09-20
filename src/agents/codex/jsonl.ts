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
 * Spec §18.4: "The adapter parses `turn.completed.usage`."
 *
 * Only the usage block is read from the stream; the final message comes from the `-o <last-message.json>` file, so
 * a stream the timeout kill cut mid-line costs nothing but the token counts. Unparseable lines are skipped rather
 * than thrown on, and the last `turn.completed` wins. Two reasoning-token spellings are accepted because Codex has
 * emitted both; T06's manual spike (§29 item 4) refreshes these fixtures against the real binary.
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
    usage = {
      input: count(fields['input_tokens']),
      cached_input: count(fields['cached_input_tokens']),
      output: count(fields['output_tokens']),
      reasoning: reasoningOf(fields),
      total: count(fields['total_tokens']),
    };
  }
  return usage;
}
