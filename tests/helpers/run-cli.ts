import { main } from '../../src/cli/main.js';
import type { CliIo, CliOverrides } from '../../src/cli/context.js';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(argv: string[], overrides: Partial<CliIo> = {}, ctxOverrides: CliOverrides = {}): Promise<CliResult> {
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
  const code = await main(argv, io, ctxOverrides);
  return { code, stdout, stderr };
}
