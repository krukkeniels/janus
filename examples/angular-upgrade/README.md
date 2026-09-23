# Angular upgrade, one major at a time

The reference flow of Janus 4.0 (spec sections 10 and 14). It upgrades one or more Angular
applications, each a Git clone in a sub-folder of the goal folder, through one major at a time:
Codex plans and upgrades, TeamCity verifies the exact commit when it is configured, a fresh Codex
reviews the diff, a human reviews, a human merges, Codex proposes a manual test plan and QA
validates. Every "no" along the way sends the work back to Codex with the findings, as a new round
of the same major; the flow moves to the next major after a direction check.

Nothing here is engine code. `janus.py` knows nothing about Angular, Git branches or TeamCity;
all of that lives in the five step prompts and the preamble, in `flow.py` and in `teamcity.py`,
where it can be read and edited.

## The files

| File | What it is |
|---|---|
| `flow.py` | The flow: three nested loops in plain Python over the primitives of spec section 4. |
| `prompts/_preamble.md` | Prepended to every prompt: the branch, the commit and the safety rules. |
| `prompts/plan.md` | Read-only survey of the repositories for one target major; returns ordered tasks. |
| `prompts/implement.md` | One task in one repository; sees `{{findings}}` of the round before. |
| `prompts/review.md` | Read-only review of the round; returns `passed`, `reasons`, `summary`. |
| `prompts/fix.md` | One red CI build; used only when TeamCity is configured. |
| `prompts/testplan.md` | Read-only proposal of the manual test plan QA runs; returns `steps`, `summary`. |
| `teamcity.py` | A short `urllib` helper: find a build by revision, poll it, report failed tests. |
| `JANUS.md` | The goal, and after the first run the open gate, the decisions and the progress. |
| `.gitignore` | Ignores the product clones (`*/`), keeps `prompts/`, `journals/` and `tests/`. |
| `tests/` | The example's own tests; they are not copied into a goal folder. |

`{{branch}}` and `{{target}}` come from `context(branch=..., target=...)` at the top of the major
loop in `flow.py`: the branch of Angular 16 is `ai/angular-15-to-16`, the branch of 17 is
`ai/angular-16-to-17`, and the preamble follows.

## Starting a goal folder from it

```bash
cp -r examples/angular-upgrade ~/work/angular-16-upgrade
cd ~/work/angular-16-upgrade
rm -rf tests README.md __pycache__   # __pycache__ appears once the example's tests have been run
cp /path/to/janus/janus.py .          # copied, not symlinked: the goal folder is self-contained
git init -b main . && git add -A && git commit -m "goal folder"

git clone <repo-url> ui-kit           # one clone per repository, as a sub-folder
git clone <repo-url> shell

$EDITOR JANUS.md                      # edit "# Goal": the repositories, the checks, the definition of done
$EDITOR flow.py                       # edit MAJORS at the top: [16] for one upgrade, [16, 17] for two
python3 janus.py run
```

`run` stops at the first gate and exits with code 2. Answer it after `answer:` in `JANUS.md`
and run again; `python3 janus.py status` shows the open gate and the last five steps. Every
finished step is replayed from `journal.yaml`, so answering a gate never repeats work.

## The steps it journals

Every key carries the major (`v16`), the round (`r1`) and, inside the task loop, the task id and
the ralph iteration. With one repository `app` and no TeamCity, a round that passes every check
journals eight steps: `v16/plan`, `v16/approve-plan`, `v16/r1/implement/app/1`, `v16/r1/review`,
`v16/r1/human-review`, `v16/r1/merge`, `v16/r1/testplan`, `v16/r1/qa`.

