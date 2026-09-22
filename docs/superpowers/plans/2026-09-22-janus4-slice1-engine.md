# Janus 4.0 Slice 1: Flow Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `janus.py`, the durable flow engine of spec section 11 slice 1: the primitives `goal`, `context`, `codex`, `ralph`, `human_gate`, `decision`, `ai_gate`, `step`, `log`, the journal with replay, gates in `JANUS.md`, commit-and-push of the two Janus files, the commands `run`, `status` and `reset`, and the pytest suite with a fake `codex`.

**Architecture:** One procedural Python file. Engine state for a run (root folder, journal, `context()` values, key counters, live keys, current key) lives in module-level globals that `begin(root)` resets. Every journaled primitive goes through one function, `run_step(key, kind, execute)`, which implements the replay rules of spec section 5 and writes `journal.yaml` atomically at each status change; `save_journal` then commits and pushes. Gates bypass `run_step` because they end the process with exit code 2. `JANUS.md` is edited as a list of lines with three section helpers (`find_section`, `remove_section`, `append_to_section`). `run` executes `flow.py` with `runpy` after aliasing `sys.modules["janus"]` to the running module so the flow shares the engine's state.

**Tech Stack:** Python 3.9+ (`from __future__ import annotations`, `typing.Optional/List/Dict/Tuple`, no `match`, no runtime `X | Y`), PyYAML 6, pytest 8 via `uv`, git 2.43, codex-cli 0.146 (never called by tests).

**Spec:** `/home/race-day/janus/janus-4.0-spec.md` (v0.1). Sections 4 to 9 and 12 bind this slice; every task cites the sections it implements. Executors read both documents. Slice 2 (the Angular example and trial, spec section 10) is not in this plan.

## Global Constraints

Copied from the spec where they bind implementation; every task's requirements include this section.

- Spec §1: "One engine file, `janus.py`. Python 3.9 or newer, standard library plus PyYAML. Target under 500 lines." The development machine has Python 3.12.3; the deployment target is 3.9, so use `from __future__ import annotations`, `typing.Optional/List/Dict/Tuple`, no `match`, no runtime `X | Y`, no `tomllib`. The assembled file of this plan is 509 lines, nine over the target, accepted for live transcript streaming (Task 5) and replay-aware `log` (Tasks 1, 4, 7); do not add code beyond what the tasks show.
- Spec §1: "The engine has no retry policy, no domain rules, no HTTP client and no secrets." Spec §12.6: "`janus.py` contains no reference to Git branches, pull requests, TeamCity, Bitbucket or Angular, apart from committing its own two files." Spec §12.8: "`janus.py` stays one file with only the standard library and PyYAML as imports."
- Spec §4: "Every one of them is a journaled step except `goal`, `context` and `log`." The primitive signatures are used exactly as written in §4: `goal()`, `context(**vars)`, `codex(prompt, key=None, cwd=".", **vars)`, `ralph(prompt, until, max_iter, key=None, cwd=".", **vars)`, `human_gate(question, key=None, show=None)`, `decision(question, options, key=None, show=None)`, `ai_gate(prompt, key=None, cwd=".", **vars)`, `step(key, fn)`, `log(text)`, `class Exhausted(Exception)` with `.last`, `class JanusError(Exception)`.
- Spec §4 Keys: "The default key is the prompt file stem followed by `#` and a counter of calls with that stem in this run ... `step` requires an explicit key ... Ralph iterations are keyed `<key>/<n>` starting at 1. Two live steps with the same key in one run is a `JanusError`."
- Spec §4 Rendering: "Placeholders are `{{name}}` and `{{name.field.subfield}}`, with dotted access into dicts and lists by index. Values that are not strings are rendered as YAML. A placeholder that resolves to nothing fails the step before Codex starts. The variables of a render are, in rising precedence: the reserved values `goal`, `attempt` and, in ralph, `previous`; the values from `context()`; the keyword arguments of the call. `previous` is absent in the first ralph iteration and renders as an empty string. If `prompts/_preamble.md` exists it is rendered with the same variables and prepended to the prompt body, separated by a blank line."
- Spec §4 Output schema: "Field types are `str`, `int`, `float`, `bool`, `list[T]` where `T` is a scalar or a nested mapping, a nested mapping for an object, and `one_of: [a, b, c]` for an enumerated string. All fields are required and no additional properties are allowed ... A prompt without `output` returns `{"text": <final message>}`." `ai_gate` adds `{passed: bool, reasons: list[str]}`.
- Spec §5 Journal: one mapping with `flow`, `started`, `steps: {key: {kind, status, attempt, started, finished, result|answer|question|error}}`; statuses `running | done | failed | open | answered`; "written atomically, through a temporary file and rename, at every status change."
- Spec §5 Replay: "`done` or `answered`: return the stored result or answer without executing anything. `running`: the step was interrupted. Increment `attempt` and execute it again. `failed`: execute again with `attempt` incremented. `open`: the gate has no answer yet. Exit with code 2 again. absent: journal `running`, execute, journal `done` with the result."
- Spec §5 Gates: the `## Gate: <key>` section holds the question, `show` as four-space-indented YAML and an `answer:` line; "The engine reads it, journals the gate as `answered`, removes the section and appends `question`, `answer` and date under `## Decisions`. An empty answer leaves the gate open. A `decision` answer outside its options appends a note under the gate and keeps it open."
- Spec §5 Exit codes: "`0` the flow ended. `2` a gate is open. `1` a step failed or the flow raised."
- Spec §5 Git: "After every journal write, if the goal folder is a Git repository, the engine stages `JANUS.md` and `journal.yaml`, commits with the message `janus: <key> <status>`, and pushes if the current branch has an upstream. A failed commit or push is logged as a warning and does not stop the run."
- Spec §6: `run` "imports `flow.py` from the current folder as a module and executes it top to bottom. Uncaught exceptions from the flow, including `Exhausted`, are written to `## Progress` with the step key that raised and the run exits with code 1." `status` prints "open gate if any, last five steps, next action". `reset` moves "`journal.yaml` to `journals/<timestamp>.yaml` and remove[s] open gates from `JANUS.md`".
- Spec §7: `codex exec -C <cwd> --dangerously-bypass-approvals-and-sandbox --output-schema <schema.json> --output-last-message <last.json> -` with "The prompt goes in on stdin, never on the command line ... Janus passes no model flags. ... A non-zero exit, a missing final message or JSON that does not validate against the schema fails the step."
- Spec §8: "A rendering error or an invalid `output` declaration fails the step before Codex starts. A failed Codex process fails the step with the last twenty lines of stderr in `error`. A `step()` whose function raises fails with the exception text."
- Spec §9: "pytest in `tests/`, run with `uv run pytest -q`. Codex is replaced by a fake `codex` executable on `PATH` that returns scripted JSON and records its calls. Git behaviour is tested in a temporary repository with a local bare remote." Tests never call the real `codex` and never need the network.
- Tooling: `pyproject.toml` with `[project] dependencies = ["pyyaml>=6"]`, `[dependency-groups] dev = ["pytest>=8"]`, `[tool.pytest.ini_options] pythonpath = ["."]`. Verification command in every task: `uv run pytest -q` (uv is `/snap/bin/uv`; it creates `.venv` and `uv.lock`).
- Commits: conventional commits with a scope (`feat(janus): ...`, `test(janus): ...`, `chore(tooling): ...`). Every commit uses the two-`-m` form so the trailer is separated by a blank line: `git commit -m "type(scope): subject" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.
- Janus 3.0 and its plans (`c6d8d94` and earlier) are history only. Nothing about git helpers, plan hashes, locks or TeamCity is ported.

## Verified facts about this machine

- `python3` is 3.12.3. PyYAML 6.0.1 is installed system-wide (so `python3 janus.py run` works in a goal folder without a venv); pytest is not (hence `uv run pytest`). `uv` is 0.12.17 at `/snap/bin/uv`. git is 2.43.0.
- `codex` is codex-cli 0.146.0 at `~/.nvm/versions/node/v24.5.0/bin/codex`. `codex exec --help` lists `-C, --cd <DIR>`, `--dangerously-bypass-approvals-and-sandbox`, `--output-schema <FILE>`, `-o, --output-last-message <FILE>`, and reads the prompt from stdin when the positional argument is `-`. Nothing in this plan runs the real `codex`.
- `yaml.safe_dump(3)` is `'3\n...\n'` and `yaml.safe_dump(True)` is `'true\n...\n'`: PyYAML ends a bare scalar document with `...`, which the renderer strips. `yaml.safe_load("a: list[str]\nb: [str]\nc: [{id: int}]\nd: {one_of: [x, y]}")` gives `{'a': 'list[str]', 'b': ['str'], 'c': [{'id': 'int'}], 'd': {'one_of': ['x', 'y']}}`, so all four declaration forms of Task 3 survive YAML parsing.
- `git diff --cached --quiet` exits 0 on an unborn branch with nothing staged and 1 when something is staged, so `git_commit` can skip empty commits without special-casing a fresh repository.
- Verified with the real Codex on 2026-09-22 (one `codex exec` in a scratch folder, exit 0, about 15,500 tokens): codex-cli 0.146 accepts a strict `--output-schema` with nested objects, `enum`, `additionalProperties: false` and every property required, and the `--output-last-message` file contains exactly the schema-shaped JSON. Codex prints its transcript (config header, `user`, `codex`, `exec` blocks, `tokens used`) to stderr and a copy of the final message to stdout; intermediate `codex` messages also follow the schema, so only the last message counts. Task 5 streams stderr live for this reason.

## Design decisions fixed here (where the spec leaves room)

- Default keys for gates: `human_gate` without `key` uses the stem `gate` (`gate#1`, `gate#2`, ...), `decision` uses `decision`. The spec defines default keys only for prompt-based steps; the example always passes a key.
- `previous` in the first ralph iteration is the empty string; a plain `codex()` prompt that uses `{{previous}}` fails as undefined. A value of `None` anywhere in a placeholder path also counts as undefined ("resolves to nothing").
- `{{goal}}` is always available to prompts, so a prompt step fails before Codex starts when `JANUS.md` has no `# Goal` section.
- A prompt without `output` is run without `--output-schema`; the final message is returned as `{"text": <message stripped>}`.
- `list[T]` with a mapping `T` is written as a one-element YAML sequence: `tasks: [{id: int, title: str}]`. `list[str]` (a string) and `[str]` (a sequence) both mean a list of strings.
- The journal keeps `kind: decision` for `decision()` gates and `kind: gate` for `human_gate()`; `show` is not stored (the flow passes it again on the next run, which rewrites the section).
- The gate section is appended at the end of `JANUS.md` and rewritten there on every run that stops at the gate; the answered gate's entry under `## Decisions` is `- <date> <key>: <question>` followed by `  answer: <first line>` and further answer lines indented by two spaces.
- A `step()` whose return value is not YAML-serialisable fails like any raising step (`error: "RepresenterError: ..."`).
- `log()` is not journaled (spec §4). It always prints, but it appends to `## Progress` only when the most recent step was executed rather than replayed (`REPLAYING`, set by `run_step` and `gate`, initially true when the journal already has steps). A real-Codex smoke run of the tiny flow showed five Progress lines for two events without this rule. Progress lines written by `log` are committed with the next journal write, not on their own.
- `reset` does not commit; the archived journal under `journals/` is left for the human to commit (spec §3 lists `journals/` as tracked content).
- Exceptions raised by flow code between steps are attributed to the most recent step key in `## Progress` (or `flow` when no step has run).

## File structure

| Path | Responsibility |
|---|---|
| `janus.py` | All engine code, in sections separated by banner comments and built in this order: constants, errors and engine state (Task 1); `JANUS.md` (Task 1); rendering (Task 2); output schema (Task 3); steps and keys (Task 4); codex (Task 5); context, ralph and ai_gate (Task 6); gates (Task 7); git (Task 8); CLI (Tasks 9, 10). Each task says exactly where its code goes. |
| `pyproject.toml`, `uv.lock`, `.gitignore` | Tooling (Task 1). |
| `tests/helpers.py` | `read_journal(root)`, `write_prompt(root, stem, body, output=None)`, and from Task 8 a tiny git wrapper: `git(cwd, *args)`, `init_repo(path)`, `commit_all(path, message)`, `make_bare(path)`. |
| `tests/conftest.py` | `root` fixture (goal folder with `JANUS.md`, empty `prompts/`, engine begun there) and from Task 5 the `fake_codex` fixture. |
| `tests/test_goal_file.py`, `test_render.py`, `test_schema.py`, `test_steps.py`, `test_codex.py`, `test_ralph.py`, `test_gates.py`, `test_git.py`, `test_run.py`, `test_status_reset.py` | One test module per task (Tasks 1 to 10). |

Spec §9 coverage map: 1 rendering → Tasks 2, 5; 2 schema → Task 3; 3 flow twice, codex once per step → Tasks 5, 9; 4 running/failed re-executed with attempt incremented → Tasks 4, 6; 5 gate cycle → Tasks 7, 9; 6 ralph → Task 6; 7 step once and never on replay → Task 4; 8 context precedence → Task 6; 9 commit after each step, failing push warns → Task 8; 10 reset → Task 10; 11 duplicate live keys → Task 4.

