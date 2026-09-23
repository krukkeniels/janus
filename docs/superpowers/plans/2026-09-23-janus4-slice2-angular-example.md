# Janus 4.0 Slice 2: The Angular Upgrade Example and Its Trial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `examples/angular-upgrade/` — the flow, the prompts, the TeamCity helper, the sample goal file and the tests of spec section 10 — and then run that flow on a throwaway Angular 15 application with the real Codex, recording the result as the trial report in the example's `README.md`.

**Architecture:** The example is a *goal folder* as spec section 3 describes it: `flow.py` is plain Python that calls the engine's primitives, `prompts/*.md` carry the instructions and their output schema in front matter, `prompts/_preamble.md` carries the standing rules that Janus 3.0 had inside its engine, and `teamcity.py` is a forty-line `urllib` helper that the flow calls only when two environment variables are set. Nothing in the example changes `janus.py`. Two test modules live beside the example and run in the root `uv run pytest -q`: `test_teamcity.py` drives the helper against a per-test `http.server` stub, and `test_flow.py` runs the whole flow with the engine's fake `codex` in a temporary goal folder. The trial is a manual task: the example folder is copied to `/home/race-day/janus-trial/angular-16-upgrade`, a clone of the throwaway app is added as `app/`, and `python3 janus.py run` is driven through its gates with the real Codex.

