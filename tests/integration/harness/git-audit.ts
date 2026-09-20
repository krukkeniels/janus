import { listRefs, reflog, reflogExists } from '../../../src/git/tree.js';
import type { AgentRunOutcome, AgentRunRequest, AgentRunner } from '../../../src/providers/types.js';

/** One audited git repository: a label used in failure messages and the directory git runs in. */
export interface AuditTarget {
  label: string;
  dir: string;
}

/** ref -> its reflog entries as `"<sha> <subject>"`, newest first. */
export type RefLogs = Map<string, string[]>;

/** target label -> that target's reflogs. */
export type RefLogSnapshot = Map<string, RefLogs>;

/** A ref update that appeared between two snapshots. */
export interface GitWrite {
  label: string;
  ref: string;
  sha: string;
  subject: string;
}

/** A git write that happened while an agent's `run()` was in flight: a spec §31.29 violation. */
export interface AgentGitWrite extends GitWrite {
  runId: string;
  role: string;
}

/**
 * Reads HEAD's reflog plus the reflog of every ref `git for-each-ref` reports, for every target.
 *
 * Remote-tracking refs are included on purpose: they are how a `git push` from inside a workspace clone becomes
 * visible ("update by push"). The bare repositories the fixtures create enable `core.logAllRefUpdates`, so a push
 * is witnessed on the receiving side too.
 */
export async function captureRefLogs(targets: readonly AuditTarget[]): Promise<RefLogSnapshot> {
  const snapshot: RefLogSnapshot = new Map();
  for (const target of targets) {
    const refs: RefLogs = new Map();
    for (const ref of ['HEAD', ...(await listRefs(target.dir))]) {
      if (!(await reflogExists(target.dir, ref))) continue;
      const entries = await reflog(target.dir, ref);
      refs.set(
        ref,
        entries.map((entry) => `${entry.sha} ${entry.subject}`),
      );
    }
    snapshot.set(target.label, refs);
  }
  return snapshot;
}

/**
 * Entries present in `after` but not in `before`.
 *
 * A reflog only grows at the front, so the entries added during the window are the prefix of the new list that
 * sits on top of the old one. When the new list is not the old list with a prefix added — a ref was deleted and
 * recreated, or a reflog was rewritten, both of which are themselves git writes — the whole new list is reported.
 */
export function diffRefLogs(before: RefLogSnapshot, after: RefLogSnapshot): GitWrite[] {
  const writes: GitWrite[] = [];
  for (const [label, refs] of after) {
    const previousRefs = before.get(label) ?? new Map<string, string[]>();
    for (const [ref, entries] of refs) {
      const previous = previousRefs.get(ref) ?? [];
      const grew = entries.length >= previous.length && sameTail(entries, previous);
      const added = grew ? entries.slice(0, entries.length - previous.length) : entries;
      for (const entry of added) {
        const space = entry.indexOf(' ');
        const sha = space === -1 ? entry : entry.slice(0, space);
        const subject = space === -1 ? '' : entry.slice(space + 1);
        writes.push({ label, ref, sha, subject });
      }
    }
  }
  return writes;
}

function sameTail(entries: readonly string[], previous: readonly string[]): boolean {
  const offset = entries.length - previous.length;
  return previous.every((entry, index) => entries[offset + index] === entry);
}

/** One indented line per violation, for the `expectNoAgentGitWrites` failure message. */
export function formatGitWrites(writes: readonly AgentGitWrite[]): string {
  return writes
    .map(
      (write) =>
        `  ${write.label} ${write.ref} ${write.sha.slice(0, 7)} "${write.subject}" (during agent run ${write.runId}, role ${write.role})`,
    )
    .join('\n');
}

/**
 * Spec §31.29 and §32 rule 11.
 *
 * Wraps an AgentRunner so that every `run()` is bracketed by a reflog snapshot of every git repository the
 * workspace touches; any ref update inside that window is pushed into `sink`. The second snapshot is taken in a
 * `finally`, so an agent that writes and then throws is still caught.
 */
export function auditAgentRunner(
  inner: AgentRunner,
  targets: readonly AuditTarget[],
  sink: AgentGitWrite[],
): AgentRunner {
  return {
    name: inner.name,
    run: async (request: AgentRunRequest): Promise<AgentRunOutcome> => {
      const before = await captureRefLogs(targets);
      try {
        return await inner.run(request);
      } finally {
        for (const write of diffRefLogs(before, await captureRefLogs(targets))) {
          sink.push({ ...write, runId: request.runId, role: request.role });
        }
      }
    },
  };
}