Engine functions and the tests that reach them, by name, so later tasks use the names earlier tasks define: `begin`, `save_journal`, `write_atomic`, `read_goal_file`, `write_goal_file`, `find_section`, `remove_section`, `append_to_section`, `goal`, `log` (Task 1); `lookup`, `as_text`, `render`, `load_prompt` (Task 2); `field_schema`, `build_schema`, `validate` (Task 3); `make_key`, `claim`, `run_step`, `step` (Task 4); `run_codex`, `run_prompt`, `codex` (Task 5); `context`, `ralph`, `ai_gate` (Task 6); `write_gate`, `read_answer`, `gate`, `human_gate`, `decision` (Task 7); `git`, `git_commit` (Task 8); `cmd_run`, `COMMANDS`, `main` (Task 9); `cmd_status`, `cmd_reset` (Task 10).

---

### Task 1: Tooling, engine state, journal file and `JANUS.md` sections

Spec §1 (one file, PyYAML), §3 (`JANUS.md`, `journal.yaml`), §4 (`goal`, `log`), §5 (journal shape, atomic write), §9 (pytest layout).

**Files:**
- Create: `pyproject.toml`, `.gitignore`, `janus.py`, `tests/helpers.py`, `tests/conftest.py`, `tests/test_goal_file.py`

**Interfaces:**
- Produces: constants `GOAL_FILE = "JANUS.md"`, `JOURNAL_FILE = "journal.yaml"`, `FLOW_FILE = "flow.py"`, `PREAMBLE_FILE = "prompts/_preamble.md"`; exceptions `JanusError(Exception)` and `Exhausted(Exception)` with `.last`; module globals `ROOT: Path`, `JOURNAL: dict` (`{"flow", "started", "steps"}`), `CONTEXT: dict`, `COUNTERS: Dict[str, int]`, `LIVE: set`, `CURRENT: Optional[str]`; `now() -> str` (ISO seconds); `write_atomic(path: Path, text: str) -> None`; `begin(root: Path) -> None` (resets all state, loads or starts the journal without writing it); `save_journal(key: str, status: str) -> None` (Task 8 extends it with the commit); `read_goal_file() -> List[str]`; `write_goal_file(lines: List[str]) -> None`; `find_section(lines, heading) -> Optional[Tuple[int, int]]` (range `[start, end)` of the heading line and its body, ending at the next `#`/`##` heading); `remove_section(heading: str) -> None`; `append_to_section(heading: str, new_lines: List[str]) -> None` (creates the section at the end of the file if missing, inserts before the blank line that precedes the next heading); `goal() -> str`; `log(text: str) -> None`.
- Test helpers: `tests/helpers.py` with `read_journal(root) -> dict` and `write_prompt(root, stem, body, output=None)` (writes `prompts/<stem>.md`, with `---\noutput: ...\n---\n` front matter when `output` is given). Fixture `root` in `tests/conftest.py`: a `tmp_path` holding `JANUS.md` (`# Goal\nUpgrade the widget.\n`) and an empty `prompts/`, with `janus.begin(tmp_path)` already called.

- [ ] **Step 1: Write the tooling files**

Create `pyproject.toml`:

```toml
[project]
name = "janus"
version = "4.0.0"
description = "Janus 4.0: a small durable flow engine for Codex"
requires-python = ">=3.9"
dependencies = ["pyyaml>=6"]

[dependency-groups]
dev = ["pytest>=8"]

[tool.pytest.ini_options]
pythonpath = ["."]
testpaths = ["tests"]
```

Create `.gitignore`:

```gitignore
.venv/
__pycache__/
.pytest_cache/
*.pyc
```

- [ ] **Step 2: Write the test helpers, the `root` fixture and the failing tests**

Create `tests/helpers.py`:

```python
"""Shared helpers for Janus tests: journal reading and prompt writing."""
import yaml


def read_journal(root):
    return yaml.safe_load((root / "journal.yaml").read_text(encoding="utf-8"))


def write_prompt(root, stem, body, output=None):
    """Write prompts/<stem>.md with an optional ``output`` front matter mapping."""
    text = body
    if output is not None:
        text = "---\n" + yaml.safe_dump({"output": output}, sort_keys=False) + "---\n" + body
    (root / "prompts").mkdir(exist_ok=True)
    (root / "prompts" / f"{stem}.md").write_text(text, encoding="utf-8")
```

Create `tests/conftest.py`:

```python
import pytest

import janus

GOAL_MD = "# Goal\nUpgrade the widget.\n"


@pytest.fixture
def root(tmp_path):
    """A goal folder with a JANUS.md and an empty prompts/ folder; the engine is begun there."""
    (tmp_path / "JANUS.md").write_text(GOAL_MD, encoding="utf-8")
    (tmp_path / "prompts").mkdir()
    janus.begin(tmp_path)
    return tmp_path
```

Create `tests/test_goal_file.py`:

```python
import re

import pytest
import yaml

import janus


def test_goal_returns_the_goal_section_text(root):
    (root / "JANUS.md").write_text(
        "# Goal\nUpgrade the widget.\n\n### Notes\nkeep it small\n\n## Decisions\n- none\n", encoding="utf-8")
    assert janus.goal() == "Upgrade the widget.\n\n### Notes\nkeep it small"


def test_goal_without_a_goal_section_raises(root):
    (root / "JANUS.md").write_text("# Something else\ntext\n", encoding="utf-8")
    with pytest.raises(janus.JanusError, match="no '# Goal' section"):
        janus.goal()


def test_log_appends_a_dated_line_to_progress_and_prints(root, capsys):
    (root / "JANUS.md").write_text("# Goal\nx\n\n## Progress\n\n## Decisions\n", encoding="utf-8")
    janus.log("task 1 done")
    assert capsys.readouterr().out == "task 1 done\n"
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    progress = text.split("## Progress\n")[1].split("## Decisions")[0]
    assert re.fullmatch(r"- \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d task 1 done\n\n", progress)


def test_log_creates_the_progress_section_when_missing(root):
    janus.log("first\nsecond line")
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert text.startswith("# Goal\nUpgrade the widget.\n\n## Progress\n- ")
    assert text.endswith(" first\n  second line\n")
    assert janus.goal() == "Upgrade the widget."


def test_begin_starts_a_fresh_journal_when_none_exists(root):
    assert janus.JOURNAL["flow"] == "flow.py"
    assert janus.JOURNAL["steps"] == {}
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d", janus.JOURNAL["started"])
    assert not (root / "journal.yaml").exists()


def test_begin_loads_an_existing_journal(root):
    (root / "journal.yaml").write_text(
        "flow: flow.py\nstarted: '2026-01-01T00:00:00'\nsteps:\n  a#1: {kind: codex, status: done, result: {x: 1}}\n",
        encoding="utf-8")
    janus.begin(root)
    assert janus.JOURNAL["started"] == "2026-01-01T00:00:00"
    assert janus.JOURNAL["steps"]["a#1"]["result"] == {"x": 1}


def test_save_journal_writes_yaml_and_leaves_no_temporary_file(root):
    janus.JOURNAL["steps"]["a#1"] = {"kind": "step", "status": "done", "result": 1}
    janus.save_journal("a#1", "done")
    data = yaml.safe_load((root / "journal.yaml").read_text(encoding="utf-8"))
    assert list(data) == ["flow", "started", "steps"]
    assert data["steps"]["a#1"]["result"] == 1
    assert sorted(p.name for p in root.iterdir()) == ["JANUS.md", "journal.yaml", "prompts"]
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest -q`
Expected: `ImportError while loading conftest '.../tests/conftest.py'` ending in `ModuleNotFoundError: No module named 'janus'`; no test is collected (pytest prints no `N passed` line at all).

- [ ] **Step 4: Write the engine skeleton, state, journal file and `JANUS.md` helpers**

Create `janus.py` (the whole file at this point; later tasks append sections and the `git` section modifies `save_journal`):

```python
#!/usr/bin/env python3
"""Janus 4.0: a small durable flow engine for Codex. One file, standard library plus PyYAML.
A flow imports the primitives with ``from janus import ...``; see janus-4.0-spec.md sections 4 to 9."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import yaml

# --- constants, errors and engine state ------------------------------------

GOAL_FILE = "JANUS.md"
JOURNAL_FILE = "journal.yaml"
FLOW_FILE = "flow.py"
PREAMBLE_FILE = "prompts/_preamble.md"


class JanusError(Exception):
    """Engine and flow errors that stop the run."""


class Exhausted(Exception):
    """Raised by ralph after max_iter iterations without success; .last is the final result."""
    def __init__(self, last: Any) -> None:
        super().__init__("ralph exhausted")
        self.last = last


# Engine state for one run; begin() resets all of it.
ROOT = Path(".")
JOURNAL: Dict[str, Any] = {"flow": FLOW_FILE, "started": None, "steps": {}}
CONTEXT: Dict[str, Any] = {}
COUNTERS: Dict[str, int] = {}
LIVE: set = set()
CURRENT: Optional[str] = None
REPLAYING = False  # True while the last step came from the journal; log() then skips Progress


def now() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def write_atomic(path: Path, text: str) -> None:
    """Write through a temporary file in the same directory, then rename over the target."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, str(path))


def begin(root: Path) -> None:
    """Reset the engine for one run rooted at ``root`` and load its journal, or start a fresh one."""
    global ROOT, JOURNAL, CONTEXT, COUNTERS, LIVE, CURRENT, REPLAYING
    ROOT = Path(root)
    path, fresh = ROOT / JOURNAL_FILE, {"flow": FLOW_FILE, "started": now(), "steps": {}}
    JOURNAL = yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else fresh
    JOURNAL.setdefault("steps", {})
    CONTEXT, COUNTERS, LIVE, CURRENT = {}, {}, set(), None
    REPLAYING = bool(JOURNAL["steps"])


def save_journal(key: str, status: str) -> None:
    """Write journal.yaml atomically at every status change of ``key``."""
    write_atomic(ROOT / JOURNAL_FILE, yaml.safe_dump(JOURNAL, sort_keys=False, allow_unicode=True))


# --- JANUS.md --------------------------------------------------------------

def read_goal_file() -> List[str]:
    path = ROOT / GOAL_FILE
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []


def write_goal_file(lines: List[str]) -> None:
    write_atomic(ROOT / GOAL_FILE, "\n".join(lines).rstrip("\n") + "\n")


def find_section(lines: List[str], heading: str) -> Optional[Tuple[int, int]]:
    """Line range [start, end) of the section with exactly this heading line; ### and deeper belong to it."""
    for i, line in enumerate(lines):
        if line.rstrip() == heading:
            j = i + 1
            while j < len(lines) and not re.match(r"#{1,2} ", lines[j]):
                j += 1
            return i, j
    return None


def remove_section(heading: str) -> None:
    lines = read_goal_file()
    span = find_section(lines, heading)
    if span is not None:
        del lines[span[0]:span[1]]
        write_goal_file(lines)


def append_to_section(heading: str, new_lines: List[str]) -> None:
    """Append lines at the end of a section, creating the section at the end of the file if needed."""
    lines = read_goal_file()
    span = find_section(lines, heading)
    if span is None:
        lines += ([""] if lines and lines[-1].strip() else []) + [heading]
        span = (len(lines) - 1, len(lines))
    end = span[1]
    while end > span[0] + 1 and not lines[end - 1].strip():  # keep the blank line before the next heading
        end -= 1
    lines[end:end] = new_lines
    write_goal_file(lines)


def goal() -> str:
    lines = read_goal_file()
    span = find_section(lines, "# Goal")
    if span is None:
        raise JanusError(f"{GOAL_FILE} has no '# Goal' section")
    return "\n".join(lines[span[0] + 1:span[1]]).strip()


def log(text: str) -> None:
    print(text)
    lines = text.splitlines() or [""]
    if not REPLAYING:  # a replayed run repeats the print, not the Progress line
        append_to_section("## Progress", [f"- {now()} {lines[0]}"] + [f"  {line}" for line in lines[1:]])
```

Notes for the implementer: `begin` does not write `journal.yaml`; the first `save_journal` does. `find_section` treats only `#` and `##` lines as section boundaries, so `###` headings inside `# Goal` stay part of the goal text. `append_to_section` inserts before the blank line that separates a section from the next heading, which is why the Progress test expects the entry followed by exactly one blank line. `write_atomic` writes into a temporary file in the same directory and `os.replace`s it, which is atomic on POSIX.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `7 passed`

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml uv.lock .gitignore janus.py tests/helpers.py tests/conftest.py tests/test_goal_file.py
git commit -m "feat(janus): engine skeleton with journal file and JANUS.md sections" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Template rendering and prompt files

Spec §4 Rendering (placeholders, dotted access, YAML for non-strings, undefined fails), §4 Output schema (front matter `output`), §9 test area 1 (dotted access, YAML rendering; preamble and "fails before Codex" are tested with the fake codex in Task 5).

