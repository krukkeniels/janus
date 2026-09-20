import { configSchema } from '../../src/config/config-schema.js';
import type { CommandRequest, CommandResult, CommandRunner } from '../../src/doctor/exec.js';
import type { DoctorFs } from '../../src/doctor/fs.js';
import type { HttpProbe, HttpProbeResult } from '../../src/doctor/http.js';
import type { DoctorCheckContext } from '../../src/doctor/types.js';

export const FROZEN_NOW = '2026-09-20T12:00:00.000Z';

export function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    spawnFailed: false,
    durationMs: 12,
    ...overrides,
  };
}

/**
 * A `CommandRunner` that answers only the requests a test declared, and throws on anything else. Throwing is the
 * point: a check that silently gained a second subprocess call would otherwise pass its test against a default.
 */
export function stubRunner(handlers: ReadonlyArray<{ match: (request: CommandRequest) => boolean; result: Partial<CommandResult> }>): CommandRunner {
  return async (request) => {
    const handler = handlers.find((candidate) => candidate.match(request));
    if (handler === undefined) throw new Error(`no stub for: ${request.bin} ${request.args.join(' ')}`);
    return commandResult(handler.result);
  };
}

export function stubHttp(result: Partial<HttpProbeResult>): HttpProbe {
  return async () => ({ ok: false, status: null, error: null, ...result });
}

/**
 * A `DoctorFs` backed by a plain map of path to contents. `writableError` makes `probeWritable` report a failure.
 * `mkdtempError` makes `mkdtemp` throw instead of returning a fake path, and `rmrfError` makes `rmrf` throw, so a
 * check's "the temp filesystem is unwritable" and "cleanup failed" paths can both be exercised without ever
 * touching the real filesystem.
 */
export function stubFs(
  options: { files?: Record<string, string>; writableError?: string; mkdtempError?: string; rmrfError?: string } = {},
): DoctorFs {
  const files = options.files ?? {};
  return {
    readText: (path) => files[path] ?? null,
    exists: (path) => path in files,
    mkdirp: () => undefined,
    probeWritable: () => options.writableError ?? null,
    mkdtemp: (prefix) => {
      if (options.mkdtempError !== undefined) throw new Error(options.mkdtempError);
      return `${prefix}stub`;
    },
    rmrf: () => {
      if (options.rmrfError !== undefined) throw new Error(options.rmrfError);
    },
    writeText: () => undefined,
  };
}

export function doctorContext(overrides: Partial<DoctorCheckContext> = {}): DoctorCheckContext {
  return {
    config: configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } }),
    goal: null,
    paths: null,
    env: {},
    fs: stubFs(),
    run: async (request) => {
      throw new Error(`unexpected command in this test: ${request.bin} ${request.args.join(' ')}`);
    },
    http: async (request) => {
      throw new Error(`unexpected http probe in this test: ${request.url}`);
    },
    now: () => new Date(FROZEN_NOW),
    ...overrides,
  };
}
