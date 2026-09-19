# T01 Repository Bootstrap and CLI Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the Janus TypeScript project with a working `janus` CLI whose commands exist as stubs, plus validated `config.yaml` and `goal.yaml` schemas with useful error messages.

**Architecture:** A single pnpm package. `src/cli/` builds a commander program whose handlers write an exit code into a shared context object, so the CLI is testable in-process. `src/config/` holds zod schemas for the two YAML files, a loader that turns files into typed objects, and a graph validator for the goal's repository relationships. Nothing here talks to git, Codex, TeamCity, or Bitbucket; that starts in T02.

**Tech Stack:** Node 20+, pnpm, TypeScript (strict, ESM, NodeNext), commander, zod 3, yaml, vitest, ESLint 9 with typescript-eslint, GitHub Actions.

**Spec:** `angular-ai-development-workflow-v2.md` (§4 goal model, §8 CLI surface, §18.6 model profiles, §28 configuration). Task definition: `tasks.md` T01.

## Global Constraints

- Node `>=20`; the project is ESM (`"type": "module"`); relative imports use `.js` extensions.
- Package manager is `pnpm`; commit messages follow `type(scope): subject`.
- TypeScript `strict: true`; no `any` outside tests.
- Exit codes per §8 are distinct per run outcome; defined once in `src/cli/exit-codes.ts`.
- Secrets never come from files; `config.yaml` only names the environment variable (`token_env`).
- Every configured value in §28 has a default except `teamcity.url` and `bitbucket.url`, which are required only when the matching provider is selected.
- A goal covers exactly one major: `target_version` must equal `source_version + 1`.
- Every command in §8 must exist on the CLI after this plan, even if it only reports "not implemented".

---

## File Structure

```text
package.json                      project manifest, scripts, pinned packageManager
tsconfig.json                     strict ESM config for src + tests (typecheck)
tsconfig.build.json               emits src/ to dist/
vitest.config.ts                  test discovery under tests/
eslint.config.js                  flat config: @eslint/js + typescript-eslint
.github/workflows/ci.yml          lint, typecheck, test, build
bin/janus.js                      executable shim -> dist/cli/main.js
src/cli/exit-codes.ts             ExitCode constants (single source of truth)
src/cli/context.ts                CliIo + CliContext types, defaultIo()
src/cli/version.ts                VERSION constant
src/cli/not-implemented.ts        notImplemented(ctx, what, task) helper
src/cli/main.ts                   buildProgram(), main(argv, io) -> exit code
src/cli/commands/index.ts         registerCommands(program, ctx)
src/cli/commands/init.ts          init (validates goal file; workspace creation is T02)
src/cli/commands/run.ts           run
src/cli/commands/status.ts        status
src/cli/commands/approve.ts       approve plan | revised-plan
src/cli/commands/reject.ts        reject plan
src/cli/commands/escalation.ts    escalation show | resolve
src/cli/commands/review.ts        review sync
src/cli/commands/doctor.ts        doctor
src/cli/commands/agent.ts         agent run <role>
src/cli/commands/ci.ts            ci wait | trigger | digest
src/cli/commands/telemetry.ts     telemetry export | compare
src/config/errors.ts              ConfigError, formatZodIssues()
src/config/yaml.ts                readYamlFile(path) -> unknown
src/config/config-schema.ts       configSchema, JanusConfig type
src/config/load-config.ts         parseConfig(), loadConfig(), resolveToken()
src/config/goal-schema.ts         goalSchema, Goal, GoalRepo types
src/config/validate-goal.ts       validateGoal() -> ValidatedGoal (graph checks, order)
src/config/load-goal.ts           loadGoal(path) -> ValidatedGoal
tests/helpers/run-cli.ts          runCli(argv, io overrides) -> { code, stdout, stderr }
tests/cli/main.test.ts
tests/cli/commands.test.ts
tests/cli/init.test.ts
tests/config/errors.test.ts
tests/config/yaml.test.ts
tests/config/config-schema.test.ts
tests/config/load-config.test.ts
tests/config/goal-schema.test.ts
tests/config/validate-goal.test.ts
README.md                         stub: what Janus is, scripts, where the spec lives
```

---

### Task 1: Project scaffold, toolchain, CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `eslint.config.js`, `.github/workflows/ci.yml`, `tests/smoke.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: scripts `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm dev -- <args>` used by every later task.

- [ ] **Step 1: Write package.json (without dependency versions; pnpm fills them)**

```json
{
  "name": "@krukkeniels/janus",
  "version": "0.0.1",
  "private": true,
  "description": "Agent-driven, resumable orchestrator for multi-repo Angular major upgrades",
  "type": "module",
  "bin": { "janus": "bin/janus.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsx src/cli/main.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {},
  "devDependencies": {}
}
```

- [ ] **Step 2: Install dependencies and pin the package manager**

Run:
```bash
cd /home/race-day/janus
pnpm add commander yaml zod@3
pnpm add -D typescript tsx vitest eslint @eslint/js typescript-eslint @types/node
node -e "const p=require('./package.json');p.packageManager='pnpm@'+require('child_process').execSync('pnpm --version').toString().trim();require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
```
Expected: `pnpm-lock.yaml` exists; `package.json` has a `packageManager` field like `pnpm@10.x.y`.

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 4: Write tsconfig.build.json**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 5: Write vitest.config.ts and eslint.config.js**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
```

`eslint.config.js`:
```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'bin/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
```

- [ ] **Step 6: Write the smoke test and the CI workflow**

`tests/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });
});
```

`.github/workflows/ci.yml`:
```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 7: Extend .gitignore**

Append to `.gitignore`:
```text
coverage/
.vitest/
```

- [ ] **Step 8: Run the toolchain**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: lint reports no errors (no source files yet), typecheck passes, vitest reports `1 passed`.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json vitest.config.ts eslint.config.js .github/workflows/ci.yml tests/smoke.test.ts .gitignore
git commit -m "chore: bootstrap pnpm, typescript, vitest, eslint, and ci"
```

---

### Task 2: Exit codes, CLI context, program builder, bin shim

**Files:**
- Create: `src/cli/exit-codes.ts`, `src/cli/context.ts`, `src/cli/version.ts`, `src/cli/main.ts`, `src/cli/commands/index.ts`, `bin/janus.js`, `tests/helpers/run-cli.ts`, `tests/cli/main.test.ts`
- Delete: `tests/smoke.test.ts`

**Interfaces:**
- Produces:
  - `ExitCode` constants: `Ok=0, UnexpectedError=1, UsageError=2, NotImplemented=3, GateWaiting=10, WaitExceeded=11, Escalated=12, Locked=13`
  - `interface CliIo { stdout(text: string): void; stderr(text: string): void; env: Record<string, string | undefined>; cwd: string }`
  - `interface CliContext { io: CliIo; exitCode: ExitCode }`
  - `buildProgram(ctx: CliContext): Command`
  - `main(argv: string[], io?: CliIo): Promise<ExitCode>`
  - `registerCommands(program: Command, ctx: CliContext): void` (empty for now; Task 3 fills it)
  - test helper `runCli(argv, overrides?) -> Promise<{ code: number; stdout: string; stderr: string }>`

- [ ] **Step 1: Write the failing tests**

`tests/helpers/run-cli.ts`:
```ts
import { main } from '../../src/cli/main.js';
import type { CliIo } from '../../src/cli/context.js';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(argv: string[], overrides: Partial<CliIo> = {}): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: {},
    cwd: process.cwd(),
    ...overrides,
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
}
```

`tests/cli/main.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { VERSION } from '../../src/cli/version.js';
import { runCli } from '../helpers/run-cli.js';

