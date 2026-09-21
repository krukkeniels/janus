# Janus 3.0 Slice 1: Local Checks Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `janus.py` and the `JANUS.md` contract for spec §10 slice 1: one product repository, `plan` → `approve` → `run` → `status`, with the local checks loop, diff guardrails, bounded Codex fix attempts, runner-owned commits pushed to a local bare `origin`, lock, checkpoints and crash resume.

**Architecture:** One procedural Python file (`janus.py`) with small functions named as in spec §10; the goal document is `JANUS.md` (YAML front matter parsed with PyYAML, Markdown body kept byte for byte). `subprocess` drives `git` and `codex exec`; `hashlib` seals the approved plan; `fcntl` gives single-run protection. Tests are pytest with temporary git repositories plus a local bare remote and a fake `codex` executable on `PATH`. No TeamCity, Bitbucket, E2E, prerelease or AI review in this slice, but the front matter keeps `pr_build`, `e2e`, `prs` and `last_verified` so later slices need no format change.

**Tech Stack:** Python 3.9+ (`from __future__ import annotations`, no `match`, no `X | Y` annotations evaluated at runtime, no `tomllib`), PyYAML 6, pytest 8 via `uv`, git 2.43, codex-cli 0.146.

**Spec:** `/home/race-day/janus/janus-3.0-spec.md` (v0.2). Every task below cites the spec section it implements; executors read both.

## Global Constraints

Copied from the spec where they bind implementation; every task's requirements include this section.

- Spec §1: "Python 3.9 or newer, standard library plus PyYAML." Development machine has Python 3.12.3; the deployment target is 3.9, so use `from __future__ import annotations`, `typing.Optional/List/Dict/Tuple`, no `match`, no runtime `X | Y`, no `tomllib`, no `str.removeprefix` reliance beyond 3.9.
- Spec §1: "There is no state machine framework, database, daemon, plugin architecture, provider interface, per-role JSON schema, separate plan YAML, persisted fake service, or custom telemetry service." All runtime code lives in `janus.py` as small procedural functions. No classes except the `Goal` dataclass. No provider interfaces, no plugin seams.
- Spec §10 function names are used exactly: `load_goal`, `save_checkpoint`, `verify_plan_approval`, `discover_repos`, `run_codex`, `record_heads`, `check_heads_unchanged`, `run_checks`, `diff_guardrails`, `git_commit_push`, `show_status`. `ensure_pr`, `find_or_trigger_build`, `wait_and_summarize_build`, `trigger_full_e2e`, `run_review` belong to later slices and MUST NOT be stubbed in.
- Spec §3: "Never commit product source or credentials into the control repo." The control repo `.gitignore` contains `*/`, `.janus.lock`, `.janus-interrupted.patch`.
- Spec §4: "The runner owns `status`, `approval`, task statuses, `current_task`, `last_verified`, `prs`, `attempts`, `in_flight` and the Progress section. Codex never edits `JANUS.md` after approval; the runner updates it from Codex's structured summary and from verified external results."
- Spec §4: "`janus approve` computes a hash of the Goal section, `angular`, `repos`, `e2e`, the task ids/repos/objectives in order, and the Approved-plan content section ... Runtime fields are excluded from the hash. `janus run` stops if approved content has changed. Replanning requires a new explicit approval."
- Spec §5: "never put secrets in `JANUS.md`, CLI arguments, agent prompts or stored logs." Check output is redacted before it enters a prompt or `JANUS.md`.
- Spec §6: "Does not overwrite commits or force push." "Never regards an older green build as proof for a new commit." "retries at most **3 code-fix attempts per task**." "must not present the intermediate result as green." In slice 1 there is no CI: after a push the runner records `status: "local_checks_passed"` and stops with a handover saying CI is not configured; it never presents local checks as green CI and never marks a task `done` on its own.
- Spec §8: "Do not silently discard changes. If ownership of the dirty tree is unclear, stop for a human." "Only one runner process may operate on a goal at a time; use a local process lock. Do not force-push, reset unknown work or auto-resolve unexpected remote branch divergence." "After a checkpoint, push the control repo. If the control push fails, stop before moving to the next task."
- Spec §9: "Codex runs with full access to the workspace. Only the runner performs product Git commit/push ... The runner records all branch heads before each Codex run and stops if any ref moved afterwards." Codex is invoked with `--dangerously-bypass-approvals-and-sandbox`; the user's `~/.codex/config.toml` (model `gpt-5.6-sol`, `model_reasoning_effort = "xhigh"`) is not overridden (no `-m`, no `-c model=`).
- Spec §10: "`PyYAML` parses and rewrites the front matter; preserve the Markdown body byte for byte." "Do not introduce abstractions before there are two real implementations needing one."
- Spec §10 tests: pytest in `tests/`; git behaviour against temporary repositories with a local bare remote; Codex replaced by a fake `codex` executable on `PATH`. Tests never call the real `codex` and never need the network.
- Tooling: `pyproject.toml` with `[project] dependencies = ["pyyaml>=6"]`, `[dependency-groups] dev = ["pytest>=8"]`, `[tool.pytest.ini_options] pythonpath = ["."]`. Verification command in every task: `uv run pytest -q` (uv is `/snap/bin/uv`; it creates `.venv` and `uv.lock`).
- Commits: conventional commits with a scope (`feat(janus): ...`, `test(janus): ...`, `chore(tooling): ...`, `docs(janus): ...`). Every commit uses the two-`-m` form so the trailer is separated by a blank line: `git commit -m "type(scope): subject" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.
- Janus 2.x (`8bf3f0f`) is history only. Nothing is ported and this plan references no v2 code.

## Verified facts about this machine

- `python3` is 3.12.3. PyYAML 6.0.1 is installed system-wide (so `python3 janus.py` works in a control repo without a venv); pytest is not (hence `uv run pytest`).
- `codex` is codex-cli 0.146.0 at `~/.nvm/versions/node/v24.5.0/bin/codex`. `codex exec` flags used: `-C <DIR>`, `--output-schema <FILE>`, `--output-last-message <FILE>`, `--dangerously-bypass-approvals-and-sandbox`; the prompt is read from stdin when the positional argument is `-`.
- NOT verified offline: whether codex-cli 0.146 forwards `--output-schema` to the model in strict structured-output mode. The schema is written to satisfy strict mode anyway (every object lists all properties in `required`, `additionalProperties: false`, no free-form maps), which non-strict mode also accepts. Therefore string maps travel as arrays of `{name, value}` objects and `config` is fully typed (Task 6); the runner converts them to the dict shapes shown in spec §4. Task 12 Step 3 records what happens with the real Codex.
- git 2.43.0, Node v24.5.0. Angular CLI on `PATH` reports itself as 11.x; the trial (Task 12) uses `npx @angular/cli@<major>` explicitly.

## File structure

| Path | Responsibility |
|---|---|
| `janus.py` | All runtime code. Sections in this order, separated by banner comments: constants and errors; goal file I/O; workspace; git; plan hash and approval; codex; plan; checks and guardrails; run; status; CLI. Each task says where its code goes. |
| `JANUS.md` | The template/contract: a valid pre-plan goal file (`# Goal` only) whose HTML comment documents the front matter fields, ownership and standard sections. Copied into each control repo. |
| `pyproject.toml`, `uv.lock`, `.gitignore` | Tooling. |
| `tests/helpers.py` | Tiny git wrapper, repo builders, goal-file builders shared by tests. |
| `tests/conftest.py` | `ws` fixture (control repo + product repo `app` + bare `origin`) and `fake_codex` fixture. |
| `tests/test_cli.py`, `test_goal_file.py`, `test_workspace.py`, `test_git.py`, `test_approve.py`, `test_codex.py`, `test_plan.py`, `test_checks.py`, `test_run.py`, `test_resume.py`, `test_status.py` | One test module per task. |

## Front matter contract for slice 1 (fixed here, used by every task)

```yaml
id: angular-15-to-16               # runner: f"angular-{from}-to-{to}"
status: awaiting_plan_approval     # runner: awaiting_plan_approval | approved | executing | blocked | done
angular: {from: 15, to: 16}        # Codex proposes
approval: {plan_hash: null, approved_by: null, approved_at: null}   # runner
repos:                             # Codex proposes; human edits
  - {name: app, base: main, branch: ai/angular-15-to-16, pr_build: null, checks: ["npm ci", "npm test -- --watch=false"]}
e2e: null                          # Codex proposes; unused in slice 1, kept for later slices
tasks:                             # Codex proposes id/repo/objective; runner owns status, values, summary, blockers
  - {id: 1, repo: app, objective: Upgrade app to Angular 16, status: pending}
                                   # task status: pending | in_progress | awaiting_ci | done | blocked
current_task: null                 # runner
last_verified: {}                  # runner: repo -> {commit, teamcity_build, status}; status local_checks_passed in slice 1
prs: {}                            # runner; unused in slice 1
attempts: 0                        # runner: code-fix attempts used on current_task (max 3)
in_flight: null                    # runner: {task, repo, start_sha, operation, attempt, started_at}
```

Body sections (Janus headings are `#`/`##`; `###` and deeper belong to the enclosing section): `# Goal` (human), `## Approved-plan content` (Codex draft, human edits), `## Rules` (fixed text), `## Review feedback` (human), `## Progress and handover` (runner-owned, regenerated at each checkpoint), `## Decisions` (human; `approve` appends one line).

---

### Task 1: Tooling, module skeleton and CLI dispatch

Spec §5 (four commands), §10 (single script, pytest in `tests/`).

**Files:**
- Create: `pyproject.toml`, `.gitignore`, `janus.py`, `tests/test_cli.py`

**Interfaces:**
- Produces: `JanusError(Exception)`; constants `GOAL_FILE = "JANUS.md"`, `LOCK_FILE = ".janus.lock"`, `PATCH_FILE = ".janus-interrupted.patch"`; `require_goal_file(root: Path) -> Path`; `main(argv: Optional[List[str]] = None) -> int` returning 0 on success, 1 when stopped for a human, 2 on `JanusError`; `COMMANDS` dict mapping command name to `cmd_<name>(root: Path) -> int`. Later tasks replace the bodies of `cmd_plan`, `cmd_approve`, `cmd_run`, `cmd_status` in place.

- [ ] **Step 1: Write the tooling files**

`pyproject.toml`:

```toml
[project]
name = "janus"
version = "3.0.0"
description = "Janus 3.0: minimal AI development orchestrator (one script, one goal file)"
requires-python = ">=3.9"
dependencies = ["pyyaml>=6"]

[dependency-groups]
dev = ["pytest>=8"]

[tool.pytest.ini_options]
pythonpath = ["."]
testpaths = ["tests"]
```

`.gitignore`:

```gitignore
.venv/
__pycache__/
.pytest_cache/
*.pyc
.janus.lock
.janus-interrupted.patch
```

- [ ] **Step 2: Write the failing test**

`tests/test_cli.py`:

