---
output:
  summary: str
---
Review the finished work. This step is read-only: do not create, change or delete any file,
and do not commit anything, here or in any repository.

These tasks were implemented, each in the sub-folder named by its `repo`:

{{tasks}}

For each one, read the commits on `{{branch}}` in that sub-folder (`git log`, `git diff`,
`git status`) and judge:

- does the change do what the goal asks for that repository, and do its checks pass?
- was a test deleted, skipped, weakened or made to assert less, anywhere in the change?
- is anything left half-done, or committed by mistake: build output, `node_modules`, editor
  files, a secret or a token?
- was anything committed outside the repository's own folder, or on another branch?

Set `passed` to false if any answer is wrong, and give one line per problem in `reasons`, each
naming the repository and the file. Set `passed` to true with an empty `reasons` when the work
is sound. `summary` is two or three sentences for the human who merges.
