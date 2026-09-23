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
rm -rf tests README.md
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