**Files:**
- Modify: `janus.py` (append the `# --- rendering ---` section after `log`)
- Create: `tests/test_render.py`

**Interfaces:**
- Consumes: `ROOT`, `JanusError`.
- Produces: `PLACEHOLDER` (compiled regex for `{{ name.path }}`); `lookup(path: str, variables: dict) -> Any` (raises `JanusError("undefined placeholder {{path}}")` for a missing key, out-of-range index or `None` value); `as_text(value) -> str` (strings unchanged, everything else `yaml.safe_dump(..., sort_keys=False)` without the trailing `...` marker); `render(text: str, variables: dict) -> str`; `load_prompt(path: str) -> Tuple[Optional[dict], str]` (the front matter `output` mapping or `None`, and the body after the closing `---`).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_render.py`:

```python
import pytest

import janus


def test_render_replaces_simple_placeholders():
    assert janus.render("hello {{name}} and {{ name }}", {"name": "bob"}) == "hello bob and bob"


def test_render_follows_dotted_paths_into_dicts_and_lists():
    variables = {"plan": {"tasks": [{"id": 7, "title": "shell"}]}}
    assert janus.render("{{plan.tasks.0.title}}#{{plan.tasks.0.id}}", variables) == "shell#7"


def test_render_writes_non_strings_as_yaml():
    variables = {"task": {"id": 1, "tags": ["a", "b"]}, "n": 3, "ok": True}
    assert janus.render("{{task}}|{{n}}|{{ok}}", variables) == "id: 1\ntags:\n- a\n- b|3|true"


def test_render_undefined_placeholder_raises_janus_error():
    with pytest.raises(janus.JanusError, match=r"undefined placeholder \{\{task.name\}\}"):
        janus.render("{{task.name}}", {"task": {"id": 1}})


def test_load_prompt_splits_the_output_front_matter_from_the_body(root):
    (root / "prompts" / "plan.md").write_text("---\noutput:\n  summary: str\n---\nPlan {{goal}}.\n", encoding="utf-8")
    assert janus.load_prompt("prompts/plan.md") == ({"summary": "str"}, "Plan {{goal}}.\n")


def test_load_prompt_without_front_matter_has_no_output(root):
    (root / "prompts" / "free.md").write_text("Just text.\n", encoding="utf-8")
    assert janus.load_prompt("prompts/free.md") == (None, "Just text.\n")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_render.py`
Expected: `AttributeError: module 'janus' has no attribute 'render'` (and `load_prompt`), `6 failed, 7 passed`.

- [ ] **Step 3: Write the rendering section**

Append to `janus.py`:

```python
# --- rendering -------------------------------------------------------------

PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}")


def lookup(path: str, variables: Dict[str, Any]) -> Any:
    """Dotted access into dicts and lists by index; a missing or None value is undefined."""
    value: Any = variables
    for part in path.split("."):
        if isinstance(value, dict) and value.get(part) is not None:
            value = value[part]
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        else:
            raise JanusError(f"undefined placeholder {{{{{path}}}}}")
    return value


def as_text(value: Any) -> str:
    """Strings as they are; everything else as YAML without the trailing document marker."""
    if isinstance(value, str):
        return value
    text = yaml.safe_dump(value, sort_keys=False, allow_unicode=True).rstrip("\n")
    return text[:-4] if text.endswith("\n...") else text


def render(text: str, variables: Dict[str, Any]) -> str:
    return PLACEHOLDER.sub(lambda m: as_text(lookup(m.group(1), variables)), text)


def load_prompt(path: str) -> Tuple[Optional[Dict[str, Any]], str]:
    """The front matter ``output`` mapping (None if absent) and the body of a prompt file."""
    text = (ROOT / path).read_text(encoding="utf-8")
    m = re.match(r"---\n(.*?)\n---\n?(.*)", text, re.S)
    return ((yaml.safe_load(m.group(1)) or {}).get("output"), m.group(2)) if m else (None, text)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `13 passed`

- [ ] **Step 5: Commit**

```bash
git add janus.py tests/test_render.py
git commit -m "feat(janus): template rendering with dotted access and prompt front matter" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Output schema and validation

Spec §4 Output schema (every type, `one_of`, nested mappings, strict objects), §7 ("JSON that does not validate against the schema fails the step"), §8 (invalid `output` declaration), §9 test area 2.

**Files:**
- Modify: `janus.py` (append the `# --- output schema ---` section after `load_prompt`)
- Create: `tests/test_schema.py`

**Interfaces:**
- Consumes: `JanusError`.
- Produces: `field_schema(decl) -> dict` for one declaration: `"str" | "int" | "float" | "bool"` → `{"type": "string" | "integer" | "number" | "boolean"}`, `"list[T]"` (T scalar) or a one-element YAML sequence `[T]` (T anything) → `{"type": "array", "items": ...}`, `{"one_of": [...]}` (non-empty list of strings) → `{"type": "string", "enum": [...]}`, any other non-empty mapping → nested strict object; anything else raises `JanusError("invalid output declaration: ...")`. `build_schema(output: dict) -> dict` → `{"type": "object", "properties": ..., "required": [all names], "additionalProperties": False}` (raises for an empty or non-mapping `output`). `validate(value, schema, where="$") -> Optional[str]`: `None` when the value matches, otherwise one message with the JSON path such as `$.tasks[0].id: expected integer`; booleans are not integers or numbers.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_schema.py`:

```python
import pytest

import janus


def test_schema_maps_scalar_types_and_requires_every_field():
    schema = janus.build_schema({"a": "str", "b": "int", "c": "float", "d": "bool"})
    assert schema == {
        "type": "object",
        "properties": {"a": {"type": "string"}, "b": {"type": "integer"}, "c": {"type": "number"},
                       "d": {"type": "boolean"}},
        "required": ["a", "b", "c", "d"],
        "additionalProperties": False,
    }


def test_schema_one_of_becomes_a_string_enum():
    schema = janus.build_schema({"verdict": {"one_of": ["pass", "fail"]}})
    assert schema["properties"]["verdict"] == {"type": "string", "enum": ["pass", "fail"]}


def test_schema_list_of_scalars():
    schema = janus.build_schema({"files": "list[str]", "sizes": "list[int]"})
    assert schema["properties"]["files"] == {"type": "array", "items": {"type": "string"}}
    assert schema["properties"]["sizes"] == {"type": "array", "items": {"type": "integer"}}


def test_schema_list_of_mappings_is_a_one_element_yaml_sequence():
    schema = janus.build_schema({"tasks": [{"id": "int", "title": "str"}]})
    assert schema["properties"]["tasks"] == {
        "type": "array",
        "items": {"type": "object", "properties": {"id": {"type": "integer"}, "title": {"type": "string"}},
                  "required": ["id", "title"], "additionalProperties": False},
    }


def test_schema_nested_mapping_is_a_strict_object():
    schema = janus.build_schema({"build": {"status": {"one_of": ["SUCCESS", "FAILURE"]}, "url": "str"}})
    assert schema["properties"]["build"] == {
        "type": "object",
        "properties": {"status": {"type": "string", "enum": ["SUCCESS", "FAILURE"]}, "url": {"type": "string"}},
        "required": ["status", "url"],
        "additionalProperties": False,
    }


@pytest.mark.parametrize("output", [
    {"a": "text"}, {"a": "list[thing]"}, {"a": []}, {"a": {}}, {"a": {"one_of": []}}, {}, "str"])
def test_schema_rejects_invalid_declarations(output):
    with pytest.raises(janus.JanusError, match="invalid output declaration"):
        janus.build_schema(output)


def test_validate_requires_exactly_the_declared_keys():
    schema = janus.build_schema({"a": "str", "b": "int"})
    assert janus.validate({"a": "x", "b": 1}, schema) is None
    assert janus.validate({"a": "x", "c": 1}, schema) == "$: expected exactly the keys ['a', 'b'], got ['a', 'c']"
    assert janus.validate(["a"], schema) == "$: expected object"


def test_validate_reports_wrong_types_and_enum_values_with_their_path():
    schema = janus.build_schema({"tasks": [{"id": "int", "state": {"one_of": ["todo", "done"]}}], "ok": "bool"})
    good = {"tasks": [{"id": 1, "state": "todo"}], "ok": True}
    assert janus.validate(good, schema) is None
    assert janus.validate({"tasks": [{"id": True, "state": "todo"}], "ok": True}, schema) == \
        "$.tasks[0].id: expected integer"
    assert janus.validate({"tasks": [{"id": 1, "state": "maybe"}], "ok": True}, schema) == \
        "$.tasks[0].state: expected string in ['todo', 'done']"
    assert janus.validate({"tasks": [], "ok": 1}, schema) == "$.ok: expected boolean"
    assert janus.validate({"tasks": {}, "ok": True}, schema) == "$.tasks: expected array"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_schema.py`
Expected: `AttributeError: module 'janus' has no attribute 'build_schema'`, `14 failed, 13 passed`.

- [ ] **Step 3: Write the schema section**

Append to `janus.py`:

```python
# --- output schema ---------------------------------------------------------

def field_schema(decl: Any) -> Dict[str, Any]:
    """JSON schema for one ``output`` field declaration (spec section 4, Output schema)."""
    scalars = {"str": "string", "int": "integer", "float": "number", "bool": "boolean"}
    if isinstance(decl, str) and decl in scalars:
        return {"type": scalars[decl]}
    if isinstance(decl, str) and re.fullmatch(r"list\[\w+\]", decl):
        return {"type": "array", "items": field_schema(decl[5:-1])}
    if isinstance(decl, list) and len(decl) == 1:
        return {"type": "array", "items": field_schema(decl[0])}
    if isinstance(decl, dict) and list(decl) == ["one_of"]:
        if isinstance(decl["one_of"], list) and decl["one_of"] and all(isinstance(o, str) for o in decl["one_of"]):
            return {"type": "string", "enum": list(decl["one_of"])}
    elif isinstance(decl, dict) and decl:
        return build_schema(decl)
    raise JanusError(f"invalid output declaration: {decl!r}")


def build_schema(output: Any) -> Dict[str, Any]:
    if not isinstance(output, dict) or not output:
        raise JanusError(f"invalid output declaration: {output!r}")
    return {"type": "object", "properties": {name: field_schema(decl) for name, decl in output.items()},
            "required": list(output), "additionalProperties": False}


def validate(value: Any, schema: Dict[str, Any], where: str = "$") -> Optional[str]:
    """The first mismatch between value and a build_schema() schema, or None."""
    kind = schema["type"]
    if kind == "object":
        if not isinstance(value, dict):
            return f"{where}: expected object"
        if sorted(value) != sorted(schema["required"]):
            return f"{where}: expected exactly the keys {schema['required']}, got {sorted(value)}"
        items = [(value[k], sub, f"{where}.{k}") for k, sub in schema["properties"].items()]
    elif kind == "array":
        if not isinstance(value, list):
            return f"{where}: expected array"
        items = [(item, schema["items"], f"{where}[{i}]") for i, item in enumerate(value)]
    else:
        is_bool = isinstance(value, bool)
        ok = {"string": isinstance(value, str), "boolean": is_bool, "integer": isinstance(value, int) and not is_bool,
              "number": isinstance(value, (int, float)) and not is_bool}[kind]
        if not ok or ("enum" in schema and value not in schema["enum"]):
            return f"{where}: expected {kind}" + (f" in {schema['enum']}" if "enum" in schema else "")
        return None
    return next((p for p in (validate(*item) for item in items) if p), None)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `27 passed`

- [ ] **Step 5: Commit**

```bash
git add janus.py tests/test_schema.py
git commit -m "feat(janus): strict output schema from prompt front matter with validation" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Journaled steps, replay rules and keys

Spec §4 Keys (default `<stem>#<n>`, duplicate live key is a `JanusError`), §4 `step`, §5 Replay (every rule), §8 (`step()` whose function raises), §9 test areas 4, 7 and 11.

**Files:**
- Modify: `janus.py` (append the `# --- steps and keys ---` section after `validate`)
- Create: `tests/test_steps.py`

**Interfaces:**
- Consumes: `JOURNAL`, `COUNTERS`, `LIVE`, `CURRENT`, `save_journal`, `now`, `JanusError`.
- Produces: `make_key(prompt: str, key: Optional[str]) -> str` (explicit key unchanged; otherwise `Path(prompt).stem` plus `#` and a per-stem counter for this run); `claim(key: str) -> None` (adds the key to `LIVE`, sets `CURRENT`, raises `JanusError("duplicate step key in one run: <key>")` when already live); `run_step(key: str, kind: str, execute: Callable[[int], Any]) -> Any` (replay `done` → stored `result`; `running`/`failed` → `attempt + 1`; absent → attempt 1; writes `running`, then `done` with `result` or `failed` with `error` and re-raises; the error text is `str(exc)` for `JanusError` and `"<Type>: <exc>"` otherwise; a result that `yaml.safe_dump` cannot represent fails the step); `step(key: str, fn: Callable[[], Any]) -> Any` = `run_step(key, "step", lambda attempt: fn())`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_steps.py`:

```python
import pytest
import yaml