```python
import pytest

import janus


def test_status_without_goal_file_reports_missing_file(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert janus.main(["status"]) == 2
    assert "JANUS.md not found" in capsys.readouterr().err


def test_unknown_command_is_a_usage_error(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit) as exc:
        janus.main(["frobnicate"])
    assert exc.value.code == 2
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `uv run pytest -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'janus'` (uv creates `.venv` and `uv.lock` on this first run).

- [ ] **Step 4: Write the skeleton**

`janus.py`:

```python
#!/usr/bin/env python3
"""Janus 3.0: a small controlled runner. Codex performs development, Janus controls
the workflow, Git retains the work, humans approve plans and merge.
See janus-3.0-spec.md. Everything lives in this one file on purpose."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List, Optional

# --- constants and errors ---------------------------------------------------

GOAL_FILE = "JANUS.md"
LOCK_FILE = ".janus.lock"
PATCH_FILE = ".janus-interrupted.patch"


class JanusError(Exception):
    """A condition that stops the command with a message for the human."""


def require_goal_file(root: Path) -> Path:
    path = root / GOAL_FILE
    if not path.exists():
        raise JanusError(f"{GOAL_FILE} not found in {root}; write a '# Goal' section there first")
    return path


# --- goal file --------------------------------------------------------------

# --- workspace --------------------------------------------------------------

# --- git --------------------------------------------------------------------

# --- plan hash and approval -------------------------------------------------

# --- codex ------------------------------------------------------------------

# --- plan -------------------------------------------------------------------

# --- checks and guardrails --------------------------------------------------

# --- run --------------------------------------------------------------------

# --- status -----------------------------------------------------------------

# --- CLI --------------------------------------------------------------------


def cmd_plan(root: Path) -> int:
    require_goal_file(root)
    raise JanusError("plan is not available in this build yet")


def cmd_approve(root: Path) -> int:
    require_goal_file(root)
    raise JanusError("approve is not available in this build yet")


def cmd_run(root: Path) -> int:
    require_goal_file(root)
    raise JanusError("run is not available in this build yet")


def cmd_status(root: Path) -> int:
    require_goal_file(root)
    raise JanusError("status is not available in this build yet")


COMMANDS = {
    "plan": (cmd_plan, "discovery + baseline + draft plan; then stop"),
    "approve": (cmd_approve, "interactive human approval of the displayed plan"),
    "run": (cmd_run, "advance until the next human gate, block or completion"),
    "status": (cmd_status, "concise state and next action"),
}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="janus", description="Minimal AI development orchestrator")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, (_, help_text) in COMMANDS.items():
        sub.add_parser(name, help=help_text)
    args = parser.parse_args(argv)
    root = Path.cwd()
    try:
        return COMMANDS[args.command][0](root)
    except JanusError as exc:
        print(f"janus: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
```

The four `cmd_*` bodies are skeletons that later tasks replace: Task 7 (`cmd_plan`), Task 5 (`cmd_approve`), Task 9 (`cmd_run`), Task 11 (`cmd_status`). `COMMANDS` stays as written because it references the functions by name.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `2 passed`

- [ ] **Step 6: Commit**

```bash
cd /home/race-day/janus
git add pyproject.toml uv.lock .gitignore janus.py tests/test_cli.py
git commit -m "chore(tooling): add janus.py skeleton, pytest via uv and CLI dispatch" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Goal file I/O (front matter round trip, sections)

Spec §4 (contract), §10 ("preserve the Markdown body byte for byte").

**Files:**
- Modify: `janus.py` (section `# --- goal file ---`)
- Create: `tests/test_goal_file.py`

**Interfaces:**
- Consumes: `JanusError`, `GOAL_FILE`, `require_goal_file` (Task 1).
- Produces: `@dataclass Goal(root: Path, front: dict, body: str)`; `split_front_matter(text: str) -> Tuple[Optional[str], str]`; `load_goal(root: Path) -> Goal` (`front == {}` when the file has no front matter); `render_goal(goal: Goal) -> str`; `save_goal(goal: Goal) -> None`; `section(body: str, heading: str) -> Optional[str]` (text under an exact heading line such as `# Goal` or `## Rules`, stripped of surrounding blank lines; `None` when absent); `set_section(body: str, heading: str, content: str) -> str` (replace in place or append). Section boundaries: the next heading of level ≤ max(level of `heading`, 2), so `### ...` inside a `##` section belongs to it.

- [ ] **Step 1: Write the failing tests**

`tests/test_goal_file.py`:

```python
import pytest

import janus

GOAL_ONLY = "# Goal\nUpgrade Angular 15 to 16.\n"
WITH_FRONT = (
    "---\n"
    "id: angular-15-to-16\n"
    "status: awaiting_plan_approval\n"
    "repos:\n"
    "- name: app\n"
    "  checks:\n"
    "  - npm test -- --watch=false\n"
    "---\n"
    "# Goal\n"
    "Upgrade Angular 15 to 16.\n"
    "\n"
    "## Approved-plan content\n"
    "Draft until approved.\n"
    "\n"
    "### Order\n"
    "1. app\n"
    "\n"
    "## Rules\n"
    "Never weaken tests.\n"
)
BODY = WITH_FRONT.split("---\n", 2)[2]


def write(tmp_path, text):
    (tmp_path / "JANUS.md").write_text(text, encoding="utf-8")
    return tmp_path


def test_goal_without_front_matter_is_the_valid_pre_plan_state(tmp_path):
    goal = janus.load_goal(write(tmp_path, GOAL_ONLY))
    assert goal.front == {}
    assert goal.body == GOAL_ONLY
    assert goal.root == tmp_path


def test_round_trip_keeps_the_body_byte_for_byte(tmp_path):
    goal = janus.load_goal(write(tmp_path, WITH_FRONT))
    assert goal.front["repos"][0]["checks"] == ["npm test -- --watch=false"]
    assert goal.body == BODY
    janus.save_goal(goal)
    again = janus.load_goal(tmp_path)
    assert again.front == goal.front
    assert again.body == BODY
    assert (tmp_path / "JANUS.md").read_text(encoding="utf-8").endswith(BODY)


def test_saving_a_goal_without_front_matter_writes_the_body_only(tmp_path):
    goal = janus.load_goal(write(tmp_path, GOAL_ONLY))
    janus.save_goal(goal)
    assert (tmp_path / "JANUS.md").read_text(encoding="utf-8") == GOAL_ONLY


def test_render_adds_front_matter_once_it_exists(tmp_path):
    goal = janus.load_goal(write(tmp_path, GOAL_ONLY))
    goal.front = {"id": "x", "approval": {"plan_hash": None}}
    assert janus.render_goal(goal) == "---\nid: x\napproval:\n  plan_hash: null\n---\n" + GOAL_ONLY


def test_unclosed_front_matter_is_an_error(tmp_path):
    write(tmp_path, "---\nid: x\n# Goal\n")
    with pytest.raises(janus.JanusError, match="never closes"):
        janus.load_goal(tmp_path)


def test_missing_file_is_an_error(tmp_path):
    with pytest.raises(janus.JanusError, match="JANUS.md not found"):
        janus.load_goal(tmp_path)


def test_section_stops_at_the_next_janus_heading_but_keeps_subheadings():
    assert janus.section(BODY, "# Goal") == "Upgrade Angular 15 to 16."
    assert janus.section(BODY, "## Approved-plan content") == "Draft until approved.\n\n### Order\n1. app"
    assert janus.section(BODY, "## Rules") == "Never weaken tests."
    assert janus.section(BODY, "## Decisions") is None


def test_set_section_replaces_in_place_and_appends_when_missing():
    body = "# Goal\nA\n\n## Progress and handover\nold\n\n## Decisions\nd\n"
    replaced = janus.set_section(body, "## Progress and handover", "new")
    assert replaced == "# Goal\nA\n\n## Progress and handover\nnew\n\n## Decisions\nd\n"
    appended = janus.set_section("# Goal\nA\n", "## Decisions", "- first")
    assert appended == "# Goal\nA\n\n## Decisions\n- first\n"


def test_set_section_on_the_last_section_is_idempotent():
    body = "# Goal\nA\n\n## Decisions\nold\n"
    once = janus.set_section(body, "## Decisions", "new")
    assert once == "# Goal\nA\n\n## Decisions\nnew\n"
    assert janus.set_section(once, "## Decisions", "new") == once
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_goal_file.py`
Expected: FAIL with `AttributeError: module 'janus' has no attribute 'load_goal'`

- [ ] **Step 3: Implement goal file I/O**

Add imports at the top of `janus.py` (keep them alphabetical within the stdlib group; `yaml` after a blank line):

```python
import dataclasses
import re
from typing import Dict, List, Optional, Tuple

import yaml
```

Insert under `# --- goal file ---`:

```python
FRONT_MATTER_END = "\n---\n"
HEADING_RE = re.compile(r"^(#{1,6}) ")


@dataclasses.dataclass
class Goal:
    """JANUS.md in memory: parsed front matter plus the untouched Markdown body."""

    root: Path
    front: dict
    body: str


def split_front_matter(text: str) -> Tuple[Optional[str], str]:
    """Return (front matter text or None, body). The body is returned byte for byte."""
    if not text.startswith("---\n"):
        return None, text
    end = text.find(FRONT_MATTER_END, 3)
    if end < 0:
        raise JanusError(f"{GOAL_FILE} opens a front matter block that never closes")
    return text[4:end + 1], text[end + len(FRONT_MATTER_END):]


def load_goal(root: Path) -> Goal:
    path = require_goal_file(root)
    front_text, body = split_front_matter(path.read_text(encoding="utf-8"))
    front = yaml.safe_load(front_text) if front_text else None
    if front is not None and not isinstance(front, dict):
        raise JanusError(f"{GOAL_FILE} front matter must be a YAML mapping")
    return Goal(root=root, front=front or {}, body=body)


def render_goal(goal: Goal) -> str:
    if not goal.front:
        return goal.body
    front_text = yaml.safe_dump(goal.front, sort_keys=False, allow_unicode=True, default_flow_style=False)
    return "---\n" + front_text + "---\n" + goal.body


def save_goal(goal: Goal) -> None:
    (goal.root / GOAL_FILE).write_text(render_goal(goal), encoding="utf-8")


def heading_level(heading: str) -> int:
    return len(heading) - len(heading.lstrip("#"))


def section_end(lines: List[str], start: int, stop_level: int) -> int:
    """Index of the first heading line at or above stop_level, or len(lines)."""
    j = start
    while j < len(lines):
        match = HEADING_RE.match(lines[j])
        if match and len(match.group(1)) <= stop_level:
            break
        j += 1
    return j


def section(body: str, heading: str) -> Optional[str]:
    """Text under `heading` (an exact line such as '# Goal'), or None when absent.
    Janus sections are '#'/'##' headings; '###' and deeper belong to the enclosing section."""
    lines = body.split("\n")
    stop_level = max(heading_level(heading), 2)
    for i, line in enumerate(lines):
        if line.rstrip() == heading:
            end = section_end(lines, i + 1, stop_level)
            return "\n".join(lines[i + 1:end]).strip("\n")
    return None


def set_section(body: str, heading: str, content: str) -> str:
    """Replace the text under `heading`, or append the section when absent. Nothing else changes."""
    lines = body.split("\n")
    stop_level = max(heading_level(heading), 2)
    block = [heading] + content.rstrip("\n").split("\n") + [""]
    for i, line in enumerate(lines):
        if line.rstrip() == heading:
            rest = lines[section_end(lines, i + 1, stop_level):]
            while rest and rest[0] == "":
                rest.pop(0)
            return "\n".join(lines[:i] + block + rest)
    return body.rstrip("\n") + "\n\n" + "\n".join(block)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `11 passed`

- [ ] **Step 5: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/test_goal_file.py
git commit -m "feat(janus): load and save JANUS.md with a byte-for-byte Markdown body" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Workspace discovery and control-repo ignore rules

Spec §3 ("Every subdirectory that contains a `.git` is a product repository", `.gitignore` contains `*/`).

**Files:**
- Modify: `janus.py` (section `# --- workspace ---`)
- Create: `tests/test_workspace.py`

**Interfaces:**
- Produces: `CONTROL_IGNORES = ["*/", ".janus.lock", ".janus-interrupted.patch"]`; `discover_repos(root: Path) -> List[str]` (sorted folder names); `ensure_control_ignore(root: Path) -> None` (appends missing lines, idempotent, creates the file).

- [ ] **Step 1: Write the failing tests**

`tests/test_workspace.py`:

```python
import janus

EXPECTED_IGNORE = "*/\n.janus.lock\n.janus-interrupted.patch\n"


def test_discover_repos_lists_immediate_git_checkouts_sorted(tmp_path):
    for name in ("shell", "ui-kit"):
        (tmp_path / name / ".git").mkdir(parents=True)
    (tmp_path / "notes").mkdir()
    (tmp_path / "nested" / "deep" / ".git").mkdir(parents=True)
    (tmp_path / "file.txt").write_text("x", encoding="utf-8")
    assert janus.discover_repos(tmp_path) == ["shell", "ui-kit"]


def test_discover_repos_accepts_a_git_file_as_in_worktrees(tmp_path):
    (tmp_path / "wt").mkdir()
    (tmp_path / "wt" / ".git").write_text("gitdir: elsewhere\n", encoding="utf-8")
    assert janus.discover_repos(tmp_path) == ["wt"]


def test_ensure_control_ignore_adds_missing_lines_once(tmp_path):
    (tmp_path / ".gitignore").write_text("*/\n", encoding="utf-8")
    janus.ensure_control_ignore(tmp_path)
    assert (tmp_path / ".gitignore").read_text(encoding="utf-8") == EXPECTED_IGNORE
    janus.ensure_control_ignore(tmp_path)
    assert (tmp_path / ".gitignore").read_text(encoding="utf-8") == EXPECTED_IGNORE


def test_ensure_control_ignore_creates_the_file(tmp_path):
    janus.ensure_control_ignore(tmp_path)
    assert (tmp_path / ".gitignore").read_text(encoding="utf-8") == EXPECTED_IGNORE
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_workspace.py`
Expected: FAIL with `AttributeError: module 'janus' has no attribute 'discover_repos'`

- [ ] **Step 3: Implement**

Add to the constants section:

```python
CONTROL_IGNORES = ["*/", LOCK_FILE, PATCH_FILE]
```

Insert under `# --- workspace ---`:

```python
def discover_repos(root: Path) -> List[str]:
    """Every immediate subdirectory holding a .git (dir or worktree file) is a product repo."""
    return sorted(p.name for p in root.iterdir() if p.is_dir() and (p / ".git").exists())


def ensure_control_ignore(root: Path) -> None:
    """The control repo ignores nested clones and Janus's ephemeral files (spec §3)."""
    path = root / ".gitignore"
    existing = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    missing = [line for line in CONTROL_IGNORES if line not in existing]
    if missing:
        path.write_text("\n".join(existing + missing) + "\n", encoding="utf-8")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `15 passed`

- [ ] **Step 5: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/test_workspace.py
git commit -m "feat(janus): discover product repos and keep the control repo ignore rules" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Git helpers against a local bare remote

Spec §6 steps 2, 3, 5 (branch without force, record heads, commit and push), §8 (control checkpoint push, no force), §9 (runner-only Git writes, ref-move detection).

Note on naming: spec §10 lists `save_checkpoint`; the checkpoint here is "save `JANUS.md`, commit it to the control repo, push if `origin` exists", so the function is `save_checkpoint(goal, message)`. It is the only checkpoint function; nothing else writes the control repo.

**Files:**
- Modify: `janus.py` (section `# --- git ---`)
- Create: `tests/helpers.py`, `tests/conftest.py`, `tests/test_git.py`

**Interfaces:**
- Consumes: `Goal`, `save_goal`, `ensure_control_ignore`, `GOAL_FILE`, `JanusError`.
- Produces: `git(cwd: Path, *args: str, check: bool = True) -> str` (stdout stripped; `JanusError` on failure when `check`); `has_remote(repo: Path, name: str = "origin") -> bool`; `ref_exists(repo: Path, ref: str) -> bool`; `record_heads(repo: Path) -> Dict[str, str]` (`refs/heads/*` and `refs/tags/*` → sha); `check_heads_unchanged(repo: Path, before: Dict[str, str]) -> List[str]` (moved/added/removed refs; empty means unchanged); `working_tree_dirty(repo: Path) -> bool`; `checkout_goal_branch(repo: Path, base: str, branch: str) -> None`; `stage_and_diff(repo: Path) -> Tuple[str, str]` (`git add -A`, then `--name-status` and full staged diff); `git_commit_push(repo: Path, branch: str, message: str, trailer: str) -> str` (returns new sha); `commit_on_remote(repo: Path, sha: str, branch: str) -> bool`; `save_checkpoint(goal: Goal, message: str) -> None`.
- Test helpers (`tests/helpers.py`): `git(cwd, *args) -> str`, `init_repo(path)`, `commit_all(path, message) -> sha`, `make_bare(path) -> path`, `draft_front(checks=..., pr_build=None) -> dict`, `write_draft(root, front=None) -> Goal`, `approve_draft(root, front=None) -> Goal`, `codex_output(**overrides) -> dict`, `BODY`. Fixture `ws` in `tests/conftest.py` returns `SimpleNamespace(root, app, bare)`.

- [ ] **Step 1: Write the shared test helpers and the `ws` fixture**

`tests/helpers.py`:

```python
"""Shared helpers for Janus tests: a tiny git wrapper, repo builders and goal-file builders."""
import copy
import subprocess

import janus


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True).stdout.strip()


def init_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.name", "Test User")
    git(path, "config", "user.email", "test@example.com")
    git(path, "config", "commit.gpgsign", "false")


def commit_all(path, message):
    git(path, "add", "-A")
    git(path, "commit", "-q", "-m", message)
    return git(path, "rev-parse", "HEAD")


def make_bare(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(path)], check=True)
    return path


BODY = (
    "# Goal\n"
    "Upgrade Angular 15 to 16 in every repository here.\n"
    "\n"
    "## Approved-plan content\n"
    "One task: upgrade app, then run its local checks.\n"
    "\n"
    "## Rules\n"
    "Never change scope or architecture without human direction.\n"
    "Never weaken/skip tests to obtain a green build.\n"
    "Never merge, publish a production release or deploy.\n"
    "\n"
    "## Review feedback\n"
    "Empty until a human pastes PR review or QA comments here and runs Janus again.\n"
    "\n"
    "## Progress and handover\n"
    "Not started.\n"
    "\n"
    "## Decisions\n"
    "None yet.\n"
)


def draft_front(checks=("test -f package.json",), pr_build=None):
    return {
        "id": "angular-15-to-16",
        "status": "awaiting_plan_approval",
        "angular": {"from": 15, "to": 16},
        "approval": {"plan_hash": None, "approved_by": None, "approved_at": None},
        "repos": [{"name": "app", "base": "main", "branch": "ai/angular-15-to-16", "pr_build": pr_build, "checks": list(checks)}],
        "e2e": None,
        "tasks": [{"id": 1, "repo": "app", "objective": "Upgrade app to Angular 16", "status": "pending"}],
        "current_task": None,
        "last_verified": {},
        "prs": {},
        "attempts": 0,
        "in_flight": None,
    }


def write_draft(root, front=None):
    goal = janus.Goal(root=root, front=copy.deepcopy(front) if front else draft_front(), body=BODY)
    janus.save_goal(goal)
    commit_all(root, "chore(janus): draft plan")
    return goal


def approve_draft(root, front=None):
    goal = write_draft(root, front)
    goal.front["approval"] = {
        "plan_hash": janus.plan_hash(goal),
        "approved_by": "Test User <test@example.com>",
        "approved_at": "2026-09-21T00:00:00Z",
    }
    goal.front["status"] = "approved"
    janus.save_goal(goal)
    commit_all(root, "chore(janus): approve plan")
    return goal


def codex_output(**overrides):
    out = {"summary": "done", "files_touched": [], "values": [], "blockers": [], "next_action": "", "config": None, "plan_markdown": None}
    out.update(overrides)
    return out
```

`approve_draft` calls `janus.plan_hash`, which Task 5 adds; it is not used before Task 5.

`tests/conftest.py`:

```python
import types

import pytest

from helpers import commit_all, git, init_repo, make_bare


@pytest.fixture
def ws(tmp_path):
    """A control repo `goal/` holding one product repo `app/` whose origin is a local bare repo."""
    root = tmp_path / "goal"
    init_repo(root)
    (root / "JANUS.md").write_text("# Goal\nUpgrade Angular 15 to 16 in every repository here.\n", encoding="utf-8")
    (root / ".gitignore").write_text("*/\n.janus.lock\n.janus-interrupted.patch\n", encoding="utf-8")
    commit_all(root, "chore(janus): start goal")
    bare = make_bare(tmp_path / "remotes" / "app.git")
    app = root / "app"
    init_repo(app)
    (app / "package.json").write_text('{"name": "app", "version": "0.0.0"}\n', encoding="utf-8")
    (app / "src").mkdir()
    (app / "src" / "app.spec.ts").write_text("describe('app', () => {\n  it('works', () => {});\n});\n", encoding="utf-8")
    commit_all(app, "feat: initial app")
    git(app, "remote", "add", "origin", str(bare))
    git(app, "push", "-q", "-u", "origin", "main")
    return types.SimpleNamespace(root=root, app=app, bare=bare)
```

- [ ] **Step 2: Write the failing tests**

`tests/test_git.py`:

