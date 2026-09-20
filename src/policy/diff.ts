import { isGeneratedPath } from '../agents/context.js';
import type { ChangeSummaryEntry } from '../agents/context.js';
import { workingTreeDiff } from '../git/tree.js';
import type { ChangedFile, ChangeStatus } from '../git/tree.js';

/** One line of a hunk. `line` is the new-file number for an added line, the old-file number for a removed one. */
export interface DiffLine {
  text: string;
  line: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  added: DiffLine[];
  removed: DiffLine[];
}

export interface DiffFile {
  status: ChangeStatus;
  path: string;
  /** The pre-rename path for `R`, else null. Both paths are scope-checked, so both must survive. */
  previousPath: string | null;
  binary: boolean;
  /** §18.2: a lockfile or build output. Listed in CHANGE SUMMARY, never inlined into a prompt. */
  generated: boolean;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** The raw patch section for this file, so the fix agent's inline diff can be rebuilt without generated files. */
  section: string;
}

export interface DiffAnalysis {
  files: DiffFile[];
  /** The whole `git diff HEAD -M` text, exported verbatim as a patch when the tree is reset (§14). */
  patch: string;
  totals: { changedFiles: number; addedLines: number; removedLines: number };
}

export class DiffAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffAnalysisError';
  }
}

/**
 * Spec §14 step 1: "collects the diff (tracked and untracked, excluding ignored files)".
 *
 * The change set comes from the git tree and from nowhere else. An agent's `AgentResult.changes_made` is never
 * consulted: during the T06 prompt spike one agent reported two changed files when the tree held three, and
 * another reported two when the tree held one. A policy check built on a self-report is a policy check that can
 * be talked out of firing.
 */
export async function analyzeDiff(cwd: string): Promise<DiffAnalysis> {
  const { files, patch } = await workingTreeDiff(cwd);
  return buildDiffAnalysis(files, patch);
}

/**
 * Pairs each `--name-status` record with its patch section **by position**.
 *
 * Both listings are produced from the same diff queue in the same order, which is the only association that
 * survives git's path quoting: a `diff --git` header C-quotes any non-ASCII path (`"a/\303\246.txt"`) and is
 * genuinely ambiguous for a rename between two paths containing spaces, so parsing the header would be guessing.
 *
 * One case breaks the naive one-section-per-record count: a **typechange** (`T` — regular file <-> symlink, or
 * <-> gitlink) is a single `--name-status` record but git's patch prints it as two consecutive `diff --git`
 * sections, "deleted file mode ..." followed by "new file mode ...", because the patch format has no way to
 * express "this path changed kind" in one hunk. So the expected section count is `changed.length` plus one for
 * every `T` record, and a `T` record consumes its **two** sections in order, concatenated into that file's
 * `section` and with both halves' hunks merged — the delete half's removed lines and the add half's added lines
 * both belong to that path. For every other status, one record is one section. When the counts still disagree
 * after accounting for typechanges, this throws rather than mis-attributing a hunk, because a check reading the
 * wrong file's added lines is exactly the failure this module exists to prevent.
 */
const BINARY_SECTION = /^(?:Binary files .* differ|GIT binary patch)$/mu;

export function buildDiffAnalysis(changed: ChangedFile[], patch: string): DiffAnalysis {
  const sections = splitPatchSections(patch);
  const typechanges = changed.filter((file) => file.status === 'T').length;
  const expectedSections = changed.length + typechanges;
  if (sections.length !== expectedSections) {
    throw new DiffAnalysisError(
      `git reported ${changed.length} changed file(s) (${typechanges} typechange(s), expecting ` +
        `${expectedSections} patch section(s) in total) but found ${sections.length}; ` +
        'refusing to guess which hunk belongs to which file',
    );
  }
  const files: DiffFile[] = [];
  let sectionIndex = 0;
  for (const file of changed) {
    if (file.status === 'T') {
      const deleteHalf = sections[sectionIndex] ?? '';
      const addHalf = sections[sectionIndex + 1] ?? '';
      sectionIndex += 2;
      const section = `${deleteHalf}\n${addHalf}`;
      const binary = BINARY_SECTION.test(section);
      const hunks = binary ? [] : [...parseHunks(deleteHalf), ...parseHunks(addHalf)];
      files.push(makeDiffFile(file, section, binary, hunks));
      continue;
    }
    const section = sections[sectionIndex] ?? '';
    sectionIndex += 1;
    const binary = BINARY_SECTION.test(section);
    const hunks = binary ? [] : parseHunks(section);
    files.push(makeDiffFile(file, section, binary, hunks));
  }
  return {
    files,
    patch,
    totals: {
      changedFiles: files.length,
      addedLines: files.reduce((sum, file) => sum + file.added, 0),
      removedLines: files.reduce((sum, file) => sum + file.removed, 0),
    },
  };
}