**Tech Stack:** Python 3.9+ for the example code (`teamcity.py` and `flow.py` use `%` formatting and no f-strings so they match the engine's floor), PyYAML 6 (only in tests), pytest 9 via `uv`, `http.server` from the standard library for the TeamCity stub, git 2.43, codex-cli 0.155.1 (used only in the trial task), Node v24.5.0 with pnpm 10.33.0 and Angular CLI 15/16 (only in the trial task).

**Spec:** `/home/race-day/janus/janus-4.0-spec.md` (v0.1). Section 10 defines this slice, section 11 slice 2 and section 12.7 its acceptance test; sections 4 to 9 describe the engine the example runs on and are binding as facts, not as work. Executors read both documents. The engine (slice 1) is merged at `ccae194` and is not changed by this plan.

## Global Constraints

Copied from the spec where they bind this slice; every task's requirements include this section.

- Spec §10: "Files: `flow.py`, `prompts/_preamble.md`, `prompts/plan.md`, `prompts/implement.md`, `prompts/review.md`, `prompts/fix.md`, `teamcity.py`, `JANUS.md` with a sample goal, `.gitignore`." Plus `README.md` (spec §10: "The trial report goes into the example's `README.md`") and the two test modules of spec §2 ("pytest suite with a fake `codex` on `PATH`").
- Spec §10: "`prompts/_preamble.md` carries the rules that Janus 3.0 had in its engine: work only on `{{branch}}`, commit and push your own work and report the commit SHA, never merge or publish a release, never weaken or skip tests, report blockers instead of guessing."
- Spec §10: "`teamcity.py` is about forty lines of `urllib`: find the build for a commit, poll until finished, return status, URL and a failure excerpt. It reads its URL and token from the environment and is used only when those are set."
- Spec §10: "The example is tried on the throwaway Angular 15 application with a local bare remote and real Codex, without TeamCity."
- Spec §11 slice 2: "The example folder, the trial on the throwaway app, the README. This slice may change the engine; if the example needs something the primitives cannot express, the engine is wrong, not the example." No engine change was found to be necessary while writing this plan (see *Design decisions fixed here*); if one is found while executing it, the rule of Task 6 applies: stop, record it, do not patch the engine inside the trial.
- Spec §12.7: "The Angular example runs on the throwaway app with real Codex through plan, approval gate, implementation loop and review gate." This is the acceptance test of the slice and is Task 6.
- Spec §12.6: "`janus.py` contains no reference to Git branches, pull requests, TeamCity, Bitbucket or Angular, apart from committing its own two files." Nothing in this plan adds one; the domain knowledge lives in `flow.py`, the prompts and `teamcity.py`.
- Spec §3: the goal folder holds "`janus.py` # the engine, copied or symlinked from this repository", `flow.py`, `prompts/`, `JANUS.md`, `journal.yaml`, `journals/`, `.gitignore` ("`*/`" for product clones, "`!prompts/`", "`!journals/`") and the product clones. "Prompt paths in `flow.py` are relative to the goal folder."
- Spec §4 Keys: "Inside loops, flows pass an explicit key that survives edits to the flow, such as `f"implement/{task_id}"`. Ralph iterations are keyed `<key>/<n>` starting at 1." The example passes an explicit key to **every** primitive, never a default one.
- Spec §4 Rendering: "The variables of a render are, in rising precedence: the reserved values `goal`, `attempt` and, in ralph, `previous`; the values from `context()`; the keyword arguments of the call. `previous` is absent in the first ralph iteration and renders as an empty string. If `prompts/_preamble.md` exists it is rendered with the same variables and prepended to the prompt body." Therefore the preamble may use only `{{goal}}`, `{{attempt}}` and `context()` values — never `{{previous}}` and never a call argument.
- Spec §4 Output schema: "All fields are required and no additional properties are allowed." Every field a prompt declares must be returned by Codex, and every field `flow.py` reads must be declared. `ai_gate` adds `{passed: bool, reasons: list[str]}` to the prompt's own `output`.
- Spec §4 `step`: "Use it for every side effect that must not repeat: a push, a test run, a CI poll." `step` gives its function no attempt number and no timeout, so `teamcity.wait_for_build` carries its own deadline and is safe to run again.
- Spec §5 Exit codes: "`0` the flow ended. `2` a gate is open. `1` a step failed or the flow raised."
- Spec §7: "The user's own `~/.codex/config.toml` supplies model and reasoning effort; Janus passes no model flags. Codex runs at full access because the machine Janus runs on is already a sandbox."
- Spec §9: "pytest in `tests/`, run with `uv run pytest -q`. Codex is replaced by a fake `codex` executable on `PATH` that returns scripted JSON and records its calls." The example's tests obey the same two rules: they never call the real `codex` and never need the network (the TeamCity stub listens on `127.0.0.1`).
- Spec §13: "The engine does not protect against a flow that forgets `step()` around a side effect, uses a changing default key in a loop, or lets Codex commit to the wrong branch. Those are visible in `flow.py` and the prompts."
- Tooling: `uv run pytest -q` (uv is `/snap/bin/uv`) is the verification command of every task. The root suite is **96 tests** before this plan and **110** after it.
- Commits: conventional commits with a scope. Every commit uses the two-`-m` form so the trailer is separated by a blank line: `git commit -m "type(scope): subject" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`. Scopes in this plan: `example` for the example folder, `tooling` for `pyproject.toml`, `docs` for the README and the trial report.
- No line in any file this plan creates exceeds 120 characters.

## Verified facts about this machine

Checked on 2026-09-23 while writing this plan; the numbers below are observed, not assumed.

- `python3` is 3.12.3 with PyYAML 6.0.1 system-wide, so `python3 janus.py run` works in a goal folder without a venv. `uv` is 0.12.17 at `/snap/bin/uv`; `git` is 2.43.0. The repository is at `main`, head `ccae194`, clean, and `uv run pytest -q` gives **96 passed**.
- `codex` is **codex-cli 0.155.1** at `/home/race-day/.nvm/versions/node/v24.5.0/bin/codex` (the brief said 0.146; the binary on `PATH` reports 0.155.1 — use what is installed). `~/.codex/config.toml` sets `model = "gpt-5.6-sol"` and `model_reasoning_effort = "xhigh"`; Janus passes no model flags, so the trial runs at that setting. `/home/race-day/janus` is already `trust_level = "trusted"` there, which is irrelevant to Janus because it passes `--dangerously-bypass-approvals-and-sandbox`.
- Node is v24.5.0, npm 11.6.0, **pnpm 10.33.0**. The npm registry is reachable: `npm view @angular/cli@16 version` lists up to `16.2.16` and `@angular/core@16` up to `16.2.12`. The pnpm store at `/home/race-day/.local/share/pnpm/store/v10` is 4.0 GB and already holds the Angular 15 packages.
- Google Chrome is at `/usr/bin/google-chrome` (Chrome Headless 153). Karma finds it without `CHROME_BIN` being set.
- The throwaway app `/home/race-day/janus-spike/ng15-app` is a Git repository with one commit `f8dc4e4 initial commit`, **no remote**, and a clean working tree. `package.json` asks for `@angular/*` `^15.2.0`, `@angular/cli` `~15.2.11`, `typescript` `~4.9.4`, `zone.js` `~0.12.0`, with `"test": "ng test"` and `"build": "ng build"`; `angular.json` uses `@angular-devkit/build-angular:browser` and `:karma`, `"cli": {"packageManager": "pnpm"}`, sources in `src/` with one spec file `src/app/app.component.spec.ts` holding three specs. `.gitignore` ignores `/dist`, `/node_modules` and `/.angular/cache`, so build output never shows up in `git status`.
- In that folder, `pnpm build` exits 0 in about 1.6 s and `pnpm test --watch=false --browsers=ChromeHeadless` exits 0 with `TOTAL: 3 SUCCESS`. Arguments must be passed as `pnpm test --watch=false ...`; `pnpm test -- --watch=false ...` fails with `Schema validation failed ... must NOT have additional properties`.
- A fresh clone behaves the same: `git clone --bare /home/race-day/janus-spike/ng15-app origin/ng15-app.git` then `git clone origin/ng15-app.git app` gives a 672 KB working tree whose default branch is **`master`**; `pnpm install` there takes 1.1 s from the warm store, after which `pnpm build` and the three karma specs pass.
- `/home/race-day/janus-spike/ng-update.log` and `ng-update-footprint.txt` record an earlier manual experiment: `ng update @angular/core@16 @angular/cli@16` installs a temporary CLI 16.2.16, rewrites `package.json` to `@angular/*` `^16.2.12`, `@angular/cli` `~16.2.16`, `@angular-devkit/build-angular` `^16.2.16` and `zone.js` `~0.13.3`, runs every `@angular/cli` and `@angular/core` migration with "No changes made", and touches only `package.json` and `pnpm-lock.yaml` (1669 lines added, 1144 removed). `typescript ~4.9.4` is left alone and is inside Angular 16's supported range. The `src/main.ts` change visible in `/home/race-day/janus-spike/ng15-footprint` is that experiment's own marker line, not something `ng update` wrote. The upgrade is therefore small and very likely to succeed, which is what makes it a good trial.
- **TeamCity and Bitbucket are not reachable from this machine.** `teamcity.py` is exercised only by `test_teamcity.py` against a `ThreadingHTTPServer` on `127.0.0.1:0`, and the trial runs with `JANUS_TEAMCITY_URL`/`JANUS_TEAMCITY_TOKEN` unset, so `teamcity.configured()` is false and the flow skips the CI branch.
- All code in this plan was assembled in `/tmp/claude-1000/-home-race-day-janus/c409ef97-b416-4a1f-9d47-9cfdebff5afd/scratchpad/plan2-check` and run; see *Self-review notes* for the observed red and green summaries of every task.

## Design decisions fixed here (where the spec leaves room)

- **`janus.py` is copied into the goal folder, not symlinked** (spec §3 allows either). The trial copies it. Reasons: the goal folder is a Git repository that is committed and pushed, so a copy records exactly which engine version ran; and Codex runs with `--dangerously-bypass-approvals-and-sandbox` from inside that folder, so a symlink would put the development checkout of the engine one `readlink` away from a process that has been told to stay in its repository folder. The example's `.gitignore` does not ignore `janus.py`; the README tells the reader to `cp /path/to/janus/janus.py .`.
- **Every primitive call passes an explicit key**: `plan`, `approve-plan`, `implement/<id>`, `implement/<id>/exhausted`, `implement/<id>/retry`, `ci/<id>`, `fix/<id>`, `review`, `review-findings`, `merge`. Ralph adds `/<n>`. No default key is ever used, because the flow branches on a gate answer and a per-run counter would shift keys between runs (slice 1 readiness note).
- **The plan's task record is `{id, repo, title, objective, build_type}`**, all `str`. `repo` is the sub-folder name of the product clone inside the goal folder and is what the flow passes as `cwd`; `id` is a short path-safe identifier and is what journal keys are built from; `build_type` is the TeamCity build type id or the literal string `none` (the schema has no null, and a prompt may not omit a field).
- **Project specifics live in `# Goal`, not in the prompts.** The goal text names the package manager, the exact `ng update` command, the build and test commands and the definition of done. Every prompt sees it through `{{goal}}` in the preamble, so the same four prompts work for another repository set by editing `JANUS.md` alone.
- **The preamble uses only `{{goal}}`, `{{attempt}}` and `{{branch}}`.** `{{branch}}` comes from `context(branch=...)` at the top of the flow, which is the one `context()` value the example sets. A preamble that mentioned `{{previous}}` would fail every plain `codex()` call before Codex starts.
- **Prompts use `{{previous}}` whole, never `{{previous.field}}`.** In the first ralph iteration `previous` is the empty string, and a dotted lookup into a string is an undefined placeholder, which fails the step.
- **Gate `show` values are trimmed.** `approve-plan` shows `{summary, tasks: ["<id> [<repo>] <title>", ...]}`, not the task objectives; the exhausted `decision` shows `{summary, blockers}` of the last result, not the whole result; `merge` shows one line per finished task with its commit. A gate section is rewritten into `JANUS.md` on every stalled run, so it stays small (slice 1 readiness note).
- **`ai_gate` returns only the boolean**, so the flow cannot print the reviewer's reasons at the follow-up gate; the gate question sends the human to `journal.yaml` under the step `review`, exactly as the spec's own outline does. This is the only place in the example where a primitive's return value loses information. It is **not** an engine gap that blocks the slice: the information is journaled, committed and one `grep` away. If working with it in practice turns out to be painful, that is the first engine change to propose after this slice — not inside it.
- **`teamcity.wait_for_build(build_type, sha, timeout=7200, poll=30)`** returns `{status, url, excerpt}` with `status` one of `SUCCESS`, `FAILURE`, `TIMEOUT`, `NOT_FOUND`. It does one lookup by revision, then polls by build id, and reads up to twenty failed test names as the excerpt. It holds its own deadline because `step()` gives it none, and it is idempotent because it only reads. A non-404 HTTP error propagates and fails the step, which is the correct behaviour: a broken token should stop the run, not be mistaken for a red build.
- **The example's tests are discovered from the root** by adding both entries to `pyproject.toml`: `pythonpath = [".", "examples/angular-upgrade"]` (so `import teamcity` works) and `testpaths = ["tests", "examples/angular-upgrade/tests"]`. A second `conftest.py` in the example's test folder is fine — pytest handles several `conftest.py` files without `__init__.py` — and the module names `test_flow` and `test_teamcity` do not collide with any engine test module.
- **The fake `codex` fixture is reused, not copied.** `examples/angular-upgrade/tests/conftest.py` loads the engine's `tests/conftest.py` by path under the module name `janus_engine_conftest` and re-binds its `fake_codex` fixture. Re-binding a fixture function in a `conftest.py` registers it for that directory.
- **`test_flow.py` runs the flow the way the engine does**, with `janus.main(["run"])` in a copied goal folder, rather than importing `flow.py` (importing it would execute the flow). The copy contains `flow.py`, `teamcity.py`, `JANUS.md`, `prompts/` and an empty `app/` folder. `flow.py`'s `import teamcity` resolves through the `sys.path` entry the engine adds for the goal folder, or from the already-imported example module — both are the same file.
- **`.gitignore` adds `!tests/` and `*.tmp`** to the spec's three lines. Without `!tests/` the example's own test folder would be ignored inside the Janus repository (`*/` ignores every directory); `*.tmp` covers the temporary files `write_atomic` leaves if a write is interrupted. Verified in a scratch repository: `prompts/`, `journals/` and `tests/` are added, `app/src/main.ts` and `journal.yaml.abc.tmp` are ignored.
- **The flow raises `SystemExit(1)` on the `stop` answer**, which `cmd_run` turns into exit code 1, and logs a Progress line first so the reason is in `JANUS.md`.
- **The trial goal folder is `/home/race-day/janus-trial/angular-16-upgrade`** with bare remotes under `/home/race-day/janus-trial/origin/`. `/home/race-day/janus-spike/ng15-app` is only ever read (`git clone --bare`), never modified.

## File structure

| Path | Responsibility | Task |
|---|---|---|
| `examples/angular-upgrade/teamcity.py` | `configured()`, `get(path)`, `failed_tests(build_id)`, `wait_for_build(...)`. The only HTTP in the repository. | 1 |
| `examples/angular-upgrade/tests/conftest.py` | `fake_codex` (re-bound from the engine suite), `without_teamcity` (autouse), `teamcity_server`, `goal_folder`. | 1 |
| `examples/angular-upgrade/tests/test_teamcity.py` | The helper against the stub: success, failure excerpt, polling, not found, timeout, locator and token. 7 tests. | 1 |
| `pyproject.toml` | `pythonpath` and `testpaths` so the root `uv run pytest -q` runs the example's tests too. | 1 |
| `examples/angular-upgrade/prompts/_preamble.md` | The standing rules, prepended to every prompt. Uses `{{goal}}`, `{{attempt}}`, `{{branch}}` only. | 2 |
| `examples/angular-upgrade/prompts/plan.md` | Read-only survey of the repository sub-folders; `output: summary, tasks[]`. | 2 |
| `examples/angular-upgrade/prompts/implement.md` | One task in one repository; `output: done, commit, summary, blockers`. | 2 |
| `examples/angular-upgrade/prompts/review.md` | Read-only review of the finished work; `output: summary` plus `ai_gate`'s `passed`/`reasons`. | 2 |
| `examples/angular-upgrade/JANUS.md` | The sample `# Goal`: what "upgraded" means and how a task is verified. | 2 |
| `examples/angular-upgrade/.gitignore` | `*/`, `!prompts/`, `!journals/`, `!tests/`, `*.tmp`. | 2 |
| `examples/angular-upgrade/flow.py` | The flow. Grows over Tasks 2 (plan, gate, implement, review, merge), 3 (the `Exhausted` branch) and 4 (the TeamCity branch). | 2, 3, 4 |
| `examples/angular-upgrade/tests/test_flow.py` | The flow end to end with the fake `codex`. 3 tests in Task 2, 2 in Task 3, 2 in Task 4. | 2, 3, 4 |
| `examples/angular-upgrade/prompts/fix.md` | One CI failure; `output: done, commit, summary, blockers`. | 4 |
| `examples/angular-upgrade/README.md` | What the example is, how to start a goal folder from it, the journal keys it produces, the TeamCity variables and the secrets warning; then the trial report. | 5, 6 |

Cumulative root suite: 96 (before) → 103 (Task 1) → 106 (Task 2) → 108 (Task 3) → 110 (Task 4) → 110 (Tasks 5, 6).

Spec §10 coverage: the file list → Tasks 1, 2, 4, 5; the flow outline → Tasks 2, 3, 4; the preamble rules → Task 2; `teamcity.py` → Task 1; the trial and its README report → Task 6. Spec §12.7 → Task 6.

Names used across tasks, so a task's implementer knows what the neighbouring tasks call things: `teamcity.configured()`, `teamcity.get(path)`, `teamcity.failed_tests(build_id)`, `teamcity.wait_for_build(build_type, sha, timeout=7200, poll=30)`; fixtures `fake_codex` (`.script(steps)`, `.calls()`), `teamcity_server` (`.serve(bodies)`, `.requests()`), `goal_folder`, `without_teamcity`; test helpers in `test_flow.py`: `run(folder, monkeypatch)`, `answer(folder, text)`, `journal_of(folder)`; flow constants `BRANCH`, `MAX_IMPLEMENT`, `MAX_FIX`; task fields `id`, `repo`, `title`, `objective`, `build_type`; implement and fix fields `done`, `commit`, `summary`, `blockers`; review fields `summary`, `passed`, `reasons`; build fields `status`, `url`, `excerpt`.

---

### Task 1: The example folder, `teamcity.py` and test discovery

Spec §10 (`teamcity.py`, "about forty lines of `urllib`... reads its URL and token from the environment and is used only when those are set"), §2 (the example folder is part of the slice), §9 (tests never need the network).

**Files:**
- Create: `examples/angular-upgrade/teamcity.py`
- Create: `examples/angular-upgrade/tests/conftest.py`
- Create: `examples/angular-upgrade/tests/test_teamcity.py`
- Modify: `pyproject.toml:10-12` (the `[tool.pytest.ini_options]` block)

**Interfaces:**
- Consumes: nothing from earlier tasks. From the engine suite: `tests/conftest.py` with its `fake_codex` fixture (`.script(steps)` takes a list of `{"output": dict}` or `{"text": str}` steps, the last one repeating; `.calls()` returns `[{"argv", "cwd", "prompt", "schema"}]`).
- Produces:
  - `teamcity.configured() -> bool`: true only when both `JANUS_TEAMCITY_URL` and `JANUS_TEAMCITY_TOKEN` are non-empty.
  - `teamcity.get(path) -> dict | None`: one authenticated GET (`Authorization: Bearer <token>`, `Accept: application/json`, 30 s timeout) against `JANUS_TEAMCITY_URL + path`; parsed JSON, or `None` on HTTP 404; any other `HTTPError` propagates.
  - `teamcity.failed_tests(build_id) -> str`: up to twenty failed test names of that build, newline separated.
  - `teamcity.wait_for_build(build_type, sha, timeout=7200, poll=30) -> dict`: `{"status": "SUCCESS"|"FAILURE"|"TIMEOUT"|"NOT_FOUND", "url": str, "excerpt": str}`.
  - Fixtures for every test module in `examples/angular-upgrade/tests/`: `fake_codex` (re-bound from the engine suite), `without_teamcity` (autouse, clears the two variables), `teamcity_server` (`.serve(bodies)` queues JSON answers in order, `.requests()` returns `[{"path", "auth"}]`; sets the two variables to the stub), `goal_folder` (a `tmp_path` copy of the example with an empty `app/`; used from Task 2 on).

- [ ] **Step 1: Make the example's tests discoverable from the root**

Replace the `[tool.pytest.ini_options]` block of `pyproject.toml` with:

```toml
[tool.pytest.ini_options]
pythonpath = [".", "examples/angular-upgrade"]
testpaths = ["tests", "examples/angular-upgrade/tests"]
```

- [ ] **Step 2: Write the example's test fixtures**

Create `examples/angular-upgrade/tests/conftest.py`:

```python
"""Fixtures for the example's tests: the engine's fake `codex`, a throwaway TeamCity and a goal folder.

The fake `codex` fixture is the engine suite's (`tests/conftest.py`), loaded by path under its own
module name so that neither pytest's conftest handling nor `sys.modules` sees two modules called
`conftest`. Re-binding the fixture function in this module registers it for this directory.
"""
import importlib.util
import json
import shutil
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

EXAMPLE = Path(__file__).resolve().parent.parent
REPO = EXAMPLE.parent.parent
sys.path.insert(0, str(EXAMPLE))  # so `import teamcity` finds the example's helper


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


fake_codex = _load("janus_engine_conftest", REPO / "tests" / "conftest.py").fake_codex


@pytest.fixture(autouse=True)
def without_teamcity(monkeypatch):
    """No test inherits a real TeamCity from the developer's environment. Autouse fixtures are set
    up before the fixtures a test names, so `teamcity_server` still wins where a test asks for it."""
    monkeypatch.delenv("JANUS_TEAMCITY_URL", raising=False)
    monkeypatch.delenv("JANUS_TEAMCITY_TOKEN", raising=False)


@pytest.fixture
def teamcity_server(monkeypatch):
    """A TeamCity on 127.0.0.1 that answers queued JSON bodies and records the requests it got.
    `serve(bodies)` queues answers in order; a request past the queue gets 404."""
    queue = []
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append({"path": self.path, "auth": self.headers.get("Authorization")})
            body = queue.pop(0) if queue else None
            if body is None:
                self.send_response(404)
                self.end_headers()
                return
            data = json.dumps(body).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass  # keep the pytest output pristine

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("JANUS_TEAMCITY_URL", "http://127.0.0.1:%d" % server.server_address[1])
    monkeypatch.setenv("JANUS_TEAMCITY_TOKEN", "t0ken")
    yield types.SimpleNamespace(serve=queue.extend, requests=lambda: list(seen))
    server.shutdown()
    server.server_close()


@pytest.fixture
def goal_folder(tmp_path):
    """A copy of the example as a goal folder, with one empty repository sub-folder `app`."""
    folder = tmp_path / "angular-16-upgrade"
    folder.mkdir()
    for name in ("flow.py", "teamcity.py", "JANUS.md"):
        shutil.copy(EXAMPLE / name, folder / name)
    shutil.copytree(EXAMPLE / "prompts", folder / "prompts")
    (folder / "app").mkdir()
    return folder
```

`goal_folder` is unused until Task 2 and fails at nothing until a test asks for it, because fixtures are lazy.

- [ ] **Step 3: Write the failing tests**

Create `examples/angular-upgrade/tests/test_teamcity.py`:

```python
import teamcity

RUNNING = {"build": [{"id": 42, "webUrl": "http://tc/viewLog.html?buildId=42", "state": "running"}]}
FINISHED = {"build": [{"id": 42, "webUrl": "http://tc/viewLog.html?buildId=42",
                       "state": "finished", "status": "SUCCESS"}]}
FAILED = {"build": [{"id": 42, "webUrl": "http://tc/viewLog.html?buildId=42",
                     "state": "finished", "status": "FAILURE"}]}


def test_configured_is_false_until_both_variables_are_set(monkeypatch):
    monkeypatch.delenv("JANUS_TEAMCITY_URL", raising=False)
    monkeypatch.delenv("JANUS_TEAMCITY_TOKEN", raising=False)
    assert teamcity.configured() is False
    monkeypatch.setenv("JANUS_TEAMCITY_URL", "http://tc")
    assert teamcity.configured() is False
    monkeypatch.setenv("JANUS_TEAMCITY_TOKEN", "t0ken")
    assert teamcity.configured() is True


def test_wait_for_build_returns_success_and_the_build_url(teamcity_server):
    teamcity_server.serve([FINISHED])
    assert teamcity.wait_for_build("app_Build", "abc123", timeout=5, poll=0) == {
        "status": "SUCCESS", "url": "http://tc/viewLog.html?buildId=42", "excerpt": ""}


def test_wait_for_build_looks_the_build_up_by_revision_with_a_bearer_token(teamcity_server):
    teamcity_server.serve([FINISHED])
    teamcity.wait_for_build("app_Build", "abc123", timeout=5, poll=0)
    request = teamcity_server.requests()[0]
    assert request["auth"] == "Bearer t0ken"
    assert request["path"].startswith("/app/rest/2018.1/builds?locator=")
    assert "buildType%3A%28id%3Aapp_Build%29" in request["path"]
    assert "revision%3A%28version%3Aabc123%29" in request["path"]


def test_wait_for_build_returns_failure_with_the_failed_test_names(teamcity_server):
    teamcity_server.serve([FAILED, {"testOccurrence": [{"name": "AppComponent should create the app"},
                                                       {"name": "AppComponent should render title"}]}])
    result = teamcity.wait_for_build("app_Build", "abc123", timeout=5, poll=0)
    assert result["status"] == "FAILURE"
    assert result["excerpt"] == "AppComponent should create the app\nAppComponent should render title"
    assert "build%3A%28id%3A42%29%2Cstatus%3AFAILURE" in teamcity_server.requests()[1]["path"]


def test_wait_for_build_polls_by_build_id_until_the_build_is_finished(teamcity_server):
    teamcity_server.serve([RUNNING, {"id": 42, "webUrl": "http://tc/viewLog.html?buildId=42",
                                     "state": "finished", "status": "SUCCESS"}])
    assert teamcity.wait_for_build("app_Build", "abc123", timeout=5, poll=0)["status"] == "SUCCESS"
    assert teamcity_server.requests()[1]["path"].startswith("/app/rest/2018.1/builds/id:42?")


def test_wait_for_build_returns_not_found_when_no_build_has_that_revision(teamcity_server):
    teamcity_server.serve([{"count": 0}])
    assert teamcity.wait_for_build("app_Build", "abc123", timeout=5, poll=0) == {
        "status": "NOT_FOUND", "url": "", "excerpt": "no app_Build build for abc123"}


def test_wait_for_build_returns_timeout_when_the_build_never_finishes(teamcity_server):
    teamcity_server.serve([RUNNING])
    assert teamcity.wait_for_build("app_Build", "abc123", timeout=0, poll=0) == {
        "status": "TIMEOUT", "url": "http://tc/viewLog.html?buildId=42",
        "excerpt": "still running after 0 s"}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `uv run pytest -q`
Expected: collection stops with `examples/angular-upgrade/tests/test_teamcity.py:1: in <module> / import teamcity / E ModuleNotFoundError: No module named 'teamcity'`, then `ERROR examples/angular-upgrade/tests/test_teamcity.py`, `Interrupted: 1 error during collection`, `1 error in 0.08s`. No test runs at all, which also proves the new `testpaths` entry is being collected.

- [ ] **Step 5: Write `teamcity.py`**

Create `examples/angular-upgrade/teamcity.py`:

```python
"""TeamCity lookup for the Angular upgrade flow. This is flow code, not engine code: Janus itself
knows nothing about CI. The URL and the token are read from the environment, so the engine never
holds a secret; the flow calls it only when ``configured()`` is true."""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

REST = "/app/rest/2018.1"


def configured():
    """True when both environment variables are set; the flow skips the CI wait otherwise."""
    return bool(os.environ.get("JANUS_TEAMCITY_URL") and os.environ.get("JANUS_TEAMCITY_TOKEN"))


def get(path):
    """One authenticated GET returning parsed JSON, or None when TeamCity answers 404."""
    url = os.environ["JANUS_TEAMCITY_URL"].rstrip("/") + path
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + os.environ["JANUS_TEAMCITY_TOKEN"], "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def failed_tests(build_id):
    """The names of up to twenty failed tests of a build, one per line."""
    locator = urllib.parse.quote("build:(id:%s),status:FAILURE" % build_id, safe="")
    data = get("%s/testOccurrences?locator=%s&count=20&fields=testOccurrence(name)" % (REST, locator)) or {}
    return "\n".join(t.get("name", "") for t in data.get("testOccurrence", []))


def wait_for_build(build_type, sha, timeout=7200, poll=30):
    """Find the ``build_type`` build of commit ``sha`` and wait for it to finish.
    Returns {status, url, excerpt} with status SUCCESS, FAILURE, TIMEOUT or NOT_FOUND.
    It carries its own deadline and is safe to run again: step() gives it neither."""
    locator = urllib.parse.quote(
        "buildType:(id:%s),revision:(version:%s),defaultFilter:false" % (build_type, sha), safe="")
    found = get("%s/builds?locator=%s&count=1&fields=build(id,webUrl,state,status)" % (REST, locator)) or {}
    builds = found.get("build") or []
    if not builds:
        return {"status": "NOT_FOUND", "url": "", "excerpt": "no %s build for %s" % (build_type, sha)}
    build = builds[0]
    deadline = time.time() + timeout
    while build.get("state") != "finished":
        if time.time() >= deadline:
            return {"status": "TIMEOUT", "url": build.get("webUrl", ""),
                    "excerpt": "still %s after %s s" % (build.get("state"), timeout)}
        time.sleep(poll)
        build = get("%s/builds/id:%s?fields=id,webUrl,state,status" % (REST, build["id"])) or build
    ok = build.get("status") == "SUCCESS"
    return {"status": "SUCCESS" if ok else "FAILURE", "url": build.get("webUrl", ""),
            "excerpt": "" if ok else failed_tests(build["id"])}
```

Notes for the implementer: `defaultFilter:false` in the locator is what makes TeamCity return cancelled and personal builds too, so a build that exists is found rather than reported as `NOT_FOUND`. The deadline is checked before sleeping, so `timeout=0` returns `TIMEOUT` immediately instead of waiting one poll interval. `get()` returning `None` for 404 is why `or {}` and `or build` appear: a build that disappears between two polls keeps the last known state rather than crashing.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `103 passed` (96 engine + 7 new).

- [ ] **Step 7: Commit**

```bash
git add pyproject.toml examples/angular-upgrade/teamcity.py examples/angular-upgrade/tests/conftest.py \
  examples/angular-upgrade/tests/test_teamcity.py
git commit -m "feat(example): teamcity build lookup for the angular upgrade flow" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The prompts, the sample goal and the flow through plan, gate, implement, review and merge

Spec §10 (the file list, the flow outline, the preamble rules), §3 (`.gitignore`, `JANUS.md`), §4 (keys, rendering, output schema), §5 (gates, exit codes).

**Files:**
- Create: `examples/angular-upgrade/prompts/_preamble.md`, `examples/angular-upgrade/prompts/plan.md`, `examples/angular-upgrade/prompts/implement.md`, `examples/angular-upgrade/prompts/review.md`
- Create: `examples/angular-upgrade/JANUS.md`, `examples/angular-upgrade/.gitignore`, `examples/angular-upgrade/flow.py`
- Create: `examples/angular-upgrade/tests/test_flow.py`

**Interfaces:**
- Consumes: the fixtures of Task 1 (`fake_codex`, `goal_folder`, `without_teamcity`); the engine primitives `goal`, `context`, `codex`, `ralph`, `human_gate`, `ai_gate`, `log` as spec §4 declares them.
- Produces:
  - `prompts/plan.md` → `{"summary": str, "tasks": [{"id": str, "repo": str, "title": str, "objective": str, "build_type": str}]}`.
  - `prompts/implement.md` → `{"done": bool, "commit": str, "summary": str, "blockers": list[str]}`; rendered with `{{task.*}}`, `{{previous}}`, `{{branch}}`.
  - `prompts/review.md` → `{"summary": str}` plus `ai_gate`'s `{"passed": bool, "reasons": list[str]}`; rendered with `{{tasks}}` (a list of `{id, repo, title, commit}`) and `{{branch}}`.
  - `flow.py` module constants `BRANCH = "ai/angular-15-to-16"`, `MAX_IMPLEMENT = 5`; the journal keys `plan`, `approve-plan`, `implement/<id>/<n>`, `review`, `review-findings`, `merge`.
  - `test_flow.py` helpers `run(folder, monkeypatch) -> int` (chdir plus `janus.main(["run"])`), `answer(folder, text) -> None` (fills the one open `answer:` line), `journal_of(folder) -> dict`, and the scripted Codex answers `PLAN`, `NOT_DONE`, `DONE`, `FIXED`, `REVIEW_OK`, `BUILD` (Tasks 3 and 4 use them unchanged).

- [ ] **Step 1: Write the failing tests**

Create `examples/angular-upgrade/tests/test_flow.py`:

```python
"""The example flow, end to end, with the engine's fake `codex` and a stubbed TeamCity."""
import yaml

import janus

PLAN = {"summary": "One repository, app, goes from Angular 15 to Angular 16.",
        "tasks": [{"id": "app", "repo": "app", "title": "Upgrade app to Angular 16",
                   "objective": "app is on Angular 15.2. Run ng update to 16 and keep the tests green.",
                   "build_type": "app_Build"}]}
NOT_DONE = {"done": False, "commit": "", "summary": "ng update ran; the build still fails.",
            "blockers": ["app.component.ts does not compile"]}
DONE = {"done": True, "commit": "a" * 40, "summary": "Angular 16, build and tests green.", "blockers": []}
FIXED = {"done": True, "commit": "b" * 40, "summary": "Fixed the failing title spec.", "blockers": []}
REVIEW_OK = {"summary": "The upgrade is complete and no test was weakened.", "passed": True, "reasons": []}
BUILD = {"id": 42, "webUrl": "http://tc/viewLog.html?buildId=42", "state": "finished"}


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


def test_the_flow_plans_gates_implements_reviews_and_ends_at_the_merge_gate(goal_folder, fake_codex, monkeypatch):
    fake_codex.script([{"output": PLAN}, {"output": NOT_DONE}, {"output": DONE}, {"output": REVIEW_OK}])
    assert run(goal_folder, monkeypatch) == 2
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    answer(goal_folder, "merged")
    assert run(goal_folder, monkeypatch) == 0
    steps = journal_of(goal_folder)["steps"]
    assert list(steps) == ["plan", "approve-plan", "implement/app/1", "implement/app/2", "review", "merge"]
    assert [e["status"] for e in steps.values()] == ["done", "answered", "done", "done", "done", "answered"]
    assert "ci/app" not in steps
    assert len(fake_codex.calls()) == 4


def test_every_prompt_renders_with_the_branch_the_goal_and_the_task(goal_folder, fake_codex, monkeypatch):
    fake_codex.script([{"output": PLAN}, {"output": NOT_DONE}, {"output": DONE}, {"output": REVIEW_OK}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    run(goal_folder, monkeypatch)
    plan, first, second, review = fake_codex.calls()
    assert plan["cwd"].endswith("angular-16-upgrade")
    assert first["cwd"].endswith("angular-16-upgrade/app")
    assert "ai/angular-15-to-16" in plan["prompt"] and "Upgrade every Angular application" in plan["prompt"]
    assert plan["schema"]["properties"]["tasks"]["items"]["required"] == \
        ["id", "repo", "title", "objective", "build_type"]
    assert "Upgrade app to Angular 16" in first["prompt"] and "This is attempt 1" in first["prompt"]
    assert "ng update ran; the build still fails." in second["prompt"]
    assert "Upgrade app to Angular 16" in review["prompt"] and "a" * 40 in review["prompt"]
    assert review["schema"]["properties"]["passed"] == {"type": "boolean"}


def test_a_second_run_of_the_finished_flow_changes_nothing(goal_folder, fake_codex, monkeypatch):
    fake_codex.script([{"output": PLAN}, {"output": DONE}, {"output": REVIEW_OK}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    run(goal_folder, monkeypatch)
    answer(goal_folder, "merged")
    assert run(goal_folder, monkeypatch) == 0
    before = journal_of(goal_folder)
    assert run(goal_folder, monkeypatch) == 0
    assert journal_of(goal_folder) == before
    assert len(fake_codex.calls()) == 3
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q`
Expected: `103 passed, 3 errors`; each error is the `goal_folder` fixture raising `FileNotFoundError: [Errno 2] No such file or directory: '.../examples/angular-upgrade/flow.py'` at `/usr/lib/python3.12/shutil.py:260`.

- [ ] **Step 3: Write the preamble**

Create `examples/angular-upgrade/prompts/_preamble.md`:

```markdown
You are one step of a Janus flow, running as a fresh process. The goal of the whole flow is:

{{goal}}

This is attempt {{attempt}} of this step. If it is not the first, an earlier process was
interrupted or failed: inspect the working tree before you change anything.

These rules override anything the instructions below ask for:

- Work only on the branch `{{branch}}` in the repository folder you were started in. If that
  branch does not exist there, create it from the current branch before you change anything.
- Commit your own work in that repository, in small commits with clear messages, and report the
  full SHA of your last commit in your output. Push `{{branch}}` if the repository has a remote.
- Never merge, rebase or push another branch, never tag, never publish a package and never deploy.
- Never weaken, delete, skip or disable a test to make a build or a check pass. If a test is
  wrong, leave it failing and say so in your output.
- Never create, change or delete a file outside the repository folder you were started in.
  `JANUS.md`, `journal.yaml` and `prompts/` belong to Janus; they are never yours to edit.
- If you are blocked, stop and report the blocker in your output instead of guessing.
- Never print, echo or commit a secret, a token or a credential. Your output is written into
  `journal.yaml`, which is committed and pushed.
- Answer with the JSON object the output schema describes, and nothing else.
```

This file is prepended to **every** prompt with the same variables, so it may name only `{{goal}}`, `{{attempt}}` and the `context()` value `{{branch}}`. Adding `{{previous}}` or `{{task.id}}` here would fail every non-ralph step before Codex starts.

- [ ] **Step 4: Write the three prompts**

Create `examples/angular-upgrade/prompts/plan.md`:

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
Plan the work. This step changes nothing: do not edit, create or delete any file, and do not
create the branch yet.

Every product repository is a sub-folder of the folder you were started in. Ignore `prompts`,
`journals`, `tests` and any folder whose name starts with a dot. For each repository, read
`package.json`, `angular.json` and enough of the source to see what the goal needs there.

Produce one task per repository, ordered so that a repository other repositories depend on
comes first. For each task:

- `id`: a short lowercase identifier, unique in this plan, safe in a file path (for example `ui-kit`).
- `repo`: the sub-folder name of that repository, exactly as it is on disk.
- `title`: one line naming what the task changes.
- `objective`: two to five sentences: where the repository stands now, what to change, and which
  checks from the goal decide that the task is done.
- `build_type`: the TeamCity build type id that builds this repository if the repository names
  one (for example in `.teamcity` or its README), otherwise the string `none`.

`summary` is two or three sentences a human can approve without reading the tasks.
```

Create `examples/angular-upgrade/prompts/implement.md`:

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
```

Create `examples/angular-upgrade/prompts/review.md`:

```markdown
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
```

`review.md` declares only `summary`; `ai_gate` adds `passed` and `reasons` to the schema, so the prompt may talk about all three.

- [ ] **Step 5: Write the sample goal and the `.gitignore`**

Create `examples/angular-upgrade/JANUS.md`:

```markdown
# Goal
Upgrade every Angular application in this folder from Angular 15 to Angular 16.

Each application is a Git clone in a sub-folder of this folder. The package manager is pnpm.
Google Chrome is installed at `/usr/bin/google-chrome`, so the unit tests run headless.

A task is done when, in its own repository folder:

- `pnpm install` succeeds;
- `pnpm ng update @angular/core@16 @angular/cli@16` has been run and every migration it offers
  has been applied;
- `package.json` asks for Angular 16 and no `@angular/*` dependency is left at 15;
- `pnpm build` succeeds;
- `pnpm test --watch=false --browsers=ChromeHeadless` succeeds with no test skipped or removed;
- the work is committed on the branch `ai/angular-15-to-16`.

Do not upgrade past 16, do not change unrelated dependencies and do not reformat files the
upgrade does not touch.
```

Create `examples/angular-upgrade/.gitignore`:

```gitignore
# Product repositories are cloned into this folder; they are not part of it.
*/
!prompts/
!journals/
!tests/
# Janus writes JANUS.md and journal.yaml through temporary files in this folder.
*.tmp
```

- [ ] **Step 6: Write the flow**

Create `examples/angular-upgrade/flow.py`:

```python
"""Upgrade every Angular application in this folder, one repository at a time.

Plan with Codex, let a human approve the plan, implement each task in a ralph loop, let Codex
review the result and let the human merge. Every step has an explicit key, so editing this file
does not shift the keys of finished steps.
"""
from janus import ai_gate, codex, context, human_gate, log, ralph

BRANCH = "ai/angular-15-to-16"
MAX_IMPLEMENT = 5

context(branch=BRANCH)

plan = codex("prompts/plan.md", key="plan")
human_gate(
    "Approve this plan? Answer 'yes' to run it. To change it, edit the goal or the prompts,"
    " run `python janus.py reset` and start again.",
    key="approve-plan",
    show={"summary": plan["summary"],
          "tasks": ["%s [%s] %s" % (t["id"], t["repo"], t["title"]) for t in plan["tasks"]]},
)

finished = []
for task in plan["tasks"]:
    result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                   key="implement/%s" % task["id"], cwd=task["repo"], task=task)
    finished.append({"id": task["id"], "repo": task["repo"], "title": task["title"],
                     "commit": result["commit"]})
    log("task %s done: %s" % (task["id"], result["summary"]))

