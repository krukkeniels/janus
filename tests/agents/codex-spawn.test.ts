import { describe, expect, it } from 'vitest';
import { parseCodexUsage } from '../../src/agents/codex/jsonl.js';
import { spawnCodex } from '../../src/agents/codex/spawn.js';

const node = process.execPath;

describe('spawnCodex', () => {
  it('feeds the prompt on stdin and returns stdout, stderr, and the exit code', async () => {
    const result = await spawnCodex({
      bin: node,
      args: ['-e', 'process.stdin.on("data", (d) => { process.stdout.write("got:" + d); process.stderr.write("warn"); });'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      stdin: 'the prompt',
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.jsonl).toBe('got:the prompt');
    expect(result.stderr).toBe('warn');
    expect(result.timedOut).toBe(false);
    expect(result.spawnFailed).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.jsonlTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
  });

  it('kills a process that outruns its timeout and says so (§18.4 "kills the process at timeout")', async () => {
    const result = await spawnCodex({
      bin: node,
      args: ['-e', 'process.stdout.write("started\\n"); setInterval(() => {}, 1000);'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      stdin: '',
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGTERM');
    expect(result.exitCode).toBeNull();
    expect(result.jsonl).toContain('started');
    expect(result.durationMs).toBeGreaterThanOrEqual(300);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM (§18.4 escalation path)', async () => {
    const result = await spawnCodex({
      bin: node,
      args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      stdin: '',
      timeoutMs: 100,
      sigkillGraceMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(300);
  }, 10_000);

  it('keeps the tail of stdout past jsonlCapBytes so the final turn.completed usage event survives (Important finding, review round 1)', async () => {
    const script = [
      'for (let i = 0; i < 20; i++) {',
      '  process.stdout.write(JSON.stringify({ type: "noise", i, pad: "x".repeat(60) }) + "\\n");',
      '}',
      'process.stdout.write(JSON.stringify({',
      '  type: "turn.completed",',
      '  usage: { input_tokens: 9, cached_input_tokens: 0, output_tokens: 9, total_tokens: 18 },',
      '}) + "\\n");',
    ].join('\n');
    const result = await spawnCodex({
      bin: node,
      args: ['-e', script],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      stdin: '',
      timeoutMs: 20_000,
      jsonlCapBytes: 200,
    });
    expect(result.exitCode).toBe(0);
    expect(result.jsonlTruncated).toBe(true);
    expect(result.jsonl.length).toBeLessThanOrEqual(200);
    expect(parseCodexUsage(result.jsonl)).toEqual({
      input: 9,
      cached_input: 0,
      output: 9,
      reasoning: null,
      total: 18,
    });
  });

  it('keeps the tail of stderr past stderrCapBytes', async () => {
    const script = [
      'for (let i = 0; i < 20; i++) {',
      '  process.stderr.write("noise-" + i + "-" + "x".repeat(60) + "\\n");',
      '}',
      'process.stderr.write("FINAL_ERROR_MARKER\\n");',
    ].join('\n');
    const result = await spawnCodex({
      bin: node,
      args: ['-e', script],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      stdin: '',
      timeoutMs: 20_000,
      stderrCapBytes: 200,
    });
    expect(result.stderrTruncated).toBe(true);
    expect(result.stderr.length).toBeLessThanOrEqual(200);
    expect(result.stderr).toContain('FINAL_ERROR_MARKER');
  });

  it('reports a non-zero exit without throwing', async () => {
    const result = await spawnCodex({
      bin: node,
      args: ['-e', 'process.exit(7);'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      stdin: '',
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it('reports a missing binary as spawnFailed instead of throwing', async () => {
    const result = await spawnCodex({
      bin: 'janus-no-such-binary-9f2c',
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      stdin: '',
      timeoutMs: 5_000,
    });
    expect(result.spawnFailed).toBe(true);
    expect(result.stderr).toContain('ENOENT');
  });
});
