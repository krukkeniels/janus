---
output:
  passed: bool
  reasons: list[str]
  summary: str
---
Review the finished work of this round. This step is read-only, here and in every repository.

Read-only means: do not change or delete any tracked file, do not create commits, branches or
tags, and do not push. You may run the project's install, build and test commands, and they may
write into `node_modules/`, `dist/` and other ignored paths.

Judge only from the repositories' Git history and working trees. Do not read `JANUS.md`,
`journal.yaml` or any other Janus file; the implementer's own report is not evidence.

The target of this round is Angular {{target}}. These tasks were implemented, each in the
sub-folder named by its `repo`:

{{tasks}}

For each one, read the commits on `{{branch}}` in that sub-folder (`git log`, `git diff`,
`git status`) and judge:

- does the change do what the goal asks for that repository, and do its checks pass?
- was a test deleted, skipped, weakened or made to assert less, anywhere in the change?
- is anything left half-done, or committed by mistake: build output, `node_modules`, editor
  files, a secret or a token?
- was anything committed outside the repository's own folder, or on another branch?

The previous round came back with these findings; work that answers them is requested, not a
defect. An empty block means this is the first round:

{{findings}}

Set `passed` to false if any answer is wrong, and give one line per problem in `reasons`, each
naming the repository and the file: those lines are handed to the next round's implementer as
its findings, so make each one actionable. Set `passed` to true with an empty `reasons` when the
work is sound. `summary` is two or three sentences for the human who reviews next.