```python
import pytest

import janus
from helpers import commit_all, git, make_bare

BRANCH = "ai/angular-15-to-16"


def test_record_heads_and_detect_moved_refs(ws):
    before = janus.record_heads(ws.app)
    assert set(before) == {"refs/heads/main"}
    assert janus.check_heads_unchanged(ws.app, before) == []
    (ws.app / "x.txt").write_text("x", encoding="utf-8")
    commit_all(ws.app, "oops: agent committed")
    git(ws.app, "tag", "v0")
    assert janus.check_heads_unchanged(ws.app, before) == ["refs/heads/main", "refs/tags/v0"]


def test_working_tree_dirty_sees_untracked_and_modified_files(ws):
    assert janus.working_tree_dirty(ws.app) is False
    (ws.app / "new.txt").write_text("n", encoding="utf-8")
    assert janus.working_tree_dirty(ws.app) is True


def test_checkout_goal_branch_creates_from_origin_base_and_is_idempotent(ws):
    janus.checkout_goal_branch(ws.app, "main", BRANCH)
    assert git(ws.app, "rev-parse", "--abbrev-ref", "HEAD") == BRANCH
    assert git(ws.app, "rev-parse", BRANCH) == git(ws.app, "rev-parse", "origin/main")
    janus.checkout_goal_branch(ws.app, "main", BRANCH)
    assert git(ws.app, "rev-parse", "--abbrev-ref", "HEAD") == BRANCH


def test_checkout_goal_branch_tracks_an_existing_remote_branch(ws, tmp_path):
    other = tmp_path / "other"
    git(tmp_path, "clone", "-q", str(ws.bare), str(other))
    git(other, "config", "user.name", "Other")
    git(other, "config", "user.email", "other@example.com")
    git(other, "checkout", "-q", "-b", BRANCH)
    (other / "remote.txt").write_text("r", encoding="utf-8")
    sha = commit_all(other, "feat: remote work")
    git(other, "push", "-q", "origin", BRANCH)
    janus.checkout_goal_branch(ws.app, "main", BRANCH)
    assert git(ws.app, "rev-parse", "HEAD") == sha


def test_checkout_goal_branch_refuses_remote_divergence(ws, tmp_path):
    janus.checkout_goal_branch(ws.app, "main", BRANCH)
    other = tmp_path / "other"
    git(tmp_path, "clone", "-q", str(ws.bare), str(other))
    git(other, "config", "user.name", "Other")
    git(other, "config", "user.email", "other@example.com")
    git(other, "checkout", "-q", "-b", BRANCH)
    (other / "remote.txt").write_text("r", encoding="utf-8")
    commit_all(other, "feat: remote work")
    git(other, "push", "-q", "origin", BRANCH)
    git(ws.app, "checkout", "-q", "main")
    with pytest.raises(janus.JanusError, match="commits that are not in the local"):
        janus.checkout_goal_branch(ws.app, "main", BRANCH)


def test_stage_and_diff_includes_untracked_files(ws):
    (ws.app / "src" / "new.ts").write_text("export const a = 1;\n", encoding="utf-8")
    (ws.app / "package.json").write_text('{"name": "app", "version": "0.0.1"}\n', encoding="utf-8")
    name_status, diff_text = janus.stage_and_diff(ws.app)
    assert sorted(name_status.splitlines()) == ["A\tsrc/new.ts", "M\tpackage.json"]
    assert "+export const a = 1;" in diff_text


def test_git_commit_push_writes_trailer_and_pushes_without_force(ws):
    janus.checkout_goal_branch(ws.app, "main", BRANCH)
    (ws.app / "done.txt").write_text("d", encoding="utf-8")
    assert janus.commit_on_remote(ws.app, git(ws.app, "rev-parse", "HEAD"), BRANCH) is False
    sha = janus.git_commit_push(ws.app, BRANCH, "chore(angular): Upgrade app to Angular 16", "Janus-Task: 1")
    assert git(ws.app, "rev-parse", "HEAD") == sha
    assert git(ws.app, "log", "-1", "--format=%s") == "chore(angular): Upgrade app to Angular 16"
    assert git(ws.app, "log", "-1", "--format=%b").strip() == "Janus-Task: 1"
    assert git(ws.bare, "rev-parse", f"refs/heads/{BRANCH}") == sha
    assert janus.commit_on_remote(ws.app, sha, BRANCH) is True


def test_git_commit_push_fails_instead_of_forcing_over_remote_work(ws, tmp_path):
    janus.checkout_goal_branch(ws.app, "main", BRANCH)
    (ws.app / "done.txt").write_text("d", encoding="utf-8")
    janus.git_commit_push(ws.app, BRANCH, "chore(angular): first", "Janus-Task: 1")
    other = tmp_path / "other"
    git(tmp_path, "clone", "-q", "-b", BRANCH, str(ws.bare), str(other))
    git(other, "config", "user.name", "Other")
    git(other, "config", "user.email", "other@example.com")
    (other / "remote.txt").write_text("r", encoding="utf-8")
    remote_sha = commit_all(other, "feat: remote work")
    git(other, "push", "-q", "origin", BRANCH)
    (ws.app / "more.txt").write_text("m", encoding="utf-8")
    with pytest.raises(janus.JanusError, match="git push"):
        janus.git_commit_push(ws.app, BRANCH, "chore(angular): second", "Janus-Task: 1")
    assert git(ws.bare, "rev-parse", f"refs/heads/{BRANCH}") == remote_sha


def test_save_checkpoint_commits_only_janus_files_and_pushes_when_origin_exists(ws, tmp_path):
    control_bare = make_bare(tmp_path / "remotes" / "goal.git")
    git(ws.root, "remote", "add", "origin", str(control_bare))
    git(ws.root, "push", "-q", "-u", "origin", "main")
    goal = janus.load_goal(ws.root)
    goal.front = {"id": "angular-15-to-16", "status": "awaiting_plan_approval"}
    janus.save_checkpoint(goal, "chore(janus): draft plan")
    assert git(ws.root, "log", "-1", "--format=%s") == "chore(janus): draft plan"
    assert git(control_bare, "log", "-1", "--format=%s", "main") == "chore(janus): draft plan"
    assert git(ws.root, "ls-files").splitlines() == [".gitignore", "JANUS.md"]
    janus.save_checkpoint(goal, "chore(janus): nothing changed")
    assert git(ws.root, "log", "-1", "--format=%s") == "chore(janus): draft plan"


def test_save_checkpoint_without_origin_commits_locally(ws):
    goal = janus.load_goal(ws.root)
    goal.front = {"id": "angular-15-to-16"}
    janus.save_checkpoint(goal, "chore(janus): local only")
    assert git(ws.root, "log", "-1", "--format=%s") == "chore(janus): local only"


def test_save_checkpoint_stops_when_the_push_fails(ws, tmp_path):
    git(ws.root, "remote", "add", "origin", str(tmp_path / "missing.git"))
    goal = janus.load_goal(ws.root)
    goal.front = {"id": "angular-15-to-16"}
    with pytest.raises(janus.JanusError, match="git push"):
        janus.save_checkpoint(goal, "chore(janus): will not push")
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_git.py`
Expected: FAIL with `AttributeError: module 'janus' has no attribute 'record_heads'`

- [ ] **Step 4: Implement the git helpers**

Add `import subprocess` to the imports. Insert under `# --- git ---`:

```python
def git(cwd: Path, *args: str, check: bool = True) -> str:
    proc = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise JanusError(f"git {' '.join(args)} failed in {cwd}: {proc.stderr.strip()}")
    return proc.stdout.strip()


def has_remote(repo: Path, name: str = "origin") -> bool:
    return subprocess.run(["git", "remote", "get-url", name], cwd=str(repo), capture_output=True).returncode == 0


def ref_exists(repo: Path, ref: str) -> bool:
    return subprocess.run(["git", "rev-parse", "--verify", "-q", ref], cwd=str(repo), capture_output=True).returncode == 0


def record_heads(repo: Path) -> Dict[str, str]:
    """Every local branch and tag with its sha; taken before each Codex run (spec §9)."""
    out = git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags")
    return dict(line.split(" ", 1) for line in out.splitlines() if line)


def check_heads_unchanged(repo: Path, before: Dict[str, str]) -> List[str]:
    """Refs that moved, appeared or vanished since `before`; an empty list means unchanged."""
    after = record_heads(repo)
    changed = {ref for ref in set(before) | set(after) if before.get(ref) != after.get(ref)}
    return sorted(changed)


def working_tree_dirty(repo: Path) -> bool:
    return bool(git(repo, "status", "--porcelain", "--untracked-files=all"))


def checkout_goal_branch(repo: Path, base: str, branch: str) -> None:
    """Check out or create the goal branch from `base`. Never force, never auto-merge (spec §6, §8)."""
    git(repo, "fetch", "-q", "origin")
    local, remote = f"refs/heads/{branch}", f"refs/remotes/origin/{branch}"
    if ref_exists(repo, local):
        if ref_exists(repo, remote) and git(repo, "rev-list", "--count", f"{local}..{remote}") != "0":
            raise JanusError(
                f"origin/{branch} has commits that are not in the local {branch} of {repo.name}; "
                "reconcile by hand (Janus does not merge, rebase or force)"
            )
        git(repo, "checkout", "-q", branch)
    elif ref_exists(repo, remote):
        git(repo, "checkout", "-q", "-b", branch, "--track", f"origin/{branch}")
    else:
        start = f"origin/{base}" if ref_exists(repo, f"refs/remotes/origin/{base}") else base
        git(repo, "checkout", "-q", "-b", branch, start)


def stage_and_diff(repo: Path) -> Tuple[str, str]:
    """Stage everything Codex left behind and return (name-status, full diff) of the staged change."""
    git(repo, "add", "-A")
    return git(repo, "diff", "--cached", "--name-status"), git(repo, "diff", "--cached")


def git_commit_push(repo: Path, branch: str, message: str, trailer: str) -> str:
    """The runner's only product write: commit staged work with a trailer and push without force."""
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message, "-m", trailer)
    git(repo, "push", "-q", "origin", f"{branch}:{branch}")
    return git(repo, "rev-parse", "HEAD")


def commit_on_remote(repo: Path, sha: str, branch: str) -> bool:
    git(repo, "fetch", "-q", "origin")
    remote = f"refs/remotes/origin/{branch}"
    if not ref_exists(repo, remote):
        return False
    proc = subprocess.run(["git", "merge-base", "--is-ancestor", sha, remote], cwd=str(repo), capture_output=True)
    return proc.returncode == 0


def save_checkpoint(goal: Goal, message: str) -> None:
    """Save JANUS.md, commit it to the control repo, push if origin exists; a push failure stops the run (spec §8)."""
    save_goal(goal)
    ensure_control_ignore(goal.root)
    git(goal.root, "add", "--", GOAL_FILE, ".gitignore")
    if git(goal.root, "status", "--porcelain", "--", GOAL_FILE, ".gitignore"):
        git(goal.root, "commit", "-q", "-m", message)
    if has_remote(goal.root):
        git(goal.root, "push", "-q", "origin", "HEAD")
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `26 passed`

- [ ] **Step 6: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/helpers.py tests/conftest.py tests/test_git.py
git commit -m "feat(janus): git helpers for goal branches, head tracking, commit-push and control checkpoints" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Plan hash, lock and the `approve` command

Spec §4 "Plan integrity", §5, §8 (single process lock).

**Files:**
- Modify: `janus.py` (section `# --- plan hash and approval ---`; replace `cmd_approve` in the CLI section)
- Create: `tests/test_approve.py`

**Interfaces:**
- Consumes: `Goal`, `load_goal`, `section`, `set_section`, `git`, `save_checkpoint`, `LOCK_FILE`.
- Produces: `now() -> str` (UTC `YYYY-MM-DDTHH:MM:SSZ`); `canonical(obj) -> str`; `plan_hash(goal: Goal) -> str` (sha256 hex); `verify_plan_approval(goal: Goal) -> None` (raises `JanusError` when unapproved or changed); `locked(root: Path)` context manager (fcntl flock on `.janus.lock`, `JanusError` when held); `git_identity(root: Path) -> str`; `cmd_approve(root: Path, ask: Callable[[str], str] = input) -> int`.

- [ ] **Step 1: Write the failing tests**

`tests/test_approve.py`:

```python
import copy

import pytest

import janus
from helpers import approve_draft, draft_front, git, write_draft


def test_plan_hash_ignores_runtime_fields(ws):
    goal = write_draft(ws.root)
    digest = janus.plan_hash(goal)
    assert len(digest) == 64
    goal.front["status"] = "executing"
    goal.front["attempts"] = 2
    goal.front["current_task"] = 1
    goal.front["tasks"][0]["status"] = "done"
    goal.front["tasks"][0]["values"] = {"v": "1"}
    goal.front["last_verified"] = {"app": {"commit": "abc", "teamcity_build": None, "status": "local_checks_passed"}}
    goal.front["in_flight"] = {"task": 1}
    goal.body = janus.set_section(goal.body, "## Progress and handover", "changed")
    goal.body = janus.set_section(goal.body, "## Decisions", "- a decision")
    assert janus.plan_hash(goal) == digest


@pytest.mark.parametrize(
    "mutate",
    [
        lambda g: g.front["tasks"][0].__setitem__("objective", "Something else"),
        lambda g: g.front["repos"][0]["checks"].append("npm run lint"),
        lambda g: g.front["angular"].__setitem__("to", 17),
        lambda g: setattr(g, "body", janus.set_section(g.body, "# Goal", "A different goal")),
        lambda g: setattr(g, "body", janus.set_section(g.body, "## Approved-plan content", "A different plan")),
        lambda g: g.front.__setitem__("e2e", {"build_type": "Fe_E2E_Full", "branch_parameters": {}}),
    ],
)
def test_plan_hash_changes_with_approved_content(ws, mutate):
    goal = write_draft(ws.root)
    digest = janus.plan_hash(goal)
    mutate(goal)
    assert janus.plan_hash(goal) != digest


def test_verify_plan_approval_rejects_a_draft(ws):
    goal = write_draft(ws.root)
    with pytest.raises(janus.JanusError, match="not approved"):
        janus.verify_plan_approval(goal)


def test_verify_plan_approval_rejects_a_goal_without_front_matter(ws):
    with pytest.raises(janus.JanusError, match="not approved"):
        janus.verify_plan_approval(janus.load_goal(ws.root))


def test_verify_plan_approval_detects_changed_content(ws):
    goal = approve_draft(ws.root)
    janus.verify_plan_approval(goal)
    goal.front["tasks"][0]["objective"] = "Edited after approval"
    with pytest.raises(janus.JanusError, match="has changed"):
        janus.verify_plan_approval(goal)


def test_approve_requires_the_literal_yes(ws, capsys):
    write_draft(ws.root)
    before = (ws.root / "JANUS.md").read_text(encoding="utf-8")
    assert janus.cmd_approve(ws.root, ask=lambda _prompt: "y") == 1
    assert (ws.root / "JANUS.md").read_text(encoding="utf-8") == before
    assert git(ws.root, "log", "-1", "--format=%s") == "chore(janus): draft plan"
    out = capsys.readouterr().out
    assert "Upgrade app to Angular 16" in out and "One task: upgrade app" in out


def test_approve_records_hash_identity_time_and_commits(ws):
    goal = write_draft(ws.root)
    expected = janus.plan_hash(goal)
    assert janus.cmd_approve(ws.root, ask=lambda _prompt: "yes") == 0
    approved = janus.load_goal(ws.root)
    assert approved.front["status"] == "approved"
    assert approved.front["approval"]["plan_hash"] == expected
    assert approved.front["approval"]["approved_by"] == "Test User <test@example.com>"
    assert approved.front["approval"]["approved_at"].endswith("Z")
    assert f"plan {expected[:12]} approved by Test User <test@example.com>" in janus.section(approved.body, "## Decisions")
    assert git(ws.root, "log", "-1", "--format=%s") == f"chore(janus): approve plan {expected[:12]}"
    janus.verify_plan_approval(approved)


def test_approve_without_a_plan_is_an_error(ws):
    with pytest.raises(janus.JanusError, match="nothing to approve"):
        janus.cmd_approve(ws.root, ask=lambda _prompt: "yes")


def test_locked_rejects_a_second_holder_and_releases(tmp_path):
    with janus.locked(tmp_path):
        with pytest.raises(janus.JanusError, match="another janus process"):
            with janus.locked(tmp_path):
                pass
    with janus.locked(tmp_path):
        pass
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_approve.py`
Expected: FAIL with `AttributeError: module 'janus' has no attribute 'plan_hash'`

- [ ] **Step 3: Implement**

Add imports: `import contextlib`, `import datetime as dt`, `import fcntl`, `import hashlib`, `import json`; extend the typing import to `from typing import Callable, Dict, Iterator, List, Optional, Tuple`.

Add to the constants section:

```python
def now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
```

Insert under `# --- plan hash and approval ---`:

```python
def canonical(obj: object) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def plan_hash(goal: Goal) -> str:
    """sha256 over the approved content only (spec §4): Goal section, angular, repos, e2e,
    task id/repo/objective in order, and the Approved-plan content section."""
    front = goal.front
    material = {
        "goal": section(goal.body, "# Goal"),
        "angular": front.get("angular"),
        "repos": front.get("repos"),
        "e2e": front.get("e2e"),
        "tasks": [
            {"id": t.get("id"), "repo": t.get("repo"), "objective": t.get("objective")}
            for t in front.get("tasks") or []
        ],
        "plan": section(goal.body, "## Approved-plan content"),
    }
    return hashlib.sha256(canonical(material).encode("utf-8")).hexdigest()


def verify_plan_approval(goal: Goal) -> None:
    recorded = (goal.front.get("approval") or {}).get("plan_hash")
    if not goal.front or goal.front.get("status") == "awaiting_plan_approval" or not recorded:
        raise JanusError("the plan is not approved; review JANUS.md and run `python janus.py approve`")
    actual = plan_hash(goal)
    if actual != recorded:
        raise JanusError(
            f"approved plan content has changed (recorded {recorded[:12]}, now {actual[:12]}); "
            "review the edits and run `python janus.py approve` again"
        )


@contextlib.contextmanager
def locked(root: Path) -> Iterator[None]:
    """Only one Janus process per goal (spec §8)."""
    handle = open(root / LOCK_FILE, "w")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise JanusError(f"another janus process holds {LOCK_FILE} in {root}")
    try:
        yield
    finally:
        fcntl.flock(handle, fcntl.LOCK_UN)
        handle.close()


def git_identity(root: Path) -> str:
    name = git(root, "config", "user.name", check=False) or "unknown"
    email = git(root, "config", "user.email", check=False)
    return f"{name} <{email}>" if email else name
```

Replace the `cmd_approve` skeleton in the CLI section with:

