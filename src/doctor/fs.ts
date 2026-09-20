import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The filesystem seam. Two checks need it for reasons a stub must be able to reproduce: `sandbox.user_namespaces`
 * reads `/proc` entries that do not exist on every machine, and `pnpm.store` has to actually attempt a write —
 * `access(W_OK)` lies on read-only mounts, on full filesystems and under some container overlays, which is exactly
 * the case §31 item 33 asks doctor to detect. `codex.model` needs a real scratch directory outside any git repo,
 * for the same "unit-testable with no real I/O" reason as the rest of this seam.
 */
export interface DoctorFs {
  /** File contents, or null when the file is missing or unreadable. Never throws. */
  readText(path: string): string | null;
  exists(path: string): boolean;
  /** **Can throw** (`EACCES`, `ENOSPC`, ...) — same reasoning as `mkdtemp`/`writeText` below. */
  mkdirp(dir: string): void;
  /** Creates and deletes a probe file in `dir`. Returns null on success, or the error message. Never throws. */
  probeWritable(dir: string): string | null;
  /**
   * Creates a fresh, uniquely-named directory under `prefix` and returns its path. Unlike the rest of this
   * interface, this **can throw** — an unwritable temp filesystem is a real environment failure, and the caller
   * (a `DoctorCheck`) is expected to catch it and turn it into a graceful `fail` finding rather than let it
   * propagate out of `run()` and take down the whole `runDoctor` pass.
   */
  mkdtemp(prefix: string): string;
  /**
   * Recursively removes `path`. Also **can throw** — `{ force: true }` on the underlying `rmSync` suppresses only
   * "the path is already gone", not a real removal failure (`EPERM`, `EBUSY`, a lingering open handle). The
   * caller decides how much a failed cleanup matters; `codex.model` treats it as non-fatal once its real result
   * is already computed.
   */
  rmrf(path: string): void;
  /**
   * Writes `content` to `path`, overwriting it. Creates no parent directories — the caller `mkdirp`s first.
   * **Can throw** (`EACCES`, `ENOSPC`, a full disk, ...): the caller is expected to catch it, alongside `mkdirp`,
   * and turn it into a graceful `fail` finding rather than let it propagate out of `run()` into `runDoctor`'s
   * generic catch, whose remediation ("this is a bug in janus doctor") is wrong for a broken environment.
   */
  writeText(path: string, content: string): void;
}

export const nodeFs: DoctorFs = {
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  exists: (path) => existsSync(path),
  mkdirp: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  probeWritable: (dir) => {
    const probe = join(dir, `.janus-doctor-${String(process.pid)}`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(probe, 'janus doctor write probe\n');
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      rmSync(probe, { force: true });
    }
  },
  mkdtemp: (prefix) => mkdtempSync(prefix),
  rmrf: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
  writeText: (path, content) => {
    writeFileSync(path, content);
  },
};
