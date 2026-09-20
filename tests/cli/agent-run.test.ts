import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { seedFakeAgents } from '../../src/providers/fake/agent-runner.js';
import { readEvents } from '../../src/telemetry/events.js';
import { initWorkspace } from '../helpers/engine-fixtures.js';
import { runCli } from '../helpers/run-cli.js';

const TASK_FILE = {
  repo: 'ui-kit',
  attempt: 1,
  guardrails: ['files outside src/ are out of scope'],
  budget: 'ci_fix_attempts: 0 of 5',
  context: {
    goal: 'Upgrade ui-kit from Angular 15 to Angular 16',
    repository: 'ui-kit (library), base branch main',
    plan_slice: 'wp-01-ui-kit-angular',
    current_state: null,
    change_summary: [{ path: 'package.json', added: 12, removed: 3, generated: false }],
    inline_diff: null,
    verification_evidence: null,
    previous_attempts: [],
    baseline_exceptions: [],
  },
};

async function workspaceWithTask(task: Record<string, unknown> = TASK_FILE) {
  const ws = await initWorkspace();
  const taskPath = join(ws.root, 'task.yaml');
  writeFileSync(taskPath, stringify(task));
  return { ws, taskPath };
}

describe('janus agent run', () => {
  it('runs one scripted agent, writes evidence, and exits 0', async () => {
    const { ws, taskPath } = await workspaceWithTask();
    seedFakeAgents(ws.fakeDir, { implementation: [{ status: 'completed', summary: 'bumped @angular/core to 16' }] });

    const result = await runCli(['agent', 'run', 'implementation', '--task', taskPath], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('status: completed');
    expect(result.stdout).toContain('bumped @angular/core to 16');
    expect(result.stdout).toContain('model: gpt-5.6-sol');
    expect(result.stdout).toMatch(/prompt: implementation@\d+/);
    expect(result.stdout).toContain('evidence/agents/');
    expect(result.stdout).toContain('committed by the next janus run checkpoint');

    const runId = /evidence\/agents\/(\S+)\.yaml/u.exec(result.stdout)?.[1];
    expect(runId).toBeDefined();
    expect(existsSync(join(ws.janusDir, 'evidence', 'agents', `${runId ?? ''}.yaml`))).toBe(true);
    const types = readEvents(ws.janusDir).map((event) => event['type']);
    expect(types).toContain('agent.started');
    expect(types).toContain('agent.finished');
  });

  it('exits 1 when the agent answers blocked, and says why', async () => {
    const { ws, taskPath } = await workspaceWithTask();
    seedFakeAgents(ws.fakeDir, { implementation: [{ status: 'blocked', summary: 'the peer dependency is not published yet' }] });
    const result = await runCli(['agent', 'run', 'implementation', '--task', taskPath], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.UnexpectedError);
    expect(result.stderr).toContain('the peer dependency is not published yet');
  });

  it('prints the rendered prompt and the codex invocation for --dry-run, without running anything', async () => {
    const { ws, taskPath } = await workspaceWithTask();
    const result = await runCli(['agent', 'run', 'implementation', '--task', taskPath, '--dry-run'], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('# TASK: implementation');
    expect(result.stdout).toContain('## GUARDRAILS AND FORBIDDEN ACTIONS');
    expect(result.stdout).toContain('## OUTPUT CONTRACT');
    expect(result.stdout).toContain('codex exec -C ');
    expect(result.stdout).toContain('--output-schema');
    expect(result.stdout).not.toContain('resume');
    expect(existsSync(join(ws.janusDir, 'evidence', 'agents'))).toBe(false);
    expect(readEvents(ws.janusDir).some((event) => event['type'] === 'agent.started')).toBe(false);
  });

  it('--dry-run for a report-writing role creates no report directory', async () => {
    const { ws, taskPath } = await workspaceWithTask({ ...TASK_FILE, repo: null });
    const result = await runCli(['agent', 'run', 'qa', '--task', taskPath, '--dry-run'], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.Ok);
    expect(existsSync(join(ws.janusDir, 'reports'))).toBe(false);
  });

  it('exits 2 for an unknown role', async () => {
    const { ws, taskPath } = await workspaceWithTask();
    const result = await runCli(['agent', 'run', 'architect', '--task', taskPath], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('unknown agent role "architect"');
    expect(result.stderr).toContain('integration_discovery');
  });

  it('exits 2 for a task file that is missing or does not match the schema', async () => {
    const { ws } = await workspaceWithTask();
    const missing = await runCli(['agent', 'run', 'qa', '--task', join(ws.root, 'nope.yaml')], { cwd: ws.root });
    expect(missing.code).toBe(ExitCode.UsageError);
    expect(missing.stderr).toContain('file not found');

    const badPath = join(ws.root, 'bad.yaml');
    writeFileSync(badPath, stringify({ repo: 'ui-kit', context: { goal: 42 } }));
    const bad = await runCli(['agent', 'run', 'qa', '--task', badPath], { cwd: ws.root });
    expect(bad.code).toBe(ExitCode.UsageError);
    expect(bad.stderr).toContain('context.goal');
  });

  it('exits 2 for a model profile that config.yaml does not define', async () => {
    const { ws, taskPath } = await workspaceWithTask();
    const result = await runCli(['agent', 'run', 'implementation', '--task', taskPath, '--model-profile', 'nope'], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('model profile "nope"');
  });

  it('runs a report-writing role with no repo', async () => {
    const { ws, taskPath } = await workspaceWithTask({ ...TASK_FILE, repo: null });
    seedFakeAgents(ws.fakeDir, { qa: [{ status: 'completed', summary: 'test the order flow', reports: { 'qa.md': '# QA\n' } }] });
    const result = await runCli(['agent', 'run', 'qa', '--task', taskPath], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.Ok);
    const runId = /evidence\/agents\/(\S+)\.yaml/u.exec(result.stdout)?.[1] ?? '';
    expect(readFileSync(join(ws.janusDir, 'reports', runId, 'qa.md'), 'utf8')).toContain('# QA');
  });
});