```python
def cmd_approve(root: Path, ask: Callable[[str], str] = input) -> int:
    with locked(root):
        goal = load_goal(root)
        if not goal.front or not goal.front.get("tasks"):
            raise JanusError("nothing to approve: run `python janus.py plan` first")
        front_text = yaml.safe_dump(goal.front, sort_keys=False, allow_unicode=True, default_flow_style=False)
        print("Front matter:\n" + front_text)
        print("## Approved-plan content\n" + (section(goal.body, "## Approved-plan content") or "(empty)") + "\n")
        answer = ask("Approve this plan exactly as shown? Type yes to approve: ")
        if answer.strip() != "yes":
            print("Plan not approved; JANUS.md unchanged.")
            return 1
        digest = plan_hash(goal)
        who = git_identity(root)
        goal.front["approval"] = {"plan_hash": digest, "approved_by": who, "approved_at": now()}
        goal.front["status"] = "approved"
        decisions = section(goal.body, "## Decisions") or ""
        line = f"- {now()}: plan {digest[:12]} approved by {who}"
        goal.body = set_section(goal.body, "## Decisions", (decisions + "\n" + line).strip("\n"))
        save_checkpoint(goal, f"chore(janus): approve plan {digest[:12]}")
        print(f"Plan approved ({digest[:12]}) by {who}.")
        return 0
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `40 passed`

- [ ] **Step 5: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/test_approve.py
git commit -m "feat(janus): seal approved plans with a content hash and add the approve command" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Codex invocation with the shared output schema

Spec §10 ("`codex exec` with the user's existing Codex configuration and one small shared JSON output schema"), §9 (full access; environment is the boundary).

**Files:**
- Modify: `janus.py` (section `# --- codex ---`)
- Modify: `tests/conftest.py` (add `fake_codex` fixture)
- Create: `tests/test_codex.py`

**Interfaces:**
- Produces: `OUTPUT_SCHEMA: dict`; `schema_object(properties: dict, nullable: bool = False) -> dict`; `run_codex(cwd: Path, prompt: str) -> dict` with keys `summary: str`, `files_touched: List[str]`, `values: Dict[str, str]` (converted from the `[{name, value}]` wire shape), `blockers: List[str]`, `next_action: str`, `config: Optional[dict]`, `plan_markdown: Optional[str]`.
- Test fixture `fake_codex` with `fake_codex.script(steps)` where each step is `{"shell": [commands run in the -C directory], "output": <dict or None>, "exit": 0}` (the last step repeats for extra calls) and `fake_codex.calls()` returning `[{"argv", "cwd", "prompt", "schema"}]`.

- [ ] **Step 1: Add the fake codex fixture**

Append to `tests/conftest.py` (add `import json`, `import os` to its imports):

```python
FAKE_CODEX = '''#!/usr/bin/env python3
"""Fake `codex` for tests: records the call, runs scripted shell commands in the -C directory,
writes the scripted JSON to --output-last-message and exits with the scripted code."""
import json, os, subprocess, sys

argv = sys.argv[1:]


def opt(flag):
    return argv[argv.index(flag) + 1] if flag in argv else None


cwd = opt("-C") or os.getcwd()
out_path = opt("--output-last-message")
schema = json.load(open(opt("--output-schema"))) if opt("--output-schema") else None
prompt = sys.stdin.read() if argv and argv[-1] == "-" else (argv[-1] if argv else "")
calls_path = os.environ["FAKE_CODEX_CALLS"]
steps = json.load(open(os.environ["FAKE_CODEX_SCRIPT"]))
done = sum(1 for _ in open(calls_path)) if os.path.exists(calls_path) else 0
step = steps[min(done, len(steps) - 1)]
with open(calls_path, "a") as f:
    f.write(json.dumps({"argv": argv, "cwd": cwd, "prompt": prompt, "schema": schema}) + "\\n")
for command in step.get("shell", []):
    subprocess.run(command, shell=True, cwd=cwd, check=True)
if step.get("output") is not None and out_path:
    with open(out_path, "w") as f:
        json.dump(step["output"], f)
sys.exit(step.get("exit", 0))
'''


@pytest.fixture
def fake_codex(tmp_path, monkeypatch):
    """Puts a scripted `codex` first on PATH. Tests never reach the real Codex."""
    bin_dir = tmp_path / "fake-bin"
    bin_dir.mkdir()
    exe = bin_dir / "codex"
    exe.write_text(FAKE_CODEX, encoding="utf-8")
    exe.chmod(0o755)
    script_path = tmp_path / "codex-script.json"
    calls_path = tmp_path / "codex-calls.jsonl"
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("FAKE_CODEX_SCRIPT", str(script_path))
    monkeypatch.setenv("FAKE_CODEX_CALLS", str(calls_path))

    def script(steps):
        script_path.write_text(json.dumps(steps), encoding="utf-8")

    def calls():
        if not calls_path.exists():
            return []
        return [json.loads(line) for line in calls_path.read_text(encoding="utf-8").splitlines()]

    return types.SimpleNamespace(script=script, calls=calls)
```

- [ ] **Step 2: Write the failing tests**

`tests/test_codex.py`:

```python
import pytest

import janus
from helpers import codex_output


def test_run_codex_passes_flags_prompt_and_schema_and_parses_output(fake_codex, tmp_path):
    fake_codex.script([{"output": codex_output(
        summary="did it", files_touched=["a.ts"],
        values=[{"name": "version", "value": "1.0.0-rc.1"}], blockers=["b"], next_action="run checks",
    )}])
    result = janus.run_codex(tmp_path, "hello prompt")
    assert result["summary"] == "did it"
    assert result["files_touched"] == ["a.ts"]
    assert result["values"] == {"version": "1.0.0-rc.1"}
    assert result["blockers"] == ["b"]
    assert result["next_action"] == "run checks"
    assert result["config"] is None and result["plan_markdown"] is None
    [call] = fake_codex.calls()
    assert call["cwd"] == str(tmp_path)
    assert call["prompt"] == "hello prompt"
    assert call["argv"][:3] == ["exec", "-C", str(tmp_path)]
    assert "--dangerously-bypass-approvals-and-sandbox" in call["argv"]
    assert "--output-schema" in call["argv"] and "--output-last-message" in call["argv"]
    assert call["argv"][-1] == "-"
    assert not any(a in call["argv"] for a in ("-m", "--model")) and not any(a.startswith("-c") for a in call["argv"])
    assert call["schema"] == janus.OUTPUT_SCHEMA


def test_run_codex_accepts_values_already_shaped_as_a_map(fake_codex, tmp_path):
    fake_codex.script([{"output": codex_output(values={"k": "v"})}])
    assert janus.run_codex(tmp_path, "p")["values"] == {"k": "v"}


def test_run_codex_fails_on_non_zero_exit(fake_codex, tmp_path):
    fake_codex.script([{"output": codex_output(), "exit": 3}])
    with pytest.raises(janus.JanusError, match="exited with 3"):
        janus.run_codex(tmp_path, "p")


def test_run_codex_fails_without_a_final_message(fake_codex, tmp_path):
    fake_codex.script([{"output": None}])
    with pytest.raises(janus.JanusError, match="no final message"):
        janus.run_codex(tmp_path, "p")


def test_run_codex_fails_when_the_message_is_not_the_schema(fake_codex, tmp_path):
    fake_codex.script([{"output": {"unexpected": True}}])
    with pytest.raises(janus.JanusError, match="does not match"):
        janus.run_codex(tmp_path, "p")


def walk(schema):
    yield schema
    for child in schema.get("properties", {}).values():
        yield from walk(child)
    if "items" in schema:
        yield from walk(schema["items"])


def test_output_schema_is_strict_structured_output_compatible():
    objects = [s for s in walk(janus.OUTPUT_SCHEMA) if "properties" in s]
    assert objects, "schema has objects"
    for obj in objects:
        assert obj["additionalProperties"] is False
        assert obj["required"] == list(obj["properties"])
    top = janus.OUTPUT_SCHEMA["properties"]
    assert list(top) == ["summary", "files_touched", "values", "blockers", "next_action", "config", "plan_markdown"]
    assert top["config"]["type"] == ["object", "null"]
    assert top["plan_markdown"]["type"] == ["string", "null"]
    assert list(top["config"]["properties"]) == ["angular", "repos", "tasks", "e2e"]
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_codex.py`
Expected: FAIL with `AttributeError: module 'janus' has no attribute 'run_codex'` / `OUTPUT_SCHEMA`

- [ ] **Step 4: Implement**

Add `import tempfile` to the imports. Insert under `# --- codex ---`:

```python
def schema_object(properties: dict, nullable: bool = False) -> dict:
    """An object schema that strict structured outputs accept: all properties required, no extras."""
    return {
        "type": ["object", "null"] if nullable else "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


STRING = {"type": "string"}
STRINGS = {"type": "array", "items": STRING}
NULLABLE_STRING = {"type": ["string", "null"]}
INTEGER = {"type": "integer"}

# One schema for every Codex run (spec §10). Plan-only fields are nullable; string maps travel as
# name/value arrays because strict structured outputs reject free-form objects.
OUTPUT_SCHEMA = schema_object({
    "summary": STRING,
    "files_touched": STRINGS,
    "values": {"type": "array", "items": schema_object({"name": STRING, "value": STRING})},
    "blockers": STRINGS,
    "next_action": STRING,
    "config": schema_object({
        "angular": schema_object({"from": INTEGER, "to": INTEGER}),
        "repos": {"type": "array", "items": schema_object({
            "name": STRING, "base": STRING, "branch": STRING, "pr_build": NULLABLE_STRING, "checks": STRINGS,
        })},
        "tasks": {"type": "array", "items": schema_object({"id": INTEGER, "repo": STRING, "objective": STRING})},
        "e2e": schema_object({
            "build_type": STRING,
            "branch_parameters": {"type": "array", "items": schema_object({"repo": STRING, "parameter": STRING})},
        }, nullable=True),
    }, nullable=True),
    "plan_markdown": NULLABLE_STRING,
})


def run_codex(cwd: Path, prompt: str) -> dict:
    """One fresh `codex exec` in `cwd` with full access (spec §9); the user's ~/.codex/config.toml
    supplies model and reasoning effort. The prompt goes in on stdin, never on argv."""
    workdir = Path(tempfile.mkdtemp(prefix="janus-codex-"))
    schema_path = workdir / "schema.json"
    out_path = workdir / "last-message.json"
    schema_path.write_text(json.dumps(OUTPUT_SCHEMA), encoding="utf-8")
    argv = [
        "codex", "exec", "-C", str(cwd), "--dangerously-bypass-approvals-and-sandbox",
        "--output-schema", str(schema_path), "--output-last-message", str(out_path), "-",
    ]
    proc = subprocess.run(argv, cwd=str(cwd), input=prompt, text=True)
    if proc.returncode != 0:
        raise JanusError(f"codex exec exited with {proc.returncode}")
    if not out_path.exists():
        raise JanusError("codex exec produced no final message")
    try:
        result = json.loads(out_path.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise JanusError(f"codex final message is not valid JSON: {exc}")
    if not isinstance(result, dict) or "summary" not in result:
        raise JanusError("codex final message does not match the Janus output schema")
    values = result.get("values") or []
    if isinstance(values, list):
        values = {str(v["name"]): str(v["value"]) for v in values if isinstance(v, dict) and "name" in v}
    result["values"] = dict(values)
    result["files_touched"] = [str(f) for f in result.get("files_touched") or []]
    result["blockers"] = [str(b) for b in result.get("blockers") or []]
    result["next_action"] = str(result.get("next_action") or "")
    result["summary"] = str(result.get("summary") or "")
    result.setdefault("config", None)
    result.setdefault("plan_markdown", None)
    return result
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `46 passed`

- [ ] **Step 6: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/conftest.py tests/test_codex.py
git commit -m "feat(janus): invoke codex exec with one strict output schema and a fake codex for tests" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The `plan` command and the `JANUS.md` template

Spec §4 (draft contents, ownership), §6 "Planning and baseline" ("Nothing is changed in product source during planning", "marks what it could not verify as unverified"), §7 ("No automatic rewriting of an approved plan").

**Files:**
- Modify: `janus.py` (section `# --- plan ---`; replace `cmd_plan`)
- Create: `JANUS.md` (template), `tests/test_plan.py`

**Interfaces:**
- Consumes: `load_goal`, `section`, `set_section`, `discover_repos`, `ensure_control_ignore`, `record_heads`, `working_tree_dirty`, `run_codex`, `save_checkpoint`, `locked`, `now`.
- Produces: `RULES_TEXT: str`; `STANDARD_SECTIONS: List[Tuple[str, str]]`; `plan_prompt(goal_text: str, repos: List[str]) -> str`; `demote_headings(markdown: str) -> str`; `validate_config(config: object, repos: List[str]) -> dict` (normalised `{"angular", "repos", "e2e", "tasks"}`); `draft_front_matter(config: dict) -> dict`; `task_by_id(goal: Goal, task_id: object) -> Optional[dict]`; `write_progress(goal: Goal, next_action: str, blocker: Optional[str] = None) -> None` (regenerates `## Progress and handover`); `changed_repos(root: Path, repos: List[str], before: Dict[str, Dict[str, str]]) -> List[str]`; `cmd_plan(root: Path) -> int`.

- [ ] **Step 1: Write the template**

`JANUS.md` (repo root; this is the file a human copies into a new control repo):

```markdown
# Goal
Write the goal here in one paragraph, for example: "Upgrade Angular 15 to 16 across the
repositories in this folder; preserve existing behaviour." Then run `python janus.py plan`.

<!--
JANUS.md contract (Janus 3.0, spec §4). Delete this comment once the goal is written.

Before `plan` runs this file needs only the `# Goal` section above. `plan` adds a YAML front
matter and the sections below; a human edits the draft and runs `approve`; `run` executes.

Front matter. Codex proposes during `plan` and a human edits before approval:
  angular: {from, to}            repos: [{name, base, branch, pr_build, checks}]
  e2e: {build_type, branch_parameters} or null        tasks: [{id, repo, objective}]
The runner owns and rewrites: id, status, approval, tasks[].status/values/summary/blockers,
  current_task, last_verified, prs, attempts, in_flight.
Repository names are the folder names of the git checkouts inside this folder.

Body sections. `# Goal` and `## Approved-plan content` are hashed at approval together with
angular, repos, e2e and the task ids/repos/objectives; changing any of them requires a new
`approve`. `## Rules` is fixed text. `## Review feedback` is for humans to paste PR review or QA
comments. `## Progress and handover` is regenerated by the runner. `## Decisions` records human
approvals and exceptions; the runner appends one line per approval.

Never put credentials in this file.
-->
```

- [ ] **Step 2: Write the failing tests**

`tests/test_plan.py`:

```python
import copy

import pytest

import janus
from helpers import approve_draft, codex_output, git, init_repo, commit_all

PLAN_CONFIG = {
    "angular": {"from": 15, "to": 16},
    "repos": [{"name": "app", "base": "main", "branch": "ai/angular-15-to-16", "pr_build": None, "checks": ["npm ci", "npm test -- --watch=false"]}],
    "tasks": [{"id": 1, "repo": "app", "objective": "Upgrade app to Angular 16"}],
    "e2e": None,
}
PLAN_MARKDOWN = "## Order\napp only.\n\n### Baseline\nTeamCity build Fe_App_Build assumed green; not verified here."


def test_plan_writes_the_draft_and_commits_it(ws, fake_codex):
    fake_codex.script([{"output": codex_output(summary="planned", config=PLAN_CONFIG, plan_markdown=PLAN_MARKDOWN, next_action="check the checks")}])
    assert janus.cmd_plan(ws.root) == 0
    goal = janus.load_goal(ws.root)
    assert goal.front["id"] == "angular-15-to-16"
    assert goal.front["status"] == "awaiting_plan_approval"
    assert goal.front["angular"] == {"from": 15, "to": 16}
    assert goal.front["approval"] == {"plan_hash": None, "approved_by": None, "approved_at": None}
    assert goal.front["repos"] == PLAN_CONFIG["repos"]
    assert goal.front["e2e"] is None
    assert goal.front["tasks"] == [{"id": 1, "repo": "app", "objective": "Upgrade app to Angular 16", "status": "pending"}]
    assert goal.front["current_task"] is None
    assert goal.front["last_verified"] == {} and goal.front["prs"] == {}
    assert goal.front["attempts"] == 0 and goal.front["in_flight"] is None
    assert list(goal.front) == ["id", "status", "angular", "approval", "repos", "e2e", "tasks", "current_task", "last_verified", "prs", "attempts", "in_flight"]
    assert janus.section(goal.body, "# Goal") == "Upgrade Angular 15 to 16 in every repository here."
    plan = janus.section(goal.body, "## Approved-plan content")
    assert plan.startswith("### Order\napp only.") and "### Baseline" in plan
    assert janus.section(goal.body, "## Rules") == janus.RULES_TEXT
    assert janus.section(goal.body, "## Review feedback").startswith("Empty until")
    progress = janus.section(goal.body, "## Progress and handover")
    assert "unverified" in progress and "janus.py approve" in progress
    assert janus.section(goal.body, "## Decisions") == "None yet."
    assert git(ws.root, "log", "-1", "--format=%s") == "chore(janus): draft plan for angular-15-to-16"
    [call] = fake_codex.calls()
    assert call["cwd"] == str(ws.root)
    assert "app" in call["prompt"] and "Upgrade Angular 15 to 16 in every repository here." in call["prompt"]
    assert "read-only" in call["prompt"]


