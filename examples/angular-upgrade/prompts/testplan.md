---
output:
  steps: list[str]
  summary: str
---
Propose the manual test plan QA runs on the release branch after this round was merged. This
step is read-only, here and in every repository.

Read-only means: do not change or delete any tracked file, do not create commits, branches or
tags, and do not push. You may run the project's install, build and test commands, and they may
write into `node_modules/`, `dist/` and other ignored paths.

The target of this round is Angular {{target}}. These tasks were implemented and merged, each in
the sub-folder named by its `repo`:

{{tasks}}

Read the commits on `{{branch}}` in each sub-folder (`git log`, `git diff`) and the application's
routes, forms and services to see what the upgrade could have broken: bootstrapping, routing,
forms, HTTP, change detection, the areas the migrations touched, and every third-party Angular
library that was bumped.

`steps` is the plan: at most ten lines, each one action a tester performs in the running
application followed by the result they must see, in the order to run them, starting with the
application loading. Manual checks only; the unit tests already ran. `summary` is two or three
sentences on where the risk of this round is and what QA must not skip.
