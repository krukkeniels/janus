import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodexArgs, createCodexAgentRunner } from '../../src/agents/codex/adapter.js';
import type { CodexSpawn, CodexSpawnRequest } from '../../src/agents/codex/spawn.js';
import type { AgentTask } from '../../src/agents/types.js';
import type { AgentRunner } from '../../src/providers/types.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { agentTaskFixture, promptFixture } from '../helpers/agent-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'codex');
const fixture = (name: string): string => readFileSync(join(fixtures, name), 'utf8');

/** Replays a recorded run: captures the request, writes the recorded last message to the `-o` path, returns the JSONL. */
function replay(options: {
  jsonl?: string;
  lastMessage?: string | null;
  exitCode?: number;
  timedOut?: boolean;
  spawnFailed?: boolean;
  /** Overrides the signal that would otherwise be derived from `timedOut`, for a kill Janus did not initiate. */
  signal?: string | null;
  jsonlTruncated?: boolean;
  stderrTruncated?: boolean;
  stderr?: string;
  seen?: CodexSpawnRequest[];
}): CodexSpawn {
  return async (request) => {
    options.seen?.push(request);
    if (request.args[0] === '--version') {
      return {
        exitCode: 0,
        signal: null,
        jsonl: 'codex-cli 0.48.0\n',
        stderr: '',
        timedOut: false,
        spawnFailed: false,
        durationMs: 3,
        jsonlTruncated: false,
        stderrTruncated: false,
      };
    }
    const outIndex = request.args.indexOf('-o');
    const outPath = request.args[outIndex + 1];
    if (options.lastMessage !== null && outPath !== undefined) {
      copyFileSync(join(fixtures, options.lastMessage ?? 'implementation-success.last-message.json'), outPath);
    }
    return {
      exitCode: options.exitCode ?? 0,
      signal: options.signal !== undefined ? options.signal : options.timedOut === true ? 'SIGTERM' : null,
      jsonl: options.jsonl ?? fixture('implementation-success.jsonl'),
      stderr: options.stderr ?? (options.spawnFailed === true ? 'spawn codex ENOENT' : ''),
      timedOut: options.timedOut ?? false,
      spawnFailed: options.spawnFailed ?? false,
      durationMs: 252_000,
      jsonlTruncated: options.jsonlTruncated ?? false,
      stderrTruncated: options.stderrTruncated ?? false,
    };
  };
}

function runnerFor(spawn: CodexSpawn) {
  const paths = workspacePaths(tempDir('janus-codex-'));
  return { paths, runner: createCodexAgentRunner({ paths, spawn }) };
}

const task = (overrides = {}) => {
  const paths = workspacePaths(tempDir('janus-codex-task-'));
  return agentTaskFixture({
    runId: 'run-0201',
    role: 'implementation',
    repo: 'ui-kit',
    cwd: paths.repoDir('ui-kit'),
    writableRoots: [paths.repoDir('ui-kit'), paths.pnpmStoreDir],
    env: { npm_config_store_dir: paths.pnpmStoreDir },
    ...overrides,
  });
};

describe('buildCodexArgs', () => {
  it('builds the §18.4 invocation in order for a code-writing task', () => {
    const t = task();
    expect(buildCodexArgs(t, { schemaPath: '/tmp/s/schema.json', lastMessagePath: '/tmp/s/last-message.json' })).toEqual([
      'exec',
      '-C',
      t.cwd,
      '-s',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=true',
      '--add-dir',
      t.writableRoots[0],
      '--add-dir',
      t.writableRoots[1],
      '--output-schema',
      '/tmp/s/schema.json',
      '--json',
      '-o',
      '/tmp/s/last-message.json',
      '--ephemeral',
      '-m',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort=high',
      '-',
    ]);
  });

  it('omits the network flag and every --add-dir for a read-only task', () => {
    const t = task({ role: 'review', repo: null, sandboxClass: 'read-only', sandbox: 'read-only', network: false, writableRoots: [] });
    const args = buildCodexArgs(t, { schemaPath: '/s.json', lastMessagePath: '/m.json' });
    expect(args).toContain('read-only');
    expect(args).not.toContain('--add-dir');
    expect(args.join(' ')).not.toContain('network_access');
  });

  it('never passes resume or --skip-git-repo-check (§18.4)', () => {
    for (const t of [task(), task({ role: 'review', sandbox: 'read-only', network: false, writableRoots: [] })]) {
      const args = buildCodexArgs(t, { schemaPath: '/s.json', lastMessagePath: '/m.json' });
      expect(args).not.toContain('resume');
      expect(args).not.toContain('--skip-git-repo-check');
    }
  });

  it('passes --skip-git-repo-check for a read-only task and never for a write-capable one (§18.4, T06 probe R2)', () => {
    const readOnly = task({
      role: 'review',
      repo: null,
      sandboxClass: 'read-only',
      sandbox: 'read-only',
      network: false,
      writableRoots: [],
      skipGitRepoCheck: true,
    });
    const args = buildCodexArgs(readOnly, { schemaPath: '/tmp/s/schema.json', lastMessagePath: '/tmp/s/last.json' });
    expect(args.slice(0, 6)).toEqual(['exec', '-C', readOnly.cwd, '-s', 'read-only', '--skip-git-repo-check']);
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('resume');

    const codeWriting = buildCodexArgs(task(), { schemaPath: '/tmp/s/schema.json', lastMessagePath: '/tmp/s/last.json' });
    expect(codeWriting).not.toContain('--skip-git-repo-check');
    expect(codeWriting).not.toContain('resume');
  });
});