def test_plan_keeps_the_goal_section_bytes_and_replaces_only_the_plan_on_rerun(ws, fake_codex):
    fake_codex.script([{"output": codex_output(config=PLAN_CONFIG, plan_markdown="first")}])
    janus.cmd_plan(ws.root)
    first = janus.load_goal(ws.root)
    first.body = janus.set_section(first.body, "## Decisions", "- humans wrote this")
    janus.save_goal(first)
    commit_all(ws.root, "docs: human edit")
    fake_codex.script([{"output": codex_output(config=PLAN_CONFIG, plan_markdown="second")}])
    janus.cmd_plan(ws.root)
    second = janus.load_goal(ws.root)
    assert janus.section(second.body, "## Approved-plan content") == "second"
    assert janus.section(second.body, "## Decisions") == "- humans wrote this"
    assert second.body.startswith("# Goal\nUpgrade Angular 15 to 16 in every repository here.\n")


def test_plan_translates_e2e_branch_parameters_into_the_spec_shape(ws, fake_codex):
    config = copy.deepcopy(PLAN_CONFIG)
    config["e2e"] = {"build_type": "Fe_E2E_Full", "branch_parameters": [{"repo": "app", "parameter": "env.APP_BRANCH"}]}
    fake_codex.script([{"output": codex_output(config=config, plan_markdown="p")}])
    janus.cmd_plan(ws.root)
    assert janus.load_goal(ws.root).front["e2e"] == {"build_type": "Fe_E2E_Full", "branch_parameters": {"app": "env.APP_BRANCH"}}


def test_plan_rejects_config_naming_an_unknown_repo(ws, fake_codex):
    config = copy.deepcopy(PLAN_CONFIG)
    config["repos"][0]["name"] = "ghost"
    config["tasks"][0]["repo"] = "ghost"
    fake_codex.script([{"output": codex_output(config=config, plan_markdown="p")}])
    before = (ws.root / "JANUS.md").read_text(encoding="utf-8")
    with pytest.raises(janus.JanusError, match="unknown repository 'ghost'"):
        janus.cmd_plan(ws.root)
    assert (ws.root / "JANUS.md").read_text(encoding="utf-8") == before


def test_plan_rejects_missing_config(ws, fake_codex):
    fake_codex.script([{"output": codex_output(config=None, plan_markdown="p", blockers=["cannot tell the Angular version"])}])
    with pytest.raises(janus.JanusError, match="cannot tell the Angular version"):
        janus.cmd_plan(ws.root)


def test_plan_refuses_when_codex_touched_a_product_repo(ws, fake_codex):
    fake_codex.script([{"shell": ["echo x > app/dirty.txt"], "output": codex_output(config=PLAN_CONFIG, plan_markdown="p")}])
    before = (ws.root / "JANUS.md").read_text(encoding="utf-8")
    with pytest.raises(janus.JanusError, match="planning must not change product source: app"):
        janus.cmd_plan(ws.root)
    assert (ws.root / "JANUS.md").read_text(encoding="utf-8") == before


def test_plan_refuses_after_approval(ws, fake_codex):
    approve_draft(ws.root)
    fake_codex.script([{"output": codex_output(config=PLAN_CONFIG, plan_markdown="p")}])
    with pytest.raises(janus.JanusError, match="already approved"):
        janus.cmd_plan(ws.root)
    assert fake_codex.calls() == []


def test_plan_requires_at_least_one_repo(tmp_path, fake_codex):
    root = tmp_path / "empty"
    init_repo(root)
    (root / "JANUS.md").write_text("# Goal\nUpgrade.\n", encoding="utf-8")
    with pytest.raises(janus.JanusError, match="no product repositories"):
        janus.cmd_plan(root)
    assert fake_codex.calls() == []


def test_plan_requires_goal_text(ws, fake_codex):
    (ws.root / "JANUS.md").write_text("# Goal\n", encoding="utf-8")
    with pytest.raises(janus.JanusError, match="'# Goal' section"):
        janus.cmd_plan(ws.root)


def test_validate_config_fills_defaults_and_checks_shapes():
    cfg = janus.validate_config({"angular": {"from": "15", "to": 16}, "repos": [{"name": "app", "checks": ["npm ci"]}], "tasks": [{"repo": "app", "objective": "Upgrade"}]}, ["app"])
    assert cfg["angular"] == {"from": 15, "to": 16}
    assert cfg["repos"] == [{"name": "app", "base": "main", "branch": "ai/angular-15-to-16", "pr_build": None, "checks": ["npm ci"]}]
    assert cfg["tasks"] == [{"id": 1, "repo": "app", "objective": "Upgrade", "status": "pending"}]
    assert cfg["e2e"] is None
    with pytest.raises(janus.JanusError, match="integer from/to"):
        janus.validate_config({"angular": {"from": "x"}, "repos": [], "tasks": []}, ["app"])
    with pytest.raises(janus.JanusError, match="tasks is empty"):
        janus.validate_config({"angular": {"from": 15, "to": 16}, "repos": [{"name": "app", "checks": []}], "tasks": []}, ["app"])
    with pytest.raises(janus.JanusError, match="not in config.repos"):
        janus.validate_config({"angular": {"from": 15, "to": 16}, "repos": [{"name": "app", "checks": []}], "tasks": [{"repo": "other", "objective": "x"}]}, ["app", "other"])
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_plan.py`
Expected: FAIL with `AttributeError: module 'janus' has no attribute 'RULES_TEXT'` / `cmd_plan` raising "not available".

- [ ] **Step 4: Implement**

Insert under `# --- plan ---`:

```python
RULES_TEXT = (
    "Never change scope or architecture without human direction.\n"
    "Never weaken/skip tests to obtain a green build.\n"
    "Never merge, publish a production release or deploy."
)
STANDARD_SECTIONS: List[Tuple[str, str]] = [
    ("## Approved-plan content", "Draft until approved."),
    ("## Rules", RULES_TEXT),
    ("## Review feedback", "Empty until a human pastes PR review or QA comments here and runs Janus again."),
    ("## Progress and handover", "Not started."),
    ("## Decisions", "None yet."),
]


def plan_prompt(goal_text: str, repos: List[str]) -> str:
    return f"""You are planning a Janus goal. Your working directory holds these product Git repositories
(folder names are repository names): {", ".join(repos)}.

# Goal
{goal_text}

# What to do
This is read-only discovery: read every repository, change nothing, run no installs, create no files,
run no git commands that write. Determine:
- the current Angular major (`from`) and the target major (`to`, normally from + 1);
- for each repository that must change: the base branch to branch from, a goal branch name
  (suggest `ai/angular-<from>-to-<to>`), the TeamCity build configuration id that builds its pull
  requests if the repository reveals one (otherwise null), and the local check commands that must pass
  before a commit (install, build, lint, unit tests; non-interactive, e.g. `npm test -- --watch=false`);
- the implementation tasks in order, one clear objective each, normally one task per repository unless a
  repository needs a separate prerelease step;
- the baseline evidence that matters (which builds or tests are expected green today, known pre-existing
  failures), dependencies and coupled changes, prerelease/versioning strategy for shared libraries, test
  strategy, acceptance criteria and non-goals.

# Output
Answer with the JSON object required by the output schema. Put the machine-readable configuration in
`config` (angular, repos, tasks, e2e or null) and the human-readable plan in `plan_markdown`, using `###`
or deeper headings only. `summary` describes what you inspected; `files_touched` must be empty; `blockers`
lists anything that prevents a sound plan; `values` may be empty; `next_action` is what the human should
check before approving."""


def demote_headings(markdown: str) -> str:
    """Plan text lives inside '## Approved-plan content'; '#'/'##' headings inside it would end the section."""
    return re.sub(r"(?m)^#{1,2} ", "### ", markdown)


def validate_config(config: object, repos: List[str]) -> dict:
    """Normalise Codex's proposed configuration into the spec §4 shapes; refuse anything unusable."""
    if not isinstance(config, dict):
        raise JanusError("codex returned no config")
    angular = config.get("angular") or {}
    try:
        from_major, to_major = int(angular["from"]), int(angular["to"])
    except (KeyError, TypeError, ValueError):
        raise JanusError("config.angular must have integer from/to")
    repo_cfgs = []
    for raw in config.get("repos") or []:
        name = raw.get("name")
        if name not in repos:
            raise JanusError(f"config.repos names unknown repository {name!r}; known: {repos}")
        checks = raw.get("checks") or []
        if not all(isinstance(c, str) and c.strip() for c in checks):
            raise JanusError(f"config.repos[{name}].checks must be non-empty command strings")
        repo_cfgs.append({
            "name": name,
            "base": str(raw.get("base") or "main"),
            "branch": str(raw.get("branch") or f"ai/angular-{from_major}-to-{to_major}"),
            "pr_build": raw.get("pr_build") or None,
            "checks": [c.strip() for c in checks],
        })
    if not repo_cfgs:
        raise JanusError("config.repos is empty")
    names = [r["name"] for r in repo_cfgs]
    tasks = []
    for index, raw in enumerate(config.get("tasks") or [], start=1):
        if raw.get("repo") not in names:
            raise JanusError(f"config.tasks[{index}] names repo {raw.get('repo')!r} that is not in config.repos")
        if not raw.get("objective"):
            raise JanusError(f"config.tasks[{index}] has no objective")
        tasks.append({"id": int(raw.get("id") or index), "repo": raw["repo"], "objective": str(raw["objective"]), "status": "pending"})
    if not tasks:
        raise JanusError("config.tasks is empty")
    e2e = config.get("e2e") or None
    if isinstance(e2e, dict) and isinstance(e2e.get("branch_parameters"), list):
        e2e = {
            "build_type": e2e.get("build_type"),
            "branch_parameters": {p["repo"]: p["parameter"] for p in e2e["branch_parameters"]},
        }
    return {"angular": {"from": from_major, "to": to_major}, "repos": repo_cfgs, "e2e": e2e, "tasks": tasks}


def draft_front_matter(config: dict) -> dict:
    """The full front matter after `plan`, in the spec §4 key order. Runner-owned fields start empty."""
    return {
        "id": f"angular-{config['angular']['from']}-to-{config['angular']['to']}",
        "status": "awaiting_plan_approval",
        "angular": config["angular"],
        "approval": {"plan_hash": None, "approved_by": None, "approved_at": None},
        "repos": config["repos"],
        "e2e": config["e2e"],
        "tasks": config["tasks"],
        "current_task": None,
        "last_verified": {},
        "prs": {},
        "attempts": 0,
        "in_flight": None,
    }


def task_by_id(goal: Goal, task_id: object) -> Optional[dict]:
    for task in goal.front.get("tasks") or []:
        if task.get("id") == task_id:
            return task
    return None


def write_progress(goal: Goal, next_action: str, blocker: Optional[str] = None) -> None:
    """Regenerate the runner-owned '## Progress and handover' section (spec §4, §7)."""
    front = goal.front
    done = [str(t["id"]) for t in front.get("tasks") or [] if t.get("status") == "done"]
    lines = [f"Updated: {now()}", f"State: {front.get('status')}", f"Completed tasks: {', '.join(done) or 'none'}"]
    current = task_by_id(goal, front.get("current_task"))
    if current:
        lines.append(
            f"Current task: {current['id']} ({current['repo']}): {current['objective']} "
            f"[{current.get('status')}, fix attempts used: {front.get('attempts') or 0} of {MAX_FIX_ATTEMPTS}]"
        )
    for name, entry in (front.get("last_verified") or {}).items():
        lines.append(f"Last verified {name}: {entry.get('commit')} ({entry.get('status')}, teamcity_build={entry.get('teamcity_build')})")
    if blocker:
        lines.append(f"Blocker: {blocker}")
    lines.append(f"Next action: {next_action}")
    goal.body = set_section(goal.body, "## Progress and handover", "\n".join(lines))


def changed_repos(root: Path, repos: List[str], before: Dict[str, Dict[str, str]]) -> List[str]:
    return [name for name in repos if record_heads(root / name) != before[name] or working_tree_dirty(root / name)]
```

Add to the constants section (used by `write_progress` now and by `run` later):

```python
MAX_FIX_ATTEMPTS = 3
```

Replace the `cmd_plan` skeleton in the CLI section with:

```python
def cmd_plan(root: Path) -> int:
    with locked(root):
        ensure_control_ignore(root)
        goal = load_goal(root)
        if goal.front.get("status") not in (None, "awaiting_plan_approval"):
            raise JanusError(
                "the plan is already approved; replanning is a human edit of JANUS.md followed by "
                "`python janus.py approve`, or remove the front matter to start over"
            )
        goal_text = section(goal.body, "# Goal")
        if not goal_text:
            raise JanusError(f"{GOAL_FILE} needs a '# Goal' section with the goal text")
        repos = discover_repos(root)
        if not repos:
            raise JanusError("no product repositories found: clone them into this folder first")
        before = {name: record_heads(root / name) for name in repos}
        result = run_codex(root, plan_prompt(goal_text, repos))
        touched = changed_repos(root, repos, before)
        if touched:
            raise JanusError(f"planning must not change product source: {', '.join(touched)} changed; inspect and clean before planning again")
        if result["config"] is None:
            raise JanusError("codex returned no plan configuration" + (": " + "; ".join(result["blockers"]) if result["blockers"] else ""))
        config = validate_config(result["config"], repos)
        goal.front = draft_front_matter(config)
        for heading, default in STANDARD_SECTIONS:
            if section(goal.body, heading) is None:
                goal.body = set_section(goal.body, heading, default)
        goal.body = set_section(goal.body, "## Approved-plan content", demote_headings(result["plan_markdown"] or result["summary"]))
        write_progress(
            goal,
            "Review and edit the draft in JANUS.md (repos, checks, tasks, plan text), then run `python janus.py approve`."
            + (" Codex suggests: " + result["next_action"] if result["next_action"] else ""),
            blocker="Baseline evidence cited by the plan is unverified (no TeamCity configured in this Janus build)."
            + (" Codex blockers: " + "; ".join(result["blockers"]) if result["blockers"] else ""),
        )
        save_checkpoint(goal, f"chore(janus): draft plan for {goal.front['id']}")
        print(f"Draft plan written to {GOAL_FILE} and committed. Review it, edit it, then run `python janus.py approve`.")
        return 0
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `56 passed`

- [ ] **Step 6: Commit**

```bash
cd /home/race-day/janus
git add janus.py JANUS.md tests/test_plan.py
git commit -m "feat(janus): plan command drafts the front matter and plan from one read-only codex run" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Redaction, local checks and diff guardrails

Spec §6 step 4 ("Inspects changed paths and rejects obvious test skips/deletions, forbidden CI changes"), §9 ("Redact credentials and sensitive query parameters", "Simple deterministic diff checks run before every runner commit", "Do not claim that a scripted path check proves tests were not weakened").

**Files:**
- Modify: `janus.py` (section `# --- checks and guardrails ---`)
- Create: `tests/test_checks.py`

**Interfaces:**
- Produces: `redact(text: str) -> str`; `tail(text: str, limit: int = TAIL_CHARS) -> str`; `run_checks(repo: Path, checks: List[str]) -> List[dict]` (each `{"command", "returncode", "output"}`, redacted and bounded; stops after the first failure); `diff_guardrails(name_status: str, diff_text: str) -> List[str]` (human-readable violations; empty means pass). Constants `TAIL_CHARS = 4000`, `CHECK_TIMEOUT_SECONDS = 1800`.

- [ ] **Step 1: Write the failing tests**

`tests/test_checks.py`:

