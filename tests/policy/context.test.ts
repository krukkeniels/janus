import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { commitAll, initRepo } from '../../src/git/ops.js';
import { buildPolicyContext } from '../../src/policy/context.js';
import { analyzeDiff } from '../../src/policy/diff.js';
import { tempDir } from '../helpers/git-fixtures.js';

const config = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } });

async function repo(): Promise<string> {
  const dir = join(tempDir(), 'r');
  mkdirSync(dir);
  await initRepo(dir, 'main');
  writeFileSync(join(dir, 'a.spec.ts'), "it('one', () => {});\nit('two', () => {});\n");
  await commitAll(dir, 'feat(r): base');
  return dir;
}

describe('buildPolicyContext', () => {
  it('reads a file at HEAD and in the working tree', async () => {
    const dir = await repo();
    writeFileSync(join(dir, 'a.spec.ts'), "it('one', () => {});\n");
    const ctx = buildPolicyContext({
      cwd: dir,
      analysis: await analyzeDiff(dir),
      config,
      targetVersion: 16,
      allowedScope: ['**'],
      allowTestFileDeletion: false,
    });
    expect(await ctx.readHead('a.spec.ts')).toContain("it('two'");
    expect(await ctx.readWorking('a.spec.ts')).not.toContain("it('two'");
  });

  it('returns null at HEAD for a file that did not exist there', async () => {
    const dir = await repo();
    writeFileSync(join(dir, 'fresh.spec.ts'), "it('new', () => {});\n");
    const ctx = buildPolicyContext({
      cwd: dir,
      analysis: await analyzeDiff(dir),
      config,
      targetVersion: 16,
      allowedScope: null,
      allowTestFileDeletion: false,
    });
    expect(await ctx.readHead('fresh.spec.ts')).toBeNull();
  });

  it('returns null in the working tree for a deleted file', async () => {
    const dir = await repo();
    rmSync(join(dir, 'a.spec.ts'));
    const ctx = buildPolicyContext({
      cwd: dir,
      analysis: await analyzeDiff(dir),
      config,
      targetVersion: 16,
      allowedScope: null,
      allowTestFileDeletion: false,
    });
    expect(await ctx.readWorking('a.spec.ts')).toBeNull();
    expect(await ctx.readHead('a.spec.ts')).toContain("it('one'");
  });

  it('defaults allowTestFileDeletion from the config when the package says nothing', async () => {
    const dir = await repo();
    const ctx = buildPolicyContext({
      cwd: dir,
      analysis: await analyzeDiff(dir),
      config,
      targetVersion: 16,
      allowedScope: null,
    });
    expect(ctx.allowTestFileDeletion).toBe(false);
  });
});