import janus
from helpers import read_journal


def test_step_runs_its_function_once_and_journals_the_result(root):
    calls = []

    def push():
        calls.append(1)
        return {"sha": "abc"}

    assert janus.step("push", push) == {"sha": "abc"}
    assert calls == [1]
    entry = read_journal(root)["steps"]["push"]
    assert (entry["kind"], entry["status"], entry["attempt"], entry["result"]) == ("step", "done", 1, {"sha": "abc"})
    assert entry["started"] and entry["finished"]


def test_step_replay_returns_the_stored_value_without_calling_the_function(root):
    janus.step("push", lambda: 1)
    janus.begin(root)

    def must_not_run():
        raise AssertionError("fn called on replay")

    assert janus.step("push", must_not_run) == 1


def test_running_step_is_executed_again_with_attempt_incremented(root):
    (root / "journal.yaml").write_text(
        "flow: flow.py\nstarted: x\nsteps:\n  push: {kind: step, status: running, attempt: 1, started: x}\n",
        encoding="utf-8")
    janus.begin(root)
    assert janus.run_step("push", "step", lambda attempt: attempt) == 2
    entry = read_journal(root)["steps"]["push"]
    assert (entry["status"], entry["attempt"], entry["result"]) == ("done", 2, 2)


def test_failed_step_is_executed_again_with_attempt_incremented(root):
    (root / "journal.yaml").write_text(
        "flow: flow.py\nstarted: x\nsteps:\n  push: {kind: step, status: failed, attempt: 2, error: boom}\n",
        encoding="utf-8")
    janus.begin(root)
    assert janus.run_step("push", "step", lambda attempt: attempt) == 3
    entry = read_journal(root)["steps"]["push"]
    assert (entry["status"], entry["attempt"]) == ("done", 3)
    assert "error" not in entry


def test_step_whose_function_raises_is_journaled_failed_and_reraises(root):
    def push():
        raise RuntimeError("no remote")

    with pytest.raises(RuntimeError, match="no remote"):
        janus.step("push", push)
    entry = read_journal(root)["steps"]["push"]
    assert (entry["status"], entry["attempt"], entry["error"]) == ("failed", 1, "RuntimeError: no remote")
    assert "result" not in entry


def test_step_result_must_be_yaml_serialisable(root):
    with pytest.raises(yaml.YAMLError):
        janus.step("bad", lambda: object())
    entry = read_journal(root)["steps"]["bad"]
    assert entry["status"] == "failed" and entry["error"].startswith("RepresenterError: ")


def test_duplicate_live_key_in_one_run_raises_janus_error(root):
    janus.step("push", lambda: 1)
    with pytest.raises(janus.JanusError, match="duplicate step key in one run: push"):
        janus.step("push", lambda: 2)
    assert read_journal(root)["steps"]["push"]["result"] == 1


def test_log_after_a_replayed_step_prints_but_does_not_repeat_the_progress_line(root, capsys):
    janus.step("push", lambda: 1)
    janus.log("pushed")
    janus.begin(root)
    janus.step("push", lambda: 1)
    janus.log("pushed")
    janus.step("tag", lambda: 2)
    janus.log("tagged")
    progress = (root / "JANUS.md").read_text(encoding="utf-8")
    assert progress.count("pushed") == 1
    assert progress.count("tagged") == 1
    assert capsys.readouterr().out.count("pushed") == 2
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_steps.py`
Expected: `AttributeError: module 'janus' has no attribute 'step'` (and `run_step`), `8 failed, 27 passed`.

- [ ] **Step 3: Write the steps section**

Append to `janus.py`:

```python
# --- steps and keys --------------------------------------------------------

def make_key(prompt: str, key: Optional[str]) -> str:
    """Explicit key, or ``<stem>#<n>`` counting calls with that prompt stem in this run."""
    if key is not None:
        return key
    stem = Path(prompt).stem
    COUNTERS[stem] = COUNTERS.get(stem, 0) + 1
    return f"{stem}#{COUNTERS[stem]}"


def claim(key: str) -> None:
    global CURRENT
    if key in LIVE:
        raise JanusError(f"duplicate step key in one run: {key}")
    LIVE.add(key)
    CURRENT = key


def run_step(key: str, kind: str, execute: Callable[[int], Any]) -> Any:
    """Replay ``key`` from the journal or execute it, journaling every status change (spec section 5)."""
    global REPLAYING
    claim(key)
    entry = JOURNAL["steps"].get(key)
    REPLAYING = entry is not None and entry.get("status") == "done"
    if REPLAYING:
        return entry["result"]
    attempt = 1 if entry is None else int(entry.get("attempt", 0)) + 1
    entry = JOURNAL["steps"][key] = {"kind": kind, "status": "running", "attempt": attempt, "started": now()}
    save_journal(key, "running")
    try:
        result = execute(attempt)
        yaml.safe_dump(result)  # a result that is not YAML-serialisable fails the step here
    except Exception as exc:
        error = str(exc) if isinstance(exc, JanusError) else f"{type(exc).__name__}: {exc}"
        entry.update(status="failed", finished=now(), error=error)
        save_journal(key, "failed")
        raise
    entry.update(status="done", finished=now(), result=result)
    save_journal(key, "done")
    return result


def step(key: str, fn: Callable[[], Any]) -> Any:
    return run_step(key, "step", lambda attempt: fn())
```

Note that `except Exception` deliberately does not catch `SystemExit` or `KeyboardInterrupt`: a run killed during a step leaves the entry `running`, which is what spec §5 and §12.2 rely on for crash resume.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `35 passed`

- [ ] **Step 5: Commit**

```bash
git add janus.py tests/test_steps.py
git commit -m "feat(janus): journaled steps with replay, attempt counting and duplicate key detection" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Codex invocation and the `codex` primitive

Spec §4 `codex`, §4 Rendering (reserved `goal`/`attempt`, preamble), §7 (exact invocation, failure modes), §8 (rendering and schema errors fail before Codex; last twenty lines of stderr), §9 (fake `codex` on `PATH`; test area 1 preamble and undefined placeholder; area 3 codex called once per step).

**Files:**
- Modify: `janus.py` (append the `# --- codex ---` section after `step`)
- Modify: `tests/conftest.py` (add the `fake_codex` fixture; the file is replaced whole below)
- Create: `tests/test_codex.py`

**Interfaces:**
- Consumes: `load_prompt`, `render`, `goal`, `build_schema`, `validate`, `run_step`, `make_key`, `CONTEXT`, `ROOT`, `PREAMBLE_FILE`, `JanusError`.
- Produces: `run_codex(cwd: Path, prompt: str, schema: Optional[dict]) -> dict` (runs `codex exec -C <cwd> --dangerously-bypass-approvals-and-sandbox [--output-schema <tmp>/schema.json] --output-last-message <tmp>/last.json -` with the prompt on stdin from a temporary file, stderr streamed to the terminal and its last twenty lines kept; raises `JanusError` on non-zero exit, empty or missing final message, non-JSON message or schema mismatch, each message ending with the last twenty stderr lines; with `schema=None` returns `{"text": <message stripped>}`); `run_prompt(prompt, cwd, attempt, variables, previous=None, extra_output=None) -> dict` (merges `{"goal": goal(), "attempt": attempt}` and, when not `None`, `previous`, then `CONTEXT`, then `variables`; renders body and preamble; merges `extra_output` into the `output` declaration; calls `run_codex`); `codex(prompt, key=None, cwd=".", **vars) -> dict`.
- Test fixture `fake_codex` (in `tests/conftest.py`): puts a scripted `codex` first on `PATH`. `fake_codex.script(steps)` takes a list of steps, each `{"output": <dict>}` or `{"text": <str>}` for the final message, plus optional `"stderr"` (written to stderr), `"shell"` (commands run in the `-C` directory) and `"exit"` (default 0); the last step repeats for extra calls. `fake_codex.calls()` returns `[{"argv", "cwd", "prompt", "schema"}]` in call order, where `argv` starts at `exec`.

- [ ] **Step 1: Add the fake codex fixture**

Replace the whole of `tests/conftest.py` with:

```python
import json
import os
import types

import pytest

import janus

GOAL_MD = "# Goal\nUpgrade the widget.\n"


@pytest.fixture
def root(tmp_path):
    """A goal folder with a JANUS.md and an empty prompts/ folder; the engine is begun there."""
    (tmp_path / "JANUS.md").write_text(GOAL_MD, encoding="utf-8")
    (tmp_path / "prompts").mkdir()
    janus.begin(tmp_path)
    return tmp_path


FAKE_CODEX = '''#!/usr/bin/env python3
"""Fake `codex` for tests: records the call, then plays the next scripted step.
A step is {"output": <dict>} or {"text": <str>} for the final message, plus optional
"stderr" (printed to stderr), "shell" (commands run in the -C directory) and "exit" (default 0).
The last step repeats for extra calls."""
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
if step.get("stderr"):
    sys.stderr.write(step["stderr"] + "\\n")
if out_path and "output" in step:
    with open(out_path, "w") as f:
        json.dump(step["output"], f)
elif out_path and "text" in step:
    with open(out_path, "w") as f:
        f.write(step["text"])
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
    script_path.write_text("[{}]", encoding="utf-8")
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

Create `tests/test_codex.py`:

```python
import pytest

import janus
from helpers import read_journal, write_prompt


def test_codex_runs_exec_with_the_spec_flags_schema_and_prompt_on_stdin(root, fake_codex):
    (root / "app").mkdir()
    write_prompt(root, "plan", "Plan for {{goal}}", output={"summary": "str"})
    fake_codex.script([{"output": {"summary": "ok"}}])
    assert janus.codex("prompts/plan.md", cwd="app") == {"summary": "ok"}
    [call] = fake_codex.calls()
    argv = call["argv"]
    assert argv[:4] == ["exec", "-C", str(root / "app"), "--dangerously-bypass-approvals-and-sandbox"]
    assert argv[4] == "--output-schema" and argv[6] == "--output-last-message" and argv[-1] == "-"
    assert call["prompt"] == "Plan for Upgrade the widget."
    assert call["schema"] == janus.build_schema({"summary": "str"})
    entry = read_journal(root)["steps"]["plan#1"]
    assert (entry["kind"], entry["status"], entry["result"]) == ("codex", "done", {"summary": "ok"})


def test_codex_default_keys_count_calls_per_prompt_stem(root, fake_codex):
    write_prompt(root, "implement", "go", output={"done": "bool"})
    write_prompt(root, "review", "look", output={"done": "bool"})
    fake_codex.script([{"output": {"done": True}}])
    janus.codex("prompts/implement.md")
    janus.codex("prompts/review.md")
    janus.codex("prompts/implement.md", key="implement/explicit")
    janus.codex("prompts/implement.md")
    assert list(read_journal(root)["steps"]) == ["implement#1", "review#1", "implement/explicit", "implement#2"]


def test_codex_prepends_the_rendered_preamble_and_renders_goal_and_attempt(root, fake_codex):
    write_prompt(root, "_preamble", "Rules for: {{goal}}\n")
    write_prompt(root, "plan", "Attempt {{attempt}} of {{goal}}\n", output={"summary": "str"})
    fake_codex.script([{"output": {"summary": "ok"}}])
    janus.codex("prompts/plan.md")
    assert fake_codex.calls()[0]["prompt"] == "Rules for: Upgrade the widget.\n\nAttempt 1 of Upgrade the widget.\n"


def test_codex_prompt_without_output_returns_the_final_message_as_text(root, fake_codex):
    write_prompt(root, "free", "Say hi")
    fake_codex.script([{"text": "hello there\n"}])
    assert janus.codex("prompts/free.md") == {"text": "hello there"}
    assert "--output-schema" not in fake_codex.calls()[0]["argv"]


def test_codex_undefined_placeholder_fails_the_step_before_codex_starts(root, fake_codex):
    write_prompt(root, "plan", "{{missing}}", output={"summary": "str"})
    with pytest.raises(janus.JanusError, match="undefined placeholder"):
        janus.codex("prompts/plan.md")
    assert fake_codex.calls() == []
    entry = read_journal(root)["steps"]["plan#1"]
    assert entry["status"] == "failed" and "undefined placeholder {{missing}}" in entry["error"]


def test_codex_invalid_output_declaration_fails_the_step_before_codex_starts(root, fake_codex):
    write_prompt(root, "plan", "x", output={"summary": "text"})
    with pytest.raises(janus.JanusError, match="invalid output declaration"):
        janus.codex("prompts/plan.md")
    assert fake_codex.calls() == []
    assert read_journal(root)["steps"]["plan#1"]["status"] == "failed"


def test_codex_non_zero_exit_fails_with_the_last_twenty_stderr_lines(root, fake_codex):
    write_prompt(root, "plan", "x", output={"summary": "str"})
    fake_codex.script([{"exit": 3, "stderr": "\n".join(f"line {i}" for i in range(1, 31))}])
    with pytest.raises(janus.JanusError, match="codex exec exited with 3"):
        janus.codex("prompts/plan.md")
    error = read_journal(root)["steps"]["plan#1"]["error"]
    assert error.startswith("codex exec exited with 3: line 11\n") and error.endswith("line 30")
    assert "line 10\n" not in error