```python
import janus


def test_redact_strips_credentials_shaped_values():
    text = (
        "token=abc123 password=hunter2 api_key: k-9988 "
        "Authorization: Bearer eyJabc.def.ghi "
        "Basic QWxhZGRpbjpvcGVuc2VzYW1l "
        "https://user:pa55word@nexus.example/x?access_token=zzz-top&page=2 keep=this"
    )
    out = janus.redact(text)
    for secret in ("abc123", "hunter2", "k-9988", "eyJabc", "QWxhZGRpbjpvcGVuc2VzYW1l", "pa55word", "zzz-top"):
        assert secret not in out
    assert "keep=this" in out and "page=2" in out and "nexus.example" in out
    assert "[REDACTED]" in out


def test_tail_keeps_the_end_and_marks_truncation():
    assert janus.tail("short") == "short"
    long = "x" * 10 + "END"
    assert janus.tail(long, limit=5) == "...[truncated]...\nxxEND"


def test_run_checks_runs_sequentially_and_stops_at_the_first_failure(tmp_path):
    results = janus.run_checks(tmp_path, ["echo first", "sh -c 'echo token=SECRET >&2; exit 3'", "echo never"])
    assert [r["command"] for r in results] == ["echo first", "sh -c 'echo token=SECRET >&2; exit 3'"]
    assert results[0]["returncode"] == 0 and results[0]["output"] == "first\n"
    assert results[1]["returncode"] == 3
    assert "SECRET" not in results[1]["output"] and "token=[REDACTED]" in results[1]["output"]


def test_run_checks_with_no_checks_passes_trivially(tmp_path):
    assert janus.run_checks(tmp_path, []) == []


def test_run_checks_bounds_output(tmp_path):
    [result] = janus.run_checks(tmp_path, ["yes | head -c 20000"])
    assert len(result["output"]) < 4100 and result["output"].startswith("...[truncated]...")


def test_diff_guardrails_pass_on_ordinary_changes():
    name_status = "M\tpackage.json\nA\tsrc/new.ts\nM\tsrc/app.spec.ts"
    diff = "+++ b/src/app.spec.ts\n+  it('also works', () => {});\n+  describe('x', () => {});"
    assert janus.diff_guardrails(name_status, diff) == []


def test_diff_guardrails_reject_test_deletion_and_rename_away():
    name_status = "D\tsrc/app.spec.ts\nR100\tsrc/util.spec.ts\tsrc/util.ts\nR100\tsrc/a.spec.ts\tsrc/b.spec.ts"
    problems = janus.diff_guardrails(name_status, "")
    assert problems == ["test file deleted: src/app.spec.ts", "test file renamed away: src/util.spec.ts -> src/util.ts"]


def test_diff_guardrails_reject_ci_configuration_changes():
    name_status = "M\t.github/workflows/ci.yml\nA\t.teamcity/settings.kts\nM\tbuild.teamcity.xml\nM\tJenkinsfile\nM\t.gitlab-ci.yml\nM\tsrc/ok.ts"
    problems = janus.diff_guardrails(name_status, "")
    assert problems == [
        "CI configuration changed: .github/workflows/ci.yml",
        "CI configuration changed: .teamcity/settings.kts",
        "CI configuration changed: build.teamcity.xml",
        "CI configuration changed: Jenkinsfile",
        "CI configuration changed: .gitlab-ci.yml",
    ]


def test_diff_guardrails_reject_added_test_skips_and_focus():
    diff = (
        "+++ b/src/app.spec.ts\n"
        "-  it('works', () => {});\n"
        "+  xit('works', () => {});\n"
        "+  fit('focused', () => {});\n"
        "+  fdescribe('suite', () => {});\n"
        "+  xdescribe('suite', () => {});\n"
        "+  it.skip('later', () => {});\n"
        "+  it.todo('someday');\n"
        "+  const fixture = 1; // 'exit(' and 'profit(' are not skips\n"
        "+++ b/src/other.ts\n"
        "+  observable.pipe(skip(1));\n"
    )
    problems = janus.diff_guardrails("M\tsrc/app.spec.ts\nM\tsrc/other.ts", diff)
    assert problems == [
        "test skip/focus added in src/app.spec.ts: xit('works', () => {});",
        "test skip/focus added in src/app.spec.ts: fit('focused', () => {});",
        "test skip/focus added in src/app.spec.ts: fdescribe('suite', () => {});",
        "test skip/focus added in src/app.spec.ts: xdescribe('suite', () => {});",
        "test skip/focus added in src/app.spec.ts: it.skip('later', () => {});",
        "test skip/focus added in src/app.spec.ts: it.todo('someday');",
    ]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_checks.py`
Expected: FAIL with `AttributeError: module 'janus' has no attribute 'redact'`

- [ ] **Step 3: Implement**

Add to the constants section:

```python
TAIL_CHARS = 4000
CHECK_TIMEOUT_SECONDS = 1800
```

Insert under `# --- checks and guardrails ---`:

```python
REDACTIONS = [
    (re.compile(r"(?i)(authorization\s*[:=]\s*)\S+(\s+\S+)?"), r"\1[REDACTED]"),
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 [REDACTED]"),
    (re.compile(r"(?i)([A-Za-z0-9_-]*(token|password|passwd|secret|api[_-]?key|access[_-]?key)[A-Za-z0-9_-]*\s*[=:]\s*)[^\s&\"']+"), r"\1[REDACTED]"),
    (re.compile(r"(://[^/\s:@]+:)[^@\s]+@"), r"\1[REDACTED]@"),
]


def redact(text: str) -> str:
    """Strip credential-shaped values before text reaches a prompt or JANUS.md (spec §9)."""
    for pattern, replacement in REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


def tail(text: str, limit: int = TAIL_CHARS) -> str:
    return text if len(text) <= limit else "...[truncated]...\n" + text[-limit:]


def run_checks(repo: Path, checks: List[str]) -> List[dict]:
    """Run the approved local checks in order; stop at the first failure; keep a redacted, bounded tail."""
    results = []
    for command in checks:
        try:
            proc = subprocess.run(command, shell=True, cwd=str(repo), capture_output=True, text=True, errors="replace", timeout=CHECK_TIMEOUT_SECONDS)
            code, output = proc.returncode, proc.stdout + proc.stderr
        except subprocess.TimeoutExpired:
            code, output = 124, f"timed out after {CHECK_TIMEOUT_SECONDS}s"
        results.append({"command": command, "returncode": code, "output": redact(tail(output))})
        if code != 0:
            break
    return results


TEST_PATH_RE = re.compile(r"(\.spec\.|\.test\.|(^|/)__tests__/)")
CI_PATH_RE = re.compile(r"(^|/)(\.github/|\.teamcity/|[^/]*\.teamcity[^/]*$|Jenkinsfile$|\.gitlab-ci[^/]*$)")
SKIP_RE = re.compile(r"\b(xit|fit|fdescribe|xdescribe)\s*\(|\.skip\s*\(|\bit\.todo\s*\(")


def diff_guardrails(name_status: str, diff_text: str) -> List[str]:
    """Deterministic rejections before every runner commit (spec §6 step 4, §9). Not a proof that
    tests were not weakened; independent review still inspects semantics."""
    problems: List[str] = []
    for line in name_status.splitlines():
        parts = line.split("\t")
        status, paths = parts[0], parts[1:]
        if not paths:
            continue
        for path in paths:
            if CI_PATH_RE.search(path):
                problems.append(f"CI configuration changed: {path}")
                break
        if status.startswith("D") and TEST_PATH_RE.search(paths[0]):
            problems.append(f"test file deleted: {paths[0]}")
        if status.startswith("R") and len(paths) == 2 and TEST_PATH_RE.search(paths[0]) and not TEST_PATH_RE.search(paths[1]):
            problems.append(f"test file renamed away: {paths[0]} -> {paths[1]}")
    current = ""
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            current = line[6:] if line.startswith("+++ b/") else line[4:]
        elif line.startswith("+") and not line.startswith("+++") and SKIP_RE.search(line):
            problems.append(f"test skip/focus added in {current}: {line[1:].strip()}")
    return problems
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `65 passed`

- [ ] **Step 5: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/test_checks.py
git commit -m "feat(janus): redacted bounded local checks and deterministic diff guardrails" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The `run` loop for one task with bounded fix attempts

Spec §6 "Implementation and TeamCity loop" steps 1 to 5 and 7 (local part), §7 (stop conditions), §8 (checkpoint before Codex, after push, at human gates), §9 (ref-move detection), §11 criteria 2, 4, 9.

**Files:**
- Modify: `janus.py` (section `# --- run ---`; replace `cmd_run`)
- Create: `tests/test_run.py`

**Interfaces:**
- Consumes: everything from Tasks 2 to 8.
- Produces: `CODEX_TASK_RULES: str`; `CI_HANDOVER: str`; `task_prompt(goal: Goal, task: dict, repo_cfg: dict, failure: Optional[str], interrupted: bool) -> str`; `next_task(goal: Goal) -> Optional[dict]`; `repo_config(goal: Goal, name: str) -> dict`; `format_failure(check_results: List[dict], violations: List[str]) -> str`; `record_verified(goal: Goal, name: str, sha: str) -> None`; `stop_for_human(goal: Goal, reason: str, next_action: str) -> int` (always returns 1); `run_next_task(goal: Goal, interrupted: bool) -> int`; `cmd_run(root: Path) -> int`. Task 10 inserts `reconcile_in_flight` into `cmd_run`.
- Exit codes: 0 when all tasks are done, 1 when stopped for a human (handover written and committed), 2 on `JanusError` (from `main`).

- [ ] **Step 1: Write the failing tests**

`tests/test_run.py`:

```python
import pytest

import janus
from helpers import approve_draft, codex_output, draft_front, git, write_draft

BRANCH = "ai/angular-15-to-16"


def test_run_implements_the_task_commits_pushes_and_stops_because_ci_is_not_configured(ws, fake_codex):
    approve_draft(ws.root, draft_front(checks=["test -f src/version.ts", "echo ok"]))
    fake_codex.script([{
        "shell": ["printf 'export const v = 16;\\n' > src/version.ts"],
        "output": codex_output(summary="bumped", files_touched=["src/version.ts"], values=[{"name": "note", "value": "x"}]),
    }])
    assert janus.cmd_run(ws.root) == 1
    sha = git(ws.app, "rev-parse", "HEAD")
    assert git(ws.app, "rev-parse", "--abbrev-ref", "HEAD") == BRANCH
    assert git(ws.app, "log", "-1", "--format=%s") == "chore(angular): Upgrade app to Angular 16"
    assert git(ws.app, "log", "-1", "--format=%b").strip() == "Janus-Task: 1"
    assert git(ws.bare, "rev-parse", f"refs/heads/{BRANCH}") == sha
    assert janus.working_tree_dirty(ws.app) is False
    goal = janus.load_goal(ws.root)
    assert goal.front["last_verified"] == {"app": {"commit": sha, "teamcity_build": None, "status": "local_checks_passed"}}
    task = goal.front["tasks"][0]
    assert task["status"] == "awaiting_ci" and task["values"] == {"note": "x"} and task["summary"] == "bumped"
    assert goal.front["status"] == "blocked" and goal.front["in_flight"] is None
    assert goal.front["attempts"] == 0 and goal.front["current_task"] == 1
    progress = janus.section(goal.body, "## Progress and handover")
    assert "not CI evidence" in progress and "pr_build is not configured" in progress and sha in progress
    assert git(ws.root, "log", "--format=%s", "-3").splitlines() == [
        "chore(janus): stop for human direction",
        f"chore(janus): task 1 pushed {sha[:12]}",
        "chore(janus): task 1 attempt 0 in app",
    ]
    [call] = fake_codex.calls()
    assert call["cwd"] == str(ws.app)
    for needle in ("Upgrade app to Angular 16", "test -f src/version.ts", "Do not run git commit", "One task: upgrade app", "set config and plan_markdown to null"):
        assert needle in call["prompt"]
    assert "Previous attempt failed" not in call["prompt"] and "Interrupted previous attempt" not in call["prompt"]


def test_run_checkpoints_in_flight_before_codex(ws, fake_codex):
    approve_draft(ws.root)
    fake_codex.script([{"shell": ["cd .. && git show HEAD:JANUS.md > in-flight-snapshot.md"], "output": codex_output()}])
    janus.cmd_run(ws.root)
    snapshot = janus.split_front_matter((ws.root / "in-flight-snapshot.md").read_text(encoding="utf-8"))[0]
    assert "in_flight:" in snapshot and "task: 1" in snapshot and "operation: codex" in snapshot and "start_sha:" in snapshot
    assert "status: executing" in snapshot


def test_run_retries_with_a_redacted_failure_summary_until_checks_pass(ws, fake_codex, monkeypatch):
    monkeypatch.setenv("LEAK", "SECRET")
    approve_draft(ws.root, draft_front(checks=['test -f fixed.txt || { echo "token=$LEAK missing fixed.txt" >&2; exit 1; }']))
    fake_codex.script([
        {"shell": ["echo a > a.txt"], "output": codex_output(summary="first try")},
        {"shell": ["touch fixed.txt"], "output": codex_output(summary="fixed")},
    ])
    assert janus.cmd_run(ws.root) == 1
    calls = fake_codex.calls()
    assert len(calls) == 2
    assert "Previous attempt failed" in calls[1]["prompt"]
    assert "exited 1" in calls[1]["prompt"] and "missing fixed.txt" in calls[1]["prompt"]
    assert "SECRET" not in calls[1]["prompt"]
    goal = janus.load_goal(ws.root)
    assert goal.front["tasks"][0]["status"] == "awaiting_ci" and goal.front["attempts"] == 0
    assert "fixed.txt" in git(ws.app, "show", "--stat", "--format=", "HEAD")
    assert "chore(janus): task 1 attempt 1 in app" in git(ws.root, "log", "--format=%s").splitlines()


def test_run_treats_guardrail_violations_as_failed_attempts(ws, fake_codex):
    approve_draft(ws.root, draft_front(checks=["test -f ok.txt"]))
    fake_codex.script([
        {"shell": ["printf \"fdescribe('focus', () => {});\\n\" >> src/app.spec.ts", "touch ok.txt"], "output": codex_output()},
        {"shell": ["git checkout HEAD -- src/app.spec.ts"], "output": codex_output(summary="reverted the focus")},
    ])
    assert janus.cmd_run(ws.root) == 1
    calls = fake_codex.calls()
    assert len(calls) == 2
    assert "Diff guardrail violations" in calls[1]["prompt"] and "fdescribe" in calls[1]["prompt"]
    assert "fdescribe" not in git(ws.app, "show", "HEAD:src/app.spec.ts")
    assert janus.load_goal(ws.root).front["tasks"][0]["status"] == "awaiting_ci"


def test_run_stops_after_three_code_fix_attempts_without_committing(ws, fake_codex):
    approve_draft(ws.root, draft_front(checks=["false"]))
    fake_codex.script([{"shell": ["echo a >> a.txt"], "output": codex_output()}])
    main_sha = git(ws.app, "rev-parse", "main")
    assert janus.cmd_run(ws.root) == 1
    assert len(fake_codex.calls()) == 4
    assert git(ws.app, "rev-parse", "HEAD") == main_sha
    assert janus.ref_exists(ws.bare, f"refs/heads/{BRANCH}") is False
    goal = janus.load_goal(ws.root)
    assert goal.front["status"] == "blocked" and goal.front["attempts"] == 3 and goal.front["in_flight"] is None
    assert goal.front["tasks"][0]["status"] == "in_progress"
    assert goal.front["last_verified"] == {}
    progress = janus.section(goal.body, "## Progress and handover")
    assert "3 code-fix attempts exhausted" in progress and "left uncommitted" in progress
    assert janus.working_tree_dirty(ws.app) is True


def test_run_refuses_an_unapproved_plan(ws, fake_codex):
    write_draft(ws.root)
    with pytest.raises(janus.JanusError, match="not approved"):
        janus.cmd_run(ws.root)
    assert fake_codex.calls() == []


def test_run_refuses_a_changed_plan(ws, fake_codex):
    goal = approve_draft(ws.root)
    goal.front["tasks"][0]["objective"] = "Edited after approval"
    janus.save_goal(goal)
    with pytest.raises(janus.JanusError, match="has changed"):
        janus.cmd_run(ws.root)
    assert fake_codex.calls() == []


def test_run_stops_when_codex_moves_a_ref(ws, fake_codex):
    approve_draft(ws.root)
    fake_codex.script([{"shell": ["git commit -q --allow-empty -m 'agent committed'"], "output": codex_output()}])
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["status"] == "blocked"
    assert f"refs/heads/{BRANCH}" in janus.section(goal.body, "## Progress and handover")
    assert janus.ref_exists(ws.bare, f"refs/heads/{BRANCH}") is False


def test_run_stops_on_an_unrecognized_dirty_tree(ws, fake_codex):
    approve_draft(ws.root)
    (ws.app / "stray.txt").write_text("?", encoding="utf-8")
    assert janus.cmd_run(ws.root) == 1
    assert fake_codex.calls() == []
    goal = janus.load_goal(ws.root)
    assert "unrecognized dirty working tree" in janus.section(goal.body, "## Progress and handover")
    assert (ws.app / "stray.txt").exists()


def test_run_stops_when_codex_changes_nothing(ws, fake_codex):
    approve_draft(ws.root)
    fake_codex.script([{"output": codex_output(blockers=["needs an architectural decision"], next_action="ask the team")}])
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    progress = janus.section(goal.body, "## Progress and handover")
    assert "needs an architectural decision" in progress and "Next action: ask the team" in progress
    assert git(ws.app, "rev-parse", "HEAD") == git(ws.app, "rev-parse", "main")


def test_run_on_a_task_awaiting_ci_stops_without_calling_codex(ws, fake_codex):
    goal = approve_draft(ws.root)
    goal.front["tasks"][0]["status"] = "awaiting_ci"
    goal.front["current_task"] = 1
    goal.front["last_verified"] = {"app": {"commit": "a" * 40, "teamcity_build": None, "status": "local_checks_passed"}}
    janus.save_goal(goal)
    assert janus.cmd_run(ws.root) == 1
    assert fake_codex.calls() == []
    assert "no CI evidence" in janus.section(janus.load_goal(ws.root).body, "## Progress and handover")


def test_run_with_all_tasks_done_records_completion(ws, fake_codex):
    goal = approve_draft(ws.root)
    goal.front["tasks"][0]["status"] = "done"
    janus.save_goal(goal)
    assert janus.cmd_run(ws.root) == 0
    assert fake_codex.calls() == []
    done = janus.load_goal(ws.root)
    assert done.front["status"] == "done"
    assert "Completed tasks: 1" in janus.section(done.body, "## Progress and handover")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_run.py`
Expected: FAIL; `cmd_run` raises `JanusError: run is not available in this build yet`.

- [ ] **Step 3: Implement**

Insert under `# --- run ---`:

```python
CODEX_TASK_RULES = (
    "Work only inside this repository. Do not run git commit, git push, git checkout, git reset, git tag or "
    "any other command that moves a ref; the runner commits and pushes.\n"
    "Do not edit CI configuration (.github/, .teamcity/, *.teamcity*, Jenkinsfile, .gitlab-ci*), and do not "
    "skip, focus, delete or weaken tests (xit, fit, fdescribe, xdescribe, .skip, it.todo, deleted spec files); "
    "the runner rejects such diffs.\n"
    "Do not touch JANUS.md or anything outside this repository. Run the local checks listed below yourself "
    "before you finish.\n"
    "If the task needs a decision the approved plan does not cover, stop and report it in blockers instead "
    "of guessing."
)
CI_HANDOVER = (
    "Verify the pushed commit through your CI yourself. To continue without CI evidence, set this task's "
    "status to done in JANUS.md, record the decision under ## Decisions, and run `python janus.py run` again."
)


def task_prompt(goal: Goal, task: dict, repo_cfg: dict, failure: Optional[str], interrupted: bool) -> str:
    front = goal.front
    values: Dict[str, str] = {}
    for earlier in front.get("tasks") or []:
        if earlier.get("id") == task["id"]:
            break
        values.update(earlier.get("values") or {})
    angular = front.get("angular") or {}
    parts = [
        f"You are implementing one approved task of a Janus goal inside the repository `{repo_cfg['name']}` "
        f"(your working directory). Angular upgrade: {angular.get('from')} to {angular.get('to')}.",
        "# Goal\n" + (section(goal.body, "# Goal") or ""),
        f"# Your task\nTask {task['id']}: {task['objective']}",
        "# Approved plan\n" + (section(goal.body, "## Approved-plan content") or ""),
        "# Rules\n" + (section(goal.body, "## Rules") or RULES_TEXT) + "\n" + CODEX_TASK_RULES,
        "# Local checks the runner will execute after you finish\n"
        + ("\n".join(f"- {c}" for c in repo_cfg["checks"]) or "- (none configured)"),
    ]
    if values:
        parts.append("# Values recorded by earlier tasks\n" + "\n".join(f"- {k}: {v}" for k, v in values.items()))
    if interrupted:
        parts.append(
            "# Interrupted previous attempt\nA previous Codex run on this task was interrupted. Its uncommitted "
            "changes are still in the working tree (the runner also saved them as a patch). Start by inspecting "
            "`git status` and `git diff`, then continue from there; do not discard that work without reason."
        )
    if failure:
        parts.append("# Previous attempt failed\nThe previous attempt did not pass. Fix the cause without weakening tests, then finish.\n" + failure)
    parts.append(
        "# Output\nWhen finished, answer with the JSON object required by the output schema: summary, files_touched, "
        "values (name/value pairs later tasks need, such as a published version), blockers (empty when none), "
        "next_action; set config and plan_markdown to null."
    )
    return "\n\n".join(parts)


def next_task(goal: Goal) -> Optional[dict]:
    for task in goal.front.get("tasks") or []:
        if task.get("status") != "done":
            return task
    return None


def repo_config(goal: Goal, name: str) -> dict:
    for repo in goal.front.get("repos") or []:
        if repo.get("name") == name:
            return repo
    raise JanusError(f"task refers to repository {name!r} which is not in repos[]")


def format_failure(check_results: List[dict], violations: List[str]) -> str:
    """Bounded, redacted summary for the fix prompt and the handover (spec §6 step 7)."""
    blocks = []
    if violations:
        blocks.append("Diff guardrail violations:\n" + "\n".join(f"- {v}" for v in violations))
    for result in check_results:
        if result["returncode"] != 0:
            blocks.append(f"Check `{result['command']}` exited {result['returncode']}. Output tail:\n```\n{result['output']}\n```")
    return redact("\n\n".join(blocks))[:FAILURE_SUMMARY_CHARS]


def record_verified(goal: Goal, name: str, sha: str) -> None:
    verified = goal.front.get("last_verified") or {}
    verified[name] = {"commit": sha, "teamcity_build": None, "status": "local_checks_passed"}
    goal.front["last_verified"] = verified


def stop_for_human(goal: Goal, reason: str, next_action: str) -> int:
    """Human gate (spec §7): record the handover, checkpoint, print it, exit 1."""
    goal.front["status"] = "blocked"
    goal.front["in_flight"] = None
    write_progress(goal, next_action, blocker=reason)
    save_checkpoint(goal, "chore(janus): stop for human direction")
    print(f"\nJanus stopped for human direction.\nReason: {reason}\nNext action: {next_action}")
    return 1


def run_next_task(goal: Goal, interrupted: bool) -> int:
    task = next_task(goal)
    if task is None:
        goal.front["status"] = "done"
        goal.front["current_task"] = None
        write_progress(goal, "All tasks are done. Human PR review, QA and merge follow the existing process.")
        save_checkpoint(goal, "chore(janus): all tasks done")
        print("All tasks are done.")
        return 0
    repo_cfg = repo_config(goal, task["repo"])
    repo = goal.root / repo_cfg["name"]
    if not (repo / ".git").exists():
        raise JanusError(f"repository folder {repo_cfg['name']} is missing; clone it into {goal.root}")
    if goal.front.get("current_task") != task["id"]:
        goal.front["current_task"] = task["id"]
        goal.front["attempts"] = 0
    goal.front["attempts"] = goal.front.get("attempts") or 0
    if task.get("status") == "awaiting_ci":
        verified = (goal.front.get("last_verified") or {}).get(repo_cfg["name"]) or {}
        reason = f"task {task['id']} is pushed as {verified.get('commit')} on {repo_cfg['branch']} but has no CI evidence"
        reason += "; pr_build is not configured for this repo" if not repo_cfg.get("pr_build") else "; PR build verification is not part of this Janus build yet"
        return stop_for_human(goal, reason, CI_HANDOVER)
    if working_tree_dirty(repo) and not interrupted:
        return stop_for_human(
            goal,
            f"{repo_cfg['name']} has an unrecognized dirty working tree and Janus does not know who owns it",
            f"Inspect `git -C {repo_cfg['name']} status`; commit, stash or clean the tree yourself (do not discard work blindly), then run again.",
        )
    checkout_goal_branch(repo, repo_cfg["base"], repo_cfg["branch"])
    goal.front["status"] = "executing"
    task["status"] = "in_progress"
    failure: Optional[str] = None
    while True:
        heads = record_heads(repo)
        goal.front["in_flight"] = {
            "task": task["id"], "repo": repo_cfg["name"], "start_sha": git(repo, "rev-parse", "HEAD"),
            "operation": "codex", "attempt": goal.front["attempts"], "started_at": now(),
        }
        write_progress(goal, f"Codex is working on task {task['id']} in {repo_cfg['name']}; run `python janus.py run` again after an interruption.")
        save_checkpoint(goal, f"chore(janus): task {task['id']} attempt {goal.front['attempts']} in {repo_cfg['name']}")
        result = run_codex(repo, task_prompt(goal, task, repo_cfg, failure, interrupted))
        interrupted = False
        moved = check_heads_unchanged(repo, heads)
        if moved:
            return stop_for_human(
                goal,
                f"Codex moved refs in {repo_cfg['name']}: {', '.join(moved)}",
                "Inspect the repository history; undo only what you understand; then run again.",
            )
        name_status, diff_text = stage_and_diff(repo)
        if not name_status:
            reason = f"Codex changed nothing in {repo_cfg['name']}" + (": " + "; ".join(result["blockers"]) if result["blockers"] else " and reported no blockers")
            return stop_for_human(goal, reason, result["next_action"] or "Decide how to proceed, record it under ## Decisions, then run again.")
        violations = diff_guardrails(name_status, diff_text)
        check_results = [] if violations else run_checks(repo, repo_cfg["checks"])
        if not violations and all(r["returncode"] == 0 for r in check_results):
            break
        failure = format_failure(check_results, violations)
        if goal.front["attempts"] >= MAX_FIX_ATTEMPTS:
            return stop_for_human(
                goal,
                f"{MAX_FIX_ATTEMPTS} code-fix attempts exhausted on task {task['id']}; the failing attempt is left uncommitted in {repo_cfg['name']}.\n{failure}",
                "Inspect the repository, fix or revert the uncommitted attempt, then run again; or edit the plan and re-approve.",
            )
        goal.front["attempts"] += 1
        print(f"Task {task['id']}: attempt failed; starting code-fix attempt {goal.front['attempts']} of {MAX_FIX_ATTEMPTS}")
    sha = git_commit_push(repo, repo_cfg["branch"], f"chore(angular): {task['objective']}", f"Janus-Task: {task['id']}")
    patch = goal.root / PATCH_FILE
    if patch.exists():
        patch.unlink()
    record_verified(goal, repo_cfg["name"], sha)
    task["status"] = "awaiting_ci"
    task["summary"] = result["summary"]
    if result["values"]:
        task["values"] = result["values"]
    if result["blockers"]:
        task["blockers"] = result["blockers"]
    goal.front["in_flight"] = None
    goal.front["attempts"] = 0
    write_progress(goal, "Awaiting CI evidence for the pushed commit.")
    save_checkpoint(goal, f"chore(janus): task {task['id']} pushed {sha[:12]}")
    reason = (
        f"task {task['id']} passed its local checks and was pushed as {sha} on {repo_cfg['branch']}, "
        "but local checks are not CI evidence"
    )
    reason += "; pr_build is not configured for this repo" if not repo_cfg.get("pr_build") else "; PR build verification is not part of this Janus build yet"
    return stop_for_human(goal, reason, CI_HANDOVER)
```

Add to the constants section:

```python
FAILURE_SUMMARY_CHARS = 6000
```

Replace the `cmd_run` skeleton in the CLI section with:

```python
def cmd_run(root: Path) -> int:
    with locked(root):
        ensure_control_ignore(root)
        goal = load_goal(root)
        verify_plan_approval(goal)
        return run_next_task(goal, interrupted=False)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `77 passed`

- [ ] **Step 5: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/test_run.py
git commit -m "feat(janus): run one approved task with checks, guardrails, bounded fixes and a runner commit" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Crash resume from `in_flight`

Spec §8 ("An already-pushed commit ... must not be duplicated merely because Janus crashed before updating Markdown", "preserve it as `.janus-interrupted.patch` and resume with a fresh agent instructed to inspect the diff"), §11 criterion 5 (local part).

**Files:**
- Modify: `janus.py` (section `# --- run ---`; edit `cmd_run`)
- Create: `tests/test_resume.py`

**Interfaces:**
- Consumes: `task_by_id`, `repo_config`, `git`, `commit_on_remote`, `working_tree_dirty`, `record_verified`, `write_progress`, `save_checkpoint`, `PATCH_FILE`.
- Produces: `reconcile_in_flight(goal: Goal) -> bool` (True when an interrupted diff was preserved for the resumed task; False otherwise; raises `JanusError` when the branch moved to a non-Janus commit). `cmd_run` becomes `verify → reconcile → run_next_task`.

- [ ] **Step 1: Write the failing tests**

`tests/test_resume.py`:

```python
import pytest

import janus
from helpers import approve_draft, codex_output, commit_all, draft_front, git

BRANCH = "ai/angular-15-to-16"


def start_task_in_flight(ws, goal, start_sha):
    goal.front.update({"status": "executing", "current_task": 1, "attempts": 1, "in_flight": {
        "task": 1, "repo": "app", "start_sha": start_sha, "operation": "codex", "attempt": 1, "started_at": "2026-09-21T00:00:00Z",
    }})
    goal.front["tasks"][0]["status"] = "in_progress"
    janus.save_goal(goal)
    commit_all(ws.root, "chore(janus): task 1 attempt 1 in app")


def janus_commit(ws, message="chore(angular): Upgrade app to Angular 16"):
    (ws.app / "done.txt").write_text("d", encoding="utf-8")
    git(ws.app, "add", "-A")
    git(ws.app, "commit", "-q", "-m", message, "-m", "Janus-Task: 1")
    return git(ws.app, "rev-parse", "HEAD")


def test_pushed_commit_is_recovered_without_a_new_codex_run(ws, fake_codex):
    goal = approve_draft(ws.root)
    janus.checkout_goal_branch(ws.app, "main", BRANCH)
    start = git(ws.app, "rev-parse", "HEAD")
    sha = janus_commit(ws)
    git(ws.app, "push", "-q", "origin", BRANCH)
    start_task_in_flight(ws, goal, start)
    assert janus.cmd_run(ws.root) == 1
    assert fake_codex.calls() == []
    assert git(ws.bare, "rev-list", "--count", BRANCH) == "2"
    after = janus.load_goal(ws.root)
    assert after.front["last_verified"]["app"]["commit"] == sha
    assert after.front["tasks"][0]["status"] == "awaiting_ci"
    assert after.front["in_flight"] is None and after.front["attempts"] == 0
    assert f"recovered pushed commit {sha[:12]}" in git(ws.root, "log", "--format=%s")


def test_local_janus_commit_is_pushed_not_redone(ws, fake_codex):
    goal = approve_draft(ws.root)
    janus.checkout_goal_branch(ws.app, "main", BRANCH)
    start = git(ws.app, "rev-parse", "HEAD")
    sha = janus_commit(ws)
    start_task_in_flight(ws, goal, start)
    assert janus.cmd_run(ws.root) == 1
    assert fake_codex.calls() == []
    assert git(ws.bare, "rev-parse", f"refs/heads/{BRANCH}") == sha
    assert janus.load_goal(ws.root).front["last_verified"]["app"]["commit"] == sha


def test_interrupted_diff_is_preserved_and_the_fresh_codex_is_told(ws, fake_codex):
    goal = approve_draft(ws.root, draft_front(checks=["test -f src/version.ts"]))
    janus.checkout_goal_branch(ws.app, "main", BRANCH)
    (ws.app / "src" / "version.ts").write_text("export const v = 16;\n", encoding="utf-8")
    (ws.app / "package.json").write_text('{"name": "app", "version": "16.0.0"}\n', encoding="utf-8")
    start_task_in_flight(ws, goal, git(ws.app, "rev-parse", "HEAD"))
    loaded = janus.load_goal(ws.root)
    assert janus.reconcile_in_flight(loaded) is True
    patch = (ws.root / ".janus-interrupted.patch").read_text(encoding="utf-8")
    assert "+export const v = 16;" in patch and '+{"name": "app", "version": "16.0.0"}' in patch
    assert (ws.app / "src" / "version.ts").exists()
    fake_codex.script([{"output": codex_output(summary="finished the interrupted work")}])
    assert janus.cmd_run(ws.root) == 1
    [call] = fake_codex.calls()
    assert "Interrupted previous attempt" in call["prompt"]
    assert "src/version.ts" in git(ws.app, "show", "--stat", "--format=", "HEAD")
    assert not (ws.root / ".janus-interrupted.patch").exists()
    after = janus.load_goal(ws.root)
    assert after.front["tasks"][0]["status"] == "awaiting_ci"
    assert after.front["attempts"] == 0


def test_interrupted_clean_tree_just_reruns_codex(ws, fake_codex):
    goal = approve_draft(ws.root)
    janus.checkout_goal_branch(ws.app, "main", BRANCH)
    start_task_in_flight(ws, goal, git(ws.app, "rev-parse", "HEAD"))
    fake_codex.script([{"shell": ["echo x > x.txt"], "output": codex_output()}])
    assert janus.cmd_run(ws.root) == 1
    [call] = fake_codex.calls()
    assert "Interrupted previous attempt" not in call["prompt"]
    assert not (ws.root / ".janus-interrupted.patch").exists()
    assert "task 1 attempt 1 in app" in git(ws.root, "log", "-3", "--format=%s")


def test_foreign_commit_since_start_stops_the_run(ws, fake_codex):
    goal = approve_draft(ws.root)
    janus.checkout_goal_branch(ws.app, "main", BRANCH)
    start = git(ws.app, "rev-parse", "HEAD")
    (ws.app / "who.txt").write_text("?", encoding="utf-8")
    commit_all(ws.app, "someone else committed")
    start_task_in_flight(ws, goal, start)
    with pytest.raises(janus.JanusError, match="not a Janus commit"):
        janus.cmd_run(ws.root)
    assert fake_codex.calls() == []
    assert janus.load_goal(ws.root).front["in_flight"] is not None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_resume.py`
Expected: FAIL with `AttributeError: module 'janus' has no attribute 'reconcile_in_flight'` and, for the recovery tests, extra codex calls.

- [ ] **Step 3: Implement**

Insert at the end of the `# --- run ---` section (after `run_next_task`):

