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

What the previous attempt at this task reported is below. An empty block means this is the
first attempt; otherwise continue from where it stopped and deal with what it reported.

{{previous}}

Work in small steps and run the checks the goal names after each of them. Read the tool output
rather than assuming it succeeded.

Set `done` to true only when every check in the goal passes for this repository and your work
is committed on `{{branch}}`. Set `commit` to the full SHA of your last commit, or to the empty
string if you committed nothing. `summary` is one or two sentences on what you changed and what
the checks said. `blockers` lists anything that stopped you, one line each, and is empty when
nothing did.