def test_codex_missing_final_message_fails_the_step(root, fake_codex):
    write_prompt(root, "plan", "x", output={"summary": "str"})
    fake_codex.script([{"stderr": "quota exceeded"}])
    with pytest.raises(janus.JanusError, match="without a final message: quota exceeded"):
        janus.codex("prompts/plan.md")
    assert read_journal(root)["steps"]["plan#1"]["status"] == "failed"


def test_codex_answer_that_does_not_match_the_schema_fails_the_step(root, fake_codex):
    write_prompt(root, "plan", "x", output={"summary": "str"})
    fake_codex.script([{"output": {"summary": 5}}])
    with pytest.raises(janus.JanusError, match=r"does not match the output schema \(\$.summary: expected string\)"):
        janus.codex("prompts/plan.md")
    assert read_journal(root)["steps"]["plan#1"]["status"] == "failed"


def test_codex_replay_does_not_call_codex_again(root, fake_codex):
    write_prompt(root, "plan", "x", output={"summary": "str"})
    fake_codex.script([{"output": {"summary": "ok"}}])
    janus.codex("prompts/plan.md")
    janus.begin(root)
    assert janus.codex("prompts/plan.md") == {"summary": "ok"}
    assert len(fake_codex.calls()) == 1
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_codex.py`
Expected: `AttributeError: module 'janus' has no attribute 'codex'`, `10 failed, 35 passed`.

- [ ] **Step 4: Write the codex section**

Append to `janus.py`:

```python
# --- codex -----------------------------------------------------------------