```python
def reconcile_in_flight(goal: Goal) -> bool:
    """Spec §8 restart: compare the in_flight checkpoint with the repository before doing anything
    irreversible. Returns True when an interrupted Codex diff was preserved for the resumed task."""
    inflight = goal.front.get("in_flight")
    if not inflight:
        return False
    task = task_by_id(goal, inflight.get("task"))
    repo_cfg = repo_config(goal, inflight.get("repo"))
    repo = goal.root / repo_cfg["name"]
    if task is None or not (repo / ".git").exists():
        raise JanusError(f"in_flight refers to task {inflight.get('task')!r} in {inflight.get('repo')!r} which no longer exists; fix JANUS.md by hand")
    head = git(repo, "rev-parse", "HEAD")
    if head != inflight.get("start_sha"):
        message = git(repo, "log", "-1", "--format=%B", head)
        if f"Janus-Task: {task['id']}" not in message:
            raise JanusError(
                f"{repo_cfg['name']} moved from {str(inflight.get('start_sha'))[:12]} to {head[:12]} while task {task['id']} "
                "was in flight and that commit is not a Janus commit; inspect it, then either reset the branch to the "
                "start commit or set in_flight to null in JANUS.md after recording the decision under ## Decisions"
            )
        if not commit_on_remote(repo, head, repo_cfg["branch"]):
            git(repo, "push", "-q", "origin", f"{repo_cfg['branch']}:{repo_cfg['branch']}")
        record_verified(goal, repo_cfg["name"], head)
        task["status"] = "awaiting_ci"
        goal.front["in_flight"] = None
        goal.front["attempts"] = 0
        write_progress(goal, "Awaiting CI evidence for the recovered commit.")
        save_checkpoint(goal, f"chore(janus): recovered pushed commit {head[:12]} for task {task['id']}")
        print(f"Recovered task {task['id']}: commit {head[:12]} was already made by Janus; not redoing it.")
        return False
    if working_tree_dirty(repo):
        git(repo, "add", "-A")
        (goal.root / PATCH_FILE).write_text(git(repo, "diff", "--cached") + "\n", encoding="utf-8")
        print(f"Preserved the interrupted diff of {repo_cfg['name']} as {PATCH_FILE}; a fresh Codex will inspect it.")
        return True
    return False
```

Replace `cmd_run` with:

```python
def cmd_run(root: Path) -> int:
    with locked(root):
        ensure_control_ignore(root)
        goal = load_goal(root)
        verify_plan_approval(goal)
        interrupted = reconcile_in_flight(goal)
        return run_next_task(goal, interrupted)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `82 passed`

- [ ] **Step 5: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/test_resume.py
git commit -m "feat(janus): resume after a crash without redoing pushed commits or discarding interrupted work" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The `status` command

Spec §5 ("concise state, PR/build links, next action"), §2 ("useful status/blocked summary").

**Files:**
- Modify: `janus.py` (section `# --- status ---`; replace `cmd_status`)
- Create: `tests/test_status.py`

**Interfaces:**
- Consumes: `load_goal`, `section`, `task_by_id`, `git`.
- Produces: `show_status(goal: Goal) -> str`; `cmd_status(root: Path) -> int`.

- [ ] **Step 1: Write the failing tests**

`tests/test_status.py`:

```python
import janus
from helpers import approve_draft, git


def test_status_before_plan_points_to_the_plan_command(ws, capsys):
    assert janus.cmd_status(ws.root) == 0
    out = capsys.readouterr().out
    assert "status: no plan yet" in out
    assert "Upgrade Angular 15 to 16 in every repository here." in out
    assert "next action: run `python janus.py plan`" in out


def test_status_shows_tasks_repos_verification_and_handover(ws):
    goal = approve_draft(ws.root)
    goal.front["status"] = "blocked"
    goal.front["current_task"] = 1
    goal.front["attempts"] = 2
    goal.front["tasks"][0]["status"] = "awaiting_ci"
    goal.front["last_verified"] = {"app": {"commit": "a" * 40, "teamcity_build": None, "status": "local_checks_passed"}}
    goal.body = janus.set_section(goal.body, "## Progress and handover", "Updated: t\nBlocker: no CI\nmore detail\nNext action: verify by hand")
    text = janus.show_status(goal)
    head = git(ws.app, "rev-parse", "--short", "HEAD")
    assert "goal: angular-15-to-16" in text
    assert "status: blocked" in text
    assert "angular: 15 -> 16" in text
    assert "approved: Test User <test@example.com> at 2026-09-21T00:00:00Z" in text
    assert "current task: 1 (app) Upgrade app to Angular 16 [awaiting_ci, fix attempts 2 of 3]" in text
    assert "  1. [awaiting_ci] app: Upgrade app to Angular 16" in text
    assert f"  app: branch ai/angular-15-to-16 (base main), head {head}, last verified {'a' * 12} local_checks_passed, pr_build not configured, pr none" in text
    assert "blocker: no CI" in text and "next action: verify by hand" in text
    assert "more detail" not in text


def test_status_shows_in_flight_and_missing_repo(ws):
    goal = approve_draft(ws.root)
    goal.front["repos"].append({"name": "ghost", "base": "main", "branch": "b", "pr_build": "Fe_Ghost", "checks": []})
    goal.front["in_flight"] = {"task": 1, "repo": "app", "start_sha": "b" * 40, "operation": "codex", "attempt": 0, "started_at": "t"}
    text = janus.show_status(goal)
    assert "  ghost: branch b (base main), head missing, last verified none, pr_build Fe_Ghost, pr none" in text
    assert "in flight: task 1 in app (codex, attempt 0, since t, from bbbbbbbbbbbb)" in text
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_status.py`
Expected: FAIL; `cmd_status` raises "not available" and `show_status` is missing.

- [ ] **Step 3: Implement**

Insert under `# --- status ---`:

```python
def show_status(goal: Goal) -> str:
    front = goal.front
    if not front:
        return "\n".join([
            "status: no plan yet",
            "goal: " + (section(goal.body, "# Goal") or "(empty)").replace("\n", " "),
            "next action: run `python janus.py plan`",
        ])
    angular = front.get("angular") or {}
    approval = front.get("approval") or {}
    lines = [
        f"goal: {front.get('id')}",
        f"status: {front.get('status')}",
        f"angular: {angular.get('from')} -> {angular.get('to')}",
        f"approved: {approval.get('approved_by')} at {approval.get('approved_at')}" if approval.get("plan_hash") else "approved: no",
    ]
    current = task_by_id(goal, front.get("current_task"))
    if current:
        lines.append(
            f"current task: {current['id']} ({current['repo']}) {current['objective']} "
            f"[{current.get('status')}, fix attempts {front.get('attempts') or 0} of {MAX_FIX_ATTEMPTS}]"
        )
    else:
        lines.append("current task: none")
    lines.append("tasks:")
    for task in front.get("tasks") or []:
        lines.append(f"  {task.get('id')}. [{task.get('status')}] {task.get('repo')}: {task.get('objective')}")
    lines.append("repos:")
    for repo_cfg in front.get("repos") or []:
        repo = goal.root / repo_cfg["name"]
        head = git(repo, "rev-parse", "--short", "HEAD", check=False) if (repo / ".git").exists() else "missing"
        verified = (front.get("last_verified") or {}).get(repo_cfg["name"]) or {}
        verified_text = f"{str(verified.get('commit'))[:12]} {verified.get('status')}" if verified else "none"
        pr = (front.get("prs") or {}).get(repo_cfg["name"]) or "none"
        lines.append(
            f"  {repo_cfg['name']}: branch {repo_cfg.get('branch')} (base {repo_cfg.get('base')}), head {head or '?'}, "
            f"last verified {verified_text}, pr_build {repo_cfg.get('pr_build') or 'not configured'}, pr {pr}"
        )
    inflight = front.get("in_flight")
    if inflight:
        lines.append(
            f"in flight: task {inflight.get('task')} in {inflight.get('repo')} ({inflight.get('operation')}, "
            f"attempt {inflight.get('attempt')}, since {inflight.get('started_at')}, from {str(inflight.get('start_sha'))[:12]})"
        )
    for line in (section(goal.body, "## Progress and handover") or "").splitlines():
        if line.startswith("Blocker: "):
            lines.append("blocker: " + line[len("Blocker: "):])
        elif line.startswith("Next action: "):
            lines.append("next action: " + line[len("Next action: "):])
    return "\n".join(lines)
```

Replace the `cmd_status` skeleton with:

```python
def cmd_status(root: Path) -> int:
    print(show_status(load_goal(root)))
    return 0
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `85 passed`

- [ ] **Step 5: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/test_status.py
git commit -m "feat(janus): status prints state, tasks, repo heads, verification and next action" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Manual end-to-end trial on a throwaway Angular app

Spec §10 "Slices": "one repository and the local checks loop, tried here on a throwaway Angular app with a local bare remote". This task is manual, has no unit tests and makes no commit to `/home/race-day/janus`; it produces observations for the controller. It calls the real Codex (ChatGPT login handled outside Janus) and costs model time; do it once.

**Files:**
- Uses: `/home/race-day/janus/janus.py`, `/home/race-day/janus/JANUS.md`. Creates everything under `~/janus-trial/` (outside the repo).

- [ ] **Step 1: Pick the Angular majors for this Node**

```bash
node --version           # v24.5.0 here
ng version 2>/dev/null | head -5   # the ng on PATH is old; the trial does not use it
which google-chrome chromium chromium-browser chrome 2>/dev/null || echo "no Chrome: Karma unit tests cannot run headless here"
```

Janus is version-generic; the trial only needs `from` and `from+1` to both support the installed Node (see the version table at angular.dev/reference/versions). On Node 24 use `from=20`, `to=21`. If a Chrome is missing, the plan's `checks` must not include a Karma run (`npm test`); you will remove it from the draft at the approve gate, which is exactly the human edit the spec expects.

- [ ] **Step 2: Create the control repo, the product app and its bare origin**

```bash
mkdir -p ~/janus-trial/remotes && cd ~/janus-trial
git init -q --bare -b main remotes/trial-app.git
mkdir angular-upgrade && cd angular-upgrade
git init -q -b main
cp /home/race-day/janus/janus.py .
printf '*/\n.janus.lock\n.janus-interrupted.patch\n' > .gitignore
# The repo's JANUS.md template documents the same contract; a goal file needs only this section:
printf '# Goal\nUpgrade Angular 20 to 21 in every repository in this folder; preserve existing behaviour.\n' > JANUS.md
git add -A && git commit -q -m "chore(janus): start goal"
npx -y @angular/cli@20 new trial-app --defaults --skip-git      # installs dependencies: several minutes; keeps package-lock.json
cd trial-app && git init -q -b main && git add -A && git commit -q -m "chore: initial Angular 20 app"
git remote add origin ~/janus-trial/remotes/trial-app.git && git push -q -u origin main
cd .. && git status --short          # expected: empty (trial-app/ is ignored by */)
python3 janus.py status              # expected: "status: no plan yet" and the goal text
```

- [ ] **Step 3: `plan`**

```bash
python3 janus.py plan
```

Expected observations:
- Codex runs once in `~/janus-trial/angular-upgrade` (its output streams to the terminal); no file in `trial-app/` changes (`git -C trial-app status --short` is empty). If Codex leaves the app dirty, Janus refuses with "planning must not change product source" and `JANUS.md` is unchanged; clean up and re-run.
- `JANUS.md` now has front matter: `status: awaiting_plan_approval`, `angular: {from: 20, to: 21}`, one repo `trial-app` with `base: main`, a branch such as `ai/angular-20-to-21`, `pr_build: null`, `checks: [...]`, one or more tasks with `status: pending`, `approval` nulls, `last_verified: {}`, `prs: {}`, `attempts: 0`, `in_flight: null`.
- The body keeps the `# Goal` line byte for byte and gains `## Approved-plan content` (Codex text, headings demoted to `###`), `## Rules`, `## Review feedback`, `## Progress and handover` (says baseline is unverified), `## Decisions`.
- `git log --oneline` shows `chore(janus): draft plan for angular-20-to-21`.
- If Codex's strict schema is rejected by the API, `codex exec` exits non-zero and Janus prints `janus: codex exec exited with N`; record the exact Codex error text in your report (this is the one machine fact the plan could not verify offline).

- [ ] **Step 4: Edit and `approve`**

Edit `JANUS.md`: make `checks` realistic and runnable here, for example `["npm ci", "npm run build"]` (add `"npm test -- --watch=false --browsers=ChromeHeadless"` only if a Chrome exists). Keep one task whose objective is the upgrade itself (for example "Run ng update to Angular 21 and fix what breaks"). Then:

```bash
python3 janus.py approve      # answer: yes
git log --oneline -1          # chore(janus): approve plan <12 hex>
python3 janus.py status       # status: approved, approved: <your git name>, task 1 [pending]
```

Also try `python3 janus.py run` after changing one character of a task objective: expected `janus: approved plan content has changed ...` and exit code 2; revert the edit afterwards (or re-approve).

- [ ] **Step 5: `run`, kill during Codex, `run` again**

Terminal A:

```bash
python3 janus.py run
```

Terminal B, while Codex is visibly working (wait until `git -C ~/janus-trial/angular-upgrade/trial-app status --short` shows changes, for example `package.json` modified):

```bash
cd ~/janus-trial/angular-upgrade
git log --oneline -1                 # chore(janus): task 1 attempt 0 in trial-app  (in_flight checkpoint exists before Codex)
grep -A6 '^in_flight:' JANUS.md      # task, repo, start_sha, operation: codex
```

Then press Ctrl-C in terminal A (it interrupts Janus and the Codex child). Observe: `.janus.lock` is gone or harmless; `JANUS.md` still says `in_flight: {...}` and `status: executing`.

Terminal A again:

```bash
python3 janus.py run
```

Expected observations:
- "Preserved the interrupted diff of trial-app as .janus-interrupted.patch" and the patch contains the half-done changes; the working tree still has them.
- A fresh Codex starts; its prompt tells it about the interrupted attempt (visible at the top of Codex's transcript if it echoes the prompt; otherwise trust the tests).
- After Codex: the approved checks run in `trial-app` (their output appears only in the redacted tail if they fail), then a commit `chore(angular): <objective>` with trailer `Janus-Task: 1` is pushed: `git --git-dir ~/janus-trial/remotes/trial-app.git log --oneline ai/angular-20-to-21 -1` shows it.
- Janus prints "Janus stopped for human direction." with the reason containing "local checks are not CI evidence; pr_build is not configured for this repo" and exit code 1.
- `JANUS.md`: `status: blocked`, task `status: awaiting_ci`, `last_verified: {trial-app: {commit: <sha>, teamcity_build: null, status: local_checks_passed}}`, `in_flight: null`, `attempts: 0`; `.janus-interrupted.patch` deleted; control repo log has `task 1 pushed <sha12>` then `stop for human direction`.
- If checks fail, watch the fix loop: "starting code-fix attempt 1 of 3", each with a fresh Codex; after three failed fixes Janus stops with "3 code-fix attempts exhausted" and the attempt left uncommitted.

- [ ] **Step 6: `status` and the honest end of slice 1**

```bash
python3 janus.py status
```

Expected: `status: blocked`, task `1. [awaiting_ci] trial-app: ...`, `last verified <sha12> local_checks_passed`, `pr_build not configured`, `blocker: task 1 passed its local checks ... not CI evidence ...`, `next action: Verify the pushed commit through your CI yourself. ...`.

Running `python3 janus.py run` again must stop immediately with the same CI handover and no Codex call. To finish the trial as the spec intends (a human decision, recorded), set the task's `status: done` in `JANUS.md`, add a line under `## Decisions` ("accepted local checks as sufficient for the trial; no CI exists"), run `python3 janus.py run` once more: exit 0, `status: done`.

- [ ] **Step 7: Report**

Report to the controller: the Angular majors used, whether the strict output schema was accepted by Codex, what Codex proposed as `checks` and what you changed, the observed Ctrl-C/resume behaviour (patch created, no duplicated commit), the final `git log` of the bare remote, and any deviation from the expected observations above. Then remove `~/janus-trial` or keep it for later slices; nothing from it is committed to `/home/race-day/janus`.

---

## Self-review notes

- Spec coverage for slice 1: §3 (Task 3, 4), §4 contract and ownership (Tasks 2, 5, 7, 9), §4 plan integrity (Task 5), §5 four commands (Tasks 1, 5, 7, 9, 11), §6 planning (Task 7), §6 loop steps 1 to 5 and 7 without CI (Task 9), §7 stop conditions (Tasks 9, 10), §8 checkpoints/lock/resume (Tasks 4, 5, 9, 10), §9 ref detection, redaction, runner-only git writes (Tasks 4, 8, 9), §10 function names and test strategy (all), §11 criteria 1, 2, 4 (local), 5 (local), 9, 10 (Tasks 5, 9, 10, 12). Deferred to later slices by design: `ensure_pr`, `find_or_trigger_build`, `wait_and_summarize_build`, `trigger_full_e2e`, `run_review`, `prs`, `e2e`, Review-feedback consumption.
- Names used across tasks are consistent: `Goal(root, front, body)`, `section`/`set_section`, `save_checkpoint`, `locked`, `record_heads`/`check_heads_unchanged` (returns moved refs), `stage_and_diff`, `git_commit_push(repo, branch, message, trailer)`, `run_codex(cwd, prompt)`, `write_progress(goal, next_action, blocker)`, `record_verified`, `stop_for_human`, `run_next_task(goal, interrupted)`, `reconcile_in_flight(goal) -> bool`.
- The code blocks of Tasks 1 to 11 were assembled verbatim into a scratch directory (not the repo) and run with `uv run pytest -q`: 85 passed, and the cumulative counts stated after each task match. `ast.parse(..., feature_version=(3, 9))` accepts every file. `python3 janus.py --help/status/plan` behave as Task 1, 7 and 11 describe.
- One fact could not be verified offline: whether Codex 0.146 forwards `--output-schema` in strict mode. The schema is written to satisfy strict mode (which also satisfies non-strict), and Task 12 Step 3 says what to record if the API still rejects it.
