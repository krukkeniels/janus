# Janus 4.0 Slice 3: Loops and Return Loops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove spec section 14 against the engine with the coverage test of section 9 item 12, reshape `examples/angular-upgrade/` into the three nested loops of section 10 (majors, rounds, tasks with a CI return loop) so that every "no" sends the work back to Codex with the findings, and run the second trial on the throwaway Angular 15 app with real Codex in which the human review answers with a finding and round 2 runs under `v16/r2/...`.

**Architecture:** Nothing changes in `janus.py`. A return loop is a `while True` around the stretch of the flow that may be repeated, with a round counter the flow recomputes from its own control flow, `findings` as a string that carries the reason back to Codex through `{{findings}}`, and every key inside the body prefixed with the round (`v16/r2/implement/app/1`). Replay does the rest: finished rounds return their stored results without executing, so the first unknown key on a rerun is the step that runs. The example's `flow.py` grows over three tasks: the loops and their checkpoints (review, human review, merge, test plan, QA), then the two bounds of a round (the `blocked` decision past `MAX_ROUNDS` and the blocker report when a ralph gives up), then the CI return loop keyed per verdict so that a fix commit is verified too. `review.md` becomes a plain `codex()` prompt that declares `passed` and `reasons` itself, because `ai_gate` returns only the boolean and the flow must hand the reasons to the next round. `test_flow.py` is rewritten for the new keys and drives every path gate by gate. The trial is manual: a fresh goal folder, a fresh single-branch bare remote for the app, real Codex, no TeamCity.

**Tech Stack:** Python 3.9+ for the example code (`flow.py` and `teamcity.py` use `%` formatting, no f-strings, like slice 2; tests may use f-strings), PyYAML 6, pytest 9.1.1 via `uv` (`/snap/bin/uv`), git 2.43.0, codex-cli 0.155.1 with `gpt-5.6-sol` at `xhigh` from `~/.codex/config.toml` (trial only), Node v24.5.0, pnpm 10.33.0 and Google Chrome at `/usr/bin/google-chrome` (trial only).

**Spec:** `/home/race-day/janus/janus-4.0-spec.md` v0.2 — **the working-tree version**, which at plan-writing time is an uncommitted edit on `main` (`git diff --stat`: `janus-4.0-spec.md | 176 +++---`). Section 14 (Loops and return loops), the rewritten section 10 (the example outline and the diagram-to-flow table), section 9 item 12, section 11 slice 3 and section 12 criterion 9 define this slice; sections 4 to 8 are binding facts about the engine. Executors read both documents. Task 0 brings the spec into the branch.

## Global Constraints

Copied from the spec where they bind this slice; every task's requirements include this section.

- Spec §11 slice 3: "Section 14, the engine test of coverage item 12, the example reshaped into the loops of section 10, and a second trial that goes through round 2. Same rule as slice 2: the engine changes only if a loop cannot be expressed without it. Writing the section showed none is needed: a return loop with a gate in its second round was run by hand on 2026-09-23 with the slice 2 engine and resumed correctly." This plan contains **no engine change**; Task 1's test passed on the unchanged engine when this plan was written (see *Self-review notes*). If an executor finds one is truly needed, they stop, record the step key and the primitive at fault, and add it as its own task with a test before continuing.
- Spec §12.9: "A round of the Angular example is sent back by a human review answer, round 2 runs with real Codex under `r2/` keys, the second run of the finished flow executes nothing, and every earlier round stays in the journal untouched." This is the acceptance test of the slice and is Task 6.
- Spec §9 item 12: "A return loop (section 14): a `while` flow whose gate answer sends it back to an earlier stage re-executes only the new round's keys on the next run, a gate inside the second round resumes in the second round, and a finished loop replays without executing anything." Task 1.
- Spec §14, two rules: "Every key in a loop body carries every enclosing loop's counter or id, and the flow derives those counters from its own control flow, never from the journal, the clock or a random source." Every primitive call in the example passes an explicit key built from the major, the round and, inside the task loop, the task id; ralph adds `/<n>`.
- Spec §14, return loop: "`findings` ... a string, empty in the first round, like `{{previous}}` in a ralph." `findings` is always a `str` in the flow; prompts use `{{findings}}` and `{{previous}}` whole, never dotted, because both are the empty string at first and a dotted lookup into a string is an undefined placeholder.
- Spec §14, bounding a return loop: "`retry` raises the limit and lets the loop go on, so the keys of the rounds that follow stay fresh. Never reset the counter to reuse `r1`: those keys are `done` and would replay."
- Spec §14, the blocker report: "`retry` ends the round and starts the next one with the blockers as `findings`; `skip` keeps what was committed and continues the round; `stop` raises `SystemExit(1)`."
- Spec §14, feeding the reason back: "When the check is Codex's own, declare `passed` and `reasons` in the prompt's `output` and call `codex()` rather than `ai_gate()`, so the reasons come back to the flow and not only into the journal." `review.md` declares all three fields and the flow calls `codex()`.
- Spec §10, the diagram table: `{k}/ci/<id>/<n>` "keyed per verdict so a fix commit is verified too"; "`MAX_FIX` iterations of `{k}/fix/<id>/<n>`, at most `MAX_CI` verdicts; past that, the blocker report"; the `NOT_FOUND`/`TIMEOUT` decision is `skip | stop` "nothing for Codex to fix"; `{k}/testplan` is "read-only, shown at the QA gate"; `{prefix}/direction` is "a `decision` between majors".
- Spec §10: "The slice 3 trial answers the human review of round 1 with a finding, so that round 2 runs with real Codex and the return loop is exercised end to end." Without TeamCity.
- Spec §4 Rendering: "The variables of a render are, in rising precedence: the reserved values `goal`, `attempt` and, in ralph, `previous`; the values from `context()`; the keyword arguments of the call. ... If `prompts/_preamble.md` exists it is rendered with the same variables and prepended to the prompt body." Therefore the preamble may use only `{{goal}}`, `{{attempt}}` and the `context()` values `{{branch}}` and `{{target}}`; never `{{previous}}`, `{{findings}}` or any call variable.
- Spec §4 Output schema: "All fields are required and no additional properties are allowed." Every field the flow reads is declared in the matching prompt, and every declared field must come back.
- Slice 1 readiness note: gate `show` values are trimmed — a summary and one line per task with its commit, never whole results — because the gate section is rewritten into `JANUS.md` on every stalled run.
- Spec §12.6: "`janus.py` contains no reference to Git branches, pull requests, TeamCity, Bitbucket or Angular, apart from committing its own two files." Nothing in this plan touches `janus.py`.
- Spec §12.8: `janus.py` stays one file with only the standard library and PyYAML. Unaffected.
- Example code (`flow.py`, `teamcity.py`) uses `%` formatting and no f-strings, to keep the engine's 3.9 floor spirit as slice 2 did; the spec's §10 outline uses f-strings for brevity and the example does not. Tests may use f-strings.
- Tooling: `uv run pytest -q` from the repository root is the verification command of every task. The root suite is **120 passed** before this plan and **128 passed** after it (120 → 121 after Task 1 → 116 after Task 2, which replaces 14 flow tests by 9 → 121 after Task 3 → 128 after Task 4; Tasks 5 and 6 add none).
- Commits: `type(scope): subject` with scopes `janus` (engine and its tests), `example` (the example folder), `docs` (README, spec, plans). Two-`-m` form so the trailer has a blank line before it: `git commit -m "type(scope): subject" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.
- No line over 120 characters in any file this plan creates or rewrites (checked for every file in the *Self-review notes*).
- Execution happens in a worktree created from the repository root with `git worktree add .worktrees/slice3-loops -b slice3-loops`; `.worktrees/` is already listed in `.git/info/exclude`. Every path in a task is relative to the worktree root, except the trial folders under `/home/race-day/janus-trial/`.

## Verified facts about this machine

Checked on 2026-09-23 while writing this plan; the numbers are observed, not assumed.

- The repository `/home/race-day/janus` is on `main` at `1d682c9` (`docs(example): call the plan step read-only ...`), clean except for the uncommitted spec edit. `uv run pytest -q` gives **120 passed in 9.29s**. `git worktree list` shows only the main checkout; `.worktrees/` exists, is empty, and is excluded through `.git/info/exclude`.
- `python3` is 3.12.3 with PyYAML 6.0.1 system-wide, so `python3 janus.py run` works in a goal folder without a venv. The `uv` environment has pytest 9.1.1 and PyYAML 6.0.3. `uv` is 0.12.17 at `/snap/bin/uv`; `git` is 2.43.0.
- `codex --version` prints **codex-cli 0.155.1**, at `/home/race-day/.nvm/versions/node/v24.5.0/bin/codex`. `~/.codex/config.toml` sets `model = "gpt-5.6-sol"`, `model_reasoning_effort = "xhigh"`, `personality = "pragmatic"`; Janus passes no model flags. Node is v24.5.0, pnpm 10.33.0, Google Chrome is at `/usr/bin/google-chrome`.
- The engine facts this slice relies on, read from `janus.py`: `run_step` returns the stored result of a `done` entry without executing (line 275-277); `gate()` returns the stored `answer` of an `answered` entry (line 424-426) and otherwise writes the section and raises `SystemExit(2)` (line 439-442); `ralph` keys iterations `<key>/<n>` and passes `previous=""` to the first (line 370-374); `ai_gate` returns only `bool(result["passed"])` (line 385); `log()` skips `## Progress` while `REPLAYING` (line 162); `codex()` inherits the process environment (`subprocess.Popen` without `env=`, line 313); `cmd_run` turns `SystemExit(n)` from the flow into exit code `n` (line 490-491).
- The slice 2 trial left `/home/race-day/janus-trial/angular-16-upgrade/` (journal keys `plan`, `approve-plan`, `implement/angular-16-upgrade/1`, `review`, `merge`) and two bare remotes under `/home/race-day/janus-trial/origin/`: `angular-16-upgrade.git` and `ng15-app.git`. **`ng15-app.git` carries two branches: `master` at `f8dc4e4 initial commit` and `ai/angular-15-to-16` at `4c0703e chore: upgrade Angular to version 16`**, pushed by Codex in that trial. Its `master` has `README.md` whose third line is `This project was generated with [Angular CLI](https://github.com/angular/angular-cli) version 15.2.11.`, `package.json` with `@angular/*` `^15.2.0`, `@angular/cli` `~15.2.11`, `typescript` `~4.9.4`, `zone.js` `~0.12.0`; on `ai/angular-15-to-16` the same file has `@angular/core` `^16.2.12`, `@angular/cli` `~16.2.16`, `zone.js` `~0.13.3`.
- Because that branch already exists on `ng15-app.git`, a new trial cloned from it would either find the upgrade already done (Codex checks out `origin/ai/angular-15-to-16`) or be rejected on push (non-fast-forward against `4c0703e`). The trial therefore uses **a fresh bare made from that remote's `master` only**: `git clone --bare --single-branch --branch master origin/ng15-app.git origin/ng15-app-slice3.git` was rehearsed in the scratchpad and yields a bare with `master` alone (`HEAD -> refs/heads/master`); a clone of it is a 1.0 MB working tree on `master` at `f8dc4e4` with `remotes/origin/master` as its only remote branch. `/home/race-day/janus-trial/slice3-angular-16` does not exist yet.
- All code in this plan was assembled in `/tmp/claude-1000/-home-race-day-janus/42229065-701a-4e08-8dcb-14948c49e35d/scratchpad/plan3-check`, a copy of the repository, and run at every red and green step; see *Self-review notes*. The real repository was not modified.

## Design decisions fixed here (where the spec leaves room)