function makeDiffFile(file: ChangedFile, section: string, binary: boolean, hunks: DiffHunk[]): DiffFile {
  return {
    status: file.status,
    path: file.path,
    previousPath: file.previousPath ?? null,
    binary,
    generated: isGeneratedPath(file.path),
    hunks,
    added: hunks.reduce((sum, hunk) => sum + hunk.added.length, 0),
    removed: hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0),
    section,
  };
}

/**
 * Splits a unified diff at each `diff --git ` header.
 *
 * A content line can never be mistaken for a header: every line inside a hunk is prefixed with a space, `+`, `-`
 * or `\`, so `diff --git ` at column zero is always a section start.
 */
export function splitPatchSections(patch: string): string[] {
  if (patch === '') return [];
  const sections: string[] = [];
  let current: string[] | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current !== null) sections.push(current.join('\n'));
      current = [line];
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) sections.push(current.join('\n'));
  return sections;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/**
 * Reads one file's hunks, carrying the old- and new-file line numbers forward.
 *
 * Lines before the first `@@` — `index`, `--- a/x`, `+++ b/x`, mode lines — are skipped because `current` is
 * still null, which is why a `+++` header never lands in `added`. `\ No newline at end of file` advances
 * neither counter.
 */
export function parseHunks(section: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of section.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { oldStart: oldLine, newStart: newLine, added: [], removed: [] };
      hunks.push(current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      current.added.push({ text: line.slice(1), line: newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      current.removed.push({ text: line.slice(1), line: oldLine });
      oldLine += 1;
      continue;
    }
    oldLine += 1;
    newLine += 1;
  }
  return hunks;
}

/** Every added line of a file, across its hunks, in file order. */
export function addedLines(file: DiffFile): DiffLine[] {
  return file.hunks.flatMap((hunk) => hunk.added);
}

/** Every removed line of a file, across its hunks, in file order. */
export function removedLines(file: DiffFile): DiffLine[] {
  return file.hunks.flatMap((hunk) => hunk.removed);
}

/** Spec §18.2 CHANGE SUMMARY: "file list with added/removed line counts", generated files marked but not inlined. */
export function changeSummaryFrom(analysis: DiffAnalysis): ChangeSummaryEntry[] {
  return analysis.files.map((file) => ({
    path: file.path,
    added: file.added,
    removed: file.removed,
    generated: file.generated,
  }));
}

/**
 * Spec §18.2 INLINE DIFF, for the code-writing fix agent.
 *
 * Generated files are dropped: `renderContextPackage` throws `ContextPackageError` when the inline diff contains
 * a lockfile or anything under `dist/`, `coverage/` or `.angular/`, and an `ng update` diff always contains a
 * lockfile — so handing over `analysis.patch` unfiltered would crash on the first real violation. The files are
 * still listed, with their counts, in CHANGE SUMMARY.
 *
 * A file's `generated` flag is derived from its **new** path only (`file.path`), but `renderContextPackage`'s
 * guard reads every path on a `diff --git` header, old and new alike — so a rename **out of** a generated
 * directory (`git mv dist/bundle.js bundle.js`) has `generated: false` yet its section still carries
 * `a/dist/bundle.js` and would trip that guard. Both directions are checked here for that reason; a rename
 * **into** a generated directory is already covered because `generated` follows the new path.
 */
export function inlineDiffFrom(analysis: DiffAnalysis): string {
  return analysis.files
    .filter((file) => !file.generated && !(file.previousPath !== null && isGeneratedPath(file.previousPath)))
    .map((file) => file.section)
    .join('\n');
}
