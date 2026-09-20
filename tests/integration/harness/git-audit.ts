import type { AgentOutcome, AgentTask } from '../../../src/agents/types.js';
import { tryRevParse } from '../../../src/git/ops.js';
import { listRefShas, reflog, reflogExists } from '../../../src/git/tree.js';
import type { RefSha } from '../../../src/git/tree.js';
import type { AgentRunner } from '../../../src/providers/types.js';

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
 * The stand-in entry recorded for a ref git keeps no reflog for, so that ref is still watched.
 *
 * `core.logAllRefUpdates` logs `refs/heads/*`, `refs/remotes/*`, `refs/notes/*` and HEAD, but never `refs/tags/*`
 * unless it is set to `always` — and a workspace clone made by `janus init` does not set it. Skipping an unlogged
 * ref would drop it from BOTH snapshots, so creating, moving or deleting a tag would be a git write the audit
 * cannot see. Recording where the ref points instead makes a creation a new entry, a move a changed entry, and a
 * deletion a vanished ref, all of which `diffRefLogs` already reports.
 */
const NO_REFLOG_SUBJECT = 'ref present (no reflog)';

/**
 * Reads HEAD's reflog plus the reflog of every ref `git for-each-ref` reports, for every target, falling back to
 * `"<sha> ref present (no reflog)"` for refs git does not log.
 *
 * Remote-tracking refs are included on purpose: they are how a `git push` from inside a workspace clone becomes
 * visible ("update by push"). The bare repositories the fixtures create enable `core.logAllRefUpdates=always`, so
 * a push — of a branch or of a tag — is witnessed on the receiving side too.
 */
export async function captureRefLogs(targets: readonly AuditTarget[]): Promise<RefLogSnapshot> {
  const snapshot: RefLogSnapshot = new Map();
  for (const target of targets) {
    if (snapshot.has(target.label)) {
      throw new Error(`duplicate audit target label: ${target.label}`);
    }
    const refs: RefLogs = new Map();
    // HEAD is not reported by `for-each-ref`; it is null in a repository whose HEAD is unborn (a fresh bare one).
    const head: RefSha[] = [{ ref: 'HEAD', sha: (await tryRevParse(target.dir, 'HEAD')) ?? '' }];
    for (const { ref, sha } of [...head, ...(await listRefShas(target.dir))]) {
      if (await reflogExists(target.dir, ref)) {
        const entries = await reflog(target.dir, ref);
        refs.set(
          ref,
          entries.map((entry) => `${entry.sha} ${entry.subject}`),
        );
      } else if (sha !== '') {
        refs.set(ref, [`${sha} ${NO_REFLOG_SUBJECT}`]);
      }
    }
    snapshot.set(target.label, refs);
  }
  return snapshot;
}

/**
 * Entries present in `after` but not in `before`, plus any ref that vanished entirely.
 *
 * A reflog only grows at the front, so the entries added during the window are the prefix of the new list that
 * sits on top of the old one. When the new list is not the old list with a prefix added — a ref was deleted and
 * recreated, or a reflog was rewritten, both of which are themselves git writes — the whole new list is reported.
 *
 * A ref git keeps no reflog for is held as a single `"<sha> ref present (no reflog)"` entry, so moving it breaks
 * the tail comparison and the whole (one-entry) list is reported; creating one reports that single entry.
 *
 * A ref (and its reflog) can also be erased outright — `git branch -D`, `git update-ref -d`, or a deleting push
 * all do this — which is itself a history rewrite under spec §32 rule 11. Any label/ref present in `before` but
 * missing from `after` is reported as a deletion, with `sha: ''` and `subject: 'ref deleted'`.
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
  for (const [label, refs] of before) {
    const currentRefs = after.get(label) ?? new Map<string, string[]>();
    for (const ref of refs.keys()) {
      if (!currentRefs.has(ref)) {
        writes.push({ label, ref, sha: '', subject: 'ref deleted' });
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
    run: async (task: AgentTask): Promise<AgentOutcome> => {
      const before = await captureRefLogs(targets);
      try {
        return await inner.run(task);
      } finally {
        for (const write of diffRefLogs(before, await captureRefLogs(targets))) {
          sink.push({ ...write, runId: task.runId, role: task.role });
        }
      }
    },
  };
}