/** `runAgent` renders the §18.2 prompt once and hands it to the runner; these tests drive the adapter directly. */
const run = async (runner: AgentRunner, t: AgentTask) => runner.run(t, promptFixture(t));

describe('createCodexAgentRunner', () => {
  it('replays a recorded run into a validated result with tokens and duration', async () => {
    const { runner } = runnerFor(replay({}));
    const outcome = await run(runner, task());
    expect(runner.name).toBe('codex');
    expect(outcome.status).toBe('completed');
    expect(outcome.summary).toBe('Updated ui-kit to Angular 16.2.12; 214 tests pass.');
    expect(outcome.result?.handover.risks).toEqual(['@angular/material is still on 15 and will need its own package']);
    expect(outcome.tokens).toEqual({ input: 184_320, cached_input: 172_032, output: 9_184, reasoning: 7_040, total: 193_504 });
    expect(outcome.durationMs).toBe(252_000);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.failure).toBeNull();
    expect(outcome.runnerVersion).toBe('codex-cli 0.48.0');
  });

  it('writes the generated output schema to the file it passes to --output-schema, before the scratch dir is cleaned up', async () => {
    // Reads inside the replay closure, which runs while the scratch dir still exists — the adapter removes it
    // once `spawn` resolves, so a read after `run()` returns would race that cleanup.
    let schema: Record<string, unknown> | undefined;
    const base = replay({});
    const spawn: CodexSpawn = async (request) => {
      if (request.args[0] === 'exec') {
        const schemaPath = request.args[request.args.indexOf('--output-schema') + 1];
        if (schemaPath === undefined) throw new Error('expected a schema path');
        schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
      }
      return base(request);
    };
    const { runner } = runnerFor(spawn);
    await run(runner, task());
    if (schema === undefined) throw new Error('expected the exec call to have run');
    expect(schema['title']).toBe('janus-implementation-result');
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toContain('handover');
  });

  it('sends the rendered §18.2 prompt on stdin and the sandbox env to the child', async () => {
    const seen: CodexSpawnRequest[] = [];
    const t = task();
    const { runner } = runnerFor(replay({ seen }));
    await run(runner, t);
    const exec = seen.find((request) => request.args[0] === 'exec');
    expect(exec?.stdin).toContain('## GUARDRAILS AND FORBIDDEN ACTIONS');
    expect(exec?.stdin).toContain('# TASK: implementation');
    expect(exec?.env['npm_config_store_dir']).toBe(t.env['npm_config_store_dir']);
    expect(exec?.cwd).toBe(t.cwd);
    expect(exec?.timeoutMs).toBe(60 * 60_000);
  });

  it('turns an invalid answer into one failed attempt whose detail names the missing field (§18.3)', async () => {
    const { runner } = runnerFor(replay({ lastMessage: 'invalid-output.last-message.json' }));
    const outcome = await run(runner, task());
    expect(outcome.status).toBe('failed');
    expect(outcome.result).toBeNull();
    expect(outcome.failure?.kind).toBe('invalid_output');
    expect(outcome.failure?.detail).toContain('handover');
  });

  it('turns a missing -o file into invalid_output rather than a crash', async () => {
    const { runner } = runnerFor(replay({ lastMessage: null }));
    const outcome = await run(runner, task());
    expect(outcome.failure?.kind).toBe('invalid_output');
    expect(outcome.failure?.detail).toContain('no final message');
  });

  it('reports a timeout kill, keeping whatever usage the partial stream held', async () => {
    const { runner } = runnerFor(replay({ timedOut: true, exitCode: 0, lastMessage: null, jsonl: fixture('timeout-partial.jsonl') }));
    const outcome = await run(runner, task());
    expect(outcome.status).toBe('failed');
    expect(outcome.timedOut).toBe(true);
    expect(outcome.failure?.kind).toBe('timeout');
    expect(outcome.failure?.detail).toContain('60 minutes');
    expect(outcome.tokens).toBeNull();
  });

  it('reports a timeout as failed even when the killed process still wrote a validating answer, but keeps the answer for the evidence trail', async () => {
    const { runner } = runnerFor(replay({ timedOut: true, exitCode: 0 }));
    const outcome = await run(runner, task());
    expect(outcome.status).toBe('failed');
    expect(outcome.result?.summary).toBe('Updated ui-kit to Angular 16.2.12; 214 tests pass.');
    expect(outcome.failure?.kind).toBe('timeout');
    expect(outcome.summary).toContain('agent run failed (timeout)');
  });

  it('reports a signal kill as a failure even when the killed process still wrote a validating answer, but keeps the answer for the evidence trail', async () => {
    const { runner } = runnerFor(replay({ signal: 'SIGKILL', exitCode: 0 }));
    const outcome = await run(runner, task());
    expect(outcome.status).toBe('failed');
    expect(outcome.result?.summary).toBe('Updated ui-kit to Angular 16.2.12; 214 tests pass.');
    expect(outcome.failure?.kind).toBe('nonzero_exit');
    expect(outcome.failure?.detail).toContain('SIGKILL');
    expect(outcome.summary).toContain('agent run failed (nonzero_exit)');
  });

  it('reports a non-zero exit with no usable answer as nonzero_exit', async () => {
    const { runner } = runnerFor(replay({ exitCode: 2, lastMessage: null, jsonl: '' }));
    const outcome = await run(runner, task());
    expect(outcome.failure?.kind).toBe('nonzero_exit');
    expect(outcome.exitCode).toBe(2);
  });

  it('prefers a valid answer over a non-zero exit code', async () => {
    const { runner } = runnerFor(replay({ exitCode: 1 }));
    const outcome = await run(runner, task());
    expect(outcome.status).toBe('completed');
    expect(outcome.failure).toBeNull();
    expect(outcome.exitCode).toBe(1);
  });

  it('carries the spawn result truncation flags into the outcome, even on a validated run', async () => {
    const { runner } = runnerFor(replay({ jsonlTruncated: true, stderrTruncated: true }));
    const outcome = await run(runner, task());
    expect(outcome.status).toBe('completed');
    expect(outcome.jsonlTruncated).toBe(true);
    expect(outcome.stderrTruncated).toBe(true);
  });

  it('defaults the truncation flags to false when the spawn result was not capped', async () => {
    const { runner } = runnerFor(replay({}));
    const outcome = await run(runner, task());
    expect(outcome.jsonlTruncated).toBe(false);
    expect(outcome.stderrTruncated).toBe(false);
  });

  it('embeds only the last 2 KiB of stderr in the failure detail, so an unredacted megabyte never reaches evidence', async () => {
    // `spawn.ts` captures up to STDERR_CAP_BYTES (1 MiB) and `evidence.ts` writes `failure.detail` to the state
    // branch; spec line 661 and §32 rule 12 say that stream may not land there whole and unredacted.
    const noise = 'CODEX_AUTH_TOKEN=sk-do-not-write-this\n'.repeat(400);
    const { runner } = runnerFor(replay({ exitCode: 2, lastMessage: null, jsonl: '', stderr: `${noise}Error: the operative last line` }));
    const outcome = await run(runner, task());

    expect(outcome.failure?.kind).toBe('nonzero_exit');
    const detail = outcome.failure?.detail ?? '';
    expect(detail).toContain('Error: the operative last line');
    expect(detail).toContain('janus kept the last 2048 bytes');
    expect(Buffer.byteLength(detail, 'utf8')).toBeLessThan(2500);
    expect(detail.split('CODEX_AUTH_TOKEN').length - 1).toBeLessThan(60);
  });

  it('leaves a short stderr intact, with no truncation note', async () => {
    const { runner } = runnerFor(replay({ exitCode: 2, lastMessage: null, jsonl: '', stderr: '  boom: everything broke  ' }));
    const outcome = await run(runner, task());
    expect(outcome.failure?.detail).toBe('codex exec exited 2: boom: everything broke');
  });

  it('reports a missing codex binary as spawn_failed with a doctor hint', async () => {
    const { runner } = runnerFor(replay({ spawnFailed: true, lastMessage: null, jsonl: '' }));
    const outcome = await run(runner, task());
    expect(outcome.failure?.kind).toBe('spawn_failed');
    expect(outcome.failure?.detail).toContain('janus doctor');
  });
});