- **The engine test is a new module `tests/test_loops.py` with one test** that follows the whole item 12 story across five `janus.main(["run"])` invocations: round 1, the answer that sends it back, an unanswered rerun that must stay in round 2, the approval inside round 2, and the replay of the finished loop. It uses `step()` and `human_gate()` and no fake `codex`: the return loop is about keys and replay, not about Codex. It is a characterisation test of behaviour the engine already has, so it is green on first run; the plan says so instead of inventing a red.
- **The round body is a function, `run_round(k, rnd, plan, findings)`, that returns `None` when QA passed and the findings string otherwise; a checkpoint inside the task loop that must end the round raises `SendBack(findings)`**, a two-line exception class in `flow.py` caught by the `while` loop. Reason: `retry` at a blocker report happens two loops deep (inside the task loop, inside the CI loop); a flag-and-`break` chain through two loops is harder to read than one exception that names what it does. `SystemExit(2)` from a gate is a `BaseException` and passes through `except SendBack` and `except Exhausted` untouched.
- **`stop` anywhere calls `stop_run(reason)`**, which writes a Progress line and raises `SystemExit(1)`, as slice 2 did.
- **Blocker report answers.** `retry`: `SendBack("Task <id> gave up at <key>:\n<blockers or summary>")`. `skip` at an exhausted *implement*: the task is left out of `finished` (nothing verified was produced; the review then sees `[]` and the human review shows no task line) and the round goes on. `skip` at an exhausted *fix*: the task is recorded with the last result CI judged, red build and all, as in slice 2. `skip` at the `red` decision: likewise. `stop`: exit 1.
- **The CI loop stops after `MAX_CI` verdicts, not after `MAX_CI` fixes**: `implement → ci/1 → fix/1 → ci/2 → fix/2 → ci/3 → red decision`. A fix whose commit could not be verified is never the last word; that is what "CI verdicts one task may wait for in one round: implement, then each fix" in the spec's constant comment means. Fix ralphs are keyed `{k}/fix/<id>/<v>` where `<v>` is the verdict they answer, so the fix after `ci/app/1` is `fix/app/1/<n>`.
- **`retry` at the `red` decision** sends the round back with `"Task <id> is still red after <MAX_CI> CI verdicts (<url>):\n<excerpt>"`; the spec table says "the blocker report" for this box and §14 gives blocker reports the `retry | skip | stop` triple.
- **The `blocked` decision shows `findings`**, a string, exactly as the spec outline does (`show=findings`); the engine writes a string `show` as indented lines.
- **Findings strings** are `"AI review of round %d:\n%s"` (reasons joined by newlines), `"Human review of round %d:\n%s"`, `"QA of round %d:\n%s"`, and the two blocker forms above. `implement.md` renders `{{findings}}` whole under a paragraph that says what it is and that the branch already carries the previous round's commits.
- **`{{target}}` appears in `plan.md`, `review.md` and `testplan.md`** ("Plan the upgrade to Angular {{target}}", "The target of this round is Angular {{target}}"). It is a `context()` value, so nothing has to be passed. `implement.md` gets the target through `{{task.objective}}`, which `plan.md` now tells Codex to write with the target in it. The preamble is unchanged: `{{branch}}` follows the major because `context(branch=..., target=...)` is set at the top of the major loop.
- **The sample goal is major-agnostic.** `JANUS.md` says "one major at a time. Each step names its target major and its branch" and writes the checks with `<target>`, so `MAJORS = [16, 17]` does not contradict the goal text. The trial goal (Task 6) does the same.
- **Gate `show` values**: `approve-plan` shows `{summary, tasks: ["<id> [<repo>] <title>", ...]}`; `human-review` shows `{review: <review summary>, tasks: ["<id> [<repo>] <commit> -- <title>", ...]}`; `merge` shows the same task lines; `qa` shows `{summary, steps}` of the test plan; the `exhausted` decisions show `{summary, blockers}`; `missing` shows `{commit, status, url}`; `red` shows `{commit, url, excerpt}`; `blocked` shows `findings`.
- **The direction check** is a `decision(["next", "stop"])` keyed `v<t>/direction`, opened only when a major follows (`i + 1 < len(MAJORS)`); `stop` breaks out of the major loop and the flow ends with exit 0, as the spec outline's `break` does.
- **`testplan.md` returns `steps: list[str]` and `summary: str`**, at most ten steps, each an action followed by the result to see; the QA gate shows both.
- **Tests change `MAJORS` by editing the copied `flow.py`**: `flow.replace("MAJORS = [16] ", "MAJORS = [16, 17]")` in the goal folder the `goal_folder` fixture built. The trailing space in the search string ties it to the constant line (`MAJORS = [16]           # ...`), and the test asserts the string is present before replacing it.
- **The trial's app remote is a fresh single-branch bare `ng15-app-slice3.git`** (see *Verified facts*); the slice 2 remote and its `ai/angular-15-to-16` branch are left as they are, because the slice 2 report cites them. The goal folder is `/home/race-day/janus-trial/slice3-angular-16` with its own bare remote `slice3-angular-16.git`. "Merged" at the merge gate means, in this trial, that the branch is pushed to that bare remote; the report says so.
- **The human-review finding of the trial is fixed in Task 6**, one line, actionable, and checkable in `app/`'s Git log: it asks for the `README.md` line that still says Angular CLI 15.2.11 to be updated and for a one-line upgrade note, and for the `zone.js` version to be confirmed in the summary.

## File structure

| Path | Responsibility | Task |
|---|---|---|
| `janus-4.0-spec.md` | Spec v0.2 with section 14, committed into the branch. | 0 |
| `tests/test_loops.py` | The return-loop replay test of spec §9 item 12. 1 test. | 1 |
| `examples/angular-upgrade/prompts/plan.md` | Read-only survey for Angular `{{target}}`; `id` tied to `repo`; titles and objectives name the target. | 2 |
| `examples/angular-upgrade/prompts/implement.md` | One task; `{{done_so_far}}`, the new `{{findings}}` block, `{{previous}}`. | 2 |
| `examples/angular-upgrade/prompts/review.md` | Read-only review as a plain `codex()` prompt: `output: passed, reasons, summary`; `{{target}}`. | 2 |
| `examples/angular-upgrade/prompts/testplan.md` | New. Read-only manual test plan: `output: steps, summary`; `{{target}}`, `{{tasks}}`. | 2 |
| `examples/angular-upgrade/JANUS.md` | The sample goal, major-agnostic. | 2 |
| `examples/angular-upgrade/flow.py` | The flow. Task 2: majors, rounds, tasks, review, human review, merge, test plan, QA, direction. Task 3: `blocked`, blocker report. Task 4: the CI return loop. | 2, 3, 4 |
| `examples/angular-upgrade/tests/test_flow.py` | Rewritten. 9 tests in Task 2, 5 in Task 3, 7 in Task 4: 21. | 2, 3, 4 |
| `examples/angular-upgrade/README.md` | Rewritten around the loops; the slice 2 trial kept as history; the slice 3 trial report. | 5, 6 |

Unchanged: `janus.py`, `tests/conftest.py`, `tests/helpers.py`, every other engine test, `examples/angular-upgrade/prompts/_preamble.md`, `prompts/fix.md`, `teamcity.py`, `.gitignore`, `tests/conftest.py` and `tests/test_teamcity.py` of the example, `pyproject.toml`.

Spec coverage: §9 item 12 → Task 1; §14 return loop, nested loops and feeding the reason back → Task 2; §14 bounding a return loop and the blocker report → Task 3; §10 CI return loop keyed per verdict → Task 4; §10 file list (`testplan.md` new) → Task 2; §10 "the trial report goes into the example's README" and §12.9 → Tasks 5, 6.

Names used across tasks, so a task's implementer knows what the neighbouring tasks call things. Flow constants: `MAJORS`, `MAX_ROUNDS`, `MAX_IMPLEMENT`, `MAX_CI`, `MAX_FIX`, `CI_TIMEOUT`. Flow functions: `task_line(record)`, `stop_run(reason)`, `ask_after_exhausted(key, exc, task, attempts)`, `verify_in_ci(k, task, result)`, `run_task(k, task, finished, findings)`, `run_round(k, rnd, plan, findings)`, class `SendBack(findings)` with `.findings`. Loop variables: `target`, `prefix = "v%d" % target`, `rnd`, `k = "%s/r%d" % (prefix, rnd)`, `findings` (str or None), `allowed`. Task record: `{id, repo, title, commit}`. Prompt outputs: plan `{summary, tasks[{id, repo, title, objective, build_type}]}`; implement and fix `{done, commit, summary, blockers}`; review `{passed, reasons, summary}`; testplan `{steps, summary}`; build `{status, url, excerpt}`. Test helpers in `test_flow.py`: `run(folder, monkeypatch)`, `answer(folder, text)`, `journal_of(folder)`, `run_to_human_review(folder, fake_codex, monkeypatch, script)`; constants `PLAN`, `NOT_DONE`, `DONE`, `DONE_2`, `FIXED`, `REVIEW_OK`, `REVIEW_BAD`, `TESTPLAN`, `BUILD`, `RED`, `GREEN`, `ONE_ROUND`, `ROUND_1`. Fixtures (unchanged, from the example's `tests/conftest.py`): `fake_codex` (`.script(steps)`, `.calls()`; the last scripted step repeats for extra calls), `goal_folder`, `teamcity_server` (`.serve(bodies)`, `.requests()`), `without_teamcity` (autouse).

---

### Task 0: Bring spec v0.2 into the branch

The spec that defines this slice is an uncommitted edit in the main working tree. The worktree branch is cut from `1d682c9`, which holds v0.1 without section 14. The branch must carry the spec it implements.

**Files:**
- Modify: `janus-4.0-spec.md` (copied from the main working tree)

- [ ] **Step 1: Check whether the spec is still uncommitted on `main`**

Run from the repository root `/home/race-day/janus`:

```bash
git status --short janus-4.0-spec.md
grep -c "^## 14. Loops and return loops" janus-4.0-spec.md .worktrees/slice3-loops/janus-4.0-spec.md
```

Expected when nothing has changed since the plan was written: ` M janus-4.0-spec.md`, then `janus-4.0-spec.md:1` and `.worktrees/slice3-loops/janus-4.0-spec.md:0`. If the first command prints nothing and both counts are `1`, the spec was committed meanwhile and the worktree already has it: skip to Task 1.

- [ ] **Step 2: Copy it into the worktree and commit**

```bash
cp janus-4.0-spec.md .worktrees/slice3-loops/janus-4.0-spec.md
cd .worktrees/slice3-loops
grep -c "^## 14. Loops and return loops" janus-4.0-spec.md
git add janus-4.0-spec.md
git commit -m "docs(spec): loops and return loops, the example reshaped around them (v0.2)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: `1`, then one commit. The main working tree keeps its uncommitted edit; whoever merges the branch resolves that copy (it is byte-identical).

---

### Task 1: The engine test of a return loop under replay (spec §9 item 12)

Spec §9 item 12 (quoted in *Global Constraints*), §14 "Why this works with replay" ("Round 1's steps are `done` and its gate is `answered`, so they return their stored results without executing; the flow takes the same branches it took last time, arrives at round 2 with the same `findings`, and the first key it meets that is not in the journal is the step that runs. A gate inside round 2 opens, exits with code 2, and the next run replays rounds 1 and 2 up to that gate."), §5 Replay.

**Files:**
- Create: `tests/test_loops.py`

**Interfaces:**
- Consumes: the engine's `root` fixture (`tests/conftest.py`: a `tmp_path` goal folder with `JANUS.md` and `prompts/`, engine begun there), `helpers.read_journal(root)`, `janus.main(["run"])`.
- Produces: nothing other tasks use. The flow text `RETURN_LOOP` is the pattern of spec §14 with `step()` in place of the ralph and `human_gate()` as the checkpoint.

- [ ] **Step 1: Write the test**

Create `tests/test_loops.py`:

```python
"""Spec section 14 return loops under replay (coverage item 12 of section 9): a `while` flow whose
gate answer sends it back to an earlier stage, run across several `janus.main(["run"])` invocations."""
import janus
from helpers import read_journal

# The return-loop shape of spec section 14, with step() and human_gate() so no Codex is needed.
# The round counter is recomputed by the flow from the replayed answers, never read from the journal.
RETURN_LOOP = """\
from janus import step, human_gate

findings = ""
rnd = 0
while True:
    rnd += 1
    k = f"r{rnd}"
    work = step(f"{k}/work", lambda: f"round {rnd} built with findings: {findings!r}")
    answer = human_gate("Approve, or write your findings.", key=f"{k}/review", show=work)
    if answer.strip().lower() != "approved":
        findings = answer
        continue
    break
step("finish", lambda: f"finished in round {rnd}")
"""


def run(root, monkeypatch):
    monkeypatch.chdir(root)
    return janus.main(["run"])


def answer(root, text):
    path = root / "JANUS.md"
    path.write_text(path.read_text(encoding="utf-8").replace("\nanswer:\n", f"\nanswer: {text}\n"), encoding="utf-8")


def test_a_return_loop_executes_only_the_new_round_and_resumes_at_a_gate_inside_it(root, monkeypatch):
    (root / "flow.py").write_text(RETURN_LOOP, encoding="utf-8")

    # Round 1: the work step runs, the gate opens, the run exits 2.
    assert run(root, monkeypatch) == 2
    steps = read_journal(root)["steps"]
    assert list(steps) == ["r1/work", "r1/review"]
    assert steps["r1/work"]["result"] == "round 1 built with findings: ''"
    assert steps["r1/review"]["status"] == "open"
    round_one = dict(steps["r1/work"])

    # The gate says no: round 1 replays, round 2 executes with the answer as findings, and its gate opens.
    answer(root, "the title is wrong")
    assert run(root, monkeypatch) == 2
    steps = read_journal(root)["steps"]
    assert list(steps) == ["r1/work", "r1/review", "r2/work", "r2/review"]
    assert steps["r1/work"] == round_one  # round 1 was replayed, not re-executed: same result, same timestamps
    assert steps["r1/review"]["answer"] == "the title is wrong"
    assert steps["r2/work"]["result"] == "round 2 built with findings: 'the title is wrong'"
    assert steps["r2/review"]["status"] == "open"
    assert "## Gate: r2/review" in (root / "JANUS.md").read_text(encoding="utf-8")

    # A run with the gate still unanswered resumes in round 2: exit 2 again, no round 3 key.
    assert run(root, monkeypatch) == 2
    assert list(read_journal(root)["steps"]) == ["r1/work", "r1/review", "r2/work", "r2/review"]

    # The gate inside round 2 says yes: the loop breaks in round 2 and the flow ends.
    answer(root, "approved")
    assert run(root, monkeypatch) == 0
    steps = read_journal(root)["steps"]
    assert list(steps) == ["r1/work", "r1/review", "r2/work", "r2/review", "finish"]
    assert steps["finish"]["result"] == "finished in round 2"
    assert "r3/work" not in steps

    # The finished loop replays without executing anything: the journal is unchanged, byte for byte.
    before = (root / "journal.yaml").read_text(encoding="utf-8")
    assert run(root, monkeypatch) == 0
    assert (root / "journal.yaml").read_text(encoding="utf-8") == before
```

- [ ] **Step 2: Run it**

Run: `uv run pytest -q tests/test_loops.py`
Expected: `1 passed`. This is a characterisation test of behaviour the engine already has (spec §11: "no engine change is expected"); there is no red step. **If it fails**, the engine does not replay a return loop as section 14 describes: stop, keep the failure output, and add an engine task to this plan (with this test as its red) before going on to Task 2. Do not patch `janus.py` without a test.

- [ ] **Step 3: Run the whole suite**

Run: `uv run pytest -q`
Expected: `121 passed`.

- [ ] **Step 4: Commit**

```bash
git add tests/test_loops.py
git commit -m "test(janus): a return loop replays finished rounds and resumes at a gate in round 2" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The loops: majors, rounds, tasks and the checkpoints that send a round back

Spec §10 (the flow outline: `for target in MAJORS`, `context(branch=..., target=...)`, `while True` rounds with `findings`, the task loop, `review` as a `codex()` that "declares passed and reasons itself", `human-review`, `merge`, `testplan`, `qa`, `direction`), §14 return loop, nested loops and feeding the reason back, §4 keys and rendering.

