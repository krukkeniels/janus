# Angular 15 to 16 upgrade

The reference flow of Janus 4.0 (spec section 10). It upgrades one or more Angular applications,
each a Git clone in a sub-folder of the goal folder, one repository at a time: Codex plans, a
human approves the plan, a ralph loop implements each task, TeamCity is consulted when it is
configured, Codex reviews the result and a human merges.

Nothing here is engine code. `janus.py` knows nothing about Angular, Git branches or TeamCity;
all of that lives in the four prompts, in `flow.py` and in `teamcity.py`, where it can be read
and edited.

## The files

| File | What it is |
|---|---|
| `flow.py` | The flow. Plain Python over the primitives of spec section 4. |
| `prompts/_preamble.md` | Prepended to every prompt: the branch, the commit and the safety rules. `{{branch}}` there is the `BRANCH` constant in `flow.py`, passed in through `context()`. |
| `prompts/plan.md` | Read-only survey of the repositories; returns ordered tasks. |
| `prompts/implement.md` | One task in one repository; returns `done`, `commit`, `summary`, `blockers`. |
| `prompts/review.md` | Read-only review of everything that was committed. |
| `prompts/fix.md` | One red CI build; used only when TeamCity is configured. |
| `teamcity.py` | Forty lines of `urllib`: find a build by revision, poll it, report failed tests. |
| `JANUS.md` | The goal, and after the first run the open gate, the decisions and the progress. |
| `.gitignore` | Ignores the product clones (`*/`), keeps `prompts/`, `journals/` and `tests/`. |
| `tests/` | The example's own tests; they are not copied into a goal folder. |

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
$EDITOR flow.py                       # edit BRANCH at the top: the branch every task works on
python3 janus.py run
```

`run` stops at the first gate and exits with code 2. Answer it after `answer:` in `JANUS.md`
and run again; `python3 janus.py status` shows the open gate and the last five steps. Every
finished step is replayed from `journal.yaml`, so answering a gate never repeats work.

## The steps it journals

| Key | Kind | What it does |
|---|---|---|
| `plan` | codex | Reads the repositories and proposes ordered tasks. |
| `approve-plan` | gate | The human approves the plan, or resets and edits it. |
| `implement/<id>/<n>` | codex | Ralph iteration `n` of task `<id>`, up to five. |
| `implement/<id>/exhausted` | decision | `retry`, `skip` or `stop`, when five iterations were not enough. |
| `implement/<id>/retry/<n>` | codex | The second ralph loop, after `retry`. |
| `ci/<id>` | step | The TeamCity wait, only when TeamCity is configured. |
| `fix/<id>/<n>` | codex | Up to three attempts at a red build. |
| `review` | ai_gate | Codex reviews every commit; `passed` and `reasons` are journaled. |
| `review-findings` | gate | Only when the review did not pass. |
| `merge` | gate | The human merges and answers `merged`. |

The keys are explicit everywhere in `flow.py`, never the engine's per-run default. That is what
lets the flow branch on a gate answer without shifting the keys of finished steps.

## TeamCity (optional)

```bash
export JANUS_TEAMCITY_URL=https://teamcity.example.com
export JANUS_TEAMCITY_TOKEN=<a token with read access>
```

With both set, each task waits for the TeamCity build of its commit before the flow moves on,
and a red build opens the fix loop. With either unset, `teamcity.configured()` is false and the
flow skips both. `build_type` in a task is the TeamCity build type id, or the string `none`.

**The token is readable by Codex.** Every `codex exec` inherits this process's environment and
runs with `--dangerously-bypass-approvals-and-sandbox`, which is the Janus 4.0 trade-off: the
machine Janus runs on is the sandbox (spec section 7). This is why the preamble forbids echoing
secrets: `journal.yaml` is committed and pushed after every step.

## Running the example's tests

From the repository root:

```bash
uv run pytest -q
```

`tests/test_teamcity.py` drives `teamcity.py` against a `http.server` stub on `127.0.0.1`, and
`tests/test_flow.py` runs the whole flow with the engine's fake `codex` in a temporary goal
folder. Neither needs the network, a TeamCity or the real Codex.

## Trial: Angular 15 to 16 with real Codex, 2026-09-23

Run on one throwaway application, without TeamCity, to satisfy spec criterion 12.7.

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
