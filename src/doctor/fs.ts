import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The filesystem seam. Two checks need it for reasons a stub must be able to reproduce: `sandbox.user_namespaces`
 * reads `/proc` entries that do not exist on every machine, and `pnpm.store` has to actually attempt a write —
 * `access(W_OK)` lies on read-only mounts, on full filesystems and under some container overlays, which is exactly
 * the case §31 item 33 asks doctor to detect.
 */
export interface DoctorFs {
  /** File contents, or null when the file is missing or unreadable. Never throws. */
  readText(path: string): string | null;
  exists(path: string): boolean;
  mkdirp(dir: string): void;
  /** Creates and deletes a probe file in `dir`. Returns null on success, or the error message. Never throws. */
  probeWritable(dir: string): string | null;
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
};