| Key | Kind | What it does |
|---|---|---|
| `v<t>/plan` | codex | Reads the repositories and proposes ordered tasks for Angular `<t>`. |
| `v<t>/approve-plan` | gate | The human approves the plan, or resets and edits it. |
| `v<t>/r<n>/implement/<id>/<i>` | codex | Ralph iteration `i` of task `<id>` in round `n`, up to `MAX_IMPLEMENT`. |
| `v<t>/r<n>/implement/<id>/exhausted` | decision | `retry` (next round, blockers as findings), `skip` or `stop`. |
| `v<t>/r<n>/ci/<id>/<v>` | step | TeamCity verdict `v` of the task's latest commit, up to `MAX_CI`. |
| `v<t>/r<n>/ci/<id>/<v>/missing` | decision | `skip` or `stop`, when verdict `v` is `NOT_FOUND` or `TIMEOUT`. |
| `v<t>/r<n>/fix/<id>/<v>/<i>` | codex | Fix iteration `i` after red verdict `v`, up to `MAX_FIX`. |
| `v<t>/r<n>/fix/<id>/<v>/exhausted` | decision | `retry`, `skip` (keep the commits, build red) or `stop`. |
| `v<t>/r<n>/ci/<id>/red` | decision | `retry`, `skip` or `stop`, when `MAX_CI` verdicts were all red. |
| `v<t>/r<n>/review` | codex | A fresh Codex reviews the round; `passed: false` sends it back, `reasons` as findings. |
| `v<t>/r<n>/human-review` | gate | `approved` moves on; any other answer is the findings of the next round. |
| `v<t>/r<n>/merge` | gate | The human merges and answers `merged`. |
| `v<t>/r<n>/testplan` | codex | Codex proposes the manual test plan, shown at the QA gate. |
| `v<t>/r<n>/qa` | gate | `passed` ends the major; any other answer is the findings of the next round. |
| `v<t>/r<n>/blocked` | decision | Past `MAX_ROUNDS` rounds: `retry` allows `MAX_ROUNDS` more, `stop` exits 1. |
| `v<t>/direction` | decision | Between majors: `next` or `stop`. Absent after the last major. |

The keys are explicit everywhere in `flow.py`, never the engine's per-run default, and every one
carries every enclosing loop's counter or id. That is what lets the flow branch on a gate answer,
or come back for another round, without shifting the keys of finished steps.

## Loops

The flow is three nested loops of spec section 14: `for target in MAJORS` outside, `while True`
rounds inside a major, and the task loop with its CI return loop inside a round. Rounds are the
return loop of the diagram: the stretch from the first implement to QA may be repeated, and every
checkpoint that says no ends the round and records why in `findings`.

How a round comes back:

1. A checkpoint fails: the AI review returns `passed: false`, the human review gets an answer other
   than `approved`, QA gets an answer other than `passed`, or the human answers `retry` at a blocker
   report (`.../exhausted`, `.../ci/<id>/red`). The flow builds `findings`, a string such as
   `Human review of round 1:\n<the answer>`, and starts round 2 without stopping, unless a gate
   opened, in which case round 2 starts on the next `run`.
2. Round 2 replays nothing of its own, because none of its keys is in the journal yet; round 1's
   steps are `done` and its gates `answered`, so `run` re-executes the flow from the top, takes the
   same branches, arrives at round 2 with the same `findings` and runs the first key it does not
   know: `v16/r2/implement/<id>/1`. `{{findings}}` in `implement.md` is that string; it is the
   empty string in round 1, like `{{previous}}` in the first ralph iteration.
3. A gate inside round 2 opens and exits with code 2; the next `run` replays rounds 1 and 2 up to
   that gate and continues from it. The round counter is never read from the journal; the flow
   recomputes it from the replayed answers, which is what keeps the keys deterministic.
4. After `MAX_ROUNDS` rounds the flow opens `v16/r4/blocked` with the last findings as `show`.
   `retry` raises the allowance by `MAX_ROUNDS` and the loop goes on with `r4`; the counter is
   never reset, because `r1..r3` are `done` and would replay. `stop` exits with code 1.