**Files:**
- Modify: `examples/angular-upgrade/prompts/plan.md`, `examples/angular-upgrade/prompts/implement.md`, `examples/angular-upgrade/prompts/review.md`, `examples/angular-upgrade/JANUS.md`
- Create: `examples/angular-upgrade/prompts/testplan.md`
- Rewrite: `examples/angular-upgrade/flow.py`, `examples/angular-upgrade/tests/test_flow.py`

**Interfaces:**
- Consumes: the fixtures `fake_codex`, `goal_folder`, `without_teamcity` of the example's `tests/conftest.py` (unchanged); the engine primitives `codex`, `context`, `decision`, `human_gate`, `log`, `ralph`.
- Produces:
  - `prompts/plan.md` → `{"summary": str, "tasks": [{"id", "repo", "title", "objective", "build_type"}]}`, rendered with `{{target}}` (and the preamble's `{{goal}}`, `{{attempt}}`, `{{branch}}`).
  - `prompts/implement.md` → `{"done": bool, "commit": str, "summary": str, "blockers": list[str]}`, rendered with `{{task.*}}`, `{{done_so_far}}`, `{{findings}}`, `{{previous}}`, `{{branch}}`.
  - `prompts/review.md` → `{"passed": bool, "reasons": list[str], "summary": str}`, rendered with `{{tasks}}`, `{{target}}`, `{{branch}}`.
  - `prompts/testplan.md` → `{"steps": list[str], "summary": str}`, rendered with `{{tasks}}`, `{{target}}`, `{{branch}}`.
  - `flow.py`: constants `MAJORS = [16]`, `MAX_IMPLEMENT = 5`; functions `task_line(record) -> str`, `run_task(k, task, finished, findings) -> dict`, `run_round(k, rnd, plan, findings) -> str | None`; keys `v<t>/plan`, `v<t>/approve-plan`, `v<t>/r<n>/implement/<id>/<i>`, `v<t>/r<n>/review`, `v<t>/r<n>/human-review`, `v<t>/r<n>/merge`, `v<t>/r<n>/testplan`, `v<t>/r<n>/qa`, `v<t>/direction`. Task 3 wraps the ralph in `run_task` and the `while` body; Task 4 inserts the CI call after the ralph.
  - `test_flow.py`: the module head (constants and helpers) that Tasks 3 and 4 append tests to.

- [ ] **Step 1: Write the failing tests**

Replace `examples/angular-upgrade/tests/test_flow.py` with:

```python
"""The example flow, end to end, with the engine's fake `codex` and a stubbed TeamCity.

Every test drives `janus.main(["run"])` in a copied goal folder the way a human would: run, answer
the one open gate in JANUS.md, run again. The keys carry the major, the round and the task
(`v16/r1/implement/app/1`), as spec section 14 asks of every loop.
"""
import yaml

import janus

PLAN = {"summary": "One repository, app, goes from Angular 15 to Angular 16.",
        "tasks": [{"id": "app", "repo": "app", "title": "Upgrade app to Angular 16",
                   "objective": "app is on Angular 15.2. Run ng update to 16 and keep the tests green.",
                   "build_type": "app_Build"}]}
NOT_DONE = {"done": False, "commit": "", "summary": "ng update ran; the build still fails.",
            "blockers": ["app.component.ts does not compile"]}
DONE = {"done": True, "commit": "a" * 40, "summary": "Angular 16, build and tests green.", "blockers": []}
DONE_2 = {"done": True, "commit": "c" * 40, "summary": "Round 2: the findings are addressed.", "blockers": []}
FIXED = {"done": True, "commit": "b" * 40, "summary": "Fixed the failing title spec.", "blockers": []}
REVIEW_OK = {"passed": True, "reasons": [], "summary": "The upgrade is complete and no test was weakened."}
REVIEW_BAD = {"passed": False, "reasons": ["app: app.component.spec.ts is marked xdescribe"],
              "summary": "The upgrade skips a spec."}
TESTPLAN = {"steps": ["Open / and see the title", "Navigate to /about and back"],
            "summary": "Bootstrapping and routing are the risk of this round."}
BUILD = {"id": 42, "webUrl": "http://tc/viewLog.html?buildId=42", "state": "finished"}
RED = [{"build": [dict(BUILD, status="FAILURE")]},
       {"testOccurrence": [{"name": "AppComponent should render title"}]}]
GREEN = [{"build": [dict(BUILD, status="SUCCESS")]}]
ONE_ROUND = [{"output": DONE}, {"output": REVIEW_OK}, {"output": TESTPLAN}]
ROUND_1 = ["v16/r1/implement/app/1", "v16/r1/review", "v16/r1/human-review", "v16/r1/merge",
           "v16/r1/testplan", "v16/r1/qa"]


def run(folder, monkeypatch):
    monkeypatch.chdir(folder)
    return janus.main(["run"])


def answer(folder, text):
    """Answer the one open gate: only one is ever open at a time."""
    path = folder / "JANUS.md"
    path.write_text(path.read_text(encoding="utf-8").replace("\nanswer:\n", "\nanswer: %s\n" % text),
                    encoding="utf-8")


def journal_of(folder):
    return yaml.safe_load((folder / "journal.yaml").read_text(encoding="utf-8"))


def run_to_human_review(folder, fake_codex, monkeypatch, script):
    """Plan, approve, and run the first round up to its human review gate."""
    fake_codex.script([{"output": PLAN}] + script)
    assert run(folder, monkeypatch) == 2
    answer(folder, "yes")
    assert run(folder, monkeypatch) == 2


def test_one_round_that_passes_every_check_ends_at_qa_passed(goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND)
    answer(goal_folder, "approved")
    assert run(goal_folder, monkeypatch) == 2
    answer(goal_folder, "merged")
    assert run(goal_folder, monkeypatch) == 2
    answer(goal_folder, "passed")
    assert run(goal_folder, monkeypatch) == 0
    steps = journal_of(goal_folder)["steps"]
    assert list(steps) == ["v16/plan", "v16/approve-plan"] + ROUND_1
    assert [e["status"] for e in steps.values()] == \
        ["done", "answered", "done", "done", "answered", "answered", "done", "answered"]
    assert steps["v16/r1/review"]["kind"] == "codex" and steps["v16/r1/review"]["result"]["passed"] is True
    assert "v16/r1/ci/app/1" not in steps and "v16/direction" not in steps
    assert len(fake_codex.calls()) == 4
    assert "Angular 16 reached in 1 round(s)" in (goal_folder / "JANUS.md").read_text(encoding="utf-8")


def test_every_prompt_renders_with_the_branch_the_target_the_task_and_empty_findings(
        goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, [{"output": NOT_DONE}] + ONE_ROUND)
    plan, first, second, review = fake_codex.calls()[:4]
    assert plan["cwd"].endswith("angular-16-upgrade") and first["cwd"].endswith("angular-16-upgrade/app")
    assert "ai/angular-15-to-16" in plan["prompt"] and "Plan the upgrade to Angular 16." in plan["prompt"]
    assert "Upgrade every Angular application" in plan["prompt"]
    assert plan["schema"]["properties"]["tasks"]["items"]["required"] == \
        ["id", "repo", "title", "objective", "build_type"]
    assert "Upgrade app to Angular 16" in first["prompt"] and "This is attempt 1" in first["prompt"]
    assert "do not start over, and make sure this round resolves every finding.\n\n\n\nWhat the previous" \
        in first["prompt"]  # {{findings}} is the empty string in round 1, like {{previous}} in iteration 1
    assert "ng update ran; the build still fails." in second["prompt"]
    assert "Upgrade app to Angular 16" in review["prompt"] and "a" * 40 in review["prompt"]
    assert "The target of this round is Angular 16." in review["prompt"]
    assert review["schema"]["required"] == ["passed", "reasons", "summary"]
    answer(goal_folder, "approved")
    run(goal_folder, monkeypatch)
    answer(goal_folder, "merged")
    run(goal_folder, monkeypatch)
    testplan = fake_codex.calls()[4]
    assert "a" * 40 in testplan["prompt"] and testplan["schema"]["required"] == ["steps", "summary"]
    text = (goal_folder / "JANUS.md").read_text(encoding="utf-8")
    assert "## Gate: v16/r1/qa" in text and "- Open / and see the title" in text


def test_a_failed_ai_review_sends_the_work_back_and_round_2_implements_with_the_reasons(
        goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch,
                        [{"output": DONE}, {"output": REVIEW_BAD}, {"output": DONE_2}] + ONE_ROUND[1:])
    steps = journal_of(goal_folder)["steps"]
    assert list(steps) == ["v16/plan", "v16/approve-plan", "v16/r1/implement/app/1", "v16/r1/review",
                           "v16/r2/implement/app/1", "v16/r2/review", "v16/r2/human-review"]
    assert steps["v16/r1/review"]["result"]["passed"] is False
    assert "v16/r1/human-review" not in steps
    round_2 = fake_codex.calls()[3]["prompt"]
    assert "AI review of round 1:\napp: app.component.spec.ts is marked xdescribe" in round_2
    text = (goal_folder / "JANUS.md").read_text(encoding="utf-8")
    assert "round 1 of Angular 16 came back: AI review of round 1:" in text
    assert "c" * 40 in text  # the human review of round 2 shows round 2's commit


def test_human_review_findings_become_the_findings_of_round_2(goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND[:2] + [{"output": DONE_2}] + ONE_ROUND[1:])
    round_1 = dict(journal_of(goal_folder)["steps"]["v16/r1/implement/app/1"])
    answer(goal_folder, "Also update zone.js to the version Angular 16 recommends")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/human-review"]["answer"] == "Also update zone.js to the version Angular 16 recommends"
    assert list(steps)[-3:] == ["v16/r2/implement/app/1", "v16/r2/review", "v16/r2/human-review"]
    assert steps["v16/r1/implement/app/1"] == round_1  # round 1 replayed, untouched
    assert "Human review of round 1:\nAlso update zone.js to the version Angular 16 recommends" \
        in fake_codex.calls()[3]["prompt"]
    answer(goal_folder, "approved")
    assert run(goal_folder, monkeypatch) == 2
    assert journal_of(goal_folder)["steps"]["v16/r2/merge"]["status"] == "open"
    assert len(fake_codex.calls()) == 5


def test_qa_findings_become_the_findings_of_round_2_and_round_2_can_finish(goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND + [{"output": DONE_2}] + ONE_ROUND[1:])
    answer(goal_folder, "approved")
    run(goal_folder, monkeypatch)
    answer(goal_folder, "merged")
    assert run(goal_folder, monkeypatch) == 2
    answer(goal_folder, "The login form no longer submits on Enter")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/qa"]["answer"] == "The login form no longer submits on Enter"
    assert list(steps)[-3:] == ["v16/r2/implement/app/1", "v16/r2/review", "v16/r2/human-review"]
    assert "QA of round 1:\nThe login form no longer submits on Enter" in fake_codex.calls()[4]["prompt"]
    for text in ("approved", "merged", "passed"):
        answer(goal_folder, text)
        code = run(goal_folder, monkeypatch)
    assert code == 0
    steps = journal_of(goal_folder)["steps"]
    assert list(steps) == ["v16/plan", "v16/approve-plan"] + ROUND_1 + [k.replace("/r1/", "/r2/") for k in ROUND_1]
    assert "Angular 16 reached in 2 round(s)" in (goal_folder / "JANUS.md").read_text(encoding="utf-8")


def test_a_second_run_of_the_finished_flow_changes_nothing(goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND)
    for text in ("approved", "merged", "passed"):
        answer(goal_folder, text)
        code = run(goal_folder, monkeypatch)
    assert code == 0
    before = (goal_folder / "journal.yaml").read_text(encoding="utf-8")
    assert run(goal_folder, monkeypatch) == 0
    assert (goal_folder / "journal.yaml").read_text(encoding="utf-8") == before
    assert len(fake_codex.calls()) == 4


def test_a_later_task_sees_what_the_earlier_tasks_of_the_round_finished(goal_folder, fake_codex, monkeypatch):
    (goal_folder / "ui-kit").mkdir()
    plan = {"summary": PLAN["summary"],
            "tasks": [PLAN["tasks"][0],
                      {"id": "ui-kit", "repo": "ui-kit", "title": "Upgrade ui-kit to Angular 16",
                       "objective": "ui-kit is on Angular 15.2 and app depends on it.", "build_type": "none"}]}
    second = {"done": True, "commit": "d" * 40, "summary": "ui-kit is on 16.", "blockers": []}
    fake_codex.script([{"output": plan}, {"output": DONE}, {"output": second}] + ONE_ROUND[1:])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    first_prompt, later_prompt = fake_codex.calls()[1]["prompt"], fake_codex.calls()[2]["prompt"]
    assert "Tasks already finished in this round" in first_prompt and "[]" in first_prompt
    assert "a" * 40 in later_prompt and "Upgrade app to Angular 16" in later_prompt
    steps = journal_of(goal_folder)["steps"]
    assert "v16/r1/implement/ui-kit/1" in steps and steps["v16/r1/human-review"]["status"] == "open"


def test_two_majors_run_in_order_when_the_direction_check_says_next(goal_folder, fake_codex, monkeypatch):
    flow = (goal_folder / "flow.py").read_text(encoding="utf-8")
    assert "MAJORS = [16] " in flow
    (goal_folder / "flow.py").write_text(flow.replace("MAJORS = [16] ", "MAJORS = [16, 17]"), encoding="utf-8")
    plan_17 = {"summary": "app goes from Angular 16 to 17.",
               "tasks": [dict(PLAN["tasks"][0], title="Upgrade app to Angular 17")]}
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND + [{"output": plan_17}] + ONE_ROUND)
    for text in ("approved", "merged", "passed"):
        answer(goal_folder, text)
        assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert (steps["v16/direction"]["kind"], steps["v16/direction"]["status"]) == ("decision", "open")
    assert "Continue to Angular 17" in steps["v16/direction"]["question"]
    answer(goal_folder, "next")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert list(steps)[-2:] == ["v17/plan", "v17/approve-plan"]
    plan_prompt = fake_codex.calls()[4]["prompt"]
    assert "ai/angular-16-to-17" in plan_prompt and "Plan the upgrade to Angular 17." in plan_prompt
    assert "ai/angular-15-to-16" not in plan_prompt
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    for text in ("approved", "merged", "passed"):
        answer(goal_folder, text)
        code = run(goal_folder, monkeypatch)
    assert code == 0
    steps = journal_of(goal_folder)["steps"]
    assert "v17/r1/qa" in steps and "v17/direction" not in steps
    assert len(fake_codex.calls()) == 8


def test_the_direction_check_can_stop_after_the_first_major(goal_folder, fake_codex, monkeypatch):
    flow = (goal_folder / "flow.py").read_text(encoding="utf-8")
    (goal_folder / "flow.py").write_text(flow.replace("MAJORS = [16] ", "MAJORS = [16, 17]"), encoding="utf-8")
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND)
    for text in ("approved", "merged", "passed"):
        answer(goal_folder, text)
        assert run(goal_folder, monkeypatch) == 2
    answer(goal_folder, "stop")
    assert run(goal_folder, monkeypatch) == 0
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/direction"]["answer"] == "stop" and "v17/plan" not in steps
    assert len(fake_codex.calls()) == 4
```

Notes for the implementer: the fake `codex` answers in script order regardless of which prompt is being rendered, and repeats its last step for extra calls, so every script lists exactly the Codex calls the flow will make: plan, implement iterations, review, test plan, then the next round's. `FIXED`, `BUILD`, `RED` and `GREEN` are unused until Task 4 and harmless here. `run_to_human_review` is the common prefix of most tests: plan, approve, and the first round up to `v16/r1/human-review`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q`
Expected: `9 failed, 107 passed`. All nine failures are in `test_flow.py`, because the old flow keys its steps `plan`, `implement/app/1`, `review`, `merge`: `At index 0 diff: 'plan' != 'v16/plan'`, `KeyError: 'v16/r1/implement/app/1'`, `assert 0 == 2` (the old flow reaches its `merge` gate and ends where the new one opens `v16/r1/qa`), and `assert 'MAJORS = [16] ' in '"""Upgrade every Angular application in this folder, one repository at a time. ...'` in the two-majors tests.

- [ ] **Step 3: Rewrite the plan prompt**

Replace `examples/angular-upgrade/prompts/plan.md` with:

```markdown
---
output:
  summary: str
  tasks:
    - id: str
      repo: str
      title: str
      objective: str
      build_type: str
---
Plan the upgrade to Angular {{target}}. This step is read-only: do not edit, create or delete
any file, and do not create the branch yet.

Every product repository is a sub-folder of the folder you were started in that is a Git
repository. Ignore any sub-folder that is not a Git repository (no `.git` inside), which rules
out `prompts`, `journals`, `tests`, `__pycache__` and any folder whose name starts with a dot.
For each repository, read `package.json`, `angular.json` and enough of the source to see what
the goal needs there to reach Angular {{target}}.

Produce one task per repository, ordered so that a repository other repositories depend on
comes first. For each task:

- `id`: the repository's sub-folder name, exactly as it is on disk, which must be safe in a file
  path (for example `ui-kit`). Only if one repository needs more than one task, add a short
  lowercase suffix after a dash (`ui-kit-styles`) so that every `id` in this plan is unique.
- `repo`: the sub-folder name of that repository, exactly as it is on disk.
- `title`: one line naming what the task changes; name the target major in it.
- `objective`: two to five sentences: where the repository stands now, what to change to reach
  Angular {{target}}, and which checks from the goal decide that the task is done.
- `build_type`: the TeamCity build type id that builds this repository if the repository names
  one (for example in `.teamcity` or its README), otherwise the string `none`.

`summary` is two or three sentences a human can approve without reading the tasks.
```

- [ ] **Step 4: Rewrite the implement prompt with the `{{findings}}` block**

Replace `examples/angular-upgrade/prompts/implement.md` with:

```markdown
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
```

`{{findings}}` and `{{previous}}` are used whole. In round 1 `findings` is `""` and renders as an empty line, which is what the rendering test asserts with its four consecutive newlines.

- [ ] **Step 5: Rewrite the review prompt as a plain `codex()` prompt**

Replace `examples/angular-upgrade/prompts/review.md` with:

```markdown
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

Set `passed` to false if any answer is wrong, and give one line per problem in `reasons`, each
naming the repository and the file: those lines are handed to the next round's implementer as
its findings, so make each one actionable. Set `passed` to true with an empty `reasons` when the
work is sound. `summary` is two or three sentences for the human who reviews next.
```

The prompt now declares `passed` and `reasons` itself, so the flow calls `codex()` and gets the reasons back (spec §14, feeding the reason back). `ai_gate` is no longer imported by the flow.

- [ ] **Step 6: Write the test plan prompt**

Create `examples/angular-upgrade/prompts/testplan.md`:

```markdown
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
```

- [ ] **Step 7: Make the sample goal major-agnostic**

Replace `examples/angular-upgrade/JANUS.md` with:

```markdown
# Goal
Upgrade every Angular application in this folder one major at a time. Each step names its target
major and its branch; `flow.py` walks the majors in `MAJORS`, one full pass per major.

Each application is a Git clone in a sub-folder of this folder. The package manager is pnpm.
Google Chrome is installed at `/usr/bin/google-chrome`, so the unit tests run headless.

A task is done when, in its own repository folder, with `<target>` the major the step names:

- `pnpm install` succeeds;
- `pnpm ng update @angular/core@<target> @angular/cli@<target>` has been run and every migration
  it offers has been applied;
- `package.json` asks for Angular `<target>` and no `@angular/*` dependency is left at the
  previous major;
- `pnpm build` succeeds;
- `pnpm test --watch=false --browsers=ChromeHeadless` succeeds with no test skipped or removed;
- the work is committed on the branch the step names.

Do not upgrade past the target major, do not change unrelated dependencies and do not reformat
files the upgrade does not touch.
```

- [ ] **Step 8: Rewrite the flow**

Replace `examples/angular-upgrade/flow.py` with:

```python
"""Upgrade every Angular application in this folder, one major at a time.

Three nested loops (spec sections 10 and 14): `for target in MAJORS` outside, `while True` rounds
inside a major, and the task and CI loops inside a round. Codex plans and upgrades, CI verifies the
exact commit, a fresh Codex reviews, a human reviews, a human merges, Codex proposes a test plan and
QA validates; every "no" along the way ends the round and the next round starts with the findings.
Every key carries every enclosing loop's counter or id, so a rerun replays the finished rounds and
executes only what is new, and the counters come from this file's own control flow, never from
the journal.
"""
from janus import codex, context, decision, human_gate, log, ralph

MAJORS = [16]           # the majors to reach, in order; [16, 17, 18] walks three upgrades in one goal
MAX_IMPLEMENT = 5       # ralph iterations of one implement task


def task_line(record):
    return "%s [%s] %s -- %s" % (record["id"], record["repo"], record["commit"] or "no commit", record["title"])


def run_task(k, task, finished, findings):
    """Implement one task in a ralph. Returns the record for `finished`."""
    key = "%s/implement/%s" % (k, task["id"])
    result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                   key=key, cwd=task["repo"], task=task, done_so_far=finished, findings=findings)
    log("task %s done: %s" % (task["id"], result["summary"]))
    return {"id": task["id"], "repo": task["repo"], "title": task["title"], "commit": result["commit"]}


def run_round(k, rnd, plan, findings):
    """One round of one major: every task, the AI review, the human review, the merge, the test plan
    and QA. Returns None when QA passed, otherwise the findings the next round starts with."""
    finished = []
    for task in plan["tasks"]:
        record = run_task(k, task, finished, findings)
        if record is not None:
            finished.append(record)
    review = codex("prompts/review.md", key="%s/review" % k, tasks=finished)
    if not review["passed"]:
        return "AI review of round %d:\n%s" % (rnd, "\n".join(review["reasons"]))
    answer = human_gate(
        "Review the pull requests of round %d. Answer 'approved', or write your findings: anything"
        " else you write is what Codex works on in the next round." % rnd,
        key="%s/human-review" % k,
        show={"review": review["summary"], "tasks": [task_line(t) for t in finished]})
    if answer.strip().lower() != "approved":
        return "Human review of round %d:\n%s" % (rnd, answer)
    human_gate("Merge the pull requests of round %d to the release branch, then answer 'merged'." % rnd,
               key="%s/merge" % k, show=[task_line(t) for t in finished])
    testplan = codex("prompts/testplan.md", key="%s/testplan" % k, tasks=finished)
    answer = human_gate(
        "QA: run this test plan on the release branch. Answer 'passed', or write your findings:"
        " anything else you write is what Codex works on in the next round.",
        key="%s/qa" % k, show={"summary": testplan["summary"], "steps": testplan["steps"]})
    if answer.strip().lower() != "passed":
        return "QA of round %d:\n%s" % (rnd, answer)
    return None


for i, target in enumerate(MAJORS):
    prefix = "v%d" % target
    context(branch="ai/angular-%d-to-%d" % (target - 1, target), target=target)
    plan = codex("prompts/plan.md", key="%s/plan" % prefix)
    human_gate(
        "Approve this plan for Angular %d? Answer 'yes' to run it. To change it, edit the goal or the"
        " prompts, run `python janus.py reset` and start again." % target,
        key="%s/approve-plan" % prefix,
        show={"summary": plan["summary"],
              "tasks": ["%s [%s] %s" % (t["id"], t["repo"], t["title"]) for t in plan["tasks"]]})

    findings = ""       # why the previous round came back: review reasons, human findings, QA findings, blockers
    rnd = 0
    while True:
        rnd += 1
        k = "%s/r%d" % (prefix, rnd)
        findings = run_round(k, rnd, plan, findings)
        if findings is None:
            log("Angular %d reached in %d round(s)" % (target, rnd))
            break
        log("round %d of Angular %d came back: %s" % (rnd, target, findings.splitlines()[0]))

    if i + 1 < len(MAJORS):
        choice = decision(
            "Direction check: Angular %d is done. Continue to Angular %d, or stop here?" % (target, MAJORS[i + 1]),
            ["next", "stop"], key="%s/direction" % prefix)
        if choice == "stop":
            log("stopped after Angular %d, as the human decided" % target)
            break
```

Notes for the implementer: `run_round` returns a string to send the round back and `None` to end the major; the `while` loop only reads that value, so it never inspects the journal. `record is not None` in `run_round` is there for Task 3, where `run_task` returns `None` when the human skips a task; in this task `run_task` always returns a record. `context()` is called once per major before the plan, so the preamble's `{{branch}}` and the prompts' `{{target}}` follow the major. `findings.splitlines()[0]` is safe because every findings string starts with a heading line. An `Exhausted` from the ralph is not caught yet: the engine ends the run with exit 1 and the last result in `## Progress` (spec §8), which Task 3 replaces with the blocker report.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `116 passed`.

- [ ] **Step 10: Check the constraints on the files written**

```bash
awk 'length > 120 {print FILENAME": "FNR": "length}' examples/angular-upgrade/flow.py \
  examples/angular-upgrade/tests/test_flow.py examples/angular-upgrade/prompts/*.md examples/angular-upgrade/JANUS.md
grep -n 'f"' examples/angular-upgrade/flow.py
grep -c "{{previous\.\|{{findings\." examples/angular-upgrade/prompts/*.md
```

Expected: no output from `awk`; no output from the `f"` grep; every prompt reports `0`.

- [ ] **Step 11: Commit**

```bash
git add examples/angular-upgrade/prompts examples/angular-upgrade/JANUS.md examples/angular-upgrade/flow.py \
  examples/angular-upgrade/tests/test_flow.py
git commit -m "feat(example): rounds that come back with findings, one pass per major, review via codex" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Bounding a round and the blocker report

Spec §14 bounding a return loop ("Count the rounds and, past the limit, open a `decision` keyed with the round (`f"r{rnd}/blocked"`) that offers `retry` or `stop`; `retry` raises the limit and lets the loop go on"), §14 the blocker report ("When a ralph gives up, `Exhausted.last` is the report. Catch it and open a `decision` with the report as `show`. `retry` ends the round and starts the next one with the blockers as `findings`; `skip` keeps what was committed and continues the round; `stop` raises `SystemExit(1)`"), §10 outline (`MAX_ROUNDS`, `allowed`, the `blocked` decision with `show=findings`, "implement: a ralph; Exhausted -> decision retry (next round, blockers become findings) | skip | stop"), §8.

**Files:**
- Modify: `examples/angular-upgrade/flow.py` (imports, constants, three new definitions, `run_task`, the `while` loop)
- Modify: `examples/angular-upgrade/tests/test_flow.py` (append five tests)

**Interfaces:**
- Consumes: from Task 2, `run_task`, `run_round`, the `while` loop, `log`; from `test_flow.py` the helpers and constants `PLAN`, `NOT_DONE`, `DONE`, `REVIEW_BAD`, `ONE_ROUND`, `run_to_human_review`.
- Produces: `MAX_ROUNDS = 3`; `class SendBack(Exception)` with `.findings`; `stop_run(reason)` (logs, raises `SystemExit(1)`); `ask_after_exhausted(key, exc, task, attempts)` (opens `<key>/exhausted` with options `retry`, `skip`, `stop`; raises `SendBack` on `retry`, exits on `stop`, returns on `skip`); `run_task` returns `None` on `skip`; the keys `v<t>/r<n>/blocked` and `v<t>/r<n>/implement/<id>/exhausted`. Task 4 calls `ask_after_exhausted` and raises `SendBack` from the CI loop.

- [ ] **Step 1: Write the failing tests**

Append to `examples/angular-upgrade/tests/test_flow.py`:

```python
def test_past_max_rounds_the_blocked_decision_opens_and_retry_continues_to_round_4(
        goal_folder, fake_codex, monkeypatch):
    sent_back = [{"output": DONE}, {"output": REVIEW_BAD}]
    run_to_human_review(goal_folder, fake_codex, monkeypatch, sent_back * 3 + ONE_ROUND)
    steps = journal_of(goal_folder)["steps"]
    gate = steps["v16/r4/blocked"]
    assert (gate["kind"], gate["status"]) == ("decision", "open")
    assert "3 rounds did not finish Angular 16" in gate["question"]
    assert list(steps)[-3:] == ["v16/r3/implement/app/1", "v16/r3/review", "v16/r4/blocked"]
    text = (goal_folder / "JANUS.md").read_text(encoding="utf-8")
    assert "    AI review of round 3:\n    app: app.component.spec.ts is marked xdescribe" in text
    answer(goal_folder, "retry")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r4/blocked"]["answer"] == "retry"
    assert list(steps)[-3:] == ["v16/r4/implement/app/1", "v16/r4/review", "v16/r4/human-review"]
    assert "AI review of round 3:" in fake_codex.calls()[7]["prompt"]
    assert "v16/r5/blocked" not in steps and "v16/r1/implement/app/2" not in steps


def test_stop_at_the_blocked_decision_ends_the_run_with_exit_1(goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, [{"output": DONE}, {"output": REVIEW_BAD}] * 3)
    answer(goal_folder, "stop")
    assert run(goal_folder, monkeypatch) == 1
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r4/blocked"]["answer"] == "stop" and "v16/r4/implement/app/1" not in steps
    assert "stopped by the human after 3 rounds" in (goal_folder / "JANUS.md").read_text(encoding="utf-8")


def test_retry_at_an_exhausted_implement_loop_starts_round_2_with_the_blockers_as_findings(
        goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, [{"output": NOT_DONE}] * 5 + ONE_ROUND)
    gate = journal_of(goal_folder)["steps"]["v16/r1/implement/app/exhausted"]
    assert (gate["kind"], gate["status"]) == ("decision", "open")
    assert "app.component.ts does not compile" in (goal_folder / "JANUS.md").read_text(encoding="utf-8")
    answer(goal_folder, "retry")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert list(steps) == ["v16/plan", "v16/approve-plan"] + ["v16/r1/implement/app/%d" % n for n in range(1, 6)] \
        + ["v16/r1/implement/app/exhausted", "v16/r2/implement/app/1", "v16/r2/review", "v16/r2/human-review"]
    assert "v16/r1/review" not in steps
    round_2 = fake_codex.calls()[6]["prompt"]
    assert "Task app gave up at v16/r1/implement/app:\napp.component.ts does not compile" in round_2


def test_skip_at_an_exhausted_implement_loop_leaves_the_task_out_of_the_round(goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, [{"output": NOT_DONE}] * 5 + ONE_ROUND[1:])
    answer(goal_folder, "skip")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/implement/app/exhausted"]["answer"] == "skip"
    assert list(steps)[-2:] == ["v16/r1/review", "v16/r1/human-review"]
    assert "named by its `repo`:\n\n[]\n" in fake_codex.calls()[6]["prompt"]  # the review sees an empty round


def test_stop_at_an_exhausted_implement_loop_ends_the_run_with_exit_1(goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, [{"output": NOT_DONE}] * 5)
    answer(goal_folder, "stop")
    assert run(goal_folder, monkeypatch) == 1
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/implement/app/exhausted"]["answer"] == "stop" and "v16/r1/review" not in steps
```

The first test is the whole of spec §14 "bounding a return loop": three rounds sent back by the AI review (no gate opens between them, so one `run` goes through `r1`, `r2`, `r3` and stops at `v16/r4/blocked`), `show=findings` written as indented lines, `retry` continuing with `r4` and never reusing `r1`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q`
Expected: `5 failed, 116 passed`, with `AssertionError: assert 1 == 2` four times and `KeyError: 'v16/r4/blocked'` once. The three exhausted tests exit 1 because nothing catches `Exhausted` yet (`janus.Exhausted: ralph exhausted` in the traceback). Without the bound, the `retry` test runs a fourth round and stops at `v16/r4/human-review` with exit 2, so `run_to_human_review` passes and `steps["v16/r4/blocked"]` raises the `KeyError`; the `stop` test's script ends with `REVIEW_BAD`, which the fake repeats as round 4's implement answer, and the schema rejects it, so that run exits 1.

- [ ] **Step 3: Add the bound and the blocker report to the flow**

In `examples/angular-upgrade/flow.py`, change the import line:

```python
from janus import codex, context, decision, human_gate, log, ralph
```

to:

```python
from janus import Exhausted, codex, context, decision, human_gate, log, ralph
```

Change the constants block:

```python
MAJORS = [16]           # the majors to reach, in order; [16, 17, 18] walks three upgrades in one goal
MAX_IMPLEMENT = 5       # ralph iterations of one implement task
```

to:

```python
MAJORS = [16]           # the majors to reach, in order; [16, 17, 18] walks three upgrades in one goal
MAX_ROUNDS = 3          # rounds per major before the flow asks whether to keep going
MAX_IMPLEMENT = 5       # ralph iterations of one implement task
```

Insert, between the constants and `def task_line(record):`, these two definitions (two blank lines around each):

```python
class SendBack(Exception):
    """Ends the round from inside the task loop; `.findings` is what the next round's Codex reads."""

    def __init__(self, findings):
        Exception.__init__(self, findings)
        self.findings = findings


def stop_run(reason):
    log(reason)
    raise SystemExit(1)
```

Insert, between `task_line` and `run_task`:

```python
def ask_after_exhausted(key, exc, task, attempts):
    """The blocker report of a ralph that gave up (spec section 14), keyed `<key>/exhausted`.
    `retry` ends the round with the blockers as the next round's findings, `stop` ends the run with
    exit 1, and `skip` returns so that the caller keeps what was committed and goes on."""
    report = "\n".join(exc.last["blockers"]) or exc.last["summary"]
    choice = decision(
        "Task %s gave up at '%s' after %d attempts. Retry it in the next round (the blockers become"
        " the findings), skip what is left of it, or stop the run?" % (task["id"], key, attempts),
        ["retry", "skip", "stop"], key="%s/exhausted" % key,
        show={"summary": exc.last["summary"], "blockers": exc.last["blockers"]})
    if choice == "stop":
        stop_run("task %s stopped the run at %s" % (task["id"], key))
    if choice == "retry":
        raise SendBack("Task %s gave up at %s:\n%s" % (task["id"], key, report))
    log("task %s: %s skipped by the human" % (task["id"], key))
```

Replace the whole `run_task` function:

```python
def run_task(k, task, finished, findings):
    """Implement one task in a ralph. Returns the record for `finished`."""
    key = "%s/implement/%s" % (k, task["id"])
    result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                   key=key, cwd=task["repo"], task=task, done_so_far=finished, findings=findings)
    log("task %s done: %s" % (task["id"], result["summary"]))
    return {"id": task["id"], "repo": task["repo"], "title": task["title"], "commit": result["commit"]}
```

with:

```python
def run_task(k, task, finished, findings):
    """Implement one task in a ralph. Returns the record for `finished`, or None when the human
    skipped the task at the blocker report."""
    key = "%s/implement/%s" % (k, task["id"])
    try:
        result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                       key=key, cwd=task["repo"], task=task, done_so_far=finished, findings=findings)
    except Exhausted as exc:  # `retry` raised SendBack and `stop` exited; only `skip` returns here
        ask_after_exhausted(key, exc, task, MAX_IMPLEMENT)
        return None
    log("task %s done: %s" % (task["id"], result["summary"]))
    return {"id": task["id"], "repo": task["repo"], "title": task["title"], "commit": result["commit"]}
```

Replace the `while` loop of the major loop:

```python
    findings = ""       # why the previous round came back: review reasons, human findings, QA findings, blockers
    rnd = 0
    while True:
        rnd += 1
        k = "%s/r%d" % (prefix, rnd)
        findings = run_round(k, rnd, plan, findings)
        if findings is None:
            log("Angular %d reached in %d round(s)" % (target, rnd))
            break
        log("round %d of Angular %d came back: %s" % (rnd, target, findings.splitlines()[0]))
```

with:

```python
    findings = ""       # why the previous round came back: review reasons, human findings, QA findings, blockers
    allowed = MAX_ROUNDS
    rnd = 0
    while True:
        rnd += 1
        if rnd > allowed:  # `retry` raises the allowance and never resets the counter: r1.. are done
            choice = decision(
                "%d rounds did not finish Angular %d. Keep going for %d more, or stop the run?"
                % (rnd - 1, target, MAX_ROUNDS),
                ["retry", "stop"], key="%s/r%d/blocked" % (prefix, rnd), show=findings)
            if choice == "stop":
                stop_run("Angular %d stopped by the human after %d rounds" % (target, rnd - 1))
            allowed += MAX_ROUNDS
        k = "%s/r%d" % (prefix, rnd)
        try:
            findings = run_round(k, rnd, plan, findings)
        except SendBack as back:
            findings = back.findings
        if findings is None:
            log("Angular %d reached in %d round(s)" % (target, rnd))
            break
        log("round %d of Angular %d came back: %s" % (rnd, target, findings.splitlines()[0]))
```

Notes for the implementer: `decision` raises `SystemExit(2)` the first time it runs, which is a `BaseException` and is not caught by `except Exhausted` or `except SendBack`; the code after a decision runs only on the run that carries the answer. The `blocked` check comes before `k` is computed, so on round 4 the first key the flow meets is `v16/r4/blocked`; on `retry` the loop continues with `r4`, and `allowed` becomes 6. `SendBack` raised inside `ask_after_exhausted` propagates through `run_task` and `run_round` to the `while` loop.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `121 passed`.

- [ ] **Step 5: Check line lengths and commit**

```bash
awk 'length > 120 {print FILENAME": "FNR": "length}' examples/angular-upgrade/flow.py examples/angular-upgrade/tests/test_flow.py
git add examples/angular-upgrade/flow.py examples/angular-upgrade/tests/test_flow.py
git commit -m "feat(example): bound the rounds with a blocked decision and open a blocker report when a ralph gives up" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: no `awk` output, one commit.

---

### Task 4: The CI return loop, keyed per verdict

Spec §10 outline ("CI return loop: wait for the exact commit; a red build gets a fix and the fix commit is waited for too", `for n in range(1, MAX_CI + 1): build = step(f"{k}/ci/{task['id']}/{n}", ...)`, the `missing` decision "nothing for Codex to fix", the `red` decision "MAX_CI verdicts and still red: the blocker report"), the diagram table rows for TeamCity and "Can Codex resolve it within run limits?", §4 `step` ("Use it for every side effect that must not repeat: ... a CI poll").

**Files:**
- Modify: `examples/angular-upgrade/flow.py` (imports, constants, `verify_in_ci`, `run_task`)
- Modify: `examples/angular-upgrade/tests/test_flow.py` (append seven tests)

**Interfaces:**
- Consumes: `teamcity.configured()` and `teamcity.wait_for_build(build_type, sha, timeout=7200, poll=30) -> {status, url, excerpt}` (unchanged from slice 2); `ask_after_exhausted`, `SendBack`, `stop_run` from Task 3; the `teamcity_server` fixture (`.serve(bodies)`, `.requests()`); `prompts/fix.md` unchanged (`{{task.*}}`, `{{build.status}}`, `{{build.url}}`, `{{build.excerpt}}`, `{{previous}}`).
- Produces: `MAX_CI = 3`, `MAX_FIX = 3`, `CI_TIMEOUT = 7200`; `verify_in_ci(k, task, result) -> dict` returning the result CI last judged; the keys `v<t>/r<n>/ci/<id>/<v>` (kind `step`), `v<t>/r<n>/ci/<id>/<v>/missing`, `v<t>/r<n>/fix/<id>/<v>/<i>`, `v<t>/r<n>/fix/<id>/<v>/exhausted`, `v<t>/r<n>/ci/<id>/red`.

- [ ] **Step 1: Write the failing tests**

Append to `examples/angular-upgrade/tests/test_flow.py`:

```python
def test_a_green_build_is_journaled_under_the_first_verdict_and_no_fix_runs(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    teamcity_server.serve(GREEN)
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND)
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/ci/app/1"]["result"] == {"status": "SUCCESS", "url": "http://tc/viewLog.html?buildId=42",
                                                  "excerpt": ""}
    assert "v16/r1/ci/app/2" not in steps and "v16/r1/fix/app/1/1" not in steps
    assert "revision%3A%28version%3A" + "a" * 40 in teamcity_server.requests()[0]["path"]


def test_a_build_type_of_none_skips_the_teamcity_wait(goal_folder, fake_codex, teamcity_server, monkeypatch):
    plan = {"summary": PLAN["summary"], "tasks": [dict(PLAN["tasks"][0], build_type="none")]}
    fake_codex.script([{"output": plan}] + ONE_ROUND)
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    assert "v16/r1/ci/app/1" not in journal_of(goal_folder)["steps"]
    assert teamcity_server.requests() == []


def test_a_red_build_gets_a_fix_whose_commit_is_verified_by_the_second_verdict(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    teamcity_server.serve(RED + GREEN)
    run_to_human_review(goal_folder, fake_codex, monkeypatch, [{"output": DONE}, {"output": FIXED}] + ONE_ROUND[1:])
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/ci/app/1"]["result"]["status"] == "FAILURE"
    assert steps["v16/r1/fix/app/1/1"]["result"]["commit"] == "b" * 40
    assert steps["v16/r1/ci/app/2"]["result"]["status"] == "SUCCESS"
    assert "v16/r1/ci/app/3" not in steps
    fix_prompt = fake_codex.calls()[2]["prompt"]
    assert "AppComponent should render title" in fix_prompt and "http://tc/viewLog.html?buildId=42" in fix_prompt
    paths = [r["path"] for r in teamcity_server.requests()]
    assert "revision%3A%28version%3A" + "a" * 40 in paths[0]
    assert "revision%3A%28version%3A" + "b" * 40 in paths[2]  # the fix commit, not the implement commit
    assert "b" * 40 in (goal_folder / "JANUS.md").read_text(encoding="utf-8")


def test_max_ci_red_verdicts_open_the_red_decision_and_skip_keeps_the_commits(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    teamcity_server.serve(RED * 3)
    run_to_human_review(goal_folder, fake_codex, monkeypatch,
                        [{"output": DONE}, {"output": FIXED}, {"output": FIXED}] + ONE_ROUND[1:])
    steps = journal_of(goal_folder)["steps"]
    assert (steps["v16/r1/ci/app/red"]["kind"], steps["v16/r1/ci/app/red"]["status"]) == ("decision", "open")
    assert [k for k in steps if "/ci/" in k or "/fix/" in k] == \
        ["v16/r1/ci/app/1", "v16/r1/fix/app/1/1", "v16/r1/ci/app/2", "v16/r1/fix/app/2/1", "v16/r1/ci/app/3",
         "v16/r1/ci/app/red"]
    answer(goal_folder, "skip")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/ci/app/red"]["answer"] == "skip"
    assert list(steps)[-2:] == ["v16/r1/review", "v16/r1/human-review"]


def test_retry_at_the_red_decision_starts_round_2_with_the_failure_as_findings(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    teamcity_server.serve(RED * 3 + GREEN)
    run_to_human_review(goal_folder, fake_codex, monkeypatch,
                        [{"output": DONE}, {"output": FIXED}, {"output": FIXED}, {"output": DONE_2}] + ONE_ROUND[1:])
    answer(goal_folder, "retry")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert list(steps)[-4:] == ["v16/r2/implement/app/1", "v16/r2/ci/app/1", "v16/r2/review", "v16/r2/human-review"]
    assert "Task app is still red after 3 CI verdicts (http://tc/viewLog.html?buildId=42):\n" \
           "AppComponent should render title" in fake_codex.calls()[4]["prompt"]


def test_an_exhausted_fix_loop_opens_its_decision_and_skip_keeps_the_implement_commit(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    teamcity_server.serve(RED)
    run_to_human_review(goal_folder, fake_codex, monkeypatch,
                        [{"output": DONE}] + [{"output": NOT_DONE}] * 3 + ONE_ROUND[1:])
    gate = journal_of(goal_folder)["steps"]["v16/r1/fix/app/1/exhausted"]
    assert (gate["kind"], gate["status"]) == ("decision", "open")
    answer(goal_folder, "skip")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/fix/app/1/exhausted"]["answer"] == "skip"
    assert "v16/r1/ci/app/2" not in steps and steps["v16/r1/human-review"]["status"] == "open"
    assert "a" * 40 in (goal_folder / "JANUS.md").read_text(encoding="utf-8")


def test_a_build_teamcity_cannot_find_opens_the_missing_decision_instead_of_a_fix(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    teamcity_server.serve([{"count": 0}])
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND)
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/ci/app/1"]["result"]["status"] == "NOT_FOUND"
    assert (steps["v16/r1/ci/app/1/missing"]["kind"], steps["v16/r1/ci/app/1/missing"]["status"]) == \
        ("decision", "open")
    assert "v16/r1/fix/app/1/1" not in steps
    answer(goal_folder, "skip")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/ci/app/1/missing"]["answer"] == "skip" and "v16/r1/ci/app/2" not in steps
    assert steps["v16/r1/human-review"]["status"] == "open"
```

How the stub is fed: `teamcity_server.serve(bodies)` queues JSON answers in request order and answers 404 past the queue. One verdict costs one request when green (`GREEN`, the build lookup) and two when red (`RED`: the lookup, then the failed-test names). `RED + GREEN` therefore scripts verdict 1 red and verdict 2 green; `RED * 3` scripts three red verdicts.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q`
Expected: `6 failed, 122 passed`. `test_a_build_type_of_none_skips_the_teamcity_wait` already passes (there is no CI code to skip). Of the six: `KeyError: 'v16/r1/ci/app/1'` twice (the green and the not-found tests), and `assert 1 == 2` four times, because the flow feeds the scripted `FIXED` or `NOT_DONE` answers to the review step, whose schema rejects them (`codex final message does not match the output schema ($: expected exactly the keys ['passed', 'reasons', 'summary'], got ['blockers', 'commit', 'done', 'summary'])`) and the run exits 1.

- [ ] **Step 3: Add the CI return loop to the flow**

In `examples/angular-upgrade/flow.py`, change the import line:

```python
from janus import Exhausted, codex, context, decision, human_gate, log, ralph
```

to:

```python
from janus import Exhausted, codex, context, decision, human_gate, log, ralph, step

import teamcity
```

Change the constants block:

```python
MAJORS = [16]           # the majors to reach, in order; [16, 17, 18] walks three upgrades in one goal
MAX_ROUNDS = 3          # rounds per major before the flow asks whether to keep going
MAX_IMPLEMENT = 5       # ralph iterations of one implement task
```

to:

```python
MAJORS = [16]           # the majors to reach, in order; [16, 17, 18] walks three upgrades in one goal
MAX_ROUNDS = 3          # rounds per major before the flow asks whether to keep going
MAX_IMPLEMENT = 5       # ralph iterations of one implement task
MAX_CI = 3              # CI verdicts one task may wait for in one round: implement, then each fix
MAX_FIX = 3             # ralph iterations of one fix
CI_TIMEOUT = 7200       # seconds one CI wait may take before it gives up on that build
```

Insert, between `ask_after_exhausted` and `run_task`:

```python
def verify_in_ci(k, task, result):
    """The CI return loop: wait for the build of the exact commit; a red build gets a fix, and the fix
    commit is waited for in turn, up to MAX_CI verdicts. Returns the result CI last judged."""
    build = None
    for n in range(1, MAX_CI + 1):
        ci_key = "%s/ci/%s/%d" % (k, task["id"], n)
        build = step(ci_key, lambda: teamcity.wait_for_build(task["build_type"], result["commit"],
                                                             timeout=CI_TIMEOUT))
        log("task %s build %d of %d %s: %s" % (task["id"], n, MAX_CI, build["status"], build["url"]))
        if build["status"] == "SUCCESS":
            return result
        if build["status"] in ("NOT_FOUND", "TIMEOUT"):
            choice = decision(  # nothing here is fixable by Codex: the build never gave a verdict
                "TeamCity gave no verdict for task %s (%s). Continue without a CI check, or stop"
                " the run?" % (task["id"], build["status"]),
                ["skip", "stop"], key="%s/missing" % ci_key,
                show={"commit": result["commit"], "status": build["status"], "url": build["url"]})
            if choice == "stop":
                stop_run("task %s stopped the run: no CI verdict" % task["id"])
            log("task %s continues without a CI verdict" % task["id"])
            return result
        if n == MAX_CI:
            break
        fix_key = "%s/fix/%s/%d" % (k, task["id"], n)
        try:
            result = ralph("prompts/fix.md", until=lambda r: r["done"], max_iter=MAX_FIX, key=fix_key,
                           cwd=task["repo"], task=task, build=build)
        except Exhausted as exc:  # `skip` keeps the implement commit, red build and all
            ask_after_exhausted(fix_key, exc, task, MAX_FIX)
            return result
    choice = decision(
        "Task %s is still red after %d CI verdicts. Retry it in the next round (the failure becomes"
        " the findings), skip it and keep the commits, or stop the run?" % (task["id"], MAX_CI),
        ["retry", "skip", "stop"], key="%s/ci/%s/red" % (k, task["id"]),
        show={"commit": result["commit"], "url": build["url"], "excerpt": build["excerpt"]})
    if choice == "stop":
        stop_run("task %s stopped the run: still red after %d CI verdicts" % (task["id"], MAX_CI))
    if choice == "retry":
        raise SendBack("Task %s is still red after %d CI verdicts (%s):\n%s"
                       % (task["id"], MAX_CI, build["url"], build["excerpt"]))
    log("task %s continues with a red build, as the human decided" % task["id"])
    return result
```

In `run_task`, change the docstring and insert the CI call before the `log(...)` line:

```python
def run_task(k, task, finished, findings):
    """Implement one task in a ralph, then verify it in CI when TeamCity is configured. Returns the
    record for `finished`, or None when the human skipped the task at the blocker report."""
    key = "%s/implement/%s" % (k, task["id"])
    try:
        result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                       key=key, cwd=task["repo"], task=task, done_so_far=finished, findings=findings)
    except Exhausted as exc:  # `retry` raised SendBack and `stop` exited; only `skip` returns here
        ask_after_exhausted(key, exc, task, MAX_IMPLEMENT)
        return None
    if teamcity.configured() and task["build_type"] != "none":
        result = verify_in_ci(k, task, result)
    log("task %s done: %s" % (task["id"], result["summary"]))
    return {"id": task["id"], "repo": task["repo"], "title": task["title"], "commit": result["commit"]}
```

Notes for the implementer: the `step` lambda closes over `result`, which the loop reassigns after a fix; `step` calls the lambda immediately inside the same iteration, so verdict `n` always waits for the commit produced just before it. `if n == MAX_CI: break` is what makes the last allowed verdict decisive instead of starting a fix that would never be verified. `teamcity.configured()` is not journaled and must not be: it is an environment read, and a flow run once with TeamCity and once without simply takes the other branch. `fix.md` is unchanged from slice 2.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `128 passed`.

- [ ] **Step 5: Check the constraints and commit**

```bash
awk 'length > 120 {print FILENAME": "FNR": "length}' examples/angular-upgrade/flow.py examples/angular-upgrade/tests/test_flow.py
grep -n 'f"' examples/angular-upgrade/flow.py
grep -cE "Git branch|pull request|TeamCity|Bitbucket|Angular" janus.py
git add examples/angular-upgrade/flow.py examples/angular-upgrade/tests/test_flow.py
git commit -m "feat(example): ci return loop keyed per verdict so a fix commit is verified too" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: no `awk` output, no `f"` match, `0` from the `janus.py` grep (spec §12.6), one commit.

---

### Task 5: The example's `README.md`

Spec §10 (the reshaped example is what a new goal folder is copied from; "The trial report goes into the example's `README.md`"), §14 (the README's *Loops* section points at it and explains how a round comes back), the diagram table (the TeamCity row: "keyed per verdict so a fix commit is verified too").

**Files:**
- Rewrite: `examples/angular-upgrade/README.md` (everything above the slice 2 trial report; the report itself is kept as history with a new heading and preface; a slot for the slice 3 report is added at the end)

**Interfaces:**
- Consumes: every file of Tasks 2 to 4 by name and every key they produce.
- Produces: the `## Trial 2 (slice 3)` section that Task 6 replaces with the report.

- [ ] **Step 1: Replace everything above the slice 2 trial report**

The current README ends with the section `## Trial: Angular 15 to 16 with real Codex, 2026-09-23` (from that heading to the end of the file, ending with the paragraph `**Verdict on spec 12.7.** Met. ...`). Keep that section's body. Replace everything **before** that heading with:

````markdown
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

````

The old paragraph beginning `**A fix commit is not verified by CI.**` is part of what is replaced and must not survive: the fix commit is now verified under the next verdict key.

- [ ] **Step 2: Turn the slice 2 trial into history and add the slot for the slice 3 report**

In the kept section, replace its heading and first paragraph:

```markdown
## Trial: Angular 15 to 16 with real Codex, 2026-09-23

Run on one throwaway application, without TeamCity, to satisfy spec criterion 12.7.
```

with:

```markdown
## Trial 1 (slice 2): Angular 15 to 16 with real Codex, 2026-09-23

Run on one throwaway application, without TeamCity, to satisfy spec criterion 12.7. **This report is
history**: it ran the slice 2 flow, whose keys (`plan`, `implement/<id>/<n>`, `review`, `merge`)
predate the loops above; the flow of this folder journals `v16/plan`, `v16/r1/implement/<id>/<n>`
and so on. It is kept because its findings about Codex still hold.
```

Leave the rest of that section byte for byte. Then append at the end of the file:

```markdown

## Trial 2 (slice 3): a round sent back by the human review, with real Codex

Filled in by the slice 3 trial (plan `docs/superpowers/plans/2026-09-23-janus4-slice3-loops.md`,
Task 6): round 1 of Angular 16 is answered with a finding at `v16/r1/human-review`, round 2 runs
with real Codex under `v16/r2/...`, and the finished flow is run once more to show that the
journal does not change.
```

- [ ] **Step 3: Check the README against the files and keys it describes**

```bash
ls examples/angular-upgrade examples/angular-upgrade/prompts
grep -n "^## " examples/angular-upgrade/README.md
grep -c "A fix commit is not verified" examples/angular-upgrade/README.md
grep -oE 'key="[^"]+"' examples/angular-upgrade/flow.py | sort -u
awk 'length > 120 {print FILENAME": "FNR": "length}' examples/angular-upgrade/README.md
uv run pytest -q
```

Expected: `prompts/` lists `_preamble.md`, `fix.md`, `implement.md`, `plan.md`, `review.md`, `testplan.md`; the headings are `The files`, `Starting a goal folder from it`, `The steps it journals`, `Loops`, `TeamCity (optional)`, `Running the example's tests`, `Trial 1 (slice 2): ...`, `Trial 2 (slice 3): ...`; the count is `0`; the key builders are `%s/approve-plan`, `%s/ci/%s/red`, `%s/direction`, `%s/exhausted`, `%s/human-review`, `%s/merge`, `%s/missing`, `%s/plan`, `%s/qa`, `%s/r%d/blocked`, `%s/review`, `%s/testplan` (the ralph and step keys are built into `key` and `ci_key` variables), every one of which has a row in the table; no `awk` output; `128 passed`.

- [ ] **Step 4: Commit**

```bash
git add examples/angular-upgrade/README.md
git commit -m "docs(example): describe the loops, the round keys and the ci return loop; keep the slice 2 trial as history" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The trial: a round sent back by the human review, with real Codex

Spec §10 ("The slice 3 trial answers the human review of round 1 with a finding, so that round 2 runs with real Codex and the return loop is exercised end to end"), §12.9 ("A round of the Angular example is sent back by a human review answer, round 2 runs with real Codex under `r2/` keys, the second run of the finished flow executes nothing, and every earlier round stays in the journal untouched"), §11 slice 3.

**This task is manual and is the acceptance test of the slice.** It runs what Tasks 2 to 5 built and writes down what happened.

**Files:**
- Create (outside the repository): `/home/race-day/janus-trial/slice3-angular-16/`, `/home/race-day/janus-trial/origin/ng15-app-slice3.git`, `/home/race-day/janus-trial/origin/slice3-angular-16.git`
- Modify: `examples/angular-upgrade/README.md` (replace the `## Trial 2 (slice 3)` slot with the report)
- Never modify: `/home/race-day/janus-trial/origin/ng15-app.git` (read with `git clone --bare` only), `/home/race-day/janus-trial/angular-16-upgrade/` (the slice 2 evidence), `janus.py`

**Interfaces:**
- Consumes: the whole example folder from the worktree after Task 5, and `janus.py` at the worktree head (identical to `main`'s).
- Produces: the trial report under `## Trial 2 (slice 3): ...` in the README, and a verdict on spec §12.9.

**Rules for the executor, all binding:**

1. **A Codex call may take a long time.** In the slice 2 trial `plan` took 76 s, one implement iteration 123 s and the review 370 s; this trial has two rounds, two reviews and a test plan, so expect 15 to 30 minutes of Codex in all. Do not kill a run because it seems stuck: Codex streams its transcript to stderr, so the run is visible in the log. Start each `run` with a generous timeout (two hours) and wait. Record the wall-clock time of each run.
2. **Never repair the app by hand.** Nothing under `app/` is edited, no command that changes it is run, no commit of Codex's is amended. If the build or the tests fail, that is a result to record.
3. **If a Codex step fails** (exit 1, `JanusError` in `journal.yaml`), record the error text and run again once; the engine re-executes it with `attempt` incremented. A second failure with the same error stops the trial and is recorded as its result.
4. **If a gate other than the expected one opens** (the AI review sends round 1 back on its own, `v16/r1/implement/app/exhausted`, `v16/r4/blocked`), answer it honestly and record it; the round numbers in the report then follow the journal, not this plan. The requirement of §12.9 is that *a* round is sent back by the human review and the next round runs under its own keys, not that it is round 1.
5. **If the flow needs something the primitives cannot express**, stop the trial, write the gap into the report with the step key, and do **not** change `janus.py` here.
6. Answer every gate by editing `JANUS.md` after `answer:` and running again. Each answer is its own step below; do not batch them.
7. **The finding must be real.** The human-review answer of Step 6 is fixed here so that the report is comparable; it names a file (`README.md`) that Codex can change and a fact (`zone.js`) it can confirm. Do not soften it into `approved`.

- [ ] **Step 1: Build the trial goal folder with a fresh single-branch remote for the app**

```bash
W=/home/race-day/janus/.worktrees/slice3-loops
T=/home/race-day/janus-trial
git clone -q --bare --single-branch --branch master $T/origin/ng15-app.git $T/origin/ng15-app-slice3.git
git -C $T/origin/ng15-app-slice3.git branch -a
cp -r $W/examples/angular-upgrade $T/slice3-angular-16
cd $T/slice3-angular-16
rm -rf tests README.md __pycache__
cp $W/janus.py .
git clone -q $T/origin/ng15-app-slice3.git app
git init -q --bare $T/origin/slice3-angular-16.git
git init -q -b main .
git add -A
git commit -q -m "chore(trial): slice 3 goal folder from the example"
git remote add origin $T/origin/slice3-angular-16.git
git push -q -u origin main
git status --porcelain
git -C app log --oneline
git -C app branch -a
ls
grep -n "^MAJORS" flow.py
git -C $T/origin/ng15-app.git branch -v
```

Expected: `branch -a` of the new bare prints `* master` only; `git status --porcelain` prints nothing (`.gitignore` keeps `app/` out); `app` has the one commit `f8dc4e4 initial commit` on `master` with `remotes/origin/master` as its only remote branch; `ls` shows `JANUS.md`, `app`, `flow.py`, `janus.py`, `prompts`, `teamcity.py`; `MAJORS = [16]`; the slice 2 remote still shows `ai/angular-15-to-16 4c0703e` and `master f8dc4e4`, untouched.

- [ ] **Step 2: Write the trial goal and confirm the environment**

Replace the `# Goal` section of `/home/race-day/janus-trial/slice3-angular-16/JANUS.md` with:

```markdown
# Goal
Upgrade the Angular application in the sub-folder `app` one major at a time; each step names its
target major and its branch. This goal walks one major, from Angular 15 to the target.

`app` is a Git clone with the remote `origin` (a local bare repository whose only branch is
`master`). The package manager is pnpm 10. Google Chrome is at `/usr/bin/google-chrome`, so the
unit tests run headless. Node is v24.5.0 and the npm registry is reachable.

The task is done when, in `app`, with `<target>` the major the step names:

- `pnpm install` succeeds;
- `pnpm ng update @angular/core@<target> @angular/cli@<target>` has been run and every migration
  it offers has been applied;
- `package.json` asks for Angular `<target>` and no `@angular/*` dependency is left at the
  previous major;
- `pnpm build` succeeds;
- `pnpm test --watch=false --browsers=ChromeHeadless` succeeds, with all three existing specs
  passing and none skipped or removed (pass the flags exactly like that: `pnpm test -- --flag`
  is rejected by the Angular CLI);
- the work is committed on the branch the step names and that branch is pushed to `origin`.

Do not upgrade past the target major, do not change unrelated dependencies, do not touch
`typescript`, and do not reformat files the upgrade does not touch. There is no TeamCity for
this trial.
```

Then:

```bash
cd /home/race-day/janus-trial/slice3-angular-16
env | grep -c JANUS_TEAMCITY || true
python3 -c "import yaml; print('pyyaml', yaml.__version__)"
codex --version
python3 janus.py status
git add JANUS.md && git commit -q -m "chore(trial): the trial goal" && git push -q
```

Expected: `0`; `pyyaml 6.0.1`; `codex-cli 0.155.1` (record whatever it prints); `no journal; nothing has run yet` and `next: python janus.py run`.

- [ ] **Step 3: Run 1: to the approval gate (real Codex, `v16/plan`)**

```bash
cd /home/race-day/janus-trial/slice3-angular-16
time python3 janus.py run > ../slice3-run1.log 2>&1; echo "exit=$?"
tail -40 ../slice3-run1.log
python3 janus.py status
sed -n '/## Gate: v16\/approve-plan/,$p' JANUS.md
```

Expected: exit 2; `JANUS.md` holds `## Gate: v16/approve-plan` with the question naming Angular 16, the trimmed plan (`summary:` and one `- app [app] ...` line) indented by four spaces, and an empty `answer:`; `journal.yaml` has `v16/plan` done and `v16/approve-plan` open; the goal folder has one commit per status change, pushed. Record the wall-clock time, the plan's `summary`, the task record (`id`, `repo`, `title`, `objective`, `build_type`) and whether `id` is `app` as `plan.md` now requires.

- [ ] **Step 4: Run 2: approve, then round 1 to the human review (real Codex, implement and review)**

```bash
cd /home/race-day/janus-trial/slice3-angular-16
sed -i 's/^answer:$/answer: yes/' JANUS.md
grep -n "^answer:" JANUS.md
time python3 janus.py run > ../slice3-run2.log 2>&1; echo "exit=$?"
tail -60 ../slice3-run2.log
python3 janus.py status
sed -n '/## Gate: v16\/r1\/human-review/,$p' JANUS.md
cp journal.yaml ../slice3-journal-after-run2.yaml
```

Expected: exit 2 at `v16/r1/human-review`, with `v16/r1/implement/app/1` (and possibly `/2`...) and `v16/r1/review` done; the gate shows `review:` (the reviewer's summary) and `tasks:` with one line `app [app] <sha> -- <title>`. If the review's `passed` is false, the flow goes on into round 2 by itself and stops at `v16/r2/human-review` instead: record the `reasons`, and from here on read `r2` for `r1` and `r3` for `r2` (rule 4). Record: the wall-clock time, each implement iteration's `done`, `commit`, `summary` and `blockers`, the review's `passed`, `reasons` and `summary`.

- [ ] **Step 5: Look at the app without touching it**

```bash
cd /home/race-day/janus-trial/slice3-angular-16/app
git log --oneline --graph --all
git status --porcelain
git branch -a
git diff master..ai/angular-15-to-16 --stat
grep -E '"(@angular/core|@angular/cli|zone.js|typescript)"' package.json
sed -n 1,4p README.md
git -C /home/race-day/janus-trial/origin/ng15-app-slice3.git branch -v
```

Expected: a branch `ai/angular-15-to-16` with one or more commits by Codex; `@angular/*` at `^16.*`, `zone.js` at `~0.13.x`; `README.md` still says `version 15.2.11` on line 3 (which the finding is about); the bare lists the branch if Codex pushed it. Record all of it as it comes out.

- [ ] **Step 6: Run 3: answer the human review with a finding, then round 2 (real Codex)**

```bash
cd /home/race-day/janus-trial/slice3-angular-16
sed -i 's/^answer:$/answer: README.md still says the project was generated with Angular CLI version 15.2.11. Change that line to Angular CLI 16 and add one line under the title saying the app was upgraded from Angular 15 to 16 on this branch. Also confirm in your summary which zone.js version package.json asks for now./' JANUS.md
grep -n "^answer:" JANUS.md
time python3 janus.py run > ../slice3-run3.log 2>&1; echo "exit=$?"
tail -60 ../slice3-run3.log
python3 janus.py status
sed -n '/## Decisions/,$p' JANUS.md
```

Expected: exit 2 at `v16/r2/human-review`. `journal.yaml` gains `v16/r2/implement/app/1` (and possibly more iterations) and `v16/r2/review`; `v16/r1/human-review` is `answered` with the finding; `## Decisions` holds it. The rendered prompt of `v16/r2/implement/app/1` is not journaled, so the evidence that `{{findings}}` reached Codex is in the log (`../slice3-run3.log` contains Codex's transcript, which typically echoes the task) and in what Codex did in `app/` (next step). Then check that round 1 is untouched:

```bash
cd /home/race-day/janus-trial/slice3-angular-16
python3 - <<'EOF'
import yaml
a = yaml.safe_load(open("../slice3-journal-after-run2.yaml"))["steps"]
b = yaml.safe_load(open("journal.yaml"))["steps"]
unchanged = [k for k in a if k != "v16/r1/human-review" and a[k] == b[k]]
print(len(unchanged), "of", len(a) - 1, "round-1 entries unchanged")
print("new keys:", [k for k in b if k not in a])
print("human-review:", b["v16/r1/human-review"]["status"], repr(b["v16/r1/human-review"]["answer"])[:70])
EOF
```

Expected: every round-1 entry other than the gate is unchanged (`N of N round-1 entries unchanged`), the new keys are `v16/r2/implement/app/1`, `v16/r2/review`, `v16/r2/human-review` (plus extra implement iterations if any), and the gate is `answered` with the finding. Record the wall-clock time, round 2's implement `commit`, `summary`, `blockers` (does the summary name the `zone.js` version?), the review's `passed`, `reasons`, `summary`.

- [ ] **Step 7: Look at what round 2 did in the app**

```bash
cd /home/race-day/janus-trial/slice3-angular-16/app
git log --oneline --graph --all
git status --porcelain
git show --stat HEAD
sed -n 1,6p README.md
git diff master..ai/angular-15-to-16 --stat
```

Expected: at least one new commit on `ai/angular-15-to-16` touching `README.md`; its first lines mention Angular 16 and the upgrade note; `git status --porcelain` empty. This commit is the proof that the finding travelled through `{{findings}}` into round 2. Record the commit and the README lines verbatim.

- [ ] **Step 8: Run 4: approve round 2, then the merge gate**

```bash
cd /home/race-day/janus-trial/slice3-angular-16
sed -i 's/^answer:$/answer: approved/' JANUS.md
time python3 janus.py run > ../slice3-run4.log 2>&1; echo "exit=$?"
python3 janus.py status
sed -n '/## Gate: v16\/r2\/merge/,$p' JANUS.md
git -C /home/race-day/janus-trial/origin/ng15-app-slice3.git branch -v
git -C /home/race-day/janus-trial/origin/ng15-app-slice3.git log --oneline ai/angular-15-to-16
```

Expected: exit 2 at `v16/r2/merge` in under a second (no Codex call); the gate shows the task line with round 2's commit. **"Merged" in this trial means the branch is on the bare remote** at the commit the gate shows: the last two commands must list `ai/angular-15-to-16` at that SHA. If Codex did not push, that is a finding of the trial; record it, and do not push by hand (rule 2) — then answer `merged` anyway and say in the report that nothing was merged.

- [ ] **Step 9: Run 5: answer `merged`, then the test plan (real Codex, `v16/r2/testplan`) to the QA gate**

```bash
cd /home/race-day/janus-trial/slice3-angular-16
sed -i 's/^answer:$/answer: merged/' JANUS.md
time python3 janus.py run > ../slice3-run5.log 2>&1; echo "exit=$?"
python3 janus.py status
sed -n '/## Gate: v16\/r2\/qa/,$p' JANUS.md
```

Expected: exit 2 at `v16/r2/qa`; the gate shows `summary:` and `steps:` with at most ten lines, each an action and its expected result, starting with the application loading. Read the plan and record it verbatim in the report; judge in one sentence whether it is a plan QA could run on this app (three specs, one component, no routing).

- [ ] **Step 10: Run 6 and 7: answer QA `passed`, finish, and run once more**

```bash
cd /home/race-day/janus-trial/slice3-angular-16
sed -i 's/^answer:$/answer: passed/' JANUS.md
time python3 janus.py run > ../slice3-run6.log 2>&1; echo "exit=$?"
tail -5 ../slice3-run6.log
cp journal.yaml ../slice3-journal-final.yaml
time python3 janus.py run > ../slice3-run7.log 2>&1; echo "exit=$?"
cmp journal.yaml ../slice3-journal-final.yaml && echo "journal unchanged"
cat ../slice3-run7.log
python3 janus.py status
python3 - <<'EOF'
import yaml
for k, e in yaml.safe_load(open("journal.yaml"))["steps"].items():
    print("%-32s %-9s %-9s attempt %s" % (k, e.get("kind"), e.get("status"), e.get("attempt", "-")))
EOF
sed -n '/## Progress/,$p' JANUS.md
git log --oneline | head -40
git status --porcelain
```

Expected: run 6 exits 0 with `Angular 16 reached in 2 round(s)` and `flow ended`; run 7 exits 0 in under a second, `journal unchanged`, and its whole log is the replayed `print` lines of `log()` plus `flow ended`, with no Codex transcript; the journal lists, in order, `v16/plan`, `v16/approve-plan`, `v16/r1/implement/app/1`, `v16/r1/review`, `v16/r1/human-review`, `v16/r2/implement/app/1`, `v16/r2/review`, `v16/r2/human-review`, `v16/r2/merge`, `v16/r2/testplan`, `v16/r2/qa` (with any extra ralph iterations), no `v16/direction` (one major); `## Progress` has the `round 1 of Angular 16 came back: Human review of round 1:` line and the `reached in 2 round(s)` line; the goal folder has one commit per status change, all pushed, and `git status --porcelain` is empty.

- [ ] **Step 11: Write the trial report into the example's README**

Replace the `## Trial 2 (slice 3): ...` section of `examples/angular-upgrade/README.md` in the worktree with the report below, filled from what Steps 1 to 10 actually produced. Do not soften anything; an unexpected gate, a retried step or a finding Codex ignored is the most valuable part.

````markdown
## Trial 2 (slice 3): a round sent back by the human review, with real Codex, 2026-09-__

Run on one throwaway application, without TeamCity, to satisfy spec criterion 12.9: the human
review of round 1 answers with a finding, round 2 runs with real Codex under `v16/r2/...`, the
finished flow is run once more and the journal does not change.

**Setup.** Goal folder `/home/race-day/janus-trial/slice3-angular-16`, a Git repository with the
bare remote `/home/race-day/janus-trial/origin/slice3-angular-16.git`. `janus.py` copied from the
repository at commit `<sha>` (identical to `main`'s: slice 3 changed no engine code). The
application is `app/`, a clone of `/home/race-day/janus-trial/origin/ng15-app-slice3.git`, a bare
made from the slice 2 remote's `master` alone (`f8dc4e4`, Angular 15.2, three karma specs),
because the slice 2 remote already carried `ai/angular-15-to-16` from Trial 1. Codex is codex-cli
`<version>`, model `gpt-5.6-sol` at `xhigh` reasoning from `~/.codex/config.toml`; Janus passes
no model flags. `JANUS_TEAMCITY_URL` and `JANUS_TEAMCITY_TOKEN` were unset, so no `ci/` key was
journaled. `MAJORS = [16]`, so the branch was `ai/angular-15-to-16` and no `direction` decision
opened.

**Runs.**

| Run | Command | Wall clock | Exit | Stopped at |
|---|---|---|---|---|
| 1 | `python3 janus.py run` | __ | 2 | gate `v16/approve-plan` |
| 2 | `python3 janus.py run` | __ | 2 | gate `v16/r1/human-review` |
| 3 | `python3 janus.py run` | __ | 2 | gate `v16/r2/human-review` |
| 4 | `python3 janus.py run` | __ | 2 | gate `v16/r2/merge` |
| 5 | `python3 janus.py run` | __ | 2 | gate `v16/r2/qa` |
| 6 | `python3 janus.py run` | __ | 0 | flow ended, `Angular 16 reached in 2 round(s)` |
| 7 | `python3 janus.py run` | __ | 0 | flow ended, nothing re-executed, journal byte-identical |

`__` Codex calls in all: `v16/plan` __ s, `v16/r1/implement/app/1` __ s, `v16/r1/review` __ s,
`v16/r2/implement/app/1` __ s, `v16/r2/review` __ s, `v16/r2/testplan` __ s.

**Gates.**

| Key | Question | Shown | Answer |
|---|---|---|---|
| `v16/approve-plan` | Approve this plan for Angular 16? … | `summary`, `- app [app] …` | `yes` |
| `v16/r1/human-review` | Review the pull requests of round 1. … | `review`, `tasks` | the finding (below) |
| `v16/r2/human-review` | Review the pull requests of round 2. … | `review`, `tasks` | `approved` |
| `v16/r2/merge` | Merge the pull requests of round 2 … | task line with round 2's commit | `merged` |
| `v16/r2/qa` | QA: run this test plan … | `summary`, `steps` | `passed` |

The finding written at `v16/r1/human-review`: "README.md still says the project was generated
with Angular CLI version 15.2.11. Change that line to Angular CLI 16 and add one line under the
title saying the app was upgraded from Angular 15 to 16 on this branch. Also confirm in your
summary which zone.js version package.json asks for now." There is no pull request in this trial,
so `merged` stands for the verified push: the bare `ng15-app-slice3.git` carries
`ai/angular-15-to-16` at `<sha>`.

**How the round came back.** Run 3 replayed `v16/plan`, `v16/approve-plan`,
`v16/r1/implement/app/1` and `v16/r1/review` from the journal (their entries are byte-identical
before and after: __ of __ round-1 entries unchanged), read the answer of `v16/r1/human-review`,
built `findings = "Human review of round 1:\n<the finding>"`, and the first key it did not know
was `v16/r2/implement/app/1`, which ran with that string in `{{findings}}`.

**What Codex did.**

- `v16/plan`: summary "…"; one task `id: app`, `repo: app`, `title: …`, `build_type: none`,
  objective "…".
- `v16/r1/implement/app/1`: `done: …`, commit `…`, summary "…", blockers `…`.
- `v16/r1/review`: `passed: …`, reasons `…`, summary "…".
- `v16/r2/implement/app/1`: `done: …`, commit `…`, summary "…" (does it name the `zone.js`
  version?), blockers `…`.
- `v16/r2/review`: `passed: …`, reasons `…`, summary "…".
- `v16/r2/testplan`: summary "…"; steps:
  1. …

**The result in `app/`.**

```text
<git log --oneline --graph --all>

<git diff master..ai/angular-15-to-16 --stat>
```

`README.md` after round 2, first lines: `…`. `zone.js` is at `…`, `@angular/core` at `…`,
`typescript` untouched at `~4.9.4`. `git status --porcelain` in `app/` was empty / was not: `…`.

**Journal.**

```text
v16/plan                          codex     done      attempt 1
v16/approve-plan                  gate      answered  -
v16/r1/implement/app/1            codex     done      attempt 1
v16/r1/review                     codex     done      attempt 1
v16/r1/human-review               gate      answered  -
v16/r2/implement/app/1            codex     done      attempt 1
v16/r2/review                     codex     done      attempt 1
v16/r2/human-review               gate      answered  -
v16/r2/merge                      gate      answered  -
v16/r2/testplan                   codex     done      attempt 1
v16/r2/qa                         gate      answered  -
```

**Problems.**

- …

**Engine gaps found.** None / `<the primitive, the step it appeared at, what could not be
expressed>`. No change was made to `janus.py` for this trial.

**Verdict on spec 12.9.** Met / not met: a round was / was not sent back by the human review
answer, round 2 ran / did not run with real Codex under `v16/r2/` keys, the run after the
finished flow executed nothing and left the journal byte-identical / changed it, and every
round-1 entry stayed untouched / did not.
````

- [ ] **Step 12: Commit the report**

```bash
cd /home/race-day/janus/.worktrees/slice3-loops
awk 'length > 120 {print FILENAME": "FNR": "length}' examples/angular-upgrade/README.md
uv run pytest -q
git add examples/angular-upgrade/README.md
git commit -m "docs(example): slice 3 trial report, a round sent back by the human review with real codex" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: no `awk` output, `128 passed`, one commit. The trial folder and the two new bare remotes under `/home/race-day/janus-trial/` are left in place as the evidence behind the report; nothing outside `examples/angular-upgrade/README.md` is committed by this task.

---

## Self-review notes

- **Spec coverage.** §9 item 12 → Task 1 (all three clauses: only the new round's keys execute, a gate inside round 2 resumes in round 2 — asserted both by the unanswered rerun and by the approval that ends the loop in round 2 — and the finished loop replays with a byte-identical journal). §14 return loop, nested loops, feeding the reason back → Task 2 (`findings` as a string, `{{findings}}` whole, `review.md` as `codex()` with `passed`/`reasons`, keys `v16/r2/implement/app/1`). §14 bounding a return loop and the blocker report → Task 3 (`blocked` with `show=findings`, `retry` raising `allowed`, `exhausted` with `retry | skip | stop`). §10 diagram table → Task 2 (`plan`, `approve-plan`, `review`, `human-review`, `merge`, `testplan`, `qa`, `direction`), Task 3 (`blocked`, `exhausted`, "Team: fix tooling ... `retry` starts the next round"), Task 4 (`ci/<id>/<n>` per verdict, `fix/<id>/<n>`, `missing`, `red`). §10 file list: `testplan.md` new (Task 2), the rest touched or kept. §10 trial through round 2 and §12.9 → Task 6. §12.6/§12.8 untouched (Task 4 Step 5 greps `janus.py`). §11's "engine changes only if a loop cannot be expressed": no engine task, and Task 1 proves the engine replays a return loop as written.
- **The code was assembled and run.** Every code block of Tasks 1 to 4 and the README of Task 5 were written into `/tmp/claude-1000/-home-race-day-janus/42229065-701a-4e08-8dcb-14948c49e35d/scratchpad/plan3-check`, a copy of the repository at `1d682c9`, and run with `uv run pytest -q` at each red and green step. Observed: Task 1 `1 passed` on the unchanged engine, then `121 passed`; Task 2 red `9 failed, 107 passed` (with the old flow: `At index 0 diff: 'plan' != 'v16/plan'`, `KeyError: 'v16/r1/implement/app/1'`, `assert 0 == 2`, `assert 'MAJORS = [16] ' in ...`), green `116 passed`; Task 3 red `5 failed, 116 passed` (`4 × assert 1 == 2`, `1 × KeyError: 'v16/r4/blocked'`), green `121 passed`; Task 4 red `6 failed, 122 passed` (`4 × assert 1 == 2`, `2 × KeyError: 'v16/r1/ci/app/1'`; the `build_type: none` test passes before the CI code exists), green `128 passed in 12.7s`. The final `flow.py` is 187 lines and the final `test_flow.py` 390 lines; `awk 'length > 120'` prints nothing for `flow.py`, `test_flow.py`, `test_loops.py`, the five prompts, `JANUS.md` and the README; `grep 'f"' flow.py` prints nothing. The Task 3 and Task 4 edit blocks were produced from `diff` between the three verified versions of `flow.py`, so the old and new text they quote is exact.
- **The trial's remote was rehearsed.** `git clone --bare --single-branch --branch master origin/ng15-app.git ng15-app-slice3.git` in the scratchpad produced a bare with `master` only; its clone has `f8dc4e4` alone and `remotes/origin/master` as the only remote branch. The real `/home/race-day/janus-trial/origin/` was not written to and the real Codex was not run: Task 6 is for the executor.
- **Rendering was checked against the fake Codex, not assumed.** `test_every_prompt_renders_...` asserts `{{target}}` and `{{branch}}` in the plan prompt, `{{task.title}}` and `{{attempt}}` in the first implement prompt, the empty `{{findings}}` block (four consecutive newlines) in round 1, `{{previous}}` in the second iteration, `{{tasks}}` and `{{target}}` in the review prompt, the review schema `['passed', 'reasons', 'summary']`, `{{tasks}}` in the test plan prompt and its schema `['steps', 'summary']`, and the QA gate's `steps` lines in `JANUS.md`. The three findings forms are asserted verbatim in the round-2 implement prompt (`AI review of round 1:\n...`, `Human review of round 1:\n...`, `QA of round 1:\n...`), as are the two blocker forms (`Task app gave up at v16/r1/implement/app:\n...`, `Task app is still red after 3 CI verdicts (...):\n...`). Every field the flow reads is declared in the matching prompt's `output`: `plan["summary"]`, `plan["tasks"]`, `task["id"|"repo"|"title"|"build_type"]`, `result["done"|"commit"|"summary"]`, `exc.last["summary"|"blockers"]`, `review["passed"|"reasons"|"summary"]`, `testplan["steps"|"summary"]`, `build["status"|"url"|"excerpt"]`.
- **Type and name consistency.** `run_task(k, task, finished, findings)`, `run_round(k, rnd, plan, findings)`, `ask_after_exhausted(key, exc, task, attempts)`, `verify_in_ci(k, task, result)`, `stop_run(reason)`, `SendBack(findings)` are called exactly as defined, in Tasks 2, 3 and 4 alike; `teamcity.wait_for_build(build_type, sha, timeout=...)` is called as slice 2 defined it. The keys in `flow.py`, in the README table and in the tests are the same strings; the README's key table was checked against `grep -oE 'key="[^"]+"' flow.py`. The test helpers and constants are defined once in Task 2 and used unchanged in Tasks 3 and 4.
- **Placeholder scan.** No "TBD", "TODO", "handle edge cases" or "similar to Task N" remains; every code step carries its code in full, and every edit in Tasks 3 and 4 quotes both the old and the new text. The blanks in Task 6's report template are measurements that do not exist yet; they are that task's deliverable.
- **Deliberate limitations.** The rendered prompt of a step is not journaled, so the trial's evidence that `{{findings}}` reached round 2 is the README commit Codex makes in `app/` and the run log, not a journal field. `skip` at an exhausted implement leaves the task out of the round's review (fixed under *Design decisions*); a flow author who wants the partial commits reviewed can record `exc.last` instead. The `blocked` decision shows the last findings only, not the whole history of rounds; `## Decisions` and `## Progress` in `JANUS.md` have that.
