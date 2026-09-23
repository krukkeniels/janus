---
output:
  done: bool
  commit: str
  summary: str
  blockers: list[str]
---
The CI build of your last commit did not succeed.

    task:   {{task.title}}
    repo:   {{task.repo}}
    status: {{build.status}}
    build:  {{build.url}}

What CI reported, the failing tests or the build error:

    {{build.excerpt}}

What the previous attempt at this fix reported is below; an empty block means this is the
first attempt.

{{previous}}

Fix the cause in the repository you were started in and commit on `{{branch}}`. A test that
fails because the code is wrong is fixed in the code, never by deleting, skipping or weakening
the test. If the build failed for a reason outside this repository, say so and stop.

Set `done` to true only when you have committed a fix you believe makes that build green, set
`commit` to the full SHA of that commit, and explain in `summary` what was wrong. `blockers`
lists what stopped you, and is empty when nothing did.