The blocker report is the other way a round ends early. When a ralph gives up, `Exhausted.last`
is shown at a decision: `retry` ends the round and the blockers become the next round's findings;
`skip` keeps what was committed and continues the round (an implement task that is skipped is left
out of the round's review); `stop` exits with code 1. The human does the tooling or access work
while the decision is open. `reset` is not the way back: it archives the journal, and every
finished round with it.

## TeamCity (optional)

```bash
export JANUS_TEAMCITY_URL=https://teamcity.example.com
export JANUS_TEAMCITY_TOKEN=<a token with read access>
```

With both set, each task waits for the TeamCity build of its latest commit before the flow moves
on. With either unset, `teamcity.configured()` is false and the flow skips the wait and the fix
loop alike. `build_type` in a task is the TeamCity build type id, or the string `none`; a task
whose `build_type` is `none` skips the wait even when TeamCity is configured, so a repository
without a build does not hold the run up. `CI_TIMEOUT` at the top of `flow.py` (7200 s) is passed
explicitly to `teamcity.wait_for_build` and is the deadline for one wait: how long the poll loop
keeps asking TeamCity for one verdict before it gives up with `TIMEOUT`.

The CI wait is a return loop of its own, keyed per verdict (`v16/r1/ci/app/1`, `/2`, `/3`):

- `SUCCESS`: the task is recorded as finished with the commit CI just verified, and the flow moves on.
- `FAILURE`: the fix loop runs (`v16/r1/fix/app/<v>/<i>`, up to `MAX_FIX` iterations) with the
  failed test names in the prompt, and **the fix commit is waited for in turn** under the next
  verdict key. A task may wait for `MAX_CI` verdicts in one round: the implement commit, then each
  fix. When the last allowed verdict is still red, the flow opens `v16/r1/ci/app/red` with the
  commit, the build URL and the excerpt: `retry` ends the round with that failure as the findings,
  `skip` keeps the commits and continues to the review, `stop` exits with code 1.
- `NOT_FOUND` or `TIMEOUT`: there is nothing for Codex to fix, because CI never gave a verdict, so
  the flow opens `v16/r1/ci/app/<v>/missing` instead of the fix loop and asks the human to `skip`
  (keep the commit and move on) or `stop`.

**The token is not readable by Codex.** `teamcity.py` reads both variables once, at import, and
removes `JANUS_TEAMCITY_TOKEN` from `os.environ` as it reads it, before any Codex process starts.
`JANUS_TEAMCITY_URL` stays in the environment; it is not a secret. This matters because every
`codex exec` inherits this process's environment and runs with
`--dangerously-bypass-approvals-and-sandbox`, which is the Janus 4.0 trade-off: the machine Janus
runs on is the sandbox (spec section 7). Whatever else you export is readable by Codex, which is
why the preamble forbids echoing secrets: `journal.yaml` is committed and pushed after every step.

## Running the example's tests

From the repository root:

```bash
uv run pytest -q
```

`tests/test_teamcity.py` drives `teamcity.py` against a `http.server` stub on `127.0.0.1`, and
`tests/test_flow.py` runs the whole flow with the engine's fake `codex` in a temporary goal
folder, round by round and gate by gate. Neither needs the network, a TeamCity or the real Codex.

## Trial 1 (slice 2): Angular 15 to 16 with real Codex, 2026-09-23

Run on one throwaway application, without TeamCity, to satisfy spec criterion 12.7. **This report is
history**: it ran the slice 2 flow, whose keys (`plan`, `implement/<id>/<n>`, `review`, `merge`)
predate the loops above; the flow of this folder journals `v16/plan`, `v16/r1/implement/<id>/<n>`
and so on. It is kept because its findings about Codex still hold.

**Setup.** Goal folder `/home/race-day/janus-trial/angular-16-upgrade`, a Git repository with
the bare remote `/home/race-day/janus-trial/origin/angular-16-upgrade.git`. `janus.py` copied
from the repository at commit `12b129e`. The application is `app/`, a clone of the throwaway
`ng15-app` (Angular 15.2, three karma specs, default branch `master`) through the bare remote
`/home/race-day/janus-trial/origin/ng15-app.git`. Codex is codex-cli 0.155.1, model
`gpt-5.6-sol` at `xhigh` reasoning, from the user's own `~/.codex/config.toml`; Janus passes no
model flags. `JANUS_TEAMCITY_URL` and `JANUS_TEAMCITY_TOKEN` were unset, so `configured()` was
false and the flow skipped `ci/<id>` and `fix/<id>`. The goal named one repository, `app`, and
`flow.py`'s `BRANCH` was left at `ai/angular-15-to-16`.

**Runs.**

| Run | Command | Wall clock | Exit | Stopped at |
|---|---|---|---|---|
| 1 | `python3 janus.py run` | 77 s | 2 | gate `approve-plan` |
| 2 | `python3 janus.py run` | 493 s | 2 | gate `merge` |
| 3 | `python3 janus.py run` | < 1 s | 0 | flow ended |
| 4 | `python3 janus.py run` | < 1 s | 0 | flow ended, nothing re-executed |

Three Codex calls in all, 569 s of the 570 s total: `plan` 76 s, `implement/angular-16-upgrade/1`
123 s, `review` 370 s. Runs 3 and 4 started no `codex` process; run 4 replayed the whole journal
and left it byte-identical.

**Gates.**

| Key | Question | Shown | Answer |
|---|---|---|---|
| `approve-plan` | Approve this plan? … | `summary`, and `angular-16-upgrade [app] Upgrade …` | `yes` |
| `merge` | Every task is committed on `ai/angular-15-to-16` … | `id`, `repo`, `title`, `commit` | `merged` |

`approve-plan` was answered `yes` because the plan was one task, scoped to `app` and to Angular
16, and changed nothing else. There is no pull request in this trial, so `merged` stands for the
verified push: the bare `ng15-app.git` carries `ai/angular-15-to-16` at `4c0703e`. The
`implement/<id>/exhausted` decision and the `review-findings` gate never opened, so the known
`ai_gate` limitation (the reasons live only in `journal.yaml`) was not exercised.

**What Codex did.**

- `plan`: summary "One product repository was found: `app`, a clean Angular 15.2 application with
  no dependent repositories or TeamCity configuration. The upgrade will remain scoped to Angular
  16, preserve TypeScript and unrelated dependencies, verify installation/build/all three tests,
  then commit and push the required branch." One task, `id: angular-16-upgrade`, `repo: app`,
  `build_type: none`, objective: create the branch, `pnpm install`, `pnpm ng update
  @angular/core@16 @angular/cli@16` with every migration, keep TypeScript, then build, test,
  commit and push.
- `implement/angular-16-upgrade/1`: `done: true`, commit `4c0703e5a8879478cd69e1a03420b0ddff112dd0`,
  summary "Upgraded all Angular dependencies to 16, applied every offered migration, preserved
  TypeScript ~4.9.4, committed, and pushed `ai/angular-15-to-16`. `pnpm install` and `pnpm build`
  succeeded; the required ChromeHeadless test command passed all three specs.", `blockers: []`.
  One iteration was enough; `until=lambda r: r["done"]` ended the ralph at `/1`.
- `review`: `passed: true`, `reasons: []`, summary "The Angular 16 upgrade is sound: installation
  and build succeeded, and all three ChromeHeadless specs passed without test changes. The clean
  branch is pushed to origin at commit 4c0703e5a8879478cd69e1a03420b0ddff112dd0 with TypeScript
  and unrelated direct dependencies preserved."

**The result in `app/`.**

```text
* 4c0703e chore: upgrade Angular to version 16
* f8dc4e4 initial commit

 package.json   |   26 +-
 pnpm-lock.yaml | 2785 +++++++++++++++++++++++++++++++++-----------------------
 2 files changed, 1667 insertions(+), 1144 deletions(-)
```

`git status --porcelain` in `app/` was empty. Every `@angular/*` dependency is at `^16.2.12`,
with `@angular/cli` at `~16.2.16` and `@angular-devkit/build-angular` at `^16.2.16`; nothing is
left at 15. `typescript` is untouched at `~4.9.4`. The only other change is `zone.js` `~0.12.0`
to `~0.13.3`, which Angular 16 requires and `ng update` made. No source file, no spec and no
`angular.json` needed a migration, so the diff is the two dependency files only.

`app/` itself was not built or tested by hand, to keep it exactly as the flow left it. The checks
were run on a fresh clone of the pushed branch from the bare remote: `pnpm install` exited `0`,
`pnpm build` exited `0`, and `pnpm test --watch=false --browsers=ChromeHeadless` exited `0` with
`TOTAL: 3 SUCCESS`. The branch `ai/angular-15-to-16` was pushed to the bare remote by Codex
itself, in the implement step.

**Journal.**

```text
plan:                            codex   done      attempt 1
approve-plan:                    gate    answered  -
implement/angular-16-upgrade/1:  codex   done      attempt 1
review:                          ai_gate done      attempt 1
merge:                           gate    answered  -
```

No step failed, so no step was re-executed with `attempt: 2`. The goal folder has one commit per
status change (`janus: plan running`, `janus: plan done`, …), ten in all, each pushed to its bare
remote.

**Problems.**

- The plan step spent most of its 76 s reading the operator's own Codex skills. `~/.codex` loads
  a "superpowers" plugin, so the first thing the fresh process did was `sed` its way through
  `using-superpowers/SKILL.md` and `writing-plans/SKILL.md`, and its first streamed message was a
  schema-shaped `{"summary": "I'm using the required superpowers workflow …", "tasks": []}`. It
  recovered and returned a correct plan. Spec section 7 puts the model and its config in the
  user's hands, so Janus cannot prevent this; it is worth knowing that a prompt competes with
  whatever global instructions the operator's Codex already has.
- Codex, not the flow, chooses the journal keys. `plan.md` asks for "a short lowercase
  identifier", and Codex answered `angular-16-upgrade`, not `app`, so the ralph keys are
  `implement/angular-16-upgrade/<n>`. The keys are stable against edits to `flow.py`, as spec
  section 4 wants, but not against a re-plan: reset and plan again and the same work can land
  under a different key. If that matters, `plan.md` should tie `id` to `repo`.
- The review was the most expensive step of the trial, 370 s against the implement step's 123 s.
  Obeying "this step is read-only", it refused to run `pnpm install` in `app/` and instead built
  itself a `bwrap` sandbox, copied the working tree into a tmpfs and ran install, build and karma
  there. That is exactly the behaviour the prompt asks for, and it is worth three minutes; but a
  reviewer that re-runs the whole suite costs about as much as the implementation.
- The review read the implementer's own report. It ran `git show <sha>:journal.yaml` in the goal
  folder and read the `implement` result before judging it. The preamble forbids *editing*
  `journal.yaml`, not reading it, and the journal is committed next to the work, so the review is
  not blind. That is a prompt decision to make deliberately, either way.
- The implement step ran `find .. -name AGENTS.md -print`, reading above its repository folder.
  Nothing was written there and the preamble only forbids creating, changing or deleting outside
  the folder, but the boundary is a rule in a prompt, not a sandbox (spec section 13).
- Copying the example folder brings a `__pycache__/` with it if the tests have been run. `*/` in
  `.gitignore` keeps it out of Git, but `plan.md`'s ignore list names only `prompts`, `journals`,
  `tests` and dot-folders, so Codex could have proposed a task for it. It was deleted before the
  run. Either `plan.md` should ignore anything without a `.git`, or the quickstart should say to
  delete it along with `tests` and `README.md`.

**Engine gaps found.** One, at the very last statement of the flow. `log()` writes its line into
`## Progress` in `JANUS.md` but does not commit; only `save_journal()` commits, and it runs on a
status change. `flow.py`'s closing `log("flow finished")` comes after the last gate was answered
and therefore after the last commit, so that line stays uncommitted: a successful run ends with
`git status` showing ` M JANUS.md`, and the pushed `JANUS.md` never says the flow finished. It
cost nothing here and the trial was not stopped for it, but any `log()` after the last journaled
step of a flow is invisible to anyone reading the remote. It is fixed in the engine, by committing
once more before `cmd_run` returns, not in the example. No change was made to `janus.py` for this
trial.

**Verdict on spec 12.7.** Met. The example ran on the throwaway app with real Codex through the
plan, the approval gate, the implementation loop and the review gate, and left `app` on Angular
16 with `pnpm build` and all three specs green on the pushed branch.

## Trial 2 (slice 3): a round sent back by the human review, with real Codex

Filled in by the slice 3 trial (plan `docs/superpowers/plans/2026-09-23-janus4-slice3-loops.md`,
Task 6): round 1 of Angular 16 is answered with a finding at `v16/r1/human-review`, round 2 runs
with real Codex under `v16/r2/...`, and the finished flow is run once more to show that the
journal does not change.
