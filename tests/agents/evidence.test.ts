import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { agentEvidencePath, buildAgentEvidence, writeAgentEvidence } from '../../src/agents/evidence.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { agentTaskFixture, promptFixture, resultFixture } from '../helpers/agent-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';

const TOKEN = 'bbt-super-secret-token-value';

function evidenceFor(paths = workspacePaths(tempDir('janus-evidence-'))) {
  const task = agentTaskFixture({
    runId: 'run-0042',
    role: 'implementation',
    repo: 'ui-kit',
    cwd: paths.repoDir('ui-kit'),
    writableRoots: [paths.repoDir('ui-kit'), paths.pnpmStoreDir],
    env: { npm_config_store_dir: paths.pnpmStoreDir },
    model: { model: 'gpt-5.6-sol', effort: 'xhigh', ladderIndex: 1, ladderLength: 2 },
    attempt: 2,
    experimentId: 'exp-ladder-1',
  });
  const evidence = buildAgentEvidence({
    task,
    paths,
    runner: 'codex',
    startedAt: '2026-09-20T10:00:00.000Z',
    finishedAt: '2026-09-20T10:04:12.000Z',
    outcome: {
      runId: 'run-0042',
      status: 'completed',
      summary: 'raised @angular/core to 16.2.12',
      result: resultFixture(),
      failure: null,
      tokens: { input: 184_320, cached_input: 172_032, output: 9_184, reasoning: 7_040, total: 193_504 },
      durationMs: 252_000,
      exitCode: 0,
      signal: null,
      timedOut: false,
      runnerVersion: 'codex-cli 0.48.0',
      jsonlTruncated: true,
      stderrTruncated: false,
    },
    // `runAgent` renders once and passes it, so `prompt_bytes`/`truncations` come from the prompt, not the runner.
    prompt: {
      ...promptFixture(task),
      bytes: 91_204,
      truncations: ['... [janus truncated the inline diff: 12 of 72012 bytes omitted at agents.max_inline_diff_bytes] ...'],
    },
  });
  return { paths, task, evidence };
}

describe('agent evidence', () => {
  it('writes evidence/agents/<run-id>.yaml with every §18.6 dimension stamped', () => {
    const { paths, evidence } = evidenceFor();
    const relative = writeAgentEvidence(paths, evidence);
    expect(relative).toBe(join('evidence', 'agents', 'run-0042.yaml'));
    expect(agentEvidencePath(paths.janusDir, 'run-0042')).toBe(join(paths.janusDir, 'evidence', 'agents', 'run-0042.yaml'));

    const written = parse(readFileSync(agentEvidencePath(paths.janusDir, 'run-0042'), 'utf8')) as Record<string, unknown>;
    expect(written['run_id']).toBe('run-0042');
    expect(written['role']).toBe('implementation');
    expect(written['class']).toBe('code-writing');
    expect(written['attempt']).toBe(2);
    expect(written['model']).toBe('gpt-5.6-sol');
    expect(written['effort']).toBe('xhigh');
    expect(written['ladder_index']).toBe(1);
    expect(written['profile']).toBe('default');
    expect(written['experiment_id']).toBe('exp-ladder-1');
    expect(written['prompt_version']).toMatch(/^implementation@\d+$/);
    expect(written['runner_version']).toBe('codex-cli 0.48.0');
    expect(written['duration_ms']).toBe(252_000);
    expect(written['exit_code']).toBe(0);
    expect(written['timed_out']).toBe(false);
    expect(written['tokens']).toEqual({ input: 184_320, cached_input: 172_032, output: 9_184, reasoning: 7_040, total: 193_504 });
    expect((written['result'] as Record<string, unknown>)['summary']).toBe('raised @angular/core to 16.2.12');
    expect(written['prompt_bytes']).toBe(91_204);
    expect(written['truncations']).toHaveLength(1);
    expect(written['jsonl_truncated']).toBe(true);
    expect(written['stderr_truncated']).toBe(false);
  });

  it('records paths relative to the workspace, so no home directory leaks into the state branch', () => {
    const { paths, evidence } = evidenceFor();
    writeAgentEvidence(paths, evidence);
    const text = readFileSync(agentEvidencePath(paths.janusDir, 'run-0042'), 'utf8');
    expect(text).not.toContain(paths.root);
    expect(evidence.cwd).toBe(join('repos', 'ui-kit'));
    expect(evidence.writable_roots).toEqual([join('repos', 'ui-kit'), '.pnpm-store']);
  });

  it('records environment variable names only, and never a token or an env dump (§32 rule 12)', () => {
    process.env['JANUS_TEAMCITY_TOKEN'] = TOKEN;
    try {
      const { paths, evidence } = evidenceFor();
      writeAgentEvidence(paths, evidence);
      const text = readFileSync(agentEvidencePath(paths.janusDir, 'run-0042'), 'utf8');
      expect(evidence.env_keys).toEqual(['npm_config_store_dir']);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('JANUS_TEAMCITY_TOKEN');
      expect(text).not.toContain('PATH');
    } finally {
      delete process.env['JANUS_TEAMCITY_TOKEN'];
    }
  });
});
