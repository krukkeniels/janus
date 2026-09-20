import { describe, expect, it } from 'vitest';
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
