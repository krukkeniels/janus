import { configSchema } from '../../src/config/config-schema.js';
import type { JanusConfig } from '../../src/config/config-schema.js';
import { buildDiffAnalysis } from '../../src/policy/diff.js';
import type { DiffAnalysis, DiffFile } from '../../src/policy/diff.js';
import type { PolicyCheckContext, PolicyReport } from '../../src/policy/types.js';

export const testConfig: JanusConfig = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } });

export interface DiffFileSpec {
  path: string;
  status?: DiffFile['status'];
  previousPath?: string;
  added?: string[];
  removed?: string[];
  binary?: boolean;
  generated?: boolean;
  /** First new-file line number for the added block; the removed block starts at the same number. */
  startLine?: number;
}

/**
 * A `DiffFile` built from intent (these lines were added, those removed) rather than from raw patch text, so a
 * check's test says what it means. `analyzeDiff` itself is covered end to end in `tests/policy/diff.test.ts`
 * against real git repositories; these fixtures exercise the checks, not the parser.
 */
export function diffFile(spec: DiffFileSpec): DiffFile {
  const start = spec.startLine ?? 1;
  const added = (spec.added ?? []).map((text, index) => ({ text, line: start + index }));
  const removed = (spec.removed ?? []).map((text, index) => ({ text, line: start + index }));
  const section = [
    `diff --git a/${spec.path} b/${spec.path}`,
    `@@ -${start},${removed.length} +${start},${added.length} @@`,
    ...removed.map((line) => `-${line.text}`),
    ...added.map((line) => `+${line.text}`),
  ].join('\n');
  return {
    status: spec.status ?? 'M',
    path: spec.path,
    previousPath: spec.previousPath ?? null,
    binary: spec.binary ?? false,
    generated: spec.generated ?? false,
    hunks: [{ oldStart: start, newStart: start, added, removed }],
    added: added.length,
    removed: removed.length,
    section,
  };
}

export function fixtureAnalysis(specs: DiffFileSpec[]): DiffAnalysis {
  const files = specs.map(diffFile);
  return {
    files,
    patch: files.map((file) => file.section).join('\n'),
    totals: {
      changedFiles: files.length,
      addedLines: files.reduce((sum, file) => sum + file.added, 0),
      removedLines: files.reduce((sum, file) => sum + file.removed, 0),
    },
  };
}

export interface PolicyContextOverrides {
  files?: DiffFileSpec[];
  analysis?: DiffAnalysis;
  config?: JanusConfig;
  targetVersion?: number;
  allowedScope?: readonly string[] | null;
  allowTestFileDeletion?: boolean;
  /** path -> contents at HEAD. Absent paths read as null. */
  head?: Record<string, string>;
  /** path -> contents in the work tree. Absent paths read as null. */
  working?: Record<string, string>;
}

export function policyContext(overrides: PolicyContextOverrides = {}): PolicyCheckContext {
  const head = overrides.head ?? {};
  const working = overrides.working ?? {};
  return {
    analysis: overrides.analysis ?? fixtureAnalysis(overrides.files ?? []),
    config: overrides.config ?? testConfig,
    targetVersion: overrides.targetVersion ?? 16,
    allowedScope: overrides.allowedScope === undefined ? null : overrides.allowedScope,
    allowTestFileDeletion: overrides.allowTestFileDeletion ?? false,
    readHead: async (path) => head[path] ?? null,
    readWorking: async (path) => working[path] ?? null,
  };
}

export function policyReportFixture(overrides: Partial<PolicyReport> = {}): PolicyReport {
  return {
    attempt_id: 'wp-01-ui-kit-a1',
    work_package: 'wp-01',
    repo: 'ui-kit',
    run_id: 'run-0001',
    phase: 'initial',
    checked_at: '2026-09-20T12:00:00.000Z',
    files: [],
    totals: { changed_files: 0, added_lines: 0, removed_lines: 0 },
    checks_run: [],
    violations: [],
    warnings: [],
    passed: true,
    ...overrides,
  };
}

/** `buildDiffAnalysis` re-exported so a test that wants the real parser does not reach into `src/`. */
export { buildDiffAnalysis };