def run_codex(cwd: Path, prompt: str, schema: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """One fresh ``codex exec`` (spec section 7). Returns the parsed final message."""
    with tempfile.TemporaryDirectory(prefix="janus-") as tmp:
        last = Path(tmp) / "last.json"
        argv = ["codex", "exec", "-C", str(cwd), "--dangerously-bypass-approvals-and-sandbox"]
        if schema is not None:
            (Path(tmp) / "schema.json").write_text(json.dumps(schema, indent=2), encoding="utf-8")
            argv += ["--output-schema", str(Path(tmp) / "schema.json")]
        argv += ["--output-last-message", str(last), "-"]
        (Path(tmp) / "prompt.md").write_text(prompt, encoding="utf-8")
        with open(Path(tmp) / "prompt.md", encoding="utf-8") as stdin:
            proc = subprocess.Popen(argv, stdin=stdin, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        lines: List[str] = []
        for line in proc.stderr:  # Codex writes its transcript to stderr: show it live, keep the tail
            sys.stderr.write(line)
            lines.append(line.rstrip("\n"))
        tail = "\n".join(lines[-20:])
        if proc.wait() != 0:
            raise JanusError(f"codex exec exited with {proc.returncode}: {tail}")
        message = last.read_text(encoding="utf-8") if last.exists() else ""
        if not message.strip():
            raise JanusError(f"codex exec ended without a final message: {tail}")
    if schema is None:
        return {"text": message.strip()}
    try:
        data = json.loads(message)
    except ValueError as exc:
        raise JanusError(f"codex final message is not JSON ({exc}): {tail}")
    problem = validate(data, schema)
    if problem:
        raise JanusError(f"codex final message does not match the output schema ({problem}): {tail}")
    return data


def run_prompt(prompt: str, cwd: str, attempt: int, variables: Dict[str, Any], previous: Optional[Any] = None,
               extra_output: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Render with reserved values < context() < call arguments, preamble first; build the schema; run Codex.
    Rendering and schema errors are raised before Codex starts."""
    output, body = load_prompt(prompt)
    merged: Dict[str, Any] = {"goal": goal(), "attempt": attempt}
    if previous is not None:
        merged["previous"] = previous
    merged.update(CONTEXT)
    merged.update(variables)
    text = render(body, merged)
    preamble = ROOT / PREAMBLE_FILE
    if preamble.exists():
        text = render(preamble.read_text(encoding="utf-8"), merged).rstrip("\n") + "\n\n" + text
    if extra_output:
        output = dict(output or {}, **extra_output)
    return run_codex(ROOT / cwd, text, None if output is None else build_schema(output))


def codex(prompt: str, key: Optional[str] = None, cwd: str = ".", **vars: Any) -> Dict[str, Any]:
    return run_step(make_key(prompt, key), "codex", lambda attempt: run_prompt(prompt, cwd, attempt, vars))
```

Codex writes its transcript (reasoning summaries, commands, intermediate messages) to stderr, so `run_codex` streams stderr to the terminal line by line while keeping the last twenty lines for the error message; Codex's stdout carries only a copy of the final message and is discarded. The prompt is handed over through a temporary file on stdin, never on argv, so a large prompt cannot deadlock against the stderr pipe. `subprocess.Popen` finds `codex` on `PATH`, which is how the fixture substitutes the fake.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `45 passed`

- [ ] **Step 6: Commit**

```bash
git add janus.py tests/conftest.py tests/test_codex.py
git commit -m "feat(janus): codex primitive with schema-shaped output and a fake codex for tests" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `context`, `ralph` and `ai_gate`

Spec §4 `context`, `ralph`, `ai_gate`, `Exhausted`; §4 Rendering precedence and `previous`; §4 Keys (`<key>/<n>`); §9 test areas 4 (ralph iteration re-executed), 6 and 8; §12.4.

**Files:**
- Modify: `janus.py` (append the `# --- context, ralph and ai_gate ---` section after `codex`)
- Create: `tests/test_ralph.py`

**Interfaces:**
- Consumes: `CONTEXT`, `CURRENT`, `make_key`, `run_step`, `run_prompt`, `Exhausted`.
- Produces: `context(**vars) -> None` (updates `CONTEXT`); `ralph(prompt, until, max_iter, key=None, cwd=".", **vars) -> dict` (iteration `n` is `run_step(f"{key}/{n}", "codex", ...)` with `previous=""` for `n == 1` and the previous result afterwards; returns the first result for which `until(result)` is true; after `max_iter` iterations sets `CURRENT = key` and raises `Exhausted(last)`); `ai_gate(prompt, key=None, cwd=".", **vars) -> bool` (`run_step(..., "ai_gate", ...)` with `extra_output={"passed": "bool", "reasons": "list[str]"}`; returns `bool(result["passed"])`).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_ralph.py`:

```python
import pytest

import janus
from helpers import read_journal, write_prompt


def test_context_values_reach_the_prompt_and_call_arguments_win(root, fake_codex):
    write_prompt(root, "p", "{{branch}}|{{goal}}|{{n}}", output={"ok": "bool"})
    fake_codex.script([{"output": {"ok": True}}])
    janus.context(branch="ai/upgrade", goal="goal from context", n=1)
    janus.codex("prompts/p.md", n=2)
    assert fake_codex.calls()[0]["prompt"] == "ai/upgrade|goal from context|2"


def test_ralph_stops_at_until_and_keys_iterations_under_the_key(root, fake_codex):
    write_prompt(root, "implement", "go", output={"done": "bool"})
    fake_codex.script([{"output": {"done": False}}, {"output": {"done": False}}, {"output": {"done": True}}])
    result = janus.ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=5, key="implement/1")
    assert result == {"done": True}
    assert list(read_journal(root)["steps"]) == ["implement/1/1", "implement/1/2", "implement/1/3"]
    assert len(fake_codex.calls()) == 3


def test_ralph_default_key_uses_the_prompt_stem_counter(root, fake_codex):
    write_prompt(root, "implement", "go", output={"done": "bool"})
    fake_codex.script([{"output": {"done": True}}])
    janus.ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=2)
    assert list(read_journal(root)["steps"]) == ["implement#1/1"]


def test_ralph_passes_previous_as_empty_then_as_the_previous_result(root, fake_codex):
    write_prompt(root, "implement", "prev: [{{previous}}]", output={"done": "bool"})
    fake_codex.script([{"output": {"done": False}}, {"output": {"done": True}}])
    janus.ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=5, key="implement/1")
    assert [c["prompt"] for c in fake_codex.calls()] == ["prev: []", "prev: [done: false]"]


def test_ralph_raises_exhausted_with_the_last_result(root, fake_codex):
    write_prompt(root, "implement", "go", output={"done": "bool", "note": "str"})
    fake_codex.script([{"output": {"done": False, "note": "still failing"}}])
    with pytest.raises(janus.Exhausted) as exc:
        janus.ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=2, key="implement/1")
    assert exc.value.last == {"done": False, "note": "still failing"}
    assert len(fake_codex.calls()) == 2
    assert list(read_journal(root)["steps"]) == ["implement/1/1", "implement/1/2"]


def test_ralph_replay_executes_only_the_unfinished_iteration(root, fake_codex):
    write_prompt(root, "implement", "go", output={"done": "bool"})
    fake_codex.script([{"output": {"done": False}}, {"output": {"done": False}}, {"output": {"done": True}}])
    janus.ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=5, key="implement/1")
    journal = read_journal(root)
    journal["steps"]["implement/1/3"]["status"] = "running"  # as if killed during the third iteration
    (root / "journal.yaml").write_text(janus.yaml.safe_dump(journal, sort_keys=False), encoding="utf-8")
    janus.begin(root)
    result = janus.ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=5, key="implement/1")
    assert result == {"done": True}
    assert len(fake_codex.calls()) == 4
    assert read_journal(root)["steps"]["implement/1/3"]["attempt"] == 2


def test_ai_gate_adds_passed_and_reasons_to_the_schema_and_returns_passed(root, fake_codex):
    write_prompt(root, "review", "Review it", output={"summary": "str"})
    fake_codex.script([{"output": {"summary": "s", "passed": False, "reasons": ["tests skipped"]}}])
    assert janus.ai_gate("prompts/review.md", key="review") is False
    schema = fake_codex.calls()[0]["schema"]
    assert schema["properties"]["passed"] == {"type": "boolean"}
    assert schema["properties"]["reasons"] == {"type": "array", "items": {"type": "string"}}
    assert schema["required"] == ["summary", "passed", "reasons"]
    entry = read_journal(root)["steps"]["review"]
    assert entry["kind"] == "ai_gate" and entry["result"]["reasons"] == ["tests skipped"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_ralph.py`
Expected: `AttributeError: module 'janus' has no attribute 'context'` (and `ralph`, `ai_gate`), `7 failed, 45 passed`.

- [ ] **Step 3: Write the section**

Append to `janus.py`:

```python
# --- context, ralph and ai_gate --------------------------------------------

def context(**vars: Any) -> None:
    CONTEXT.update(vars)


def ralph(prompt: str, until: Callable[[Dict[str, Any]], bool], max_iter: int, key: Optional[str] = None,
          cwd: str = ".", **vars: Any) -> Dict[str, Any]:
    """codex() repeated until ``until(result)``; iterations are keyed <key>/<n> and see {{previous}}."""
    global CURRENT
    key = make_key(prompt, key)
    previous: Any = ""
    last: Any = None
    for n in range(1, max_iter + 1):
        last = run_step(f"{key}/{n}", "codex",
                        lambda attempt, prev=previous: run_prompt(prompt, cwd, attempt, vars, previous=prev))
        if until(last):
            return last
        previous = last
    CURRENT = key
    raise Exhausted(last)


def ai_gate(prompt: str, key: Optional[str] = None, cwd: str = ".", **vars: Any) -> bool:
    result = run_step(make_key(prompt, key), "ai_gate", lambda attempt: run_prompt(
        prompt, cwd, attempt, vars, extra_output={"passed": "bool", "reasons": "list[str]"}))
    return bool(result["passed"])
```

The lambda's default argument `prev=previous` binds the value for that iteration; `until` is evaluated on replayed results too, so a rerun stops at the same iteration as the original run.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `52 passed`

- [ ] **Step 5: Commit**

```bash
git add janus.py tests/test_ralph.py
git commit -m "feat(janus): context values, ralph loop with previous result, ai_gate" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Human gates and decisions in `JANUS.md`

Spec §4 `human_gate`, `decision`; §5 Gates in `JANUS.md` (section shape, answer reading, `## Decisions`, empty answer, rejected decision), §5 Replay (`open` exits 2 again, `answered` returns the answer), §5 Exit codes; §9 test area 5; §12.3.

**Files:**
- Modify: `janus.py` (append the `# --- gates ---` section after `ai_gate`)
- Create: `tests/test_gates.py`

**Interfaces:**
- Consumes: `JOURNAL`, `claim`, `make_key`, `save_journal`, `read_goal_file`, `write_goal_file`, `find_section`, `remove_section`, `append_to_section`, `as_text`, `now`, `GOAL_FILE`.
- Produces: `write_gate(key, question, show, note=None) -> None` (removes any existing `## Gate: <key>` section and appends a fresh one at the end of `JANUS.md`: heading, question, blank, optional `show` as four-space-indented YAML plus blank, optional note plus blank, `answer:`, blank); `read_answer(key) -> str` (text after `answer:` to the end of the section, stripped; `""` when there is no answer or no section); `gate(question, key, show, options) -> str` (the shared implementation: `answered` → stored answer; otherwise reads the answer, and either journals `answered`, removes the section, appends to `## Decisions` and returns it, or rewrites the section (with a `Note: "<answer>" is not one of: a, b.` line when a decision answer is outside its options), journals `open`, prints `gate open: <key>. Answer it in JANUS.md and run again.` and raises `SystemExit(2)`); `human_gate(question, key=None, show=None) -> str` (default key stem `gate`); `decision(question, options, key=None, show=None) -> str` (default key stem `decision`, journal `kind: decision`).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_gates.py`:

```python
import re

import pytest

import janus
from helpers import read_journal


def open_gate(root, answer=None, **kwargs):
    """Open (or re-enter) a gate expecting exit 2; optionally write an answer afterwards."""
    with pytest.raises(SystemExit) as exc:
        janus.human_gate("Approve this plan?", key="approve-plan", **kwargs)
    assert exc.value.code == 2
    if answer is not None:
        path = root / "JANUS.md"
        path.write_text(path.read_text(encoding="utf-8").replace("answer:\n", f"answer:{answer}\n"), encoding="utf-8")


def test_human_gate_writes_the_section_journals_open_and_exits_2(root, capsys):
    open_gate(root, show={"tasks": ["a", "b"]})
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert text == ("# Goal\nUpgrade the widget.\n\n## Gate: approve-plan\nApprove this plan?\n\n"
                    "    tasks:\n    - a\n    - b\n\nanswer:\n")
    entry = read_journal(root)["steps"]["approve-plan"]
    assert (entry["kind"], entry["status"], entry["question"]) == ("gate", "open", "Approve this plan?")
    assert "gate open: approve-plan" in capsys.readouterr().out


def test_answer_is_journaled_moved_to_decisions_returned_and_replayed(root):
    open_gate(root, answer=" yes")
    janus.begin(root)
    assert janus.human_gate("Approve this plan?", key="approve-plan") == "yes"
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert "## Gate:" not in text
    assert re.search(r"## Decisions\n- \d{4}-\d\d-\d\d approve-plan: Approve this plan\?\n  answer: yes\n", text)
    entry = read_journal(root)["steps"]["approve-plan"]
    assert (entry["status"], entry["answer"]) == ("answered", "yes")
    janus.begin(root)
    assert janus.human_gate("Approve this plan?", key="approve-plan") == "yes"


def test_answer_may_continue_on_the_following_lines(root):
    open_gate(root, answer="\nchange task 2\nthen go")
    janus.begin(root)
    assert janus.human_gate("Approve this plan?", key="approve-plan") == "change task 2\nthen go"
    assert "  answer: change task 2\n  then go\n" in (root / "JANUS.md").read_text(encoding="utf-8")


def test_empty_answer_keeps_the_gate_open_and_exits_2_again(root):
    open_gate(root)
    janus.begin(root)
    open_gate(root)
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert text.count("## Gate: approve-plan") == 1
    assert read_journal(root)["steps"]["approve-plan"]["status"] == "open"


def test_decision_rejects_an_answer_outside_its_options_with_a_note(root):
    with pytest.raises(SystemExit):
        janus.decision("Continue?", ["retry", "skip"], key="d")
    path = root / "JANUS.md"
    path.write_text(path.read_text(encoding="utf-8").replace("answer:\n", "answer: maybe\n"), encoding="utf-8")
    janus.begin(root)
    with pytest.raises(SystemExit) as exc:
        janus.decision("Continue?", ["retry", "skip"], key="d")
    assert exc.value.code == 2
    text = path.read_text(encoding="utf-8")
    assert text.endswith('## Gate: d\nContinue?\n\nNote: "maybe" is not one of: retry, skip.\n\nanswer:\n')
    entry = read_journal(root)["steps"]["d"]
    assert (entry["kind"], entry["status"]) == ("decision", "open")


def test_decision_returns_an_answer_within_its_options(root):
    with pytest.raises(SystemExit):
        janus.decision("Continue?", ["retry", "skip"], key="d")
    path = root / "JANUS.md"
    path.write_text(path.read_text(encoding="utf-8").replace("answer:\n", "answer: skip\n"), encoding="utf-8")
    janus.begin(root)
    assert janus.decision("Continue?", ["retry", "skip"], key="d") == "skip"
    assert read_journal(root)["steps"]["d"]["status"] == "answered"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_gates.py`
Expected: `AttributeError: module 'janus' has no attribute 'human_gate'` (and `decision`), `6 failed, 52 passed`.

- [ ] **Step 3: Write the gates section**

Append to `janus.py`:

```python
# --- gates -----------------------------------------------------------------

def write_gate(key: str, question: str, show: Any, note: Optional[str] = None) -> None:
    """(Re)write the gate section at the end of JANUS.md with an empty ``answer:`` line."""
    remove_section(f"## Gate: {key}")
    lines = read_goal_file()
    section = [f"## Gate: {key}", question, ""]
    if show is not None:
        section += ["    " + line for line in as_text(show).splitlines()] + [""]
    section += ([note, ""] if note else []) + ["answer:", ""]
    write_goal_file(lines + ([""] if lines and lines[-1].strip() else []) + section)


def read_answer(key: str) -> str:
    """Text after ``answer:`` up to the end of the gate section; empty when there is none."""
    lines = read_goal_file()
    span = find_section(lines, f"## Gate: {key}")
    body = [] if span is None else lines[span[0] + 1:span[1]]
    for i, line in enumerate(body):
        if line.startswith("answer:"):
            return "\n".join([line[len("answer:"):]] + body[i + 1:]).strip()
    return ""


def gate(question: str, key: str, show: Any, options: Optional[List[str]]) -> str:
    global REPLAYING
    claim(key)
    entry = JOURNAL["steps"].get(key)
    REPLAYING = entry is not None and entry.get("status") == "answered"
    if REPLAYING:
        return entry["answer"]
    if entry is None:
        entry = JOURNAL["steps"][key] = {"kind": "gate" if options is None else "decision", "status": "open",
                                         "question": question, "started": now()}
    answer = read_answer(key)
    rejected = bool(answer) and options is not None and answer not in options
    if answer and not rejected:
        entry.update(status="answered", answer=answer, finished=now())
        remove_section(f"## Gate: {key}")
        append_to_section("## Decisions", [f"- {dt.date.today().isoformat()} {key}: {question}"]
                          + [("  answer: " if i == 0 else "  ") + line for i, line in enumerate(answer.splitlines())])
        save_journal(key, "answered")
        return answer
    write_gate(key, question, show, f'Note: "{answer}" is not one of: {", ".join(options)}.' if rejected else None)
    save_journal(key, "open")
    print(f"gate open: {key}. Answer it in {GOAL_FILE} and run again.")
    raise SystemExit(2)


def human_gate(question: str, key: Optional[str] = None, show: Any = None) -> str:
    return gate(question, make_key("gate", key), show, None)


def decision(question: str, options: List[str], key: Optional[str] = None, show: Any = None) -> str:
    return gate(question, make_key("decision", key), show, list(options))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `58 passed`

- [ ] **Step 5: Commit**

```bash
git add janus.py tests/test_gates.py
git commit -m "feat(janus): human gates and decisions answered in JANUS.md" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Commit and push after every journal write

Spec §5 Git ("After every journal write ... stages `JANUS.md` and `journal.yaml`, commits with the message `janus: <key> <status>`, and pushes if the current branch has an upstream. A failed commit or push is logged as a warning and does not stop the run."), §9 (temporary repository with a local bare remote; test area 9), §12.6 (the engine touches only its own two files).

**Files:**
- Modify: `janus.py` (append the `# --- git ---` section after `decision`; replace `save_journal` in the first section)
- Modify: `tests/helpers.py` (add the git wrapper; the file is replaced whole below)
- Create: `tests/test_git.py`

**Interfaces:**
- Consumes: `ROOT`, `GOAL_FILE`, `JOURNAL_FILE`, `save_journal`.
- Produces: `git(*args) -> subprocess.CompletedProcess` (runs `git` in `ROOT`, output captured, never raises); `git_commit(message: str) -> None` (no-op unless `ROOT/.git` exists; `git add -- JANUS.md journal.yaml` for the files that exist; returns silently when nothing is staged; `git commit -q -m <message>`, warning `janus: warning: git commit failed: ...` on stderr on failure; pushes with `git push -q` only when `git rev-parse --abbrev-ref --symbolic-full-name @{u}` succeeds, warning `janus: warning: git push failed: ...` on failure). `save_journal` now ends with `git_commit(f"janus: {key} {status}")`.
- Test helpers added to `tests/helpers.py`: `git(cwd, *args) -> str` (stdout stripped, raises on failure), `init_repo(path)` (`git init -b main` plus test user config), `commit_all(path, message) -> sha`, `make_bare(path) -> path`.

- [ ] **Step 1: Add the git test helpers**

Replace the whole of `tests/helpers.py` with:

```python
"""Shared helpers for Janus tests: journal reading, prompt writing and a tiny git wrapper."""
import subprocess

import yaml


def read_journal(root):
    return yaml.safe_load((root / "journal.yaml").read_text(encoding="utf-8"))


def write_prompt(root, stem, body, output=None):
    """Write prompts/<stem>.md with an optional ``output`` front matter mapping."""
    text = body
    if output is not None:
        text = "---\n" + yaml.safe_dump({"output": output}, sort_keys=False) + "---\n" + body
    (root / "prompts").mkdir(exist_ok=True)
    (root / "prompts" / f"{stem}.md").write_text(text, encoding="utf-8")


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True).stdout.strip()


def init_repo(path):
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.name", "Test User")
    git(path, "config", "user.email", "test@example.com")
    git(path, "config", "commit.gpgsign", "false")


def commit_all(path, message):
    git(path, "add", "-A")
    git(path, "commit", "-q", "-m", message)
    return git(path, "rev-parse", "HEAD")


def make_bare(path):
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(path)], check=True)
    return path
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_git.py`:

```python
import shutil

import pytest

import janus
from helpers import commit_all, git, init_repo, make_bare


@pytest.fixture
def repo(root):
    init_repo(root)
    commit_all(root, "init")
    return root


@pytest.fixture
def repo_with_upstream(repo, tmp_path):
    bare = make_bare(tmp_path / "origin.git")
    git(repo, "remote", "add", "origin", str(bare))
    git(repo, "push", "-q", "-u", "origin", "main")
    return repo, bare


def test_every_journal_write_is_committed_with_key_and_status(repo):
    janus.step("push", lambda: 1)
    assert git(repo, "log", "--format=%s").splitlines() == ["janus: push done", "janus: push running", "init"]
    assert git(repo, "status", "--porcelain") == ""


def test_janus_md_changes_are_committed_together_with_the_journal(repo):
    with pytest.raises(SystemExit):
        janus.human_gate("Approve?", key="approve")
    assert git(repo, "log", "-1", "--format=%s") == "janus: approve open"
    assert sorted(git(repo, "show", "--name-only", "--format=", "HEAD").splitlines()) == ["JANUS.md", "journal.yaml"]


def test_commits_are_pushed_when_the_branch_has_an_upstream(repo_with_upstream):
    repo, bare = repo_with_upstream
    janus.step("push", lambda: 1)
    assert git(bare, "log", "-1", "--format=%s", "main") == "janus: push done"


def test_failed_push_warns_and_the_run_continues(repo_with_upstream, capsys):
    repo, bare = repo_with_upstream
    shutil.rmtree(bare)
    assert janus.step("push", lambda: 1) == 1
    assert "janus: warning: git push failed" in capsys.readouterr().err
    assert git(repo, "log", "-1", "--format=%s") == "janus: push done"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_git.py`
Expected: `assert ['init'] == ['janus: push done', 'janus: push running', 'init']` and similar (nothing is committed yet), `4 failed, 58 passed`.

- [ ] **Step 4: Write the git section and hook it into `save_journal`**

Append to `janus.py`:

```python
# --- git -------------------------------------------------------------------

def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(ROOT), capture_output=True, text=True)


def git_commit(message: str) -> None:
    """Commit JANUS.md and journal.yaml and push if there is an upstream. Failures warn only."""
    if not (ROOT / ".git").exists():
        return
    git("add", "--", *[f for f in (GOAL_FILE, JOURNAL_FILE) if (ROOT / f).exists()])
    if git("diff", "--cached", "--quiet").returncode == 0:
        return  # nothing staged
    commit = git("commit", "-q", "-m", message)
    if commit.returncode != 0:
        print(f"janus: warning: git commit failed: {commit.stderr.strip()}", file=sys.stderr)
    elif git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").returncode == 0:
        push = git("push", "-q")
        if push.returncode != 0:
            print(f"janus: warning: git push failed: {push.stderr.strip()}", file=sys.stderr)
```

Replace `save_journal` in `janus.py` with:

```python
def save_journal(key: str, status: str) -> None:
    """Write journal.yaml atomically at every status change of ``key``, then commit (section 5, Git)."""
    write_atomic(ROOT / JOURNAL_FILE, yaml.safe_dump(JOURNAL, sort_keys=False, allow_unicode=True))
    git_commit(f"janus: {key} {status}")
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `62 passed` (the earlier tests run in folders without `.git`, so `git_commit` returns at once for them).

- [ ] **Step 6: Commit**

```bash
git add janus.py tests/helpers.py tests/test_git.py
git commit -m "feat(janus): commit and push JANUS.md and journal.yaml after every journal write" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The `run` command

Spec §6 (`run` imports `flow.py` from the current folder and executes it; uncaught exceptions including `Exhausted` go to `## Progress` with the step key; exit 1), §5 Exit codes, §8 (`Exhausted` not caught stops the run with the last result in `## Progress`), §9 test area 3, §12.1.

**Files:**
- Modify: `janus.py` (append the `# --- CLI ---` section after `git_commit`)
- Create: `tests/test_run.py`

**Interfaces:**
- Consumes: `begin`, `ROOT`, `FLOW_FILE`, `JOURNAL`, `CURRENT`, `log`, `as_text`, `Exhausted`.
- Produces: `cmd_run() -> int` (`begin(Path.cwd())`; 1 with `janus: flow.py not found in <root>` on stderr when there is no flow; aliases `sys.modules["janus"]` to this module and puts the goal folder on `sys.path`; `runpy.run_path(flow)`; `SystemExit` → its integer code (gates exit 2); `Exhausted` → traceback on stderr, `log("<key>: ralph exhausted; last result:\n<yaml>")`, 1; any other exception → traceback, `log("<key or flow>: <Type>: <message>")`, 1; otherwise prints `flow ended` and returns 0); `COMMANDS = {"run": cmd_run}` (Task 10 adds the other two); `main(argv: Optional[List[str]] = None) -> int` (argparse with one positional `command` chosen from `COMMANDS`; returns the command's exit code); `if __name__ == "__main__": sys.exit(main())`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_run.py`:

```python
import os
import shutil
import subprocess
import sys

import yaml

import janus
from helpers import read_journal, write_prompt

FLOW = """\
from janus import codex, step, log

plan = codex("prompts/plan.md")
for task in plan["tasks"]:
    step(f"echo/{task}", lambda: task.upper())
log("all tasks echoed")
"""


def run(root, monkeypatch, *argv):
    monkeypatch.chdir(root)
    return janus.main(list(argv) or ["run"])


def test_run_executes_the_flow_and_a_second_run_replays_every_step(root, fake_codex, monkeypatch):
    (root / "flow.py").write_text(FLOW, encoding="utf-8")
    write_prompt(root, "plan", "Plan {{goal}}", output={"tasks": "list[str]"})
    fake_codex.script([{"output": {"tasks": ["a", "b"]}}])
    assert run(root, monkeypatch) == 0
    first = read_journal(root)
    assert run(root, monkeypatch) == 0
    second = read_journal(root)
    assert len(fake_codex.calls()) == 1
    assert first == second
    assert list(first["steps"]) == ["plan#1", "echo/a", "echo/b"]
    assert first["steps"]["echo/b"]["result"] == "B"


def test_run_exits_2_at_an_open_gate(root, monkeypatch):
    (root / "flow.py").write_text("from janus import human_gate\nhuman_gate('Go on?', key='go')\n", encoding="utf-8")
    assert run(root, monkeypatch) == 2
    assert read_journal(root)["steps"]["go"]["status"] == "open"


def test_run_writes_an_uncaught_exception_to_progress_with_the_step_key(root, monkeypatch):
    (root / "flow.py").write_text(
        "from janus import step\n\ndef boom():\n    raise ValueError('bad sha')\n\nstep('push', boom)\n",
        encoding="utf-8")
    assert run(root, monkeypatch) == 1
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert "## Progress\n- " in text and text.endswith(" push: ValueError: bad sha\n")
    assert read_journal(root)["steps"]["push"]["status"] == "failed"


def test_run_writes_the_last_result_of_an_uncaught_exhausted_to_progress(root, fake_codex, monkeypatch):
    (root / "flow.py").write_text(
        "from janus import ralph\nralph('prompts/fix.md', until=lambda r: r['done'], max_iter=2, key='fix/1')\n",
        encoding="utf-8")
    write_prompt(root, "fix", "fix it", output={"done": "bool", "note": "str"})
    fake_codex.script([{"output": {"done": False, "note": "flaky"}}])
    assert run(root, monkeypatch) == 1
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert " fix/1: ralph exhausted; last result:\n  done: false\n  note: flaky\n" in text


def test_run_without_flow_py_exits_1(root, monkeypatch, capsys):
    assert run(root, monkeypatch) == 1
    assert "flow.py not found" in capsys.readouterr().err


def test_run_as_a_script_shares_engine_state_with_the_flow(root, fake_codex):
    shutil.copy(janus.__file__, root / "janus.py")
    (root / "flow.py").write_text(FLOW, encoding="utf-8")
    write_prompt(root, "plan", "Plan {{goal}}", output={"tasks": "list[str]"})
    fake_codex.script([{"output": {"tasks": ["a"]}}])
    proc = subprocess.run([sys.executable, "janus.py", "run"], cwd=str(root), capture_output=True, text=True,
                          env=dict(os.environ))
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == "all tasks echoed\nflow ended\n"
    journal = yaml.safe_load((root / "journal.yaml").read_text(encoding="utf-8"))
    assert list(journal["steps"]) == ["plan#1", "echo/a"]
    assert journal["steps"]["echo/a"] == {**journal["steps"]["echo/a"], "status": "done", "result": "A"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_run.py`
Expected: `AttributeError: module 'janus' has no attribute 'main'` for five tests and `FileNotFoundError: ... journal.yaml` for the script test (`python janus.py run` does nothing yet), `6 failed, 62 passed`.

- [ ] **Step 3: Write the CLI section with `run`**

Append to `janus.py`:

```python
# --- CLI -------------------------------------------------------------------

def cmd_run() -> int:
    begin(Path.cwd())
    if not (ROOT / FLOW_FILE).exists():
        print(f"janus: {FLOW_FILE} not found in {ROOT}", file=sys.stderr)
        return 1
    # flow.py says `from janus import ...`; that must resolve to this module, not to a second copy of the file.
    sys.modules.setdefault("janus", sys.modules[__name__])
    sys.path.insert(0, str(ROOT))  # so flow.py can import helper modules from the goal folder
    try:
        runpy.run_path(str(ROOT / FLOW_FILE), run_name="flow")
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    except Exhausted as exc:
        traceback.print_exc()
        log(f"{CURRENT}: ralph exhausted; last result:\n{as_text(exc.last)}")
        return 1
    except Exception as exc:
        traceback.print_exc()
        log(f"{CURRENT or 'flow'}: {type(exc).__name__}: {exc}")
        return 1
    print("flow ended")
    return 0


COMMANDS = {"run": cmd_run}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="janus.py", description="Janus 4.0: a small durable flow engine for Codex")
    parser.add_argument("command", choices=sorted(COMMANDS))
    return COMMANDS[parser.parse_args(argv).command]()


if __name__ == "__main__":
    sys.exit(main())
```

Why the `sys.modules` line matters: when the engine runs as `python janus.py run`, the running module is `__main__`; without the alias, `from janus import codex` in `flow.py` would import a second copy of the file with its own empty state, and `except Exhausted` in `cmd_run` would not catch the flow's `Exhausted`. The last test in `tests/test_run.py` runs the engine as a script for exactly this reason.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `68 passed`

- [ ] **Step 5: Commit**

```bash
git add janus.py tests/test_run.py
git commit -m "feat(janus): run command executing flow.py with replay and exit codes" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The `status` and `reset` commands

Spec §6 (`status`: "open gate if any, last five steps, next action"; `reset`: "move `journal.yaml` to `journals/<timestamp>.yaml` and remove open gates from `JANUS.md`"), §9 test area 10.

**Files:**
- Modify: `janus.py` (insert `cmd_status` and `cmd_reset` before the `COMMANDS` line; extend `COMMANDS`)
- Create: `tests/test_status_reset.py`

**Interfaces:**
- Consumes: `begin`, `ROOT`, `JOURNAL`, `JOURNAL_FILE`, `GOAL_FILE`, `read_goal_file`, `remove_section`.
- Produces: `cmd_status() -> int` (without a journal prints `no journal; nothing has run yet` and `next: python janus.py run`; otherwise `open gate: <key>` plus the indented question or `no open gate`, then `last steps:` with up to five lines `  <key>: <kind> <status> (attempt <n or ->)` in journal order, then `next: answer '<key>' in JANUS.md, then python janus.py run` for an open gate, `next: python janus.py run (re-executes <key>)` when a step is `running` or `failed`, else `next: python janus.py run`); `cmd_reset() -> int` (moves `journal.yaml` to `journals/<YYYYmmddTHHMMSS>.yaml`, removes every `## Gate: ...` section, prints what it did); `COMMANDS = {"run": cmd_run, "status": cmd_status, "reset": cmd_reset}`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_status_reset.py`:

```python
import yaml

import janus

JOURNAL = {
    "flow": "flow.py",
    "started": "2026-09-22T10:00:00",
    "steps": {
        "plan#1": {"kind": "codex", "status": "done", "attempt": 1},
        "implement/1/1": {"kind": "codex", "status": "done", "attempt": 1},
        "implement/1/2": {"kind": "codex", "status": "done", "attempt": 2},
        "ci/1": {"kind": "step", "status": "done", "attempt": 1},
        "implement/2/1": {"kind": "codex", "status": "done", "attempt": 1},
        "approve-plan": {"kind": "gate", "status": "open", "question": "Approve this plan?"},
    },
}

DECISIONS = "# Goal\nUpgrade.\n\n## Decisions\n- 2026-09-22 x: y\n  answer: z\n"
JANUS_MD = DECISIONS + "\n## Gate: approve-plan\nApprove this plan?\n\nanswer:\n\n## Gate: other\nOther?\n\nanswer:\n"


def run(root, monkeypatch, command):
    monkeypatch.chdir(root)
    return janus.main([command])


def test_status_shows_the_open_gate_the_last_five_steps_and_the_next_action(root, monkeypatch, capsys):
    (root / "journal.yaml").write_text(yaml.safe_dump(JOURNAL, sort_keys=False), encoding="utf-8")
    assert run(root, monkeypatch, "status") == 0
    assert capsys.readouterr().out == (
        "open gate: approve-plan\n"
        "  Approve this plan?\n"
        "last steps:\n"
        "  implement/1/1: codex done (attempt 1)\n"
        "  implement/1/2: codex done (attempt 2)\n"
        "  ci/1: step done (attempt 1)\n"
        "  implement/2/1: codex done (attempt 1)\n"
        "  approve-plan: gate open (attempt -)\n"
        "next: answer 'approve-plan' in JANUS.md, then python janus.py run\n"
    )


def test_status_points_at_the_step_that_will_be_re_executed(root, monkeypatch, capsys):
    (root / "journal.yaml").write_text(
        "flow: flow.py\nstarted: x\nsteps:\n  plan#1: {kind: codex, status: failed, attempt: 1, error: boom}\n",
        encoding="utf-8")
    assert run(root, monkeypatch, "status") == 0
    out = capsys.readouterr().out
    assert out.startswith("no open gate\n") and out.endswith("next: python janus.py run (re-executes plan#1)\n")


def test_status_without_a_journal_points_at_run(root, monkeypatch, capsys):
    assert run(root, monkeypatch, "status") == 0
    assert capsys.readouterr().out == "no journal; nothing has run yet\nnext: python janus.py run\n"


def test_reset_archives_the_journal_and_removes_open_gates(root, monkeypatch):
    (root / "journal.yaml").write_text(yaml.safe_dump(JOURNAL, sort_keys=False), encoding="utf-8")
    (root / "JANUS.md").write_text(JANUS_MD, encoding="utf-8")
    assert run(root, monkeypatch, "reset") == 0
    assert not (root / "journal.yaml").exists()
    [archive] = list((root / "journals").iterdir())
    assert archive.suffix == ".yaml" and yaml.safe_load(archive.read_text(encoding="utf-8")) == JOURNAL
    assert (root / "JANUS.md").read_text(encoding="utf-8") == DECISIONS
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_status_reset.py`
Expected: `SystemExit: 2` from argparse, `error: argument command: invalid choice: 'status'`, `4 failed, 68 passed`.

- [ ] **Step 3: Write `status` and `reset`**

Insert into `janus.py` before the line `COMMANDS = {"run": cmd_run}`:

```python
def cmd_status() -> int:
    begin(Path.cwd())
    if not (ROOT / JOURNAL_FILE).exists():
        print("no journal; nothing has run yet\nnext: python janus.py run")
        return 0
    steps: Dict[str, Any] = JOURNAL["steps"]
    gates = [k for k, e in steps.items() if e.get("status") == "open"]
    unfinished = [k for k, e in steps.items() if e.get("status") in ("running", "failed")]
    print(f"open gate: {gates[0]}\n  {steps[gates[0]].get('question', '')}" if gates else "no open gate")
    print("last steps:")
    for k in list(steps)[-5:]:
        print(f"  {k}: {steps[k].get('kind')} {steps[k].get('status')} (attempt {steps[k].get('attempt', '-')})")
    if gates:
        print(f"next: answer '{gates[0]}' in {GOAL_FILE}, then python janus.py run")
    else:
        print("next: python janus.py run" + (f" (re-executes {unfinished[0]})" if unfinished else ""))
    return 0


def cmd_reset() -> int:
    begin(Path.cwd())
    path = ROOT / JOURNAL_FILE
    if path.exists():
        archive = ROOT / "journals" / (dt.datetime.now().strftime("%Y%m%dT%H%M%S") + ".yaml")
        archive.parent.mkdir(exist_ok=True)
        shutil.move(str(path), str(archive))
        print(f"archived {JOURNAL_FILE} to {archive.relative_to(ROOT)}")
    gates = [line.rstrip() for line in read_goal_file() if line.startswith("## Gate: ")]
    for heading in gates:
        remove_section(heading)
    print(f"removed {len(gates)} open gate(s) from {GOAL_FILE}")
    return 0
```

Replace the line `COMMANDS = {"run": cmd_run}` in `janus.py` with:

```python
COMMANDS = {"run": cmd_run, "status": cmd_status, "reset": cmd_reset}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `72 passed`

- [ ] **Step 5: Check the engine file against the global constraints**

Run:

```bash
wc -l janus.py
python3 -c "import ast; ast.parse(open('janus.py').read(), feature_version=(3, 9)); print('ast 3.9 ok')"
grep -n -i 'branch\|pull request\|teamcity\|bitbucket\|angular' janus.py
grep -n '^import\|^from' janus.py
```

Expected: `509 janus.py` (the spec target is under 500; nine lines over is accepted for live transcript streaming and replay-aware `log`, nothing more); `ast 3.9 ok`; the domain-word grep prints nothing (§12.6); the import grep lists only `argparse, datetime, json, os, re, runpy, shutil, subprocess, sys, tempfile, traceback, pathlib, typing` and `yaml` (§12.8).

- [ ] **Step 6: Commit**

```bash
git add janus.py tests/test_status_reset.py
git commit -m "feat(janus): status and reset commands" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Smoke run of a tiny flow with the fake codex

Spec §11 slice 1 ("Verified by the test suite and by running a tiny flow with a fake `codex`"), §12.1 to §12.5 exercised by hand. No new tests; nothing here is committed to the repository. Work in a scratch folder outside the repository, for example `/tmp/janus-smoke`.

**Files:**
- Create (scratch, outside the repo): `/tmp/janus-smoke/bin/codex`, `/tmp/janus-smoke/script.json`, `/tmp/janus-smoke/goal/{JANUS.md,flow.py,.gitignore,prompts/_preamble.md,prompts/plan.md,prompts/implement.md,prompts/review.md}`, a bare repository `/tmp/janus-smoke/origin.git`.

**Interfaces:**
- Consumes: the finished `janus.py`; the fake codex script text `FAKE_CODEX` from `tests/conftest.py`.

- [ ] **Step 1: Build the scratch goal folder with a local bare remote**

```bash
S=/tmp/janus-smoke; rm -rf $S; mkdir -p $S/bin $S/goal/prompts
# the fake codex is the FAKE_CODEX text of tests/conftest.py written to a file
python3 - <<'EOF'
import re
src = open("tests/conftest.py").read()
body = re.search(r"FAKE_CODEX = '''(.*?)'''", src, re.S).group(1).replace("\\\\n", "\\n")
open("/tmp/janus-smoke/bin/codex", "w").write(body)
EOF
chmod +x $S/bin/codex
cat > $S/script.json <<'EOF'
[{"output": {"tasks": ["ui-kit", "shell"], "summary": "two upgrades"}},
 {"output": {"done": false, "note": "tests red"}},
 {"output": {"done": true, "note": "green"}},
 {"output": {"done": true, "note": "green"}},
 {"output": {"passed": true, "reasons": []}},
 {"output": {"done": true, "note": "green again"}}]
EOF
# the fake plays the steps in call order: plan, ui-kit x2, shell, review; the sixth entry serves Step 3
cd $S/goal
git init -q -b main . && git config user.email you@example.com && git config user.name You
git init -q --bare -b main $S/origin.git && git remote add origin $S/origin.git
ln -s "$(git -C /home/race-day/janus rev-parse --show-toplevel)/janus.py" janus.py
printf '# Goal\nUpgrade the widget from 15 to 16.\n' > JANUS.md
printf '*/\n!prompts/\n!journals/\n' > .gitignore
printf 'Work on {{goal}}. Attempt {{attempt}}.\n' > prompts/_preamble.md
printf -- '---\noutput:\n  tasks: list[str]\n  summary: str\n---\nPropose the tasks.\n' > prompts/plan.md
printf -- '---\noutput:\n  done: bool\n  note: str\n---\nImplement {{task}}. Previous: {{previous}}\n' > prompts/implement.md
printf 'Review everything.\n' > prompts/review.md
cat > flow.py <<'EOF'
from janus import codex, ralph, human_gate, ai_gate, step, log, Exhausted

plan = codex("prompts/plan.md")
human_gate("Approve this plan?", key="approve-plan", show=plan)
for task in plan["tasks"]:
    result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=3, key=f"implement/{task}", task=task)
    step(f"push/{task}", lambda: f"pushed {task}")
    log(f"{task}: {result['note']}")
ai_gate("prompts/review.md", key="review")
EOF
git add -A && git commit -q -m init && git push -q -u origin main
export PATH=$S/bin:$PATH FAKE_CODEX_SCRIPT=$S/script.json FAKE_CODEX_CALLS=$S/calls.jsonl
```

- [ ] **Step 2: Run to the gate, inspect, answer, run to the end, run again**

```bash
python3 janus.py run; echo "exit=$?"
python3 janus.py status
cat JANUS.md
sed -i 's/^answer:$/answer: yes/' JANUS.md
python3 janus.py run; echo "exit=$?"
python3 janus.py run; echo "exit=$?"
echo "codex calls: $(wc -l < $S/calls.jsonl)"
python3 janus.py status
git log --format=%s | head -20
git -C $S/origin.git log -1 --format=%s main
cat JANUS.md journal.yaml
```

Expected, in order:
- First run prints `gate open: approve-plan. Answer it in JANUS.md and run again.` and `exit=2`. `status` shows `open gate: approve-plan`, the two steps `plan#1: codex done (attempt 1)` and `approve-plan: gate open (attempt -)`, and `next: answer 'approve-plan' in JANUS.md, then python janus.py run`. `JANUS.md` ends with the gate section: question, the plan as four-space-indented YAML (`tasks:`, `- ui-kit`, `- shell`, `summary: two upgrades`), `answer:`.
- Second run prints `ui-kit: green`, `shell: green`, `flow ended`, `exit=0`. Third run prints the same (log lines are not journaled) with `exit=0`, and `codex calls: 5` (plan, two implement iterations for ui-kit, one for shell, review) shows that the replay called nothing again.
- `status` now shows `no open gate`, the last five steps ending with `review: ai_gate done (attempt 1)` and `next: python janus.py run`.
- `git log` shows one commit per status change, newest first: `janus: review done`, `janus: review running`, `janus: push/shell done`, ..., `janus: approve-plan answered`, `janus: approve-plan open`, `janus: plan#1 done`, `janus: plan#1 running`, `init`; the bare origin's `main` head is `janus: review done`.
- `JANUS.md` has `## Decisions` with `- <today> approve-plan: Approve this plan?` and `  answer: yes`, then `## Progress` with the dated log lines (twice, once per completed run). `journal.yaml` lists `plan#1`, `approve-plan` (answered), `implement/ui-kit/1` (result `done: false`), `implement/ui-kit/2`, `push/ui-kit` (result `pushed ui-kit`), `implement/shell/1`, `push/shell`, `review` (result `passed: true`, `reasons: []`).

- [ ] **Step 3: Crash resume, then reset**

```bash
python3 - <<'EOF'
import yaml
j = yaml.safe_load(open("journal.yaml"))
j["steps"]["implement/shell/1"]["status"] = "running"   # as if the run had been killed here
open("journal.yaml", "w").write(yaml.safe_dump(j, sort_keys=False))
EOF
python3 janus.py run; echo "exit=$?"
echo "codex calls: $(wc -l < $S/calls.jsonl)"
grep -A3 'implement/shell/1:' journal.yaml
python3 janus.py reset
ls journals; grep -c 'Gate:' JANUS.md || true
```

Expected: `exit=0`; `codex calls: 6` (exactly one more call, for the interrupted step; the sixth scripted output `green again` answers it); the entry `implement/shell/1` now has `attempt: 2` and `status: done`; `reset` prints `archived journal.yaml to journals/<timestamp>.yaml` and `removed 0 open gate(s) from JANUS.md`; `journals/` holds one file and `JANUS.md` has no gate section.

- [ ] **Step 4: Clean up**

```bash
rm -rf /tmp/janus-smoke
```

Nothing to commit; the repository is unchanged by this task.

---

## Self-review notes

- Spec coverage for slice 1: §1 (Tasks 1, 10 step 5), §3 files (Tasks 1, 7, 10), §4 primitives (`goal`, `log` Task 1; `codex` Task 5; `context`, `ralph`, `ai_gate` Task 6; `human_gate`, `decision` Task 7; `step` Task 4), §4 keys (Task 4, 6, 7), §4 rendering (Tasks 2, 5, 6), §4 output schema (Tasks 3, 5, 6), §5 journal and replay (Tasks 1, 4, 6, 9), §5 gates (Task 7), §5 exit codes (Tasks 7, 9), §5 git (Task 8), §6 CLI (Tasks 9, 10), §7 invocation (Task 5), §8 errors (Tasks 4, 5, 9), §9 all eleven test areas (coverage map in the file structure section), §11 slice 1 smoke run (Task 11), §12.1 to §12.6 and §12.8 (Tasks 4, 5, 6, 7, 8, 9, 10, 11); §12.7 and §10 belong to slice 2.
- Names used across tasks are consistent: `begin(root)`, `save_journal(key, status)`, `run_step(key, kind, execute)`, `make_key(prompt, key)`, `run_prompt(prompt, cwd, attempt, variables, previous=None, extra_output=None)`, `run_codex(cwd, prompt, schema)`, `gate(question, key, show, options)`, `write_gate(key, question, show, note=None)`, `read_answer(key)`, `git_commit(message)`, `cmd_run/cmd_status/cmd_reset`, `COMMANDS`, `main(argv)`. Test helpers: `read_journal(root)`, `write_prompt(root, stem, body, output=None)`, `git(cwd, *args)`, `init_repo`, `commit_all`, `make_bare`; fixtures `root`, `fake_codex` (`.script(steps)`, `.calls()`), `repo`, `repo_with_upstream`.
- The code blocks of Tasks 1 to 10 were assembled verbatim, in order, into a scratch directory outside the repository and run with `uv run pytest -q` after each task's red step and green step. The red and green summaries stated in the plan are the ones observed: Task 1: red `ImportError while loading conftest, no tests collected`, green `7 passed`; Task 2: red `6 failed, 7 passed`, green `13 passed`; Task 3: red `14 failed, 13 passed`, green `27 passed`; Task 4: red `8 failed, 27 passed`, green `35 passed`; Task 5: red `10 failed, 35 passed`, green `45 passed`; Task 6: red `7 failed, 45 passed`, green `52 passed`; Task 7: red `6 failed, 52 passed`, green `58 passed`; Task 8: red `4 failed, 58 passed`, green `62 passed`; Task 9: red `6 failed, 62 passed`, green `68 passed`; Task 10: red `4 failed, 68 passed`, green `72 passed`. The assembled `janus.py` is byte-identical to the file the smoke run of Task 11 used; `wc -l janus.py` is 509; `python3 -c "import ast; ast.parse(open('janus.py').read(), feature_version=(3, 9))"` passes for `janus.py` and every test module; no line of any file exceeds 120 characters; `grep -i 'branch\|pull request\|teamcity\|bitbucket\|angular' janus.py` prints nothing. Task 11 was performed against the assembled engine with the outputs stated there (exit codes 2, 0, 0; five then six fake codex calls; the commit list; the origin head).
- Placeholder scan: no "TBD", "TODO", "similar to", or "add error handling" remains; every code step shows the code.
- The strict `--output-schema` form was confirmed against the real codex-cli 0.146 on 2026-09-22 (see Verified facts). After that check, `run_codex` was changed to stream stderr live and read the prompt from a temporary file; then `log()` was made replay-aware after a real-Codex smoke run showed Progress lines repeating on every rerun; the scratch suite gives `72 passed` and the file is 509 lines.
