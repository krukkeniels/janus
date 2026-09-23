---
output:
  done: bool
  commit: str
  summary: str
  blockers: list[str]
---
Carry out this task in the repository you were started in:

    id:        {{task.id}}
    repo:      {{task.repo}}
    title:     {{task.title}}
    objective: {{task.objective}}

Tasks already finished in this round (repo, title, commit), so that you know what the other
repositories already produced. `[]` means this is the first task of the round:

{{done_so_far}}

Why the previous round of this upgrade came back is below. An empty block means this is the
first round. Otherwise these are the findings of the AI review, the human review or QA of the
last round, or the blockers a task reported: the branch already carries that round's commits,
so continue from them, do not start over, and make sure this round resolves every finding.

{{findings}}

What the previous attempt at this task reported is below. An empty block means this is the
first attempt; otherwise continue from where it stopped and deal with what it reported.

{{previous}}

Work in small steps and run the checks the goal names after each of them. Read the tool output
rather than assuming it succeeded.

Set `done` to true only when every check in the goal passes for this repository, every finding
above is resolved and your work is committed on `{{branch}}`. Set `commit` to the full SHA of
your last commit, or to the empty string if you committed nothing. `summary` is one or two
sentences on what you changed and what the checks said. `blockers` lists anything that stopped
you, one line each, and is empty when nothing did.