describe('janus cli', () => {
  it('prints help and exits 0 with --help', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('Usage: janus');
  });

  it('prints the version with --version', async () => {
    const result = await runCli(['--version']);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout.trim()).toBe(VERSION);
  });

  it('exits 2 on an unknown command', async () => {
    const result = await runCli(['frobnicate']);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('unknown command');
  });

  it('prints help and exits 0 when called with no arguments', async () => {
    const result = await runCli([]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('Usage: janus');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `rm tests/smoke.test.ts && pnpm test`
Expected: FAIL, cannot resolve `../../src/cli/main.js`.

- [ ] **Step 3: Write exit codes, context, version**

`src/cli/exit-codes.ts`:
```ts
/** Process exit codes. Distinct per run outcome (spec §8). */
export const ExitCode = {
  Ok: 0,
  UnexpectedError: 1,
  UsageError: 2,
  NotImplemented: 3,
  GateWaiting: 10,
  WaitExceeded: 11,
  Escalated: 12,
  Locked: 13,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
```

`src/cli/context.ts`:
```ts
import type { ExitCode } from './exit-codes.js';
import { ExitCode as Codes } from './exit-codes.js';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
}

export interface CliContext {
  io: CliIo;
  exitCode: ExitCode;
}

export function defaultIo(): CliIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    env: process.env,
    cwd: process.cwd(),
  };
}

export function createContext(io: CliIo): CliContext {
  return { io, exitCode: Codes.Ok };
}
```

`src/cli/version.ts`:
```ts
export const VERSION = '0.0.1';
```

- [ ] **Step 4: Write the program builder and main**

`src/cli/commands/index.ts` (filled in Task 3):
```ts
import type { Command } from 'commander';
import type { CliContext } from '../context.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerCommands(program: Command, ctx: CliContext): void {
  // Commands are registered in Task 3.
}
```

`src/cli/main.ts`:
```ts
import { Command, CommanderError } from 'commander';
import { registerCommands } from './commands/index.js';
import { createContext, defaultIo } from './context.js';
import type { CliContext, CliIo } from './context.js';
import { ExitCode } from './exit-codes.js';
import { VERSION } from './version.js';

export function buildProgram(ctx: CliContext): Command {
  const program = new Command('janus');
  program
    .description('Agent-driven, resumable orchestrator for multi-repo Angular major upgrades')
    .version(VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => ctx.io.stdout(text),
      writeErr: (text) => ctx.io.stderr(text),
    })
    .showHelpAfterError('(run "janus --help" for usage)');
  registerCommands(program, ctx);
  return program;
}

const HELP_CODES = new Set(['commander.helpDisplayed', 'commander.help', 'commander.version']);

export async function main(argv: string[], io: CliIo = defaultIo()): Promise<ExitCode> {
  const ctx = createContext(io);
  const program = buildProgram(ctx);
  if (argv.length === 0) {
    program.outputHelp();
    return ExitCode.Ok;
  }
  try {
    await program.parseAsync(argv, { from: 'user' });
    return ctx.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return HELP_CODES.has(error.code) ? ExitCode.Ok : ExitCode.UsageError;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`janus: ${message}\n`);
    return ExitCode.UnexpectedError;
  }
}
```

`bin/janus.js`:
```js
#!/usr/bin/env node
import { main } from '../dist/cli/main.js';

process.exitCode = await main(process.argv.slice(2));
```

Run: `chmod +x bin/janus.js`

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verify the built binary and dev script**

Run: `pnpm build && node bin/janus.js --version && pnpm dev -- --help | head -3`
Expected: prints `0.0.1`, then the usage header.

- [ ] **Step 7: Commit**

```bash
git add bin/janus.js src/cli tests/helpers tests/cli/main.test.ts
git rm -q --cached tests/smoke.test.ts 2>/dev/null || true
git add -A tests
git commit -m "feat(cli): add exit codes, io context, program builder, and bin shim"
```

---

### Task 3: Command stubs for the full §8 surface

**Files:**
- Create: `src/cli/not-implemented.ts`, `src/cli/commands/init.ts`, `src/cli/commands/run.ts`, `src/cli/commands/status.ts`, `src/cli/commands/approve.ts`, `src/cli/commands/reject.ts`, `src/cli/commands/escalation.ts`, `src/cli/commands/review.ts`, `src/cli/commands/doctor.ts`, `src/cli/commands/agent.ts`, `src/cli/commands/ci.ts`, `src/cli/commands/telemetry.ts`, `tests/cli/commands.test.ts`
- Modify: `src/cli/commands/index.ts`

**Interfaces:**
- Consumes: `CliContext`, `ExitCode`, `Command` from Task 2.
- Produces: `notImplemented(ctx: CliContext, what: string, task: string): ExitCode` writing `janus: <what> is not implemented yet (planned in <task>).` to stderr and returning `ExitCode.NotImplemented`. Each command file exports `register<Name>(program: Command, ctx: CliContext): void`. Task 9 replaces the body of `registerInit`.

- [ ] **Step 1: Write the failing tests**

`tests/cli/commands.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { runCli } from '../helpers/run-cli.js';

const stubbed: string[][] = [
  ['run'],
  ['run', '--until', 'planning', '--max-wait', '45m', '--dry-run', '--model-profile', 'fast-first'],
  ['status'],
  ['status', '--json', '--telemetry'],
  ['approve', 'plan', '--commit', 'abc123'],
  ['approve', 'plan', '--commit', 'abc123', '--exception', 'ex-1', '--exception', 'ex-2'],
  ['approve', 'revised-plan', '--commit', 'abc123'],
  ['reject', 'plan', '--reason', 'wrong order'],
  ['escalation', 'show'],
  ['escalation', 'show', '--json'],
  ['escalation', 'resolve', '--direction', 'split the shell package'],
  ['review', 'sync'],
  ['doctor'],
  ['doctor', '--json'],
  ['agent', 'run', 'debug', '--task', 'task.yaml'],
  ['ci', 'wait', '--repo', 'shell', '--build', '42'],
  ['ci', 'trigger', '--repo', 'shell'],
  ['ci', 'digest', '--repo', 'shell', '--build', '42'],
  ['telemetry', 'export'],
  ['telemetry', 'export', '--csv'],
  ['telemetry', 'compare', 'a.jsonl', 'b.jsonl'],
  ['init', '--resume', 'ssh://git/state.git', 'angular-15-to-16'],
];

describe('command stubs', () => {
  it.each(stubbed)('%s exits 3 with a not-implemented message', async (...argv) => {
    const result = await runCli(argv);
    expect(result.code).toBe(ExitCode.NotImplemented);
    expect(result.stderr).toMatch(/not implemented yet \(planned in T\d\d\)/);
  });

  it('rejects approve plan without --commit', async () => {
    const result = await runCli(['approve', 'plan']);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain("required option '--commit <sha>' not specified");
  });

  it('rejects reject plan without --reason', async () => {
    const result = await runCli(['reject', 'plan']);
    expect(result.code).toBe(ExitCode.UsageError);
  });

  it('rejects escalation resolve without --direction', async () => {
    const result = await runCli(['escalation', 'resolve']);
    expect(result.code).toBe(ExitCode.UsageError);
  });

  it('lists every top-level command in help', async () => {
    const result = await runCli(['--help']);
    for (const name of ['init', 'run', 'status', 'approve', 'reject', 'escalation', 'review', 'doctor', 'agent', 'ci', 'telemetry']) {
      expect(result.stdout).toContain(name);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/cli/commands.test.ts`
Expected: FAIL, every stubbed case exits 2 with "unknown command".

- [ ] **Step 3: Write the helper and the command files**

`src/cli/not-implemented.ts`:
```ts
import type { CliContext } from './context.js';
import { ExitCode } from './exit-codes.js';

export function notImplemented(ctx: CliContext, what: string, task: string): ExitCode {
  ctx.io.stderr(`janus: ${what} is not implemented yet (planned in ${task}).\n`);
  return ExitCode.NotImplemented;
}
```

`src/cli/commands/init.ts` (temporary body; Task 9 replaces it):
```ts
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerInit(program: Command, ctx: CliContext): void {
  program
    .command('init')
    .description('Create a goal workspace from a goal file, or rebuild one from a state branch')
    .argument('[goal-id]', 'goal id, used with --resume')
    .option('--goal <file>', 'path to goal.yaml')
    .option('--config <file>', 'path to config.yaml (defaults next to the goal file)')
    .option('--workspace <dir>', 'workspace directory to create (default: ./<goal-id>)')
    .option('--resume <state-remote>', 'rebuild a workspace from a state branch remote')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'init', 'T02');
    });
}
```

`src/cli/commands/run.ts`:
```ts
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerRun(program: Command, ctx: CliContext): void {
  program
    .command('run')
    .description('Advance the goal until the next gate, wait limit, escalation, or completion')
    .option('--until <stage>', 'stop once this stage is reached')
    .option('--max-wait <duration>', 'longest blocking wait before exiting, for example 45m')
    .option('--dry-run', 'print the next steps without running agents, commits, or CI calls')
    .option('--model-profile <name>', 'model profile override for this invocation')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'run', 'T03');
    });
}
```

`src/cli/commands/status.ts`:
```ts
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerStatus(program: Command, ctx: CliContext): void {
  program
    .command('status')
    .description('Show goal stage, per-repo state, budgets, gate, and merge order')
    .option('--json', 'machine-readable output')
    .option('--telemetry', 'include derived metrics')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'status', 'T14');
    });
}
```

`src/cli/commands/approve.ts`:
```ts
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerApprove(program: Command, ctx: CliContext): void {
  const approve = program.command('approve').description('Pass a human gate');

  approve
    .command('plan')
    .description('Approve the technical plan, baseline, and listed exceptions (Gate 1)')
    .requiredOption('--commit <sha>', 'state-branch commit that contains the plan being approved')
    .option('--exception <id...>', 'baseline exception ids to approve')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'approve plan', 'T03');
    });

  approve
    .command('revised-plan')
    .description('Approve a revised plan after an escalation (Gate 2)')
    .requiredOption('--commit <sha>', 'state-branch commit that contains the revised plan')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'approve revised-plan', 'T03');
    });
}
```

`src/cli/commands/reject.ts`:
```ts
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerReject(program: Command, ctx: CliContext): void {
  const reject = program.command('reject').description('Reject a gate with a reason');

  reject
    .command('plan')
    .description('Reject the current plan and send it back to planning')
    .requiredOption('--reason <text>', 'why the plan is rejected')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'reject plan', 'T03');
    });
}
```

`src/cli/commands/escalation.ts`:
```ts
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerEscalation(program: Command, ctx: CliContext): void {
  const escalation = program.command('escalation').description('Inspect or resolve an escalation');

  escalation
    .command('show')
    .description('Print the current escalation package')
    .option('--json', 'machine-readable output')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'escalation show', 'T13');
    });

  escalation
    .command('resolve')
    .description('Record human direction and start replanning')
    .requiredOption('--direction <text>', 'the direction the planning agent must follow')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'escalation resolve', 'T13');
    });
}
```

`src/cli/commands/review.ts`:
```ts
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerReview(program: Command, ctx: CliContext): void {
  const review = program.command('review').description('Human PR review loop helpers');

  review
    .command('sync')
    .description('Fetch new PR activity now')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'review sync', 'T13');
    });
}
```

`src/cli/commands/doctor.ts`:
```ts
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerDoctor(program: Command, ctx: CliContext): void {
  program
    .command('doctor')
    .description('Check codex, git, tokens, sandbox, and provider reachability')
    .option('--json', 'machine-readable output')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'doctor', 'T07');
    });
}
```

`src/cli/commands/agent.ts`:
```ts
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerAgent(program: Command, ctx: CliContext): void {
  const agent = program.command('agent').description('Debug helpers for agent tasks');

  agent
    .command('run')
    .description('Run one agent task by hand')
    .argument('<role>', 'agent role, for example implementation or debug')
    .requiredOption('--task <file>', 'task file describing the context package')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'agent run', 'T05');
    });
}
```

`src/cli/commands/ci.ts`:
```ts
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerCi(program: Command, ctx: CliContext): void {
  const ci = program.command('ci').description('Debug helpers for the CI provider');

  ci
    .command('wait')
    .description('Wait for a build to finish')
    .requiredOption('--repo <name>', 'repository name from goal.yaml')
    .requiredOption('--build <id>', 'build id')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'ci wait', 'T09');
    });

  ci
    .command('trigger')
    .description('Trigger the PR build for a repository')
    .requiredOption('--repo <name>', 'repository name from goal.yaml')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'ci trigger', 'T09');
    });

  ci
    .command('digest')
    .description('Produce the failure digest for a build')
    .requiredOption('--repo <name>', 'repository name from goal.yaml')
    .requiredOption('--build <id>', 'build id')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'ci digest', 'T09');
    });
}
```

`src/cli/commands/telemetry.ts`:
```ts
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerTelemetry(program: Command, ctx: CliContext): void {
  const telemetry = program.command('telemetry').description('Export and compare telemetry');

  telemetry
    .command('export')
    .description('Write the event log with resolved model dimensions')
    .option('--csv', 'CSV instead of JSONL')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'telemetry export', 'T21');
    });

  telemetry
    .command('compare')
    .description('Compare runs per model, role, and prompt version across event logs')
    .argument('<events...>', 'one or more events.jsonl files')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'telemetry compare', 'T21');
    });
}
```

- [ ] **Step 4: Register everything**

Replace `src/cli/commands/index.ts`:
```ts
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { registerAgent } from './agent.js';
import { registerApprove } from './approve.js';
import { registerCi } from './ci.js';
import { registerDoctor } from './doctor.js';
import { registerEscalation } from './escalation.js';
import { registerInit } from './init.js';
import { registerReject } from './reject.js';
import { registerReview } from './review.js';
import { registerRun } from './run.js';
import { registerStatus } from './status.js';
import { registerTelemetry } from './telemetry.js';

export function registerCommands(program: Command, ctx: CliContext): void {
  registerInit(program, ctx);
  registerRun(program, ctx);
  registerStatus(program, ctx);
  registerApprove(program, ctx);
  registerReject(program, ctx);
  registerEscalation(program, ctx);
  registerReview(program, ctx);
  registerDoctor(program, ctx);
  registerAgent(program, ctx);
  registerCi(program, ctx);
  registerTelemetry(program, ctx);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS. If the `required option` assertion fails on exact wording, copy the exact commander message from the failure output into the test; the exit code assertion is the important one.

- [ ] **Step 6: Lint and typecheck, then commit**

Run: `pnpm lint && pnpm typecheck`
Expected: no errors.

```bash
git add src/cli tests/cli/commands.test.ts
git commit -m "feat(cli): register all spec §8 commands as not-implemented stubs"
```

---

### Task 4: Config errors and YAML reading

**Files:**
- Create: `src/config/errors.ts`, `src/config/yaml.ts`, `tests/config/errors.test.ts`, `tests/config/yaml.test.ts`

**Interfaces:**
- Produces:
  - `class ConfigError extends Error { readonly source: string; readonly issues: string[] }` with message `"<source>: N problem(s)\n  - issue\n  - issue"`
  - `formatZodIssues(error: ZodError): string[]` producing `"path.to.field: message"` (or `"<root>: message"`)
  - `readYamlFile(path: string): unknown` throwing `ConfigError` for a missing file or invalid YAML; an empty file yields `null`

- [ ] **Step 1: Write the failing tests**

`tests/config/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, formatZodIssues } from '../../src/config/errors.js';

describe('ConfigError', () => {
  it('lists every issue in its message', () => {
    const error = new ConfigError('config.yaml', ['teamcity.url: required', 'agents.max_parallel: must be positive']);
    expect(error.name).toBe('ConfigError');
    expect(error.source).toBe('config.yaml');
    expect(error.issues).toHaveLength(2);
    expect(error.message).toBe(
      'config.yaml: 2 problem(s)\n  - teamcity.url: required\n  - agents.max_parallel: must be positive',
    );
  });
});

describe('formatZodIssues', () => {
  it('joins paths with dots and uses <root> for top-level issues', () => {
    const schema = z.object({ a: z.object({ b: z.number() }) }).strict();
    const result = schema.safeParse({ a: { b: 'x' }, extra: 1 });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issues = formatZodIssues(result.error);
    expect(issues).toContain('a.b: Expected number, received string');
    expect(issues.some((issue) => issue.startsWith("<root>: Unrecognized key(s) in object: 'extra'"))).toBe(true);
  });
});
```

`tests/config/yaml.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { readYamlFile } from '../../src/config/yaml.js';

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'janus-yaml-'));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('readYamlFile', () => {
  it('parses a YAML document', () => {
    const path = tempFile('a.yaml', 'workflow:\n  ci_provider: local\n');
    expect(readYamlFile(path)).toEqual({ workflow: { ci_provider: 'local' } });
  });

  it('returns null for an empty file', () => {
    expect(readYamlFile(tempFile('empty.yaml', ''))).toBeNull();
  });

  it('throws ConfigError naming the file when it is missing', () => {
    expect(() => readYamlFile('/nonexistent/config.yaml')).toThrowError(ConfigError);
    expect(() => readYamlFile('/nonexistent/config.yaml')).toThrowError(/file not found/);
  });

  it('throws ConfigError with the parser message for invalid YAML', () => {
    const path = tempFile('bad.yaml', 'a: [1, 2\n');
    expect(() => readYamlFile(path)).toThrowError(ConfigError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/config`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

`src/config/errors.ts`:
```ts
import type { ZodError } from 'zod';

export class ConfigError extends Error {
  readonly source: string;
  readonly issues: string[];

  constructor(source: string, issues: string[]) {
    const lines = issues.map((issue) => `  - ${issue}`).join('\n');
    super(`${source}: ${issues.length} problem(s)\n${lines}`);
    this.name = 'ConfigError';
    this.source = source;
    this.issues = issues;
  }
}

export function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${path}: ${issue.message}`;
  });
}
```

`src/config/yaml.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { ConfigError } from './errors.js';

export function readYamlFile(path: string): unknown {
  if (!existsSync(path)) {
    throw new ConfigError(path, ['file not found']);
  }
  const text = readFileSync(path, 'utf8');
  try {
    return parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(path, [`invalid YAML: ${message}`]);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/config`
Expected: PASS, 6 tests. If the exact zod message wording differs, update the two string assertions to the actual wording printed; the shape `path: message` is what matters.

- [ ] **Step 5: Commit**

```bash
git add src/config/errors.ts src/config/yaml.ts tests/config/errors.test.ts tests/config/yaml.test.ts
git commit -m "feat(config): add ConfigError, zod issue formatting, and yaml reader"
```

---

### Task 5: Config schema with defaults

**Files:**
- Create: `src/config/config-schema.ts`, `tests/config/config-schema.test.ts`

**Interfaces:**
- Produces: `configSchema` (zod), `type JanusConfig = z.infer<typeof configSchema>`, `type ModelSpec`, `type AgentRole` union of the ten role names, `DEFAULT_DISCOVERY_AREAS`.

- [ ] **Step 1: Write the failing tests**

`tests/config/config-schema.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { formatZodIssues } from '../../src/config/errors.js';

function issuesOf(input: unknown): string[] {
  const result = configSchema.safeParse(input);
  return result.success ? [] : formatZodIssues(result.error);
}

describe('configSchema', () => {
  it('applies every default to a config that only selects fake providers', () => {
    const config = configSchema.parse({
      workflow: { agent_runner: 'fake', ci_provider: 'fake', scm_provider: 'fake' },
    });
    expect(config.workflow.create_prs_early).toBe(true);
    expect(config.teamcity.poll_interval_seconds).toBe(30);
    expect(config.teamcity.token_env).toBe('JANUS_TEAMCITY_TOKEN');
    expect(config.bitbucket.token_env).toBe('JANUS_BITBUCKET_TOKEN');
    expect(config.agents.max_parallel).toBe(4);
    expect(config.agents.roles.implementation.timeout_minutes).toBe(60);
    expect(config.agents.roles.checkpoint.timeout_minutes).toBe(20);
    expect(config.discovery.areas).toEqual(['deps-and-build', 'tests-and-e2e', 'architecture-and-ci']);
    expect(config.workflow_models.profile).toBe('default');
    expect(config.model_profiles.default?.['*']?.model).toBe('gpt-5.6-sol');
    expect(config.guardrails.max_ci_fix_attempts).toBe(5);
    expect(config.guardrails.max_infra_retries).toBe(1);
    expect(config.digest.max_bytes).toBe(65536);
    expect(config.digest.redact).toBe(true);
    expect(config.policy.forbidden_paths).toEqual(['.teamcity/**', '.github/**']);
    expect(config.experiment.id).toBeNull();
    expect(config.telemetry.price_table).toBeNull();
  });

  it('defaults providers to codex, teamcity, and bitbucket-server and then requires urls', () => {
    const issues = issuesOf({});
    expect(issues).toContain('teamcity.url: required when workflow.ci_provider is "teamcity"');
    expect(issues).toContain('bitbucket.url: required when workflow.scm_provider is "bitbucket-server"');
  });

  it('accepts real providers when urls are present', () => {
    const issues = issuesOf({
      teamcity: { url: 'https://teamcity.example.internal' },
      bitbucket: { url: 'https://bitbucket.example.internal' },
    });
    expect(issues).toEqual([]);
  });

  it('rejects unknown keys anywhere', () => {
    const issues = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake', bogus: 1 },
    });
    expect(issues.some((issue) => issue.startsWith('workflow: Unrecognized key'))).toBe(true);
  });

  it('rejects a selected model profile that does not exist', () => {
    const issues = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      workflow_models: { profile: 'missing' },
    });
    expect(issues).toContain('workflow_models.profile: model profile "missing" is not defined in model_profiles');
  });

  it('requires every model profile to have a "*" fallback', () => {
    const issues = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      model_profiles: { default: { implementation: { model: 'gpt-5.6-sol' } } },
    });
    expect(issues).toContain('model_profiles.default: must define a "*" entry used for roles without an explicit model');
  });

  it('rejects a role timeout above max_agent_runtime_minutes', () => {
    const issues = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      agents: { roles: { implementation: { timeout_minutes: 90 } } },
      guardrails: { max_agent_runtime_minutes: 60 },
    });
    expect(issues).toContain('agents.roles.implementation.timeout_minutes: must not exceed guardrails.max_agent_runtime_minutes (60)');
  });

  it('rejects an unknown role name inside a model profile', () => {
    const issues = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      model_profiles: { default: { '*': { model: 'x' }, tester: { model: 'y' } } },
    });
    expect(issues.some((issue) => issue.startsWith('model_profiles.default.tester'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/config/config-schema.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the schema**

`src/config/config-schema.ts`:
```ts
import { z } from 'zod';

export const AGENT_ROLES = [
  'implementation',
  'debug',
  'fix',
  'sync_conflict',
  'discovery',
  'planning',
  'checkpoint',
  'review',
  'triage',
  'qa',
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export const DEFAULT_DISCOVERY_AREAS = ['deps-and-build', 'tests-and-e2e', 'architecture-and-ci'];

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

const roleTimeout = (minutes: number) =>
  z.object({ timeout_minutes: positiveInt.default(minutes) }).strict().default({});

const modelSpecSchema = z
  .object({
    model: z.string().min(1),
    effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('high'),
    ladder: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export type ModelSpec = z.infer<typeof modelSpecSchema>;

const modelProfileSchema = z.record(z.string(), modelSpecSchema).superRefine((profile, ctx) => {
  for (const role of Object.keys(profile)) {
    if (role !== '*' && !(AGENT_ROLES as readonly string[]).includes(role)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [role], message: `unknown agent role; expected "*" or one of ${AGENT_ROLES.join(', ')}` });
    }
  }
  if (!('*' in profile)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must define a "*" entry used for roles without an explicit model' });
  }
});

const priceSchema = z
  .object({
    input_per_million: z.number().nonnegative(),
    cached_input_per_million: z.number().nonnegative(),
    output_per_million: z.number().nonnegative(),
    reasoning_per_million: z.number().nonnegative(),
  })
  .strict();

export const configSchema = z
  .object({
    workflow: z
      .object({
        agent_runner: z.enum(['codex', 'fake']).default('codex'),
        ci_provider: z.enum(['teamcity', 'local', 'fake']).default('teamcity'),
        scm_provider: z.enum(['bitbucket-server', 'fake']).default('bitbucket-server'),
        create_prs_early: z.boolean().default(true),
      })
      .strict()
      .default({}),
    state: z
      .object({
        repo: z.object({ project: z.string().min(1), slug: z.string().min(1) }).strict().optional(),
      })
      .strict()
      .default({}),
    teamcity: z
      .object({
        url: z.string().url().optional(),
        token_env: z.string().min(1).default('JANUS_TEAMCITY_TOKEN'),
        poll_interval_seconds: positiveInt.default(30),
        appearance_timeout_minutes: positiveInt.default(5),
        build_timeout_minutes: positiveInt.default(90),
        e2e_timeout_minutes: positiveInt.default(240),
      })
      .strict()
      .default({}),
    bitbucket: z
      .object({
        url: z.string().url().optional(),
        token_env: z.string().min(1).default('JANUS_BITBUCKET_TOKEN'),
        required_reviewers: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({}),
    local_ci: z
      .object({
        repos: z
          .record(
            z.string(),
            z
              .object({
                install: z.string().min(1).optional(),
                build: z.string().min(1).optional(),
                test: z.string().min(1).optional(),
                lint: z.string().min(1).optional(),
              })
              .strict(),
          )
          .default({}),
        e2e: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    discovery: z
      .object({ areas: z.array(z.string().min(1)).min(1).default(DEFAULT_DISCOVERY_AREAS) })
      .strict()
      .default({}),
    agents: z
      .object({
        max_parallel: positiveInt.default(4),
        max_context_bytes: positiveInt.default(200_000),
        max_inline_diff_bytes: positiveInt.default(60_000),
        pnpm_store: z.enum(['workspace', 'global']).default('workspace'),
        allow_unsandboxed: z.boolean().default(false),
        roles: z
          .object({
            implementation: roleTimeout(60),
            debug: roleTimeout(45),
            fix: roleTimeout(45),
            sync_conflict: roleTimeout(30),
            discovery: roleTimeout(30),
            planning: roleTimeout(45),
            checkpoint: roleTimeout(20),
            review: roleTimeout(60),
            triage: roleTimeout(20),
            qa: roleTimeout(30),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    workflow_models: z.object({ profile: z.string().min(1).default('default') }).strict().default({}),
    model_profiles: z
      .record(z.string(), modelProfileSchema)
      .default({ default: { '*': { model: 'gpt-5.6-sol', effort: 'high' } } }),
    experiment: z
      .object({
        id: z.string().min(1).nullable().default(null),
        hypothesis: z.string().nullable().default(null),
        notes: z.string().nullable().default(null),
      })
      .strict()
      .default({}),
    policy: z
      .object({
        forbidden_test_patterns: z
          .array(z.string().min(1))
          .default(['xit(', 'xdescribe(', 'fit(', 'fdescribe(', '.skip(', '.only(']),
        forbidden_paths: z.array(z.string().min(1)).default(['.teamcity/**', '.github/**']),
        max_test_count_decrease_percent: z.number().min(0).max(100).default(0),
        allow_test_file_deletion: z.boolean().default(false),
      })
      .strict()
      .default({}),
    digest: z
      .object({
        max_tests: positiveInt.default(50),
        log_tail_lines: positiveInt.default(400),
        max_error_windows: positiveInt.default(10),
        max_bytes: positiveInt.default(65_536),
        redact: z.boolean().default(true),
      })
      .strict()
      .default({}),
    guardrails: z
      .object({
        max_ci_fix_attempts: positiveInt.default(5),
        max_e2e_fix_attempts: positiveInt.default(3),
        max_ai_review_cycles: positiveInt.default(3),
        max_no_progress_iterations: positiveInt.default(2),
        max_work_packages_without_green: positiveInt.default(3),
        max_policy_violations_per_package: positiveInt.default(2),
        max_sync_conflict_attempts: positiveInt.default(2),
        max_infra_retries: nonNegativeInt.default(1),
        max_agent_runtime_minutes: positiveInt.default(60),
        max_changed_files: positiveInt.nullable().default(null),
        max_diff_lines: positiveInt.nullable().default(null),
        max_goal_runtime_hours: positiveInt.nullable().default(null),
      })
      .strict()
      .default({}),
    telemetry: z
      .object({ price_table: z.record(z.string(), priceSchema).nullable().default(null) })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.workflow.ci_provider === 'teamcity' && config.teamcity.url === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['teamcity', 'url'], message: 'required when workflow.ci_provider is "teamcity"' });
    }
    if (config.workflow.scm_provider === 'bitbucket-server' && config.bitbucket.url === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bitbucket', 'url'], message: 'required when workflow.scm_provider is "bitbucket-server"' });
    }
    if (!(config.workflow_models.profile in config.model_profiles)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workflow_models', 'profile'],
        message: `model profile "${config.workflow_models.profile}" is not defined in model_profiles`,
      });
    }
    const ceiling = config.guardrails.max_agent_runtime_minutes;
    for (const role of AGENT_ROLES) {
      if (config.agents.roles[role].timeout_minutes > ceiling) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['agents', 'roles', role, 'timeout_minutes'],
          message: `must not exceed guardrails.max_agent_runtime_minutes (${ceiling})`,
        });
      }
    }
  });

export type JanusConfig = z.infer<typeof configSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/config/config-schema.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck`

```bash
git add src/config/config-schema.ts tests/config/config-schema.test.ts
git commit -m "feat(config): add config.yaml schema with spec defaults and cross-field checks"
```

---

### Task 6: Config loader and token resolution

**Files:**
- Create: `src/config/load-config.ts`, `tests/config/load-config.test.ts`

**Interfaces:**
- Consumes: `configSchema`, `JanusConfig`, `readYamlFile`, `ConfigError`, `formatZodIssues`.
- Produces:
  - `parseConfig(raw: unknown, source: string): JanusConfig` (null or undefined raw means `{}`)
  - `loadConfig(path: string): JanusConfig`
  - `resolveToken(config: JanusConfig, service: 'teamcity' | 'bitbucket', env: Record<string, string | undefined>): string` throwing `ConfigError` when the variable is unset or empty

- [ ] **Step 1: Write the failing tests**

`tests/config/load-config.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { loadConfig, parseConfig, resolveToken } from '../../src/config/load-config.js';

function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'janus-config-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, content);
  return path;
}

describe('parseConfig', () => {
  it('treats null as an empty config', () => {
    expect(() => parseConfig(null, 'config.yaml')).toThrowError(ConfigError);
    const config = parseConfig({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } }, 'config.yaml');
    expect(config.workflow.ci_provider).toBe('fake');
  });

  it('wraps schema issues in ConfigError naming the source', () => {
    try {
      parseConfig({ agents: { max_parallel: 0 }, workflow: { ci_provider: 'fake', scm_provider: 'fake' } }, 'my.yaml');
      expect.unreachable('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.source).toBe('my.yaml');
      expect(configError.issues.some((issue) => issue.startsWith('agents.max_parallel:'))).toBe(true);
    }
  });
});

describe('loadConfig', () => {
  it('loads a file and applies defaults', () => {
    const path = tempFile('workflow:\n  ci_provider: local\n  scm_provider: fake\n');
    const config = loadConfig(path);
    expect(config.workflow.ci_provider).toBe('local');
    expect(config.guardrails.max_ci_fix_attempts).toBe(5);
  });

  it('reports the path when the file is invalid', () => {
    const path = tempFile('workflow:\n  ci_provider: nope\n');
    expect(() => loadConfig(path)).toThrowError(new RegExp(path.replace(/[/\\]/g, '.')));
  });
});

describe('resolveToken', () => {
  const config = parseConfig(
    {
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      teamcity: { token_env: 'MY_TC_TOKEN' },
    },
    'config.yaml',
  );

  it('reads the configured environment variable', () => {
    expect(resolveToken(config, 'teamcity', { MY_TC_TOKEN: 'secret' })).toBe('secret');
    expect(resolveToken(config, 'bitbucket', { JANUS_BITBUCKET_TOKEN: 'bb' })).toBe('bb');
  });

  it('throws ConfigError naming the variable when unset or empty', () => {
    expect(() => resolveToken(config, 'teamcity', {})).toThrowError(/MY_TC_TOKEN is not set/);
    expect(() => resolveToken(config, 'teamcity', { MY_TC_TOKEN: '' })).toThrowError(ConfigError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/config/load-config.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the loader**

`src/config/load-config.ts`:
```ts
import { configSchema } from './config-schema.js';
import type { JanusConfig } from './config-schema.js';
import { ConfigError, formatZodIssues } from './errors.js';
import { readYamlFile } from './yaml.js';

export function parseConfig(raw: unknown, source: string): JanusConfig {
  const result = configSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(source, formatZodIssues(result.error));
  }
  return result.data;
}

export function loadConfig(path: string): JanusConfig {
  return parseConfig(readYamlFile(path), path);
}

export type TokenService = 'teamcity' | 'bitbucket';

export function resolveToken(
  config: JanusConfig,
  service: TokenService,
  env: Record<string, string | undefined>,
): string {
  const variable = config[service].token_env;
  const value = env[variable];
  if (value === undefined || value === '') {
    throw new ConfigError(`${service} token`, [`environment variable ${variable} is not set`]);
  }
  return value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/config/load-config.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/config/load-config.ts tests/config/load-config.test.ts
git commit -m "feat(config): add config loader and environment token resolution"
```

---

### Task 7: Goal schema

**Files:**
- Create: `src/config/goal-schema.ts`, `tests/config/goal-schema.test.ts`

**Interfaces:**
- Produces: `goalSchema` (zod), `type Goal = z.infer<typeof goalSchema>`, `type GoalRepo = Goal['repos'][number]`, `REPO_KINDS`.

- [ ] **Step 1: Write the failing tests**

`tests/config/goal-schema.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatZodIssues } from '../../src/config/errors.js';
import { goalSchema } from '../../src/config/goal-schema.js';

export const validGoal = {
  id: 'angular-15-to-16',
  source_version: '15',
  target_version: '16',
  title: 'Upgrade Angular 15 to 16',
  repos: [
    {
      name: 'ui-kit',
      kind: 'library',
      scm: { project: 'FE', slug: 'ui-kit' },
      base_branch: 'main',
      package_name: '@acme/ui-kit',
      ci: { pr_build_type_id: 'Fe_UiKit_Build', publish_build_type_id: 'Fe_UiKit_Publish' },
    },
    {
      name: 'shell',
      kind: 'shell',
      scm: { project: 'FE', slug: 'shell' },
      base_branch: 'main',
      ci: { pr_build_type_id: 'Fe_Shell_Build' },
      depends_on: ['ui-kit'],
      loads_remotes: ['orders-remote'],
    },
    {
      name: 'orders-remote',
      kind: 'remote',
      scm: { project: 'FE', slug: 'orders-remote' },
      base_branch: 'develop',
      ci: { pr_build_type_id: 'Fe_Orders_Build' },
      depends_on: ['ui-kit'],
      coupled_with: ['shell'],
    },
  ],
  e2e: {
    build_type_id: 'Fe_E2E_Full',
    branch_params: { shell: 'env.SHELL_BRANCH', 'orders-remote': 'env.ORDERS_BRANCH' },
  },
};

function issuesOf(input: unknown): string[] {
  const result = goalSchema.safeParse(input);
  return result.success ? [] : formatZodIssues(result.error);
}

describe('goalSchema', () => {
  it('accepts a valid goal and fills defaults', () => {
    const goal = goalSchema.parse(validGoal);
    expect(goal.repos[0]?.depends_on).toEqual([]);
    expect(goal.repos[0]?.coupled_with).toEqual([]);
    expect(goal.repos[0]?.loads_remotes).toEqual([]);
    expect(goal.acknowledged_outside_goal).toEqual([]);
    expect(goal.e2e.extra_params).toEqual({});
    expect(goal.e2e.suite_repo_map).toEqual({});
    expect(goal.success_criteria).toEqual([]);
  });

  it('requires target_version to be source_version + 1', () => {
    expect(issuesOf({ ...validGoal, target_version: '17' })).toContain(
      'target_version: must be exactly one major above source_version (expected "16")',
    );
  });

  it('rejects non-numeric versions', () => {
    expect(issuesOf({ ...validGoal, source_version: 'v15' })).toContain(
      'source_version: must be a major version number like "16"',
    );
  });

  it('rejects an id or repo name that is not kebab-case', () => {
    expect(issuesOf({ ...validGoal, id: 'Angular 15' })).toContain('id: must be kebab-case (lowercase letters, digits, dashes)');
    const repos = [{ ...validGoal.repos[0], name: 'UI Kit' }, ...validGoal.repos.slice(1)];
    expect(issuesOf({ ...validGoal, repos })).toContain('repos.0.name: must be kebab-case (lowercase letters, digits, dashes)');
  });

  it('requires at least one repo and a pr_build_type_id per repo', () => {
    expect(issuesOf({ ...validGoal, repos: [] })).toContain('repos: Array must contain at least 1 element(s)');
    const repos = [{ ...validGoal.repos[0], ci: {} }, ...validGoal.repos.slice(1)];
    expect(issuesOf({ ...validGoal, repos })).toContain('repos.0.ci.pr_build_type_id: Required');
  });

  it('rejects an unknown repo kind and unknown keys', () => {
    const repos = [{ ...validGoal.repos[0], kind: 'service' }, ...validGoal.repos.slice(1)];
    expect(issuesOf({ ...validGoal, repos }).some((issue) => issue.startsWith('repos.0.kind:'))).toBe(true);
    expect(issuesOf({ ...validGoal, extra: true }).some((issue) => issue.startsWith('<root>: Unrecognized key'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/config/goal-schema.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the schema**

`src/config/goal-schema.ts`:
```ts
import { z } from 'zod';

export const REPO_KINDS = ['library', 'app', 'shell', 'remote'] as const;
export type RepoKind = (typeof REPO_KINDS)[number];

const kebab = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be kebab-case (lowercase letters, digits, dashes)');

const majorVersion = z.string().regex(/^\d+$/, 'must be a major version number like "16"');

const scmRefSchema = z.object({ project: z.string().min(1), slug: z.string().min(1) }).strict();

const repoSchema = z
  .object({
    name: kebab,
    kind: z.enum(REPO_KINDS),
    scm: scmRefSchema,
    base_branch: z.string().min(1),
    package_name: z.string().min(1).optional(),
    ci: z
      .object({
        pr_build_type_id: z.string().min(1),
        publish_build_type_id: z.string().min(1).optional(),
        release_build_type_id: z.string().min(1).optional(),
      })
      .strict(),
    depends_on: z.array(kebab).default([]),
    coupled_with: z.array(kebab).default([]),
    loads_remotes: z.array(kebab).default([]),
  })
  .strict();

export const goalSchema = z
  .object({
    id: kebab,
    source_version: majorVersion,
    target_version: majorVersion,
    title: z.string().min(1),
    repos: z.array(repoSchema).min(1),
    acknowledged_outside_goal: z
      .array(z.object({ repo: kebab, reason: z.string().min(1) }).strict())
      .default([]),
    e2e: z
      .object({
        build_type_id: z.string().min(1),
        branch_params: z.record(z.string(), z.string().min(1)).default({}),
        extra_params: z.record(z.string(), z.string()).default({}),
        suite_repo_map: z.record(z.string(), z.string().min(1)).default({}),
      })
      .strict(),
    success_criteria: z.array(z.string().min(1)).default([]),
    non_goals: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((goal, ctx) => {
    const expected = String(Number(goal.source_version) + 1);
    if (goal.target_version !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target_version'],
        message: `must be exactly one major above source_version (expected "${expected}")`,
      });
    }
  });

export type Goal = z.infer<typeof goalSchema>;
export type GoalRepo = Goal['repos'][number];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/config/goal-schema.test.ts`
Expected: PASS, 6 tests. If zod's built-in wording for "at least 1 element" or "Required" differs, copy the actual message into the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/config/goal-schema.ts tests/config/goal-schema.test.ts
git commit -m "feat(config): add goal.yaml schema with single-major and naming rules"
```

---

### Task 8: Goal graph validation and repository order

**Files:**
- Create: `src/config/validate-goal.ts`, `tests/config/validate-goal.test.ts`

**Interfaces:**
- Consumes: `Goal`, `GoalRepo`, `ConfigError`.
- Produces:
  - `interface ValidatedGoal { goal: Goal; repoOrder: string[] }` where `goal.repos[*].coupled_with` is symmetric and sorted and `repoOrder` is a dependency-respecting order (dependencies first; ties broken by declaration order)
  - `validateGoal(goal: Goal, source?: string): ValidatedGoal` throwing `ConfigError` with every issue found (source defaults to `'goal.yaml'`)

- [ ] **Step 1: Write the failing tests**

`tests/config/validate-goal.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { goalSchema } from '../../src/config/goal-schema.js';
import type { Goal } from '../../src/config/goal-schema.js';
import { validateGoal } from '../../src/config/validate-goal.js';
import { validGoal } from './goal-schema.test.js';

function goalWith(mutate: (goal: Goal) => void): Goal {
  const goal = goalSchema.parse(validGoal);
  mutate(goal);
  return goal;
}

function issuesOf(goal: Goal): string[] {
  try {
    validateGoal(goal);
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
}

describe('validateGoal', () => {
  it('returns dependency order with dependencies first and declaration order as tiebreak', () => {
    const result = validateGoal(goalSchema.parse(validGoal));
    expect(result.repoOrder).toEqual(['ui-kit', 'shell', 'orders-remote']);
  });

  it('normalizes coupled_with to be symmetric and sorted', () => {
    const result = validateGoal(goalSchema.parse(validGoal));
    const shell = result.goal.repos.find((repo) => repo.name === 'shell');
    const orders = result.goal.repos.find((repo) => repo.name === 'orders-remote');
    expect(shell?.coupled_with).toEqual(['orders-remote']);
    expect(orders?.coupled_with).toEqual(['shell']);
  });

  it('rejects duplicate repo names', () => {
    const goal = goalWith((g) => {
      g.repos.push({ ...g.repos[0]!, name: 'ui-kit' });
    });
    expect(issuesOf(goal)).toContain('repos: duplicate repo name "ui-kit"');
  });

  it('rejects unknown references in depends_on and coupled_with', () => {
    const goal = goalWith((g) => {
      g.repos[1]!.depends_on = ['ghost'];
      g.repos[2]!.coupled_with = ['phantom'];
    });
    const issues = issuesOf(goal);
    expect(issues).toContain('repos.shell.depends_on: unknown repo "ghost"');
    expect(issues).toContain('repos.orders-remote.coupled_with: unknown repo "phantom"');
  });

  it('rejects self references', () => {
    const goal = goalWith((g) => {
      g.repos[0]!.depends_on = ['ui-kit'];
    });
    expect(issuesOf(goal)).toContain('repos.ui-kit.depends_on: a repo cannot depend on itself');
  });

  it('rejects dependency cycles and names the members', () => {
    const goal = goalWith((g) => {
      g.repos[0]!.depends_on = ['shell'];
    });
    expect(issuesOf(goal)).toContain('repos: dependency cycle among shell, ui-kit');
  });

  it('requires every loaded remote to be in the goal or acknowledged', () => {
    const goal = goalWith((g) => {
      g.repos[1]!.loads_remotes = ['orders-remote', 'billing-remote'];
    });
    expect(issuesOf(goal)).toContain(
      'repos.shell.loads_remotes: "billing-remote" is neither in repos nor in acknowledged_outside_goal',
    );
    const acknowledged = goalWith((g) => {
      g.repos[1]!.loads_remotes = ['orders-remote', 'billing-remote'];
      g.acknowledged_outside_goal = [{ repo: 'billing-remote', reason: 'retired next quarter' }];
    });
    expect(issuesOf(acknowledged)).toEqual([]);
  });

  it('rejects an acknowledged repo that is also in the goal', () => {
    const goal = goalWith((g) => {
      g.acknowledged_outside_goal = [{ repo: 'shell', reason: 'x' }];
    });
    expect(issuesOf(goal)).toContain('acknowledged_outside_goal: "shell" is part of the goal and cannot be acknowledged as outside it');
  });

  it('rejects e2e.branch_params for unknown repos', () => {
    const goal = goalWith((g) => {
      g.e2e.branch_params = { ...g.e2e.branch_params, nowhere: 'env.X' };
    });
    expect(issuesOf(goal)).toContain('e2e.branch_params: unknown repo "nowhere"');
  });

  it('collects every issue in one error', () => {
    const goal = goalWith((g) => {
      g.repos[1]!.depends_on = ['ghost'];
      g.e2e.branch_params = { nowhere: 'env.X' };
    });
    expect(issuesOf(goal)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/config/validate-goal.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the validator**

`src/config/validate-goal.ts`:
```ts
import { ConfigError } from './errors.js';
import type { Goal, GoalRepo } from './goal-schema.js';

export interface ValidatedGoal {
  goal: Goal;
  repoOrder: string[];
}

export function validateGoal(goal: Goal, source = 'goal.yaml'): ValidatedGoal {
  const issues: string[] = [];
  const names = goal.repos.map((repo) => repo.name);
  const known = new Set<string>();
  for (const name of names) {
    if (known.has(name)) issues.push(`repos: duplicate repo name "${name}"`);
    known.add(name);
  }
  const acknowledged = new Set(goal.acknowledged_outside_goal.map((entry) => entry.repo));

  for (const repo of goal.repos) {
    checkRefs(repo, 'depends_on', repo.depends_on, known, issues);
    checkRefs(repo, 'coupled_with', repo.coupled_with, known, issues);
    for (const remote of repo.loads_remotes) {
      if (!known.has(remote) && !acknowledged.has(remote)) {
        issues.push(
          `repos.${repo.name}.loads_remotes: "${remote}" is neither in repos nor in acknowledged_outside_goal`,
        );
      }
    }
  }

  for (const entry of goal.acknowledged_outside_goal) {
    if (known.has(entry.repo)) {
      issues.push(
        `acknowledged_outside_goal: "${entry.repo}" is part of the goal and cannot be acknowledged as outside it`,
      );
    }
  }

  for (const name of Object.keys(goal.e2e.branch_params)) {
    if (!known.has(name)) issues.push(`e2e.branch_params: unknown repo "${name}"`);
  }

  const order = topologicalOrder(goal.repos, known);
  if (order.cycle.length > 0) {
    issues.push(`repos: dependency cycle among ${[...order.cycle].sort().join(', ')}`);
  }

  if (issues.length > 0) {
    throw new ConfigError(source, issues);
  }

  return { goal: normalizeCoupling(goal), repoOrder: order.sorted };
}

function checkRefs(
  repo: GoalRepo,
  field: 'depends_on' | 'coupled_with',
  refs: string[],
  known: Set<string>,
  issues: string[],
): void {
  for (const ref of refs) {
    if (ref === repo.name) {
      const verb = field === 'depends_on' ? 'depend on' : 'be coupled with';
      issues.push(`repos.${repo.name}.${field}: a repo cannot ${verb} itself`);
    } else if (!known.has(ref)) {
      issues.push(`repos.${repo.name}.${field}: unknown repo "${ref}"`);
    }
  }
}

/** Kahn's algorithm; declaration order breaks ties. Repos left over are in a cycle. */
function topologicalOrder(repos: GoalRepo[], known: Set<string>): { sorted: string[]; cycle: string[] } {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const repo of repos) {
    indegree.set(repo.name, 0);
    dependents.set(repo.name, []);
  }
  for (const repo of repos) {
    for (const dep of repo.depends_on) {
      if (!known.has(dep) || dep === repo.name) continue;
      indegree.set(repo.name, (indegree.get(repo.name) ?? 0) + 1);
      dependents.get(dep)?.push(repo.name);
    }
  }
  const sorted: string[] = [];
  const ready = repos.map((repo) => repo.name).filter((name) => indegree.get(name) === 0);
  while (ready.length > 0) {
    const next = ready.shift()!;
    sorted.push(next);
    for (const dependent of dependents.get(next) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort((a, b) => declarationIndex(repos, a) - declarationIndex(repos, b));
      }
    }
  }
  const cycle = repos.map((repo) => repo.name).filter((name) => !sorted.includes(name));
  return { sorted, cycle };
}

function declarationIndex(repos: GoalRepo[], name: string): number {
  return repos.findIndex((repo) => repo.name === name);
}

function normalizeCoupling(goal: Goal): Goal {
  const coupling = new Map<string, Set<string>>();
  for (const repo of goal.repos) coupling.set(repo.name, new Set(repo.coupled_with));
  for (const repo of goal.repos) {
    for (const peer of repo.coupled_with) coupling.get(peer)?.add(repo.name);
  }
  return {
    ...goal,
    repos: goal.repos.map((repo) => ({
      ...repo,
      coupled_with: [...(coupling.get(repo.name) ?? [])].sort(),
    })),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/config/validate-goal.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck`

```bash
git add src/config/validate-goal.ts tests/config/validate-goal.test.ts
git commit -m "feat(config): validate goal repo graph and derive dependency order"
```

---

### Task 9: Goal loader and `janus init` validation path

**Files:**
- Create: `src/config/load-goal.ts`, `tests/cli/init.test.ts`
- Modify: `src/cli/commands/init.ts`

**Interfaces:**
- Consumes: `readYamlFile`, `goalSchema`, `validateGoal`, `loadConfig`, `ConfigError`, `notImplemented`.
- Produces: `loadGoal(path: string): ValidatedGoal`. `janus init --goal <file>` validates the goal (and `--config <file>` when given), prints a one-line summary and the repo order, then exits `NotImplemented` (workspace creation is T02). Invalid files exit `UsageError` with the `ConfigError` message on stderr. `--resume` stays a stub.

- [ ] **Step 1: Write the failing tests**

`tests/cli/init.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { validGoal } from '../config/goal-schema.test.js';
import { runCli } from '../helpers/run-cli.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'janus-init-'));
}

describe('janus init --goal', () => {
  it('validates the goal, prints the summary, and reports workspace creation as not implemented', async () => {
    const dir = tempDir();
    const goalPath = join(dir, 'goal.yaml');
    writeFileSync(goalPath, stringify(validGoal));
    const result = await runCli(['init', '--goal', goalPath]);
    expect(result.stdout).toContain('goal angular-15-to-16: Angular 15 -> 16, 3 repos');
    expect(result.stdout).toContain('repo order: ui-kit, shell, orders-remote');
    expect(result.stderr).toContain('workspace creation is not implemented yet (planned in T02)');
    expect(result.code).toBe(ExitCode.NotImplemented);
  });

  it('exits 2 and names the field when the goal is invalid', async () => {
    const dir = tempDir();
    const goalPath = join(dir, 'goal.yaml');
    writeFileSync(goalPath, stringify({ ...validGoal, target_version: '18' }));
    const result = await runCli(['init', '--goal', goalPath]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('target_version: must be exactly one major above source_version');
  });

  it('exits 2 when the goal file is missing', async () => {
    const result = await runCli(['init', '--goal', '/nonexistent/goal.yaml']);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('file not found');
  });

  it('also validates --config when given', async () => {
    const dir = tempDir();
    const goalPath = join(dir, 'goal.yaml');
    const configPath = join(dir, 'config.yaml');
    writeFileSync(goalPath, stringify(validGoal));
    writeFileSync(configPath, 'workflow:\n  ci_provider: bogus\n');
    const result = await runCli(['init', '--goal', goalPath, '--config', configPath]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('workflow.ci_provider');
  });

  it('exits 2 when neither --goal nor --resume is given', async () => {
    const result = await runCli(['init']);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('either --goal <file> or --resume <state-remote> is required');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/cli/init.test.ts`
Expected: FAIL, the first test gets exit 3 without the summary; the others get the wrong exit code or message.

- [ ] **Step 3: Write the goal loader**

`src/config/load-goal.ts`:
```ts
import { ConfigError, formatZodIssues } from './errors.js';
import { goalSchema } from './goal-schema.js';
import { validateGoal } from './validate-goal.js';
import type { ValidatedGoal } from './validate-goal.js';
import { readYamlFile } from './yaml.js';

export function loadGoal(path: string): ValidatedGoal {
  const raw = readYamlFile(path);
  const result = goalSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(path, formatZodIssues(result.error));
  }
  return validateGoal(result.data, path);
}
```

- [ ] **Step 4: Replace the init command**

`src/cli/commands/init.ts`:
```ts
import type { Command } from 'commander';
import { ConfigError } from '../../config/errors.js';
import { loadConfig } from '../../config/load-config.js';
import { loadGoal } from '../../config/load-goal.js';
import type { CliContext } from '../context.js';
import { ExitCode } from '../exit-codes.js';
import { notImplemented } from '../not-implemented.js';

interface InitOptions {
  goal?: string;
  config?: string;
  workspace?: string;
  resume?: string;
}

export function registerInit(program: Command, ctx: CliContext): void {
  program
    .command('init')
    .description('Create a goal workspace from a goal file, or rebuild one from a state branch')
    .argument('[goal-id]', 'goal id, used with --resume')
    .option('--goal <file>', 'path to goal.yaml')
    .option('--config <file>', 'path to config.yaml (defaults next to the goal file)')
    .option('--workspace <dir>', 'workspace directory to create (default: ./<goal-id>)')
    .option('--resume <state-remote>', 'rebuild a workspace from a state branch remote')
    .action((_goalId: string | undefined, options: InitOptions) => {
      ctx.exitCode = runInit(ctx, options);
    });
}

function runInit(ctx: CliContext, options: InitOptions): ExitCode {
  if (options.resume !== undefined) {
    return notImplemented(ctx, 'init --resume', 'T02');
  }
  if (options.goal === undefined) {
    ctx.io.stderr('janus: either --goal <file> or --resume <state-remote> is required\n');
    return ExitCode.UsageError;
  }
  try {
    const { goal, repoOrder } = loadGoal(options.goal);
    if (options.config !== undefined) {
      loadConfig(options.config);
    }
    ctx.io.stdout(
      `goal ${goal.id}: Angular ${goal.source_version} -> ${goal.target_version}, ${goal.repos.length} repos\n`,
    );
    ctx.io.stdout(`repo order: ${repoOrder.join(', ')}\n`);
  } catch (error) {
    if (error instanceof ConfigError) {
      ctx.io.stderr(`janus: ${error.message}\n`);
      return ExitCode.UsageError;
    }
    throw error;
  }
  return notImplemented(ctx, 'workspace creation', 'T02');
}
```

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS, all tests. The `commands.test.ts` case `['init', '--resume', ...]` still passes because `--resume` returns the T02 stub.

- [ ] **Step 6: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck`

```bash
git add src/config/load-goal.ts src/cli/commands/init.ts tests/cli/init.test.ts
git commit -m "feat(cli): validate goal and config files in janus init"
```

---

### Task 10: README stub and final verification

**Files:**
- Create: `README.md`

**Interfaces:**
- Produces: nothing programmatic. Documents the scripts every later task runs.

- [ ] **Step 1: Write README.md**

```markdown
# Janus

Agent-driven, resumable orchestrator for upgrading a multi-repository Angular application one major version at a time. Fresh Codex agents do bounded tasks; Janus owns state, gates, budgets, policy checks, CI observation, and Git checkpoints.

Design: `angular-ai-development-workflow-v2.md`. Task breakdown: `tasks.md`. Implementation plans: `docs/superpowers/plans/`.

## Status

Early scaffold. The CLI exists with every command from spec §8; most report "not implemented" and name the task that delivers them. `janus init --goal goal.yaml` validates a goal file.

## Development

```bash
pnpm install
pnpm test          # vitest
pnpm lint          # eslint
pnpm typecheck     # tsc --noEmit
pnpm build         # emits dist/
pnpm dev -- --help # run the CLI from source
node bin/janus.js --help
```

Node 20 or newer and pnpm are required. Tokens for TeamCity and Bitbucket come from environment variables named in `config.yaml` (`JANUS_TEAMCITY_TOKEN`, `JANUS_BITBUCKET_TOKEN` by default) and are never read from files.
```

- [ ] **Step 2: Run everything the CI workflow runs**

Run: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build && node bin/janus.js --help`
Expected: all green; help lists the eleven top-level commands.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README with development workflow"
```

---

## Self-Review

**Spec coverage for T01 (tasks.md):**
- pnpm, TypeScript strict, ESLint, vitest, build, `bin/janus`: Task 1 and Task 2.
- §8 command surface stubbed with distinct exit codes: Task 2 (codes) and Task 3 (commands, including `run --model-profile` and `telemetry export|compare` from §18.6).
- `config.yaml` schema per §28 with defaults and env-var token resolution: Tasks 5 and 6. Cross-field rules: provider urls, profile existence, `"*"` fallback, role timeouts under the ceiling.
- `goal.yaml` schema per §4 with acyclic `depends_on`, `coupled_with` normalization, `loads_remotes` coverage, `branch_params` known repos: Tasks 7 and 8.
- GitHub Actions lint and tests: Task 1.
- Done-when "invalid config and goal files fail with messages naming the field": Tasks 4 to 9, exercised end to end in Task 9's init tests.

**Placeholder scan:** none. Every step has its code.

**Type consistency:** `CliContext`, `CliIo`, `ExitCode` are defined in Task 2 and used unchanged in Tasks 3 and 9. `ConfigError`/`formatZodIssues` from Task 4 are used in Tasks 5 to 9. `JanusConfig`, `AGENT_ROLES` from Task 5; `Goal`, `GoalRepo` from Task 7; `ValidatedGoal` from Task 8; `loadGoal` from Task 9. The `validGoal` fixture is exported from `tests/config/goal-schema.test.ts` and imported by Tasks 8 and 9.

**Known wording dependencies:** three assertions copy zod's or commander's built-in messages (`Expected number, received string`, `Array must contain at least 1 element(s)`, `required option '--commit <sha>' not specified`). If the installed versions word them differently, update the assertion string; the behavior under test is the exit code and the field path.