if not ai_gate("prompts/review.md", key="review", tasks=finished):
    human_gate(
        "The review did not pass. Its reasons are in journal.yaml under the step 'review'."
        " Fix what it found, or answer 'accepted' to continue anyway.",
        key="review-findings")

human_gate(
    "Every task is committed on %s. Review the branches, open and merge the pull requests,"
    " then answer 'merged'." % BRANCH,
    key="merge", show=finished)
log("flow finished")
```

Notes for the implementer: `cwd=task["repo"]` is relative to the goal folder, and `run_codex` fails the step before starting Codex if that folder does not exist, so a plan that invents a repository name stops immediately. `show` at `approve-plan` is deliberately a trimmed list of one-line strings — the gate section is rewritten into `JANUS.md` on every run that stops there. `finished` is an ordinary Python list; the engine deep-copies results, so nothing here can rewrite journal history.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `106 passed`.

- [ ] **Step 8: Commit**

```bash
git add examples/angular-upgrade/prompts examples/angular-upgrade/JANUS.md \
  examples/angular-upgrade/.gitignore examples/angular-upgrade/flow.py \
  examples/angular-upgrade/tests/test_flow.py
git commit -m "feat(example): angular upgrade flow with plan, approval, implement and review" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The `Exhausted` decision branch

Spec §10 (the flow outline's `except Exhausted` with `decision(..., ["retry", "skip", "stop"])`), §4 (`ralph` "Raises `Exhausted(last)` after max_iter iterations"), §8 ("The intended pattern is to catch it and open a `human_gate`, as the example shows"), §12.4.

**Files:**
- Modify: `examples/angular-upgrade/flow.py` (the body of the `for task in plan["tasks"]:` loop)
- Modify: `examples/angular-upgrade/tests/test_flow.py` (append two tests)

**Interfaces:**
- Consumes: from Task 2, `flow.py`'s `BRANCH`, `MAX_IMPLEMENT`, the loop over `plan["tasks"]`, the keys `implement/<id>`; from `test_flow.py` the helpers `run`, `answer`, `journal_of` and the constants `PLAN`, `NOT_DONE`.
- Produces: the journal keys `implement/<id>/exhausted` (kind `decision`, options `retry`, `skip`, `stop`) and `implement/<id>/retry/<n>`; the engine import list of `flow.py` grows by `Exhausted` and `decision`.

- [ ] **Step 1: Write the failing tests**

Append to `examples/angular-upgrade/tests/test_flow.py`:

```python
def test_an_exhausted_implement_loop_opens_a_decision_and_skip_continues(goal_folder, fake_codex, monkeypatch):
    fake_codex.script([{"output": PLAN}] + [{"output": NOT_DONE}] * 5 + [{"output": REVIEW_OK}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    gate = journal_of(goal_folder)["steps"]["implement/app/exhausted"]
    assert (gate["kind"], gate["status"]) == ("decision", "open")
    assert "app.component.ts does not compile" in (goal_folder / "JANUS.md").read_text(encoding="utf-8")
    answer(goal_folder, "skip")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert list(steps) == ["plan", "approve-plan"] + ["implement/app/%d" % n for n in range(1, 6)] + \
        ["implement/app/exhausted", "review", "merge"]
    assert steps["implement/app/exhausted"]["answer"] == "skip"


def test_stop_at_the_exhausted_decision_ends_the_run_with_exit_1(goal_folder, fake_codex, monkeypatch):
    fake_codex.script([{"output": PLAN}] + [{"output": NOT_DONE}] * 5)
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    run(goal_folder, monkeypatch)
    answer(goal_folder, "stop")
    assert run(goal_folder, monkeypatch) == 1
    steps = journal_of(goal_folder)["steps"]
    assert steps["implement/app/exhausted"]["answer"] == "stop"
    assert "review" not in steps
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q`
Expected: `2 failed, 106 passed`. Both failures end in `janus.Exhausted: ralph exhausted` printed by `cmd_run`'s traceback, and the assertions that fail are `assert 1 == 2` (the run exits 1 instead of opening a gate) and `KeyError: 'implement/app/exhausted'`.

- [ ] **Step 3: Catch `Exhausted` in the flow**

In `examples/angular-upgrade/flow.py`, change the import line:

```python
from janus import ai_gate, codex, context, human_gate, log, ralph
```

to:

```python
from janus import Exhausted, ai_gate, codex, context, decision, human_gate, log, ralph
```

and replace these two lines of the loop body:

```python
    result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                   key="implement/%s" % task["id"], cwd=task["repo"], task=task)
```

with:

```python
    key = "implement/%s" % task["id"]
    try:
        result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                       key=key, cwd=task["repo"], task=task)
    except Exhausted as exc:
        choice = decision(
            "Task %s is not done after %d attempts. Retry it, skip it, or stop the run?"
            % (task["id"], MAX_IMPLEMENT),
            ["retry", "skip", "stop"], key="%s/exhausted" % key,
            show={"summary": exc.last["summary"], "blockers": exc.last["blockers"]})
        if choice == "stop":
            log("task %s stopped the run" % task["id"])
            raise SystemExit(1)
        if choice == "skip":
            log("task %s skipped by the human" % task["id"])
            continue
        result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                       key="%s/retry" % key, cwd=task["repo"], task=task)
```

Notes for the implementer: `decision` exits the process with code 2 the first time it runs, so everything after it in the loop body runs only on the run that carries the answer. `show` passes just the last result's `summary` and `blockers`, not the whole result. `SystemExit(1)` is caught by `cmd_run` and becomes the process's exit code; the `log` line before it puts the reason in `## Progress`. The retry loop gets its own key `implement/<id>/retry`, so its iterations are `implement/<id>/retry/1` and cannot collide with the first loop's `implement/<id>/1`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `108 passed`.

- [ ] **Step 5: Commit**

```bash
git add examples/angular-upgrade/flow.py examples/angular-upgrade/tests/test_flow.py
git commit -m "feat(example): open a retry/skip/stop decision when the implement loop is exhausted" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The TeamCity wait and the fix loop

Spec §10 (the flow outline's `if teamcity.configured(): build = step(...)` and the `fix.md` ralph), §4 (`step`: "Use it for every side effect that must not repeat: ... a CI poll").

**Files:**
- Create: `examples/angular-upgrade/prompts/fix.md`
- Modify: `examples/angular-upgrade/flow.py` (import `teamcity`, add `MAX_FIX`, add the CI block to the loop body)
- Modify: `examples/angular-upgrade/tests/test_flow.py` (append two tests)

**Interfaces:**
- Consumes: `teamcity.configured()` and `teamcity.wait_for_build(build_type, sha)` from Task 1; the `teamcity_server` fixture from Task 1; `flow.py`'s loop from Tasks 2 and 3.
- Produces: `prompts/fix.md` → `{"done": bool, "commit": str, "summary": str, "blockers": list[str]}`, rendered with `{{task.*}}`, `{{build.status}}`, `{{build.url}}`, `{{build.excerpt}}`, `{{previous}}`, `{{branch}}`; the journal keys `ci/<id>` (kind `step`, result `{status, url, excerpt}`) and `fix/<id>/<n>`; the flow constant `MAX_FIX = 3`.

- [ ] **Step 1: Write the failing tests**

Append to `examples/angular-upgrade/tests/test_flow.py`:

```python
def test_a_successful_teamcity_build_is_journaled_and_no_fix_loop_runs(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    fake_codex.script([{"output": PLAN}, {"output": DONE}, {"output": REVIEW_OK}])
    teamcity_server.serve([{"build": [dict(BUILD, status="SUCCESS")]}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["ci/app"]["result"] == {"status": "SUCCESS", "url": "http://tc/viewLog.html?buildId=42",
                                         "excerpt": ""}
    assert "fix/app/1" not in steps
    assert "revision%3A%28version%3A" + "a" * 40 in teamcity_server.requests()[0]["path"]


def test_a_failing_teamcity_build_runs_the_fix_loop_with_the_failed_tests(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    fake_codex.script([{"output": PLAN}, {"output": DONE}, {"output": FIXED}, {"output": REVIEW_OK}])
    teamcity_server.serve([{"build": [dict(BUILD, status="FAILURE")]},
                           {"testOccurrence": [{"name": "AppComponent should render title"}]}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["ci/app"]["result"]["status"] == "FAILURE"
    assert steps["fix/app/1"]["result"]["commit"] == "b" * 40
    fix_prompt = fake_codex.calls()[2]["prompt"]
    assert "AppComponent should render title" in fix_prompt and "http://tc/viewLog.html?buildId=42" in fix_prompt
    assert "b" * 40 in (goal_folder / "JANUS.md").read_text(encoding="utf-8")
```

The last assertion checks the `merge` gate's `show`: the commit the human is asked to merge is the fix commit, not the implement commit.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q`
Expected: `2 failed, 108 passed`. Both fail inside the third scripted Codex call, which the flow never makes: without the CI block the flow goes straight from the implement result to `review`, so the `FIXED` answer is fed to the review step and the engine rejects it with `janus.JanusError: codex final message does not match the output schema ($: expected exactly the keys ['summary', 'passed', 'reasons'], got ['blockers', 'commit', 'done', 'summary'])`; the first test fails earlier with `KeyError: 'ci/app'`.

- [ ] **Step 3: Write the fix prompt**

Create `examples/angular-upgrade/prompts/fix.md`:

```markdown
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
```

- [ ] **Step 4: Add the CI block to the flow**

In `examples/angular-upgrade/flow.py`, change the import block from:

```python
from janus import Exhausted, ai_gate, codex, context, decision, human_gate, log, ralph

BRANCH = "ai/angular-15-to-16"
MAX_IMPLEMENT = 5
```

to:

```python
from janus import Exhausted, ai_gate, codex, context, decision, human_gate, log, ralph, step

import teamcity

BRANCH = "ai/angular-15-to-16"
MAX_IMPLEMENT = 5
MAX_FIX = 3
```

and insert this block in the loop, between the `try/except Exhausted` statement and the `finished.append(...)` call:

```python
    if teamcity.configured():
        build = step("ci/%s" % task["id"],
                     lambda: teamcity.wait_for_build(task["build_type"], result["commit"]))
        log("task %s build %s: %s" % (task["id"], build["status"], build["url"]))
        if build["status"] != "SUCCESS":
            result = ralph("prompts/fix.md", until=lambda r: r["done"], max_iter=MAX_FIX,
                           key="fix/%s" % task["id"], cwd=task["repo"], task=task, build=build)
```

Also update the module docstring's second paragraph to name the CI wait:

```python
"""Upgrade every Angular application in this folder, one repository at a time.

Plan with Codex, let a human approve the plan, implement each task in a ralph loop, wait for
TeamCity when it is configured, let Codex review the result and let the human merge. Every step
has an explicit key, so editing this file does not shift the keys of finished steps.
"""
```

Notes for the implementer: the lambda closes over `task` and `result`, which is safe because `step` calls it immediately inside this iteration. The whole CI wait is one journaled `step`, so a run that is killed while polling re-polls on the next run rather than re-triggering anything; `wait_for_build` only reads. `teamcity.configured()` itself is not journaled, and must not be: it is a pure environment read, and a flow that is run once with TeamCity and once without must simply take the other branch.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `110 passed`.

- [ ] **Step 6: Commit**

```bash
git add examples/angular-upgrade/prompts/fix.md examples/angular-upgrade/flow.py \
  examples/angular-upgrade/tests/test_flow.py
git commit -m "feat(example): wait for teamcity and run a fix loop when the build is red" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The example's `README.md`

Spec §10 (the example is what a new goal folder is copied from), §3 ("A new goal starts by copying an example folder, editing `# Goal` in `JANUS.md`, adjusting `flow.py` and the prompts, and running `python janus.py run`"), slice 1 readiness note on the environment that Codex inherits.

**Files:**
- Create: `examples/angular-upgrade/README.md`

**Interfaces:**
- Consumes: every file of Tasks 1 to 4, by name; the journal keys they produce.
- Produces: the document that Task 6 appends the trial report to, under a `## Trial` heading.

- [ ] **Step 1: Write the README**

Create `examples/angular-upgrade/README.md`:

````markdown
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
| `prompts/_preamble.md` | Prepended to every prompt: the branch, the commit and the safety rules. |
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

$EDITOR JANUS.md                      # edit "# Goal": the repositories, the checks, the branch
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
````

- [ ] **Step 2: Check the README against the files it describes**

Run:

```bash
ls examples/angular-upgrade examples/angular-upgrade/prompts examples/angular-upgrade/tests
grep -n "key=" examples/angular-upgrade/flow.py
uv run pytest -q
```

Expected: every file named in the README's table exists; the keys in `flow.py` are `plan`,
`approve-plan`, `implement/%s`, `%s/exhausted`, `%s/retry`, `ci/%s`, `fix/%s`, `review`,
`review-findings`, `merge`, matching the second table; `110 passed`.

- [ ] **Step 3: Commit**

```bash
git add examples/angular-upgrade/README.md
git commit -m "docs(example): describe the angular upgrade example and its goal folder" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The trial on the throwaway Angular 15 app with real Codex

Spec §10 ("The example is tried on the throwaway Angular 15 application with a local bare remote and real Codex, without TeamCity. The trial report goes into the example's `README.md`"), §12.7 ("The Angular example runs on the throwaway app with real Codex through plan, approval gate, implementation loop and review gate"), §11 slice 2.

**This task is manual and is the acceptance test of the slice.** It is not test-driven: it runs the software that Tasks 1 to 5 built and writes down what happened.

**Files:**
- Create (outside the repository): `/home/race-day/janus-trial/angular-16-upgrade/` and `/home/race-day/janus-trial/origin/`
- Modify: `examples/angular-upgrade/README.md` (append the `## Trial` section)
- Never modify: `/home/race-day/janus-spike/ng15-app` (read with `git clone --bare` only)

**Interfaces:**
- Consumes: the whole example folder from Tasks 1 to 5 and `janus.py` at the repository head.
- Produces: the trial report in `README.md` under `## Trial: Angular 15 to 16 with real Codex`, and a verdict on spec §12.7.

**Rules for the executor, all of them binding:**

1. **A Codex call may take a long time.** The model is `gpt-5.6-sol` at `xhigh` reasoning and it is running `pnpm install`, `ng update`, a build and a karma run. How long that takes on this machine is **unknown** — it may be several minutes per call and the implement loop may make several calls. Do not kill a run because it seems stuck: Codex streams its transcript to stderr, so the run is visible. Start each `run` in the background or with a very generous timeout (two hours), and wait. Record the wall-clock time of each run.
2. **Never repair the app by hand.** If the build or the tests fail, that is a result to record, not a problem to fix. Do not edit anything under `app/`, do not run `ng update` yourself, do not amend Codex's commits. The trial is only worth something if it is what the flow did.
3. **If a Codex step fails** (exit 1, `JanusError` in `journal.yaml`), record the error text, then run again once — the engine re-executes a failed step with `attempt` incremented, and that is exactly the behaviour the trial should show. If it fails a second time with the same error, stop and record it as a failure of the trial.
4. **If `Exhausted` fires**, the flow opens the `implement/app/exhausted` decision. Answer it honestly: `retry` once if the last result reads like it was close, `skip` or `stop` if it reads like it was not. Record the question, the `show` block, the answer and the reason for it.
5. **If the flow needs something the primitives cannot express** — a gap in the engine, not a bug in the prompts — stop the trial, write the gap into the trial report with the exact step it appeared at, and do **not** change `janus.py` here. A separate engine change, if one is needed, is proposed after this slice and is not part of it.
6. Answer every gate by editing `JANUS.md` after `answer:` and running again. Each answer is its own step of this task; do not batch them.

- [ ] **Step 1: Build the trial goal folder**

```bash
mkdir -p /home/race-day/janus-trial/origin
cp -r /home/race-day/janus/examples/angular-upgrade /home/race-day/janus-trial/angular-16-upgrade
cd /home/race-day/janus-trial/angular-16-upgrade
rm -rf tests README.md
cp /home/race-day/janus/janus.py .
git clone --bare /home/race-day/janus-spike/ng15-app /home/race-day/janus-trial/origin/ng15-app.git
git clone /home/race-day/janus-trial/origin/ng15-app.git app
git init -q --bare /home/race-day/janus-trial/origin/angular-16-upgrade.git
git init -q -b main .
git add -A
git commit -q -m "chore(trial): angular 16 upgrade goal folder from the example"
git remote add origin /home/race-day/janus-trial/origin/angular-16-upgrade.git
git push -q -u origin main
git status --porcelain
git -C app log --oneline
ls
```

Expected: `git status --porcelain` prints nothing (the `.gitignore` keeps `app/` out); `git -C app log --oneline` shows `f8dc4e4 initial commit` on branch `master`; `ls` shows `JANUS.md`, `app`, `flow.py`, `janus.py`, `prompts`, `teamcity.py`. `/home/race-day/janus-spike/ng15-app` is untouched — check with `git -C /home/race-day/janus-spike/ng15-app status --porcelain` (empty) and `git -C /home/race-day/janus-spike/ng15-app log --oneline` (still one commit).

- [ ] **Step 2: Write the trial goal and confirm TeamCity is off**

Replace the `# Goal` section of `/home/race-day/janus-trial/angular-16-upgrade/JANUS.md` with:

```markdown
# Goal
Upgrade the Angular application in the sub-folder `app` from Angular 15 to Angular 16.

`app` is a Git clone with the remote `origin` (a local bare repository). The package manager is
pnpm 10. Google Chrome is at `/usr/bin/google-chrome`, so the unit tests run headless. Node is
v24.5.0 and the npm registry is reachable.

The task is done when, in `app`:

- `pnpm install` succeeds;
- `pnpm ng update @angular/core@16 @angular/cli@16` has been run and every migration it offers
  has been applied;
- `package.json` asks for Angular 16 and no `@angular/*` dependency is left at 15;
- `pnpm build` succeeds;
- `pnpm test --watch=false --browsers=ChromeHeadless` succeeds, with all three existing specs
  passing and none skipped or removed (pass the flags exactly like that: `pnpm test -- --flag`
  is rejected by the Angular CLI);
- the work is committed on the branch `ai/angular-15-to-16` and that branch is pushed to `origin`.

Do not upgrade past 16, do not change unrelated dependencies, do not touch `typescript`, and do
not reformat files the upgrade does not touch. There is no TeamCity for this trial.
```

Then confirm the environment:

```bash
cd /home/race-day/janus-trial/angular-16-upgrade
env | grep -c JANUS_TEAMCITY || true
python3 -c "import yaml; print('pyyaml ok')"
codex --version
python3 janus.py status
git add JANUS.md && git commit -q -m "chore(trial): the trial goal" && git push -q
```

Expected: `env | grep -c JANUS_TEAMCITY` prints `0`; `pyyaml ok`; `codex-cli 0.155.1`; `status` prints `no journal; nothing has run yet` and `next: python janus.py run`.

- [ ] **Step 3: Run to the approval gate (real Codex, the `plan` step)**

```bash
cd /home/race-day/janus-trial/angular-16-upgrade
time python3 janus.py run > ../run1.log 2>&1; echo "exit=$?"
tail -40 ../run1.log
python3 janus.py status
sed -n '/## Gate: approve-plan/,$p' JANUS.md
```

Expected: exit 2; `JANUS.md` holds `## Gate: approve-plan` with the question, the trimmed plan
(`summary:` and one `- app [app] ...` line) indented by four spaces, and an empty `answer:`;
`journal.yaml` has `plan` done and `approve-plan` open; the goal folder has a commit per status
change and they are pushed to the bare remote. Record: the wall-clock time, the plan's `summary`,
every task record from `journal.yaml`, and whether `repo` really is `app` and `build_type` is
`none`.

If the `plan` step fails, follow rule 3 above.

- [ ] **Step 4: Approve the plan and run the implement loop (real Codex, the long one)**

```bash
cd /home/race-day/janus-trial/angular-16-upgrade
$EDITOR JANUS.md          # write: answer: yes
time python3 janus.py run > ../run2.log 2>&1; echo "exit=$?"
tail -60 ../run2.log
python3 janus.py status
```

Expected, when the upgrade goes through in one or two ralph iterations: exit 2 at the `merge`
gate, with `implement/app/1` (and possibly `/2` …) and `review` done in `journal.yaml`. If the
review did not pass, the run stops at `review-findings` instead — that is a legitimate outcome;
read the reasons in `journal.yaml` and record them.

If `Exhausted` fires first, the run exits 2 at `implement/app/exhausted`; follow rule 4, record
the decision, and run again.

Record: the wall-clock time, the number of ralph iterations, each iteration's `done`, `summary`
and `blockers`, the review's `passed`, `reasons` and `summary`, and every gate question and
answer.

- [ ] **Step 5: Verify the app by hand, without touching it**

```bash
cd /home/race-day/janus-trial/angular-16-upgrade/app
git log --oneline --graph --all
git status --porcelain
git branch -a
git diff master..ai/angular-15-to-16 --stat
grep -A14 '"dependencies"' package.json
pnpm build; echo "build=$?"
pnpm test --watch=false --browsers=ChromeHeadless; echo "test=$?"
git -C /home/race-day/janus-trial/origin/ng15-app.git branch
```

Expected: a branch `ai/angular-15-to-16` with one or more commits by Codex; `@angular/*` at
`^16.*`; `build=0`; `test=0` with `TOTAL: 3 SUCCESS`; the bare remote lists the branch if Codex
pushed it. Record all of it exactly as it comes out, including anything that fails — `build=1`
or a missing branch is a result, not something to repair (rule 2). `git status --porcelain`
should be empty; if it is not, record what Codex left uncommitted.

- [ ] **Step 6: Answer the merge gate and finish the flow**

```bash
cd /home/race-day/janus-trial/angular-16-upgrade
sed -n '/## Gate: merge/,$p' JANUS.md
$EDITOR JANUS.md          # write: answer: merged
time python3 janus.py run > ../run3.log 2>&1; echo "exit=$?"
python3 janus.py status
python3 janus.py run; echo "second run exit=$?"
git log --oneline | head -30
cat journal.yaml
sed -n '/## Decisions/,$p' JANUS.md
```

Expected: exit 0 and `flow ended`; the last run repeats nothing (no new `codex` process, the
journal is unchanged); `## Decisions` holds one entry per answered gate with its date; the goal
folder's Git log has one commit per status change, pushed to the bare remote. Record the full
list of journal keys with their kind, status and attempt.

- [ ] **Step 7: Write the trial report into the example's README**

Append to `/home/race-day/janus/examples/angular-upgrade/README.md`, filling every field from
what Steps 1 to 6 actually produced. Do not soften anything: a failed check, a retried step or a
prompt that had to be read twice is the most valuable part of this report.

````markdown
## Trial: Angular 15 to 16 with real Codex, 2026-09-__

Run on one throwaway application, without TeamCity, to satisfy spec criterion 12.7.

**Setup.** Goal folder `/home/race-day/janus-trial/angular-16-upgrade`, a Git repository with
the bare remote `/home/race-day/janus-trial/origin/angular-16-upgrade.git`. `janus.py` copied
from the repository at commit `<sha>`. The application is `app/`, a clone of the throwaway
`ng15-app` (Angular 15.2, three karma specs, default branch `master`) through the bare remote
`/home/race-day/janus-trial/origin/ng15-app.git`. Codex is codex-cli 0.155.1, model
`gpt-5.6-sol` at `xhigh` reasoning, from the user's own `~/.codex/config.toml`; Janus passes no
model flags. `JANUS_TEAMCITY_URL` and `JANUS_TEAMCITY_TOKEN` were unset, so the flow skipped
`ci/app` and `fix/app`.

**Runs.**

| Run | Command | Wall clock | Exit | Stopped at |
|---|---|---|---|---|
| 1 | `python3 janus.py run` | __ | 2 | gate `approve-plan` |
| 2 | `python3 janus.py run` | __ | _ | _ |
| 3 | `python3 janus.py run` | __ | 0 | flow ended |
| 4 | `python3 janus.py run` | __ | 0 | flow ended, nothing re-executed |

**Gates.**

| Key | Question | Shown | Answer |
|---|---|---|---|
| `approve-plan` | … | … | `yes` |
| `merge` | … | … | `merged` |

**What Codex did.**

- `plan`: summary `…`; one task `id: app`, `repo: app`, `build_type: none`, objective `…`.
- `implement/app/1`: `done: …`, summary `…`, blockers `…`.
- `review`: `passed: …`, reasons `…`, summary `…`.

**The result in `app/`.**

```text
<git log --oneline --graph of the branch>
<git diff master..ai/angular-15-to-16 --stat>
```

`pnpm build` exited `_`; `pnpm test --watch=false --browsers=ChromeHeadless` exited `_` with
`TOTAL: _ SUCCESS`. `@angular/*` is at `…`. The branch `ai/angular-15-to-16` was / was not
pushed to the bare remote.

**Journal.** `<key: kind status attempt>` for every step, in order.

**Problems.**

- …

**Engine gaps found.** None / `<the primitive, the step it appeared at, what could not be
expressed>`. No change was made to `janus.py` for this trial.

**Verdict on spec 12.7.** The example ran / did not run on the throwaway app with real Codex
through plan, approval gate, implementation loop and review gate.
````

- [ ] **Step 8: Commit the report**

```bash
cd /home/race-day/janus
uv run pytest -q
git add examples/angular-upgrade/README.md
git commit -m "docs(example): trial report of the angular upgrade flow with real codex" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: `110 passed`, then one commit. The trial folder under `/home/race-day/janus-trial/`
is deliberately left in place as the evidence behind the report; nothing outside
`examples/angular-upgrade/README.md` is committed by this task.

---

## Self-review notes

- **Spec coverage.** §10 file list: `flow.py` (Tasks 2, 3, 4), `prompts/_preamble.md`, `plan.md`, `implement.md`, `review.md` (Task 2), `fix.md` (Task 4), `teamcity.py` (Task 1), `JANUS.md` (Task 2), `.gitignore` (Task 2), `README.md` (Tasks 5, 6). §10 flow outline: plan and approval gate (Task 2), the per-task ralph with `until=lambda r: r["done"]`, `max_iter=5` and key `implement/<id>` (Task 2), `Exhausted` → `decision(["retry","skip","stop"])` (Task 3), `teamcity.configured()` → `step(f"ci/{id}")` → `fix.md` ralph (Task 4), `ai_gate` review and the `merge` gate (Task 2). §10 preamble rules: Task 2 Step 3, one bullet per rule the brief lists. §10 `teamcity.py` behaviour and REST paths: Task 1. §10 trial and report: Task 6. §11 slice 2's engine-change permission: covered by the design decision on `ai_gate` and by rule 5 of Task 6; no engine task is included because no primitive was found unable to express the flow. §12.7: Task 6. §2 "pytest suite with a fake `codex`": Tasks 1 to 4. §3 goal folder layout and `.gitignore`: Task 2 and Task 6 Step 1. §12.6 and §12.8 are unaffected: nothing in this plan touches `janus.py`.
- **The code was assembled and run.** Every code block of Tasks 1 to 4 was written into `/tmp/claude-1000/-home-race-day-janus/c409ef97-b416-4a1f-9d47-9cfdebff5afd/scratchpad/plan2-check` beside a copy of `janus.py`, `pyproject.toml` and `tests/` from the repository at `ccae194`, and run with the repository's pytest (9.1.1) at each red and green step. The summaries stated in the plan are the ones observed: Task 1 red `1 error in 0.08s` (`ModuleNotFoundError: No module named 'teamcity'`, collection interrupted), green `103 passed`; Task 2 red `103 passed, 3 errors` (`FileNotFoundError ... flow.py` from the `goal_folder` fixture), green `106 passed`; Task 3 red `2 failed, 106 passed` (`janus.Exhausted: ralph exhausted`), green `108 passed`; Task 4 red `2 failed, 108 passed` (`KeyError: 'ci/app'` and the schema mismatch quoted in the task), green `110 passed`. The full suite is `110 passed in 6.1s`.
- **Rendering was checked against the fake Codex outputs, not assumed.** `test_every_prompt_renders_with_the_branch_the_goal_and_the_task` asserts the preamble's `{{branch}}` and `{{goal}}` in the plan prompt, `{{task.title}}` and `{{attempt}}` in the first implement prompt, `{{previous}}` in the second, and `{{tasks}}` in the review prompt; `test_a_failing_teamcity_build_...` asserts `{{build.excerpt}}` and `{{build.url}}` in the fix prompt. An undefined placeholder fails its step before Codex starts and would show up as an exit code 1 and a `failed` journal entry, so the exit-code and key assertions of all seven flow tests cover the remaining placeholders. Every field the flow reads (`plan["summary"]`, `plan["tasks"]`, `task["id"]`, `task["repo"]`, `task["title"]`, `task["build_type"]`, `result["done"]`, `result["commit"]`, `result["summary"]`, `exc.last["summary"]`, `exc.last["blockers"]`, `build["status"]`, `build["url"]`) is declared in the matching prompt's `output`, and the two schemas are asserted in the tests.
- **The `.gitignore` was tested in a scratch Git repository**, not reasoned about: with `*/`, `!prompts/`, `!journals/`, `!tests/`, `*.tmp`, `git add -A` stages `flow.py`, `.gitignore`, `JANUS.md`, `journals/2026.yaml`, the five prompts, `teamcity.py` and the three test files, while `git check-ignore -v` reports `app/src/main.ts` ignored by `*/` and `journal.yaml.abc.tmp` ignored by `*.tmp`.
- **The trial's mechanics were rehearsed without Codex.** `git clone --bare /home/race-day/janus-spike/ng15-app origin/ng15-app.git` followed by `git clone origin/ng15-app.git app` produces a 672 KB working tree on branch `master`; `pnpm install` there takes 1.1 s from the warm store and `pnpm build` and `pnpm test --watch=false --browsers=ChromeHeadless` then exit 0 with `TOTAL: 3 SUCCESS`. The spike folder was left untouched (`git status --porcelain` empty, one commit). The real Codex was **not** run and the trial was **not** performed; Task 6 is for the executor.
- **Type and name consistency.** `wait_for_build` is called in `flow.py` exactly as Task 1 declares it (`build_type, sha`) and its `{status, url, excerpt}` result is what `fix.md` and the tests read. The fixtures named in Tasks 2 to 4 (`goal_folder`, `fake_codex`, `teamcity_server`, `without_teamcity`) are the ones Task 1 creates. The test helpers `run`, `answer`, `journal_of` and the constants `PLAN`, `NOT_DONE`, `DONE`, `FIXED`, `REVIEW_OK`, `BUILD` are defined once, in Task 2, and used unchanged in Tasks 3 and 4. The journal keys in `flow.py`, in the README's table and in the tests are the same strings.
- **Placeholder scan.** No "TBD", "TODO", "handle edge cases" or "similar to Task N" remains; every code step carries its code in full, and the two edits in Tasks 3 and 4 quote both the old and the new lines. The blanks in the trial report template of Task 6 are fields for measurements that do not exist yet — they are the deliverable of that task, not unwritten plan content.
- **Known limitation left in deliberately.** `ai_gate` returns only its boolean, so the `review-findings` gate sends the human to `journal.yaml` instead of showing the reasons, exactly as the spec's own outline does. If the trial shows that this is painful in practice, it is the first engine change to propose after this slice.
