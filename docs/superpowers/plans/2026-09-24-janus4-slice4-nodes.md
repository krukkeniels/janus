# Janus 4.1 Slice 4: Node Flows in the Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a flow a state machine of small Python functions: `@node(next=...)` and `END` register the nodes, the engine walks them, prefixes every key with the visit (`implement#3/plan#1`), records the map (`graph`) and the path taken in `journal.yaml` and checks a rerun against that path; `python janus.py graph` prints the map as mermaid, `status` names the current visit, `python janus.py init <folder>` writes a goal folder that already runs, and `janus-4.0-spec.md` becomes v0.3.

**Architecture:** Everything is an addition to `janus.py`, in the order a run meets it. A `NODES` registry filled by the `node` decorator while `flow.py` loads (Task 1); a `NODE` global that `make_key` prepends to every key while the runner is inside a visit, with `COUNTERS` emptied per visit so the default counters restart (Task 2); a `run_nodes()` walker that `cmd_run` calls after `flow.py` loaded when `NODES` is not empty, inside the same `try` so gates, `Exhausted` and other exceptions are handled by the existing handlers, with a journal write added to the `finally` so the path's last entry reaches disk (Task 3); `to_mermaid` and a `graph` command that loads `flow.py` with `DRY = True` so `claim()` refuses to run a step (Task 4); one `at:` line in `status` (Task 5); `init` with the starter files as string constants (Task 6); the spec edits (Task 7). Script flows never set `NODE`, never get a `path`, and the 128 existing tests run unchanged.

**Tech Stack:** Python 3.9+ (f-strings are fine in the engine; `from __future__ import annotations` stays), PyYAML 6, pytest via `uv` (`/snap/bin/uv`), git 2.43.0. No new dependency: `types.SimpleNamespace` is standard library.

**Spec:** `docs/superpowers/specs/2026-09-24-janus-nodes-and-ui-design.md`, sections 1 and 2 (2.1 to 2.9). Sections 3 (the example as nodes) and 4 (the page) are slices 5 and 6 and are **not** planned here, but they consume what this slice produces: section 3.2's node table needs labelled edges, `END` inside a dict and the `<node>#<visit>/` keys; section 4.2 consumes `to_mermaid(graph, classes, counts)` and the journal's `graph` and `path` fields exactly as Tasks 3 and 4 shape them. The engine spec `janus-4.0-spec.md` v0.2 (sections 4, 5, 6, 9, 13) is edited to v0.3 in Task 7. Executors read both documents.

**Where the work happens:** a git worktree at `.worktrees/slice4-nodes` on branch `slice4-nodes`, created from the repository root with `git worktree add .worktrees/slice4-nodes -b slice4-nodes` (`.worktrees/` is already in `.git/info/exclude`). **Every path in this plan is relative to that worktree root**; `uv run pytest -q` is run from it.

## Global Constraints

Copied from the design spec where it binds this slice; every task's requirements include this section.

- Design §2.1: "`NODES: Dict[str, Node]` in the engine; `Node = (name, fn, edges)` where `edges: Dict[str, Optional[str]]` is the normalised form: a single edge becomes `{"": target}`, `END` becomes `None`."
- Design §2.1: "Registration errors are `JanusError` at decoration time: a duplicate node name, `next` of a type not listed above, a dict with a non-string label, an empty dict. Validation errors are `JanusError` before the first visit: a target that names no node."
- Design §2.1: "The state `s` is a `types.SimpleNamespace()` created fresh for each run. The engine never persists it." "A node function may call every primitive. Gates raise `SystemExit(2)` from inside a node as they do today; the runner lets it through."
- Design §2.2: "While node `X` is in its `n`-th visit the engine sets `NODE = "X#n"` and empties `COUNTERS`. `make_key` returns `f"{NODE}/{key}"` where `key` is the explicit key or `<stem>#<count within this visit>`." "The engine sets `NODE = None` outside the runner so script flows (2.3) key exactly as before. `step` goes through `make_key` so it gets the prefix too."
- Design §2.3: "`cmd_run` executes `flow.py` as today. If, after that, `NODES` is empty the run is over." "`cmd_run`'s `finally` writes the journal (`write_atomic`, then `git_commit("janus: run ended")`) ... which happens only when `journal.yaml` already exists or the run recorded a path, so a script flow that ran no step still leaves no journal behind." "A finished visit is checked, not re-recorded ... An entry without `finished` is the visit that was interrupted (crash, gate, failure) and is resumed in place: its `visit` count is trusted, its `started` is kept."
- Design §2.3, the two path errors, verbatim: `flow changed: visit {index + 1} was {entry['node']}, now {name}` and `flow changed: {NODE} went to {entry['next']!r} before, now {label!r}`.
- Design §2.4, the two return-value errors, verbatim: `node X declares one edge but returned 'y'` and `node X returned 'y'; declared: a, b, c`. "The error is raised after the node's steps ran and were journaled."
- Design §2.5: `graph()` returns `{"start": name, "nodes": [{"name": n, "next": {label: target_or_null}}, ...]}` in registration order and "is stored under `JOURNAL["graph"]` at the start of every node run (overwriting)". `to_mermaid`: "One line per edge, in node order then label order as declared. An unlabelled edge (`""`) prints `a --> b`. With `counts` ... a taken edge prints `-- failed (2) -->` or, unlabelled, `-- (2) -->`. `END([END])` is emitted once when any edge targets END ... With `classes` ... each mapped node gets `class name cls` and the four `classDef` lines (`visited`, `running`, `open`, `failed`) are emitted with fill and stroke only. Without `classes` no `classDef` lines are printed."
- Design §2.6: "`graph` executes `flow.py` with `DRY = True`. `claim()` raises `JanusError("flow.py runs steps at load time; only node flows have a graph")` when `DRY` is set ... If `NODES` is empty after loading, the same message is printed and the exit code is 1. `status` gains one line when the journal has a path: `at: review#2 (visit 2 of review)`."
- Design §2.7: `init` "creates `<folder>` (a `JanusError` when it exists and is not empty)" and writes `janus.py` (a copy of `Path(__file__)`), `janus_ui.py` ("a copy, when it sits next to the running `janus.py`; silently skipped otherwise"), `JANUS.md`, `flow.py` (the starter flow, verbatim from the spec), `prompts/_preamble.md`, `prompts/draft.md`, `.gitignore` (`*/`, `!prompts/`, `!journals/`). "`init` ends by printing the six steps ... It does not run `git init`."
- Design §2.9: "The existing suite must stay green unchanged, which is the proof that script flows are untouched." No existing test file is edited by this plan.
- Engine spec §12.6 and §12.8: `janus.py` stays one file with only the standard library and PyYAML, and contains no reference to Git branches, pull requests, TeamCity, Bitbucket or Angular. The starter prompts in Task 6 talk about "the goal" and "commits", nothing domain-specific.
- Size: the controller's target is "under about 700 lines" for `janus.py`. This plan lands at **776 lines** (562 + 214); see *Design decisions* for why and what could be cut. Prefer small additions over restructuring: no existing function is reshaped except `cmd_run` (its `runpy` call moves into `load_flow()` so `graph` can share it) and `save_journal` (its write moves into `write_journal()` so the `finally` can share it).
- Tooling: `uv run pytest -q` from the worktree root is the verification command of every task. The suite is **128 passed** before this plan and **160 passed** after it (128 → 138 after Task 1 → 140 after Task 2 → 151 after Task 3 → 156 after Task 4 → 157 after Task 5 → 160 after Task 6; Task 7 adds none).
- Commits: `type(scope): subject`, scopes `engine` (janus.py and its tests) and `spec` (the engine spec). Two-`-m` form so the trailer has a blank line before it: `git commit -m "type(scope): subject" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.
- No line over 120 characters in `janus.py`, `tests/test_nodes.py` or `tests/test_init.py` (checked in *Self-review notes*).

## Verified facts about this machine

Checked on 2026-09-24 while writing this plan; the numbers are observed, not assumed.

- The repository `/home/race-day/janus` is on `main` at `67f6917` (`docs(spec): add init, a starter goal folder ...`), clean. `uv run pytest -q` gives **128 passed in 12.70s**. `janus.py` is 562 lines. `git worktree list` shows only the main checkout; `.worktrees/` is excluded through `.git/info/exclude` and `.worktrees/slice4-nodes` does not exist yet.
- `python3` is 3.12.3. The whole engine suite of this plan (`tests/`, 131 tests without the example's) also passes under Python 3.9 (`uv run --python 3.9 --isolated --with pyyaml --with pytest pytest -q tests`: **131 passed**), so the nested f-string in `to_mermaid` and `types.SimpleNamespace` are within the floor.
- Engine facts this plan builds on, read from `janus.py` at `67f6917`: `begin()` (line 64) resets `ROOT, JOURNAL, CONTEXT, COUNTERS, LIVE, CURRENT, REPLAYING` and is called by every command; `make_key(prompt, key)` (line 253) returns the explicit key or `<stem>#<n>` from `COUNTERS`; `claim(key)` (line 262) is the first thing both `run_step` and `gate` do; `step(key, fn)` (line 294) passes its key straight to `run_step`; `ralph` (line 365) keys iterations `f"{key}/{n}"` under `make_key(prompt, key)`; `human_gate` uses `make_key("gate", key)` and `decision` `make_key("decision", key)`; `cmd_run` (line 479) runs `runpy.run_path` inside `try` with handlers for `SystemExit`, `Exhausted` and `Exception` and a `finally` that only commits; `cmd_status` (line 508) prints `open gate`/`no open gate` first; `main` (line 547) parses one positional `command` from `sorted(COMMANDS)` and turns `JanusError` into `janus: <message>` on stderr with exit 1.
- Test conventions, from `tests/conftest.py` and `tests/helpers.py`: the `root` fixture writes `JANUS.md` (`# Goal\nUpgrade the widget.\n`) and `prompts/` into `tmp_path` and calls `janus.begin(tmp_path)`; `fake_codex` puts a scripted `codex` on `PATH` with `.script([...])` (each step `{"output": {...}}` or `{"text": "..."}`, the last step repeats) and `.calls()` (list of `{"argv", "cwd", "prompt", "schema"}`); `read_journal(root)`; `write_prompt(root, stem, body, output=None)`. Flows are written by the tests to `root / "flow.py"` and run with `monkeypatch.chdir(root)` then `janus.main(["run"])`, as `tests/test_run.py` and `tests/test_loops.py` do.
- All code in this plan was assembled in a copy of the repository under the session scratchpad and replayed from a clean clone task by task: each task's tests were run red on the previous task's engine, the edits applied, the tests run green and the whole suite run; the final `janus.py` of the replay is byte-identical to the rehearsal's. The observed red and green outputs are quoted in the steps. The real repository was not modified.

## Design decisions fixed here (where the spec leaves room)

- **`path` is created by the runner, not by `begin()`.** Design §2.3 says both that "`JOURNAL["path"]` defaults to `[]` in `begin()` like `steps`" and that "a script flow never writes them [`graph` and `path`]". With the new journal write in `finally` (which fires whenever `journal.yaml` exists), a `begin()` default would put `path: []` into every script flow's journal. The plan therefore sets `JOURNAL.setdefault("path", [])` inside `run_nodes()`; a script journal stays byte-identical to 4.0 and `tests/test_loops.py`'s byte-for-byte replay assertion keeps passing.
- **A finished visit is not touched on replay.** Design §2.3's pseudocode does `entry.update(finished=now(), next=label)` for every visit, but the bullet below it says "A finished visit is checked, not re-recorded", and test 5 asks that a second run leaves "the path unchanged". The runner updates `finished`/`next` only when the entry has no `finished`; a finished entry is compared and left alone.
- **Visit counts are a local dict in `run_nodes()`** (`visits`), not a module global `VISITS`: nothing outside the walker reads them, and replay recomputes them from the start every run.
- **`END` is `object()`**, compared by identity; `Node` is a `Tuple[str, Callable, Dict[str, Optional[str]]]` alias used only for the `NODES` annotation.
- **Messages the spec leaves open** (all `JanusError`): bad `next` → `node next must be a name, END or a non-empty dict of label -> name or END: <repr>`, raised by `node(next)` itself, which runs when the decorator line is evaluated, that is at decoration time; duplicate → `duplicate node name: <name>`; unknown target → `node <name> goes to '<target>', which is not a node`; `init` without a folder → `init needs a folder: python janus.py init <folder>`; `init` into a non-empty folder → `<folder> exists and is not empty`. A dict with a non-string *value* (`{"go": 3}`) is treated as "`next` of a type not listed" and gets the bad-`next` message.
- **`graph` goes through `begin()`** like every command, so it resets the registry and `DRY`, and it refuses a corrupt `journal.yaml` with the same message `status` gives (finding 6 behaviour); it does not need the journal otherwise. `DRY` is reset to `False` by `begin()`, so `run` after `graph` in one process (the tests do this) runs steps again.
- **`graph` on a file that registers no node and runs no step** (for example an empty `flow.py`) raises the same `DRY_MESSAGE`, as §2.6 asks, through `JanusError` so `main` prints `janus: flow.py runs steps at load time; only node flows have a graph` and returns 1 in both cases.
- **`to_mermaid` returns no trailing newline**; `cmd_graph` prints it, which adds one. `class` lines come before the four `classDef` lines; mermaid accepts either order. The four styles are `visited fill:#1b5e20,stroke:#66bb6a`, `running fill:#0d47a1,stroke:#42a5f5`, `open fill:#e65100,stroke:#ffb74d`, `failed fill:#b71c1c,stroke:#ef5350` (dark fills for the dark page of slice 6, which may override them in CSS).
- **The `at:` line is the first line of `status`** (before `open gate`/`no open gate`), taken from the last path entry whether or not it is finished.
- **`init` takes its folder from a second, optional positional** (`parser.add_argument("folder", nargs="?")`); `main` calls `cmd_init(args.folder)` for `init` and the other commands as before. `init` does not call `begin()` (it needs no journal and no goal folder of its own). `init` into an existing empty folder is allowed.
- **The starter prompts** are short: `_preamble.md` is `{{goal}}` and one "Rules:" paragraph with the three rules of §2.7; `draft.md` declares `done`, `summary`, `blockers`, asks for the goal's work in the current folder and renders `{{previous}}` and `{{findings}}` on their own lines. The starter `flow.py` is the spec's text verbatim.
- **Size.** The engine lands at 776 lines: nodes and runner about 90, mermaid and `graph` about 40, `init` with its five templates about 75, the rest small edits. The templates cannot be shortened much (the starter flow is fixed by the spec and the draft prompt must carry two placeholders and three fields). If the controller wants the 700 target met, the candidates are moving `to_mermaid`'s `CLASS_STYLES` into the page (slice 6 owns the colours anyway) and shortening docstrings; this plan does not do it.
- **Loop test and the `flow changed` tests** use `step()` and `human_gate()` where Codex adds nothing, and the fake `codex` only where a label must come from a result (spec 2.9 item 3), a prompt with `output: {go: str}` supplying it.

## File structure

| Path | Responsibility | Task |
|---|---|---|
| `janus.py` | `END`, `Node`, `NODES`, `node()`, `graph()`, `validate_nodes()` | 1 |
| `janus.py` | `NODE`, `make_key` prefix, `step` through `make_key` | 2 |
| `janus.py` | `write_journal()`, `check_label()`, `run_nodes()`, `load_flow()`, `cmd_run` runner call and `finally` write | 3 |
| `janus.py` | `DRY`, `DRY_MESSAGE`, `claim` check, `CLASS_STYLES`, `to_mermaid()`, `cmd_graph()`, `COMMANDS` | 4 |
| `janus.py` | `cmd_status` `at:` line | 5 |
| `janus.py` | `STARTER_FLOW`, `STARTER_PREAMBLE`, `STARTER_DRAFT`, `STARTER_FILES`, `INIT_STEPS`, `cmd_init()`, `main` folder argument | 6 |
| `tests/test_nodes.py` | New. Registration (10 tests, Task 1), keys (2, Task 2), runner (11, Task 3), graph/mermaid (5, Task 4), status (1, Task 5): 29 tests. | 1–5 |
| `tests/test_init.py` | New. 3 tests. | 6 |
| `janus-4.0-spec.md` | v0.3: header, §4, §5, §6, §9, §13. | 7 |

Unchanged: `tests/conftest.py`, `tests/helpers.py`, every existing test file, `examples/angular-upgrade/` (slice 5), `pyproject.toml`.

Names used across tasks. Engine globals: `END`, `Node`, `NODES: Dict[str, Node]`, `NODE: Optional[str]`, `DRY: bool`, `DRY_MESSAGE: str`, `CLASS_STYLES: Dict[str, str]`. Engine functions: `node(next) -> decorator`, `graph() -> dict`, `validate_nodes() -> None`, `check_label(name, edges, returned) -> str`, `run_nodes() -> None`, `write_journal() -> None`, `load_flow() -> None`, `to_mermaid(graph, classes=None, counts=None) -> str`, `cmd_graph() -> int`, `cmd_init(folder: Optional[str]) -> int`. Journal fields: `graph` (`{"start": str, "nodes": [{"name": str, "next": {str: Optional[str]}}]}`), `path` (list of `{"node": str, "visit": int, "started": str}` plus `"finished": str, "next": str` once the visit returned). Test helpers in `tests/test_nodes.py`: `run(root, monkeypatch, *argv)`, `answer(root, text)`; flow constants `WALK`, `LABELS`, `LOOP`, `GATE`, `MERMAID_FLOW`, `MERMAID`. In `tests/test_init.py`: `answer(root, text)`, constants `FILES`, `MERMAID`.

---

### Task 1: `node`, `END`, the registry and `graph()`

Design §2.1 (the primitive, normalisation, registration and validation errors) and §2.5 (`graph()`'s shape). No runner yet: a node flow loaded by `run` after this task registers its nodes and does nothing, which is what Task 3 then builds on.

**Files:**
- Modify: `janus.py` (imports, module globals, `begin()`, a new `# --- nodes ---` section before `# --- git ---`)
- Create: `tests/test_nodes.py`

**Interfaces:**
- Consumes: `JanusError`, `begin()`.
- Produces: `END` (sentinel object), `Node` type alias, `NODES: Dict[str, Node]` reset by `begin()`, `node(next) -> Callable[[fn], fn]`, `graph() -> {"start": Optional[str], "nodes": [...]}`, `validate_nodes() -> None`. Task 3's runner reads `NODES[name] == (name, fn, edges)` and calls `validate_nodes()` then `graph()`; Task 4's `cmd_graph` does the same.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_nodes.py`:

```python
"""Node flows (design 2026-09-24 section 2): registration, keys inside a node, the runner, graph and mermaid."""
import pytest

import janus
from helpers import read_journal, write_prompt


def run(root, monkeypatch, *argv):
    monkeypatch.chdir(root)
    return janus.main(list(argv) or ["run"])


def answer(root, text):
    path = root / "JANUS.md"
    path.write_text(path.read_text(encoding="utf-8").replace("\nanswer:\n", f"\nanswer: {text}\n"), encoding="utf-8")


# --- 2.1 registration --------------------------------------------------------

def test_nodes_register_in_order_with_normalised_edges(root):
    @janus.node(next="b")
    def a(s):
        pass

    @janus.node(next={"left": "c", "right": "a", "stop": janus.END})
    def b(s):
        pass

    @janus.node(next=janus.END)
    def c(s):
        pass

    assert janus.graph() == {"start": "a", "nodes": [
        {"name": "a", "next": {"": "b"}},
        {"name": "b", "next": {"left": "c", "right": "a", "stop": None}},
        {"name": "c", "next": {"": None}},
    ]}
    assert janus.NODES["b"][1] is b
    janus.validate_nodes()


def test_duplicate_node_name_raises_at_decoration(root):
    @janus.node(next=janus.END)
    def a(s):
        pass

    with pytest.raises(janus.JanusError, match="duplicate node name: a"):
        @janus.node(next=janus.END)
        def a(s):  # noqa: F811
            pass


@pytest.mark.parametrize("bad", [3, None, {}, {1: "a"}, {"go": 3}, ["a"]])
def test_bad_next_raises_at_decoration(root, bad):
    with pytest.raises(janus.JanusError, match="node next must be a name, END or a non-empty dict"):
        janus.node(next=bad)
    assert janus.NODES == {}


def test_unknown_target_fails_validation_before_any_visit(root):
    @janus.node(next="nowhere")
    def a(s):
        pass

    with pytest.raises(janus.JanusError, match="node a goes to 'nowhere', which is not a node"):
        janus.validate_nodes()


def test_begin_empties_the_node_registry(root):
    @janus.node(next=janus.END)
    def a(s):
        pass

    janus.begin(root)
    assert janus.NODES == {} and janus.graph() == {"start": None, "nodes": []}
```

The `run` and `answer` helpers are unused until Task 3; they sit at the top so every later task appends below them.

- [ ] **Step 2: Run the tests to see them fail**

Run: `uv run pytest -q tests/test_nodes.py`
Expected: `10 failed` with `AttributeError: module 'janus' has no attribute 'node'` in every test (the parametrised test counts six).

- [ ] **Step 3: Add the import, the sentinel, the registry and its reset**

In `janus.py`, replace

```python
import tempfile
import traceback
```

with

```python
import tempfile
import traceback
import types
```

Replace

```python
# Engine state for one run; begin() resets all of it.
ROOT = Path(".")
JOURNAL: Dict[str, Any] = {"flow": FLOW_FILE, "started": None, "steps": {}}
CONTEXT: Dict[str, Any] = {}
COUNTERS: Dict[str, int] = {}
LIVE: set = set()
CURRENT: Optional[str] = None
REPLAYING = False  # True while the last step came from the journal; log() then skips Progress
```

with

```python
END = object()  # sentinel for node(next=END) and {"label": END}: the flow ends there
Node = Tuple[str, Callable[[Any], Any], Dict[str, Optional[str]]]  # (name, fn, edges); an END target is None

# Engine state for one run; begin() resets all of it.
ROOT = Path(".")
JOURNAL: Dict[str, Any] = {"flow": FLOW_FILE, "started": None, "steps": {}}
CONTEXT: Dict[str, Any] = {}
COUNTERS: Dict[str, int] = {}
LIVE: set = set()
CURRENT: Optional[str] = None
REPLAYING = False  # True while the last step came from the journal; log() then skips Progress
NODES: Dict[str, Node] = {}  # node flows register here in definition order; the first one is the start
```

In `begin()`, replace

```python
    global ROOT, JOURNAL, CONTEXT, COUNTERS, LIVE, CURRENT, REPLAYING
```

with

```python
    global ROOT, JOURNAL, CONTEXT, COUNTERS, LIVE, CURRENT, REPLAYING, NODES
```

and replace

```python
    CONTEXT, COUNTERS, LIVE, CURRENT = {}, {}, set(), None
    REPLAYING = bool(JOURNAL["steps"])
```

with

```python
    CONTEXT, COUNTERS, LIVE, CURRENT, NODES = {}, {}, set(), None, {}
    REPLAYING = bool(JOURNAL["steps"])
```

- [ ] **Step 4: Add the nodes section**

In `janus.py`, replace the section marker line

```python
# --- git -------------------------------------------------------------------
```

with

```python
# --- nodes -----------------------------------------------------------------

def node(next: Any) -> Callable[[Callable[[Any], Any]], Callable[[Any], Any]]:
    """Register the decorated function as a node named after it. ``next`` is a node name (one edge,
    the function returns None), END, or {label: name or END} (the function returns a label)."""
    if next is END or isinstance(next, str):
        edges: Dict[str, Optional[str]] = {"": None if next is END else next}
    elif (isinstance(next, dict) and next and all(isinstance(k, str) for k in next)
          and all(v is END or isinstance(v, str) for v in next.values())):
        edges = {k: (None if v is END else v) for k, v in next.items()}
    else:
        raise JanusError(f"node next must be a name, END or a non-empty dict of label -> name or END: {next!r}")

    def register(fn: Callable[[Any], Any]) -> Callable[[Any], Any]:
        if fn.__name__ in NODES:
            raise JanusError(f"duplicate node name: {fn.__name__}")
        NODES[fn.__name__] = (fn.__name__, fn, edges)
        return fn
    return register


def graph() -> Dict[str, Any]:
    """The flow's map in registration order: {"start": name, "nodes": [{"name", "next": {label: target|None}}]}."""
    return {"start": next(iter(NODES), None), "nodes": [{"name": n, "next": dict(e)} for n, _, e in NODES.values()]}


def validate_nodes() -> None:
    for name, _, edges in NODES.values():
        for target in edges.values():
            if target is not None and target not in NODES:
                raise JanusError(f"node {name} goes to {target!r}, which is not a node")


# --- git -------------------------------------------------------------------
```

- [ ] **Step 5: Run the tests to see them pass, then the whole suite**

Run: `uv run pytest -q tests/test_nodes.py`
Expected: `10 passed`.

Run: `uv run pytest -q`
Expected: `138 passed`. `janus.py` is 600 lines.

- [ ] **Step 6: Commit**

```bash
git add janus.py tests/test_nodes.py
git commit -m "feat(engine): node and END register a flow's nodes; graph() lists them" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Keys inside a node visit

Design §2.2: the `NODE` global, `make_key` prefixing every key with `<node>#<visit>/`, default counters per visit, `step` through `make_key`, `NODE = None` outside the runner. This task adds the global and the prefix; Task 3 sets `NODE` and empties `COUNTERS` per visit.

**Files:**
- Modify: `janus.py` (`NODE` global and its reset in `begin()`, `make_key`, `step`)
- Modify: `tests/test_nodes.py` (append)

**Interfaces:**
- Consumes: `COUNTERS`, `run_step`.
- Produces: `NODE: Optional[str]` (reset to `None` by `begin()`); `make_key(prompt, key)` returning `f"{NODE}/{key}"` when `NODE` is set; `step(key, fn)` keyed through `make_key(key, key)`. Task 3 sets `NODE = f"{name}#{visit}"` and `COUNTERS = {}` before calling a node function.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_nodes.py`:

```python


# --- 2.2 keys inside a node ----------------------------------------------------

def test_inside_a_node_visit_every_key_is_prefixed_with_the_visit(root, fake_codex, monkeypatch):
    write_prompt(root, "plan", "plan", output={"ok": "bool"})
    write_prompt(root, "implement", "implement", output={"done": "bool"})
    fake_codex.script([{"output": {"ok": True}}, {"output": {"done": False}}, {"output": {"done": True}}])
    monkeypatch.setattr(janus, "NODE", "implement#3")
    janus.codex("prompts/plan.md")
    janus.ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=3)
    janus.step("wait", lambda: "waited")
    with pytest.raises(SystemExit):
        janus.human_gate("Go on?")
    with pytest.raises(SystemExit):
        janus.decision("What now?", ["a", "b"], key="what-now")
    assert list(read_journal(root)["steps"]) == [
        "implement#3/plan#1", "implement#3/implement#1/1", "implement#3/implement#1/2", "implement#3/wait",
        "implement#3/gate#1", "implement#3/what-now"]
    assert "## Gate: implement#3/gate#1" in (root / "JANUS.md").read_text(encoding="utf-8")


def test_outside_the_runner_keys_are_unchanged(root):
    assert janus.NODE is None
    janus.step("push", lambda: 1)
    assert janus.make_key("prompts/plan.md", None) == "plan#1"
    assert list(read_journal(root)["steps"]) == ["push"]
```

The first test is the table of design §2.2, row by row: `codex` → `implement#3/plan#1`, `ralph` iteration 2 → `implement#3/implement#1/2`, `step("wait")` → `implement#3/wait`, `human_gate` → `implement#3/gate#1`, `decision(key="what-now")` → `implement#3/what-now`. `monkeypatch.setattr` stands in for the runner and restores `NODE` afterwards.

- [ ] **Step 2: Run the tests to see them fail**

Run: `uv run pytest -q tests/test_nodes.py`
Expected: `2 failed, 10 passed`; both new tests fail with `AttributeError: module 'janus' has no attribute 'NODE'`.

- [ ] **Step 3: Add `NODE`, the prefix in `make_key`, and route `step` through it**

In `janus.py`, replace

```python
NODES: Dict[str, Node] = {}  # node flows register here in definition order; the first one is the start
```

with

```python
NODES: Dict[str, Node] = {}  # node flows register here in definition order; the first one is the start
NODE: Optional[str] = None  # "<node>#<visit>" while the runner is inside a node; every key gets it as a prefix
```

In `begin()`, replace

```python
    global ROOT, JOURNAL, CONTEXT, COUNTERS, LIVE, CURRENT, REPLAYING, NODES
```

with

```python
    global ROOT, JOURNAL, CONTEXT, COUNTERS, LIVE, CURRENT, REPLAYING, NODES, NODE
```

and replace

```python
    CONTEXT, COUNTERS, LIVE, CURRENT, NODES = {}, {}, set(), None, {}
```

with

```python
    CONTEXT, COUNTERS, LIVE, CURRENT, NODES, NODE = {}, {}, set(), None, {}, None
```

Replace the whole `make_key`

```python
def make_key(prompt: str, key: Optional[str]) -> str:
    """Explicit key, or ``<stem>#<n>`` counting calls with that prompt stem in this run."""
    if key is not None:
        return key
    stem = Path(prompt).stem
    COUNTERS[stem] = COUNTERS.get(stem, 0) + 1
    return f"{stem}#{COUNTERS[stem]}"
```

with

```python
def make_key(prompt: str, key: Optional[str]) -> str:
    """Explicit key, or ``<stem>#<n>`` counting calls with that prompt stem in this run (in this node visit,
    inside a node flow); inside a node the key is prefixed with ``<node>#<visit>/``."""
    if key is None:
        stem = Path(prompt).stem
        COUNTERS[stem] = COUNTERS.get(stem, 0) + 1
        key = f"{stem}#{COUNTERS[stem]}"
    return key if NODE is None else f"{NODE}/{key}"
```

Replace

```python
def step(key: str, fn: Callable[[], Any]) -> Any:
    return run_step(key, "step", lambda attempt: fn())
```

with

```python
def step(key: str, fn: Callable[[], Any]) -> Any:
    return run_step(make_key(key, key), "step", lambda attempt: fn())
```

(`make_key` ignores its first argument when the key is explicit; passing the key twice keeps the signature unchanged.)

- [ ] **Step 4: Run the tests to see them pass, then the whole suite**

Run: `uv run pytest -q tests/test_nodes.py`
Expected: `12 passed`.

Run: `uv run pytest -q`
Expected: `140 passed`. The 128 script-flow tests are untouched because `NODE` is `None` outside the runner.

- [ ] **Step 5: Commit**

```bash
git add janus.py tests/test_nodes.py
git commit -m "feat(engine): prefix every key with the node visit" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The runner: path recording, replay check, return values, journal write in `finally`

Design §2.3 (the walk, the path entries, the two `flow changed` errors, the `finally` write), §2.4 (return values), §2.5 (`JOURNAL["graph"]` at the start of every node run), §2.9 tests 2 to 8 plus the `run` half of test 1.

**Files:**
- Modify: `janus.py` (`write_journal()` split out of `save_journal`, `check_label()` and `run_nodes()` in the nodes section, `load_flow()` split out of `cmd_run`, the runner call and the `finally` write in `cmd_run`)
- Modify: `tests/test_nodes.py` (append)

**Interfaces:**
- Consumes: `NODES`, `NODE`, `COUNTERS`, `graph()`, `validate_nodes()`, `now()`, `write_atomic`, `git_commit`.
- Produces: `write_journal() -> None` (the atomic dump of `JOURNAL`, no commit); `check_label(name, edges, returned) -> str`; `run_nodes() -> None`; `load_flow() -> None` (the `sys.modules`/`sys.path` setup and `runpy.run_path`, shared with Task 4's `cmd_graph`); journal fields `graph` and `path` as described under *File structure*. Task 5 reads `JOURNAL["path"][-1]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_nodes.py`:

```python


# --- 2.3 and 2.4 the runner ---------------------------------------------------

WALK = """\
from janus import node, END, codex

@node(next="b")
def a(s):
    s.plan = codex("prompts/plan.md")

@node(next=END)
def b(s):
    codex("prompts/plan.md", tasks=s.plan["tasks"])
"""

LABELS = """\
from janus import node, END, codex

@node(next={"left": "l", "right": "r"})
def a(s):
    return codex("prompts/plan.md")["go"]

@node(next=END)
def l(s):
    pass

@node(next=END)
def r(s):
    pass
"""

LOOP = """\
from janus import node, END, codex

@node(next={"again": "a", "stop": END})
def a(s):
    s.n = getattr(s, "n", 0) + 1
    codex("prompts/plan.md")
    return "again" if s.n < 3 else "stop"
"""

GATE = """\
from janus import node, END, step, human_gate

@node(next="b")
def a(s):
    s.work = step("work", lambda: "built")

@node(next={"yes": "c", "no": "a"})
def b(s):
    return "yes" if human_gate("Good?", show=s.work) == "yes" else "no"

@node(next=END)
def c(s):
    step("finish", lambda: "finished")
"""


def test_walk_visits_a_then_b_and_records_two_finished_visits(root, fake_codex, monkeypatch):
    (root / "flow.py").write_text(WALK, encoding="utf-8")
    write_prompt(root, "plan", "Plan {{goal}}", output={"tasks": "list[str]"})
    fake_codex.script([{"output": {"tasks": ["x"]}}])
    assert run(root, monkeypatch) == 0
    journal = read_journal(root)
    assert list(journal["steps"]) == ["a#1/plan#1", "b#1/plan#1"]
    assert journal["graph"] == {"start": "a", "nodes": [{"name": "a", "next": {"": "b"}},
                                                        {"name": "b", "next": {"": None}}]}
    assert [(e["node"], e["visit"], e["next"]) for e in journal["path"]] == [("a", 1, ""), ("b", 1, "")]
    assert all(e["started"] and e["finished"] for e in journal["path"])
    assert len(fake_codex.calls()) == 2


def test_a_label_chosen_from_a_codex_result_is_recorded_as_the_taken_edge(root, fake_codex, monkeypatch):
    (root / "flow.py").write_text(LABELS, encoding="utf-8")
    write_prompt(root, "plan", "Which way?", output={"go": "str"})
    fake_codex.script([{"output": {"go": "right"}}])
    assert run(root, monkeypatch) == 0
    path = read_journal(root)["path"]
    assert [(e["node"], e["next"]) for e in path] == [("a", "right"), ("r", "")]


def test_an_undeclared_label_exits_1_with_the_message_and_keeps_the_step_done(root, fake_codex, monkeypatch):
    (root / "flow.py").write_text(LABELS, encoding="utf-8")
    write_prompt(root, "plan", "Which way?", output={"go": "str"})
    fake_codex.script([{"output": {"go": "up"}}])
    assert run(root, monkeypatch) == 1
    journal = read_journal(root)
    assert journal["steps"]["a#1/plan#1"]["status"] == "done"
    assert "finished" not in journal["path"][0]
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert "a#1/plan#1: JanusError: node a returned 'up'; declared: left, right\n" in text


def test_a_single_edge_node_that_returns_a_value_exits_1_with_its_message(root, monkeypatch):
    (root / "flow.py").write_text(
        "from janus import node, END\n\n@node(next=END)\ndef a(s):\n    return 'yes'\n", encoding="utf-8")
    assert run(root, monkeypatch) == 1
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert "flow: JanusError: node a declares one edge but returned 'yes'\n" in text


def test_a_loop_counts_visits_and_a_second_run_executes_nothing(root, fake_codex, monkeypatch):
    (root / "flow.py").write_text(LOOP, encoding="utf-8")
    write_prompt(root, "plan", "again", output={"ok": "bool"})
    fake_codex.script([{"output": {"ok": True}}])
    assert run(root, monkeypatch) == 0
    first = read_journal(root)
    assert list(first["steps"]) == ["a#1/plan#1", "a#2/plan#1", "a#3/plan#1"]
    assert [(e["node"], e["visit"], e["next"]) for e in first["path"]] == \
        [("a", 1, "again"), ("a", 2, "again"), ("a", 3, "stop")]
    assert run(root, monkeypatch) == 0
    assert read_journal(root) == first
    assert len(fake_codex.calls()) == 3


def test_a_gate_inside_a_node_exits_2_and_the_next_run_resumes_in_that_node(root, monkeypatch):
    (root / "flow.py").write_text(GATE, encoding="utf-8")
    assert run(root, monkeypatch) == 2
    journal = read_journal(root)
    assert list(journal["steps"]) == ["a#1/work", "b#1/gate#1"]
    assert "## Gate: b#1/gate#1" in (root / "JANUS.md").read_text(encoding="utf-8")
    assert [(e["node"], "finished" in e) for e in journal["path"]] == [("a", True), ("b", False)]
    answer(root, "no")
    assert run(root, monkeypatch) == 2  # b -> a (visit 2) -> b (visit 2) opens its gate
    journal = read_journal(root)
    assert list(journal["steps"]) == ["a#1/work", "b#1/gate#1", "a#2/work", "b#2/gate#1"]
    assert [(e["node"], e["visit"]) for e in journal["path"]] == [("a", 1), ("b", 1), ("a", 2), ("b", 2)]
    assert journal["path"][1]["next"] == "no"
    answer(root, "yes")
    assert run(root, monkeypatch) == 0
    journal = read_journal(root)
    assert list(journal["steps"])[-1] == "c#1/finish"
    assert [(e["node"], e["next"]) for e in journal["path"]][-2:] == [("b", "yes"), ("c", "")]


def test_an_interrupted_visit_has_no_finished_and_its_step_runs_again_as_attempt_2(root, monkeypatch):
    (root / "flow.py").write_text(
        "from janus import node, END, step\n"
        "import os\n\n"
        "@node(next=END)\n"
        "def a(s):\n"
        "    step('push', lambda: os.environ['PUSH_OK'] == '1' or (_ for _ in ()).throw(RuntimeError('no remote')))\n",
        encoding="utf-8")
    monkeypatch.setenv("PUSH_OK", "0")
    assert run(root, monkeypatch) == 1
    journal = read_journal(root)
    assert journal["steps"]["a#1/push"]["status"] == "failed"
    assert "finished" not in journal["path"][-1] and journal["path"][-1]["node"] == "a"
    started = journal["path"][-1]["started"]
    monkeypatch.setenv("PUSH_OK", "1")
    assert run(root, monkeypatch) == 0
    journal = read_journal(root)
    assert (journal["steps"]["a#1/push"]["status"], journal["steps"]["a#1/push"]["attempt"]) == ("done", 2)
    assert len(journal["path"]) == 1 and journal["path"][0]["started"] == started
    assert journal["path"][0]["next"] == ""


def test_a_flow_whose_second_visit_changed_node_exits_1_with_flow_changed(root, monkeypatch):
    (root / "flow.py").write_text(GATE, encoding="utf-8")
    assert run(root, monkeypatch) == 2
    (root / "flow.py").write_text(GATE.replace('@node(next="b")', '@node(next="c")'), encoding="utf-8")
    assert run(root, monkeypatch) == 1
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert "a#1/work: JanusError: flow changed: visit 2 was b, now c\n" in text


def test_a_finished_visit_that_takes_another_edge_exits_1_with_flow_changed(root, fake_codex, monkeypatch):
    (root / "flow.py").write_text(LABELS, encoding="utf-8")
    write_prompt(root, "plan", "Which way?", output={"go": "str"})
    fake_codex.script([{"output": {"go": "right"}}])
    assert run(root, monkeypatch) == 0
    (root / "flow.py").write_text(LABELS.replace('return codex("prompts/plan.md")["go"]',
                                                 'codex("prompts/plan.md"); return "left"'), encoding="utf-8")
    assert run(root, monkeypatch) == 1
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert "a#1/plan#1: JanusError: flow changed: a#1 went to 'right' before, now 'left'\n" in text


def test_an_unknown_target_fails_run_before_any_visit(root, monkeypatch):
    (root / "flow.py").write_text(
        "from janus import node\n\n@node(next='nowhere')\ndef a(s):\n    raise AssertionError('visited')\n",
        encoding="utf-8")
    assert run(root, monkeypatch) == 1
    assert not (root / "journal.yaml").exists()
    assert "flow: JanusError: node a goes to 'nowhere', which is not a node\n" in \
        (root / "JANUS.md").read_text(encoding="utf-8")


def test_a_script_flow_that_ran_no_step_leaves_no_journal(root, monkeypatch):
    (root / "flow.py").write_text("print('hello')\n", encoding="utf-8")
    assert run(root, monkeypatch) == 0
    assert not (root / "journal.yaml").exists()
```

What each test pins down: `test_walk_...` is spec test 2 plus the `graph` field; `test_a_label_...` and `test_an_undeclared_label_...` are test 3 (the step under `a` stays `done`, the path entry of `a` has no `finished`, the message reaches `## Progress` under the last claimed key); `test_a_single_edge_...` is test 4 (no step was claimed, so the Progress line says `flow:`); `test_a_loop_...` is test 5 (three visits, second run identical journal, three fake calls in total); `test_a_gate_...` is test 6 and also drives the `no` edge back to `a` for visit 2; `test_an_interrupted_...` is test 7 (the entry is resumed with its `started`, no second entry, attempt 2); the two `flow changed` tests are test 8 and the second error of §2.3; `test_an_unknown_target_...` is the `run` half of test 1; the last test pins the `finally` condition.

- [ ] **Step 2: Run the tests to see them fail**

Run: `uv run pytest -q tests/test_nodes.py`
Expected: `10 failed, 13 passed`. Without the runner a node flow registers its nodes and exits 0 with no journal: `assert 0 == 1`, `assert 0 == 2`, `FileNotFoundError: ... journal.yaml`. `test_a_script_flow_that_ran_no_step_leaves_no_journal` passes already (the old `finally` never wrote) and must keep passing.

- [ ] **Step 3: Split the journal write out of `save_journal`**

In `janus.py`, replace

```python
def save_journal(key: str, status: str) -> None:
    """Write journal.yaml atomically at every status change of ``key``, then commit (section 5, Git)."""
    write_atomic(ROOT / JOURNAL_FILE, yaml.safe_dump(JOURNAL, sort_keys=False, allow_unicode=True))
    git_commit(f"janus: {key} {status}")
```

with

```python
def write_journal() -> None:
    write_atomic(ROOT / JOURNAL_FILE, yaml.safe_dump(JOURNAL, sort_keys=False, allow_unicode=True))


def save_journal(key: str, status: str) -> None:
    """Write journal.yaml atomically at every status change of ``key``, then commit (section 5, Git)."""
    write_journal()
    git_commit(f"janus: {key} {status}")
```

- [ ] **Step 4: Add `check_label` and `run_nodes` after `validate_nodes`**

In `janus.py`, replace

```python
def validate_nodes() -> None:
    for name, _, edges in NODES.values():
        for target in edges.values():
            if target is not None and target not in NODES:
                raise JanusError(f"node {name} goes to {target!r}, which is not a node")
```

with

```python
def validate_nodes() -> None:
    for name, _, edges in NODES.values():
        for target in edges.values():
            if target is not None and target not in NODES:
                raise JanusError(f"node {name} goes to {target!r}, which is not a node")


def check_label(name: str, edges: Dict[str, Optional[str]], returned: Any) -> str:
    """The edge label a node's return value selects (design 2.4): "" for a single edge, else the label."""
    if list(edges) == [""]:
        if returned is not None:
            raise JanusError(f"node {name} declares one edge but returned {returned!r}")
        return ""
    if isinstance(returned, str) and returned in edges:
        return returned
    raise JanusError(f"node {name} returned {returned!r}; declared: {', '.join(edges)}")


def run_nodes() -> None:
    """Walk the graph from the start node, recording each visit in JOURNAL["path"] (design 2.3). A finished
    entry is checked against the replayed visit, not re-recorded; an unfinished one is resumed in place."""
    global NODE, COUNTERS
    validate_nodes()
    JOURNAL["graph"] = graph()
    path: List[Dict[str, Any]] = JOURNAL.setdefault("path", [])
    s, visits, name, index = types.SimpleNamespace(), {}, graph()["start"], 0
    while name is not None:
        visit = visits[name] = visits.get(name, 0) + 1
        entry = path[index] if index < len(path) else None
        if entry is not None and entry["node"] != name:  # finished or interrupted, either way the flow changed
            raise JanusError(f"flow changed: visit {index + 1} was {entry['node']}, now {name}")
        if entry is None:
            entry = {"node": name, "visit": visit, "started": now()}
            path.append(entry)
        NODE, COUNTERS = f"{name}#{visit}", {}
        _, fn, edges = NODES[name]
        label = check_label(name, edges, fn(s))
        if entry.get("finished"):
            if entry["next"] != label:
                raise JanusError(f"flow changed: {NODE} went to {entry['next']!r} before, now {label!r}")
        else:
            entry.update(finished=now(), next=label)
        name, index = edges[label], index + 1
    NODE = None
```

Notes for the implementer: `{returned!r}` renders a string as `'up'` and `None` as `None`, which gives the spec's exact messages. The path entry is appended in memory before the node runs; the first `save_journal` inside the node dumps it (unfinished), and the `finally` in Step 5 dumps the finished one. `NODE` is also reset by `begin()`, so a run that leaves through an exception does not leak the prefix into the next command in the same process.

- [ ] **Step 5: Split `load_flow` out of `cmd_run`, call the runner, write the journal in `finally`**

In `janus.py`, replace

```python
# --- CLI -------------------------------------------------------------------

def cmd_run() -> int:
    global REPLAYING
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
```

with

```python
# --- CLI -------------------------------------------------------------------

def load_flow() -> None:
    """Execute flow.py top to bottom: a script flow runs its steps here; a node flow registers its nodes."""
    sys.modules.setdefault("janus", sys.modules[__name__])  # `from janus import ...` must resolve to this module
    sys.path.insert(0, str(ROOT))  # so flow.py can import helper modules from the goal folder
    runpy.run_path(str(ROOT / FLOW_FILE), run_name="flow")


def cmd_run() -> int:
    global REPLAYING
    begin(Path.cwd())
    if not (ROOT / FLOW_FILE).exists():
        print(f"janus: {FLOW_FILE} not found in {ROOT}", file=sys.stderr)
        return 1
    try:
        load_flow()
        if NODES:  # a node flow: the file only registered its nodes; the runner walks them
            run_nodes()
    except SystemExit as exc:
```

and replace

```python
    finally:  # only save_journal() commits; a log() after the last status change needs this one
        git_commit("janus: run ended")
    print("flow ended")
    return 0
```

with

```python
    finally:  # the path's last entry and a log() after the last status change are not saved yet
        if (ROOT / JOURNAL_FILE).exists() or JOURNAL.get("path"):  # a script flow that ran no step leaves none
            write_journal()
        git_commit("janus: run ended")
    print("flow ended")
    return 0
```

The three `except` clauses between the two edits stay as they are: `SystemExit(2)` from a gate inside a node returns 2, `Exhausted` and every other exception (including the `JanusError`s of `validate_nodes`, `check_label` and the path check) log `{CURRENT or 'flow'}: ...` to `## Progress` and return 1, with `CURRENT` now carrying the node prefix.

- [ ] **Step 6: Run the tests to see them pass, then the whole suite**

Run: `uv run pytest -q tests/test_nodes.py`
Expected: `23 passed`.

Run: `uv run pytest -q`
Expected: `151 passed`. In particular `tests/test_loops.py` (byte-identical journal on the replay of a finished script loop) and `tests/test_run.py::test_run_as_a_script_shares_engine_state_with_the_flow` (the engine run as a subprocess) still pass with the new `finally` write. `janus.py` is 653 lines.

- [ ] **Step 7: Commit**

```bash
git add janus.py tests/test_nodes.py
git commit -m "feat(engine): walk node flows, record and check the path" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `to_mermaid` and the `graph` command with `DRY`

Design §2.5 (`to_mermaid(graph, classes=None, counts=None)`), §2.6 (`graph`, `DRY`, the load-time message), §2.9 tests 9 and 10 and the `graph` half of test 1. Slice 6's `build_state` will call `to_mermaid(graph, classes, counts)` with `classes` a `{node: "visited"|"running"|"open"|"failed"}` mapping and `counts` a `{(node, label): int}` mapping; the signature and output here are what it consumes.

**Files:**
- Modify: `janus.py` (`DRY`, `DRY_MESSAGE`, their reset in `begin()`, the check in `claim()`, `CLASS_STYLES` and `to_mermaid` in the nodes section, `cmd_graph`, `COMMANDS`)
- Modify: `tests/test_nodes.py` (append)

**Interfaces:**
- Consumes: `NODES`, `graph()`, `validate_nodes()`, `load_flow()`, `begin()`, `claim()`.
- Produces: `DRY: bool` (reset to `False` by `begin()`), `DRY_MESSAGE: str`, `CLASS_STYLES: Dict[str, str]`, `to_mermaid(graph, classes=None, counts=None) -> str` (no trailing newline), `cmd_graph() -> int`, `COMMANDS["graph"]`. Task 6's `init` test runs `graph` in the starter folder.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_nodes.py`:

```python


# --- 2.5 and 2.6 graph, mermaid and status ------------------------------------

MERMAID_FLOW = """\
from janus import node, END, codex

@node(next="approve")
def plan(s):
    codex("prompts/plan.md")

@node(next="review")
def approve(s):
    pass

@node(next={"passed": "human_review", "failed": "plan"})
def review(s):
    return "passed"

@node(next={"stop": END})
def human_review(s):
    return "stop"
"""

MERMAID = """\
flowchart LR
  plan --> approve
  approve --> review
  review -- passed --> human_review
  review -- failed --> plan
  human_review -- stop --> END
  END([END])
"""


def test_graph_command_prints_the_mermaid_of_a_node_flow(root, fake_codex, monkeypatch, capsys):
    (root / "flow.py").write_text(MERMAID_FLOW, encoding="utf-8")
    assert run(root, monkeypatch, "graph") == 0
    assert capsys.readouterr().out == MERMAID
    assert fake_codex.calls() == [] and not (root / "journal.yaml").exists()


def test_graph_command_refuses_a_script_flow_without_running_its_steps(root, fake_codex, monkeypatch, capsys):
    (root / "flow.py").write_text("from janus import codex\ncodex('prompts/plan.md')\n", encoding="utf-8")
    write_prompt(root, "plan", "Plan", output={"ok": "bool"})
    assert run(root, monkeypatch, "graph") == 1
    assert capsys.readouterr().err == "janus: flow.py runs steps at load time; only node flows have a graph\n"
    assert fake_codex.calls() == [] and not (root / "journal.yaml").exists()
    (root / "flow.py").write_text("print('no steps, no nodes')\n", encoding="utf-8")
    assert run(root, monkeypatch, "graph") == 1
    assert capsys.readouterr().err == "janus: flow.py runs steps at load time; only node flows have a graph\n"


def test_graph_command_validates_targets(root, monkeypatch, capsys):
    (root / "flow.py").write_text("from janus import node\n\n@node(next='nowhere')\ndef a(s):\n    pass\n",
                                  encoding="utf-8")
    assert run(root, monkeypatch, "graph") == 1
    assert capsys.readouterr().err == "janus: node a goes to 'nowhere', which is not a node\n"


def test_run_after_graph_runs_steps_again(root, monkeypatch):
    (root / "flow.py").write_text("from janus import node, END, step\n\n@node(next=END)\ndef a(s):\n"
                                  "    step('x', lambda: 1)\n", encoding="utf-8")
    assert run(root, monkeypatch, "graph") == 0
    assert run(root, monkeypatch) == 0
    assert read_journal(root)["steps"]["a#1/x"]["status"] == "done"


def test_to_mermaid_with_classes_and_counts(root):
    g = {"start": "a", "nodes": [{"name": "a", "next": {"": "b"}},
                                 {"name": "b", "next": {"again": "a", "stop": None}}]}
    assert janus.to_mermaid(g) == "flowchart LR\n  a --> b\n  b -- again --> a\n  b -- stop --> END\n  END([END])"
    out = janus.to_mermaid(g, classes={"a": "visited", "b": "open"}, counts={("a", ""): 2, ("b", "again"): 1})
    assert out == (
        "flowchart LR\n"
        "  a -- (2) --> b\n"
        "  b -- again (1) --> a\n"
        "  b -- stop --> END\n"
        "  END([END])\n"
        "  class a visited\n"
        "  class b open\n"
        "  classDef visited fill:#1b5e20,stroke:#66bb6a\n"
        "  classDef running fill:#0d47a1,stroke:#42a5f5\n"
        "  classDef open fill:#e65100,stroke:#ffb74d\n"
        "  classDef failed fill:#b71c1c,stroke:#ef5350")
    assert janus.to_mermaid({"start": "a", "nodes": [{"name": "a", "next": {"": "a"}}]}) == "flowchart LR\n  a --> a"
```

The `MERMAID` constant is design §2.5's example with its four edge shapes (unlabelled, labelled, labelled to END) and `END([END])` once; the second `graph` call in the refusal test covers "If `NODES` is empty after loading, the same message is printed"; `test_run_after_graph_...` pins that `begin()` clears `DRY`. The third `to_mermaid` assertion shows a graph with no END edge prints no `END([END])`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `uv run pytest -q tests/test_nodes.py`
Expected: `5 failed, 23 passed`: the four `graph` tests with `janus.py: error: argument command: invalid choice: 'graph' (choose from 'reset', 'run', 'status')` (main returns 1, so `assert 1 == 0`), `test_to_mermaid_...` with `AttributeError: module 'janus' has no attribute 'to_mermaid'`.

- [ ] **Step 3: Add `DRY`, its reset, and the check in `claim()`**

In `janus.py`, replace

```python
NODE: Optional[str] = None  # "<node>#<visit>" while the runner is inside a node; every key gets it as a prefix
```

with

```python
NODE: Optional[str] = None  # "<node>#<visit>" while the runner is inside a node; every key gets it as a prefix
DRY = False  # set by `graph`: loading flow.py must register nodes only, so claim() refuses to run a step
DRY_MESSAGE = "flow.py runs steps at load time; only node flows have a graph"
```

In `begin()`, replace

```python
    global ROOT, JOURNAL, CONTEXT, COUNTERS, LIVE, CURRENT, REPLAYING, NODES, NODE
```

with

```python
    global ROOT, JOURNAL, CONTEXT, COUNTERS, LIVE, CURRENT, REPLAYING, NODES, NODE, DRY
```

and replace

```python
    CONTEXT, COUNTERS, LIVE, CURRENT, NODES, NODE = {}, {}, set(), None, {}, None
```

with

```python
    CONTEXT, COUNTERS, LIVE, CURRENT, NODES, NODE, DRY = {}, {}, set(), None, {}, None, False
```

Replace

```python
def claim(key: str) -> None:
    global CURRENT
    if key in LIVE:
```

with

```python
def claim(key: str) -> None:
    global CURRENT
    if DRY:
        raise JanusError(DRY_MESSAGE)
    if key in LIVE:
```

`claim` is the first call of both `run_step` (codex, ralph, ai_gate, step) and `gate` (human_gate, decision), so every primitive that would journal refuses under `DRY` before touching the journal.

- [ ] **Step 4: Add `CLASS_STYLES` and `to_mermaid` before `run_nodes`**

In `janus.py`, replace

```python
def run_nodes() -> None:
```

with

```python
CLASS_STYLES = {"visited": "fill:#1b5e20,stroke:#66bb6a", "running": "fill:#0d47a1,stroke:#42a5f5",
                "open": "fill:#e65100,stroke:#ffb74d", "failed": "fill:#b71c1c,stroke:#ef5350"}


def to_mermaid(graph: Dict[str, Any], classes: Optional[Dict[str, str]] = None,
               counts: Optional[Dict[Tuple[str, str], int]] = None) -> str:
    """A graph() mapping as a mermaid flowchart (design 2.5); ``classes`` adds class lines, ``counts`` (n)."""
    lines, ends = ["flowchart LR"], False
    for n in graph["nodes"]:
        for label, target in n["next"].items():
            count = (counts or {}).get((n["name"], label))
            text = " ".join(p for p in (label, f"({count})" if count is not None else "") if p)
            lines.append(f"  {n['name']} {f'-- {text} -->' if text else '-->'} {'END' if target is None else target}")
            ends = ends or target is None
    lines += ["  END([END])"] if ends else []
    if classes:
        lines += [f"  class {name} {cls}" for name, cls in classes.items()]
        lines += [f"  classDef {cls} {style}" for cls, style in CLASS_STYLES.items()]
    return "\n".join(lines)


def run_nodes() -> None:
```

- [ ] **Step 5: Add `cmd_graph` and register it**

In `janus.py`, replace

```python
def cmd_status() -> int:
    begin(Path.cwd())
```

with

```python
def cmd_graph() -> int:
    global DRY
    begin(Path.cwd())
    if not (ROOT / FLOW_FILE).exists():
        print(f"janus: {FLOW_FILE} not found in {ROOT}", file=sys.stderr)
        return 1
    DRY = True
    load_flow()
    if not NODES:
        raise JanusError(DRY_MESSAGE)
    validate_nodes()
    print(to_mermaid(graph()))
    return 0


def cmd_status() -> int:
    begin(Path.cwd())
```

Replace

```python
COMMANDS = {"run": cmd_run, "status": cmd_status, "reset": cmd_reset}
```

with

```python
COMMANDS = {"run": cmd_run, "status": cmd_status, "reset": cmd_reset, "graph": cmd_graph}
```

The `JanusError` raised by `claim()` inside `load_flow()` and the one raised for an empty `NODES` both propagate to `main`, which prints `janus: <message>` on stderr and returns 1: one code path for both cases of §2.6.

- [ ] **Step 6: Run the tests to see them pass, then the whole suite**

Run: `uv run pytest -q tests/test_nodes.py`
Expected: `28 passed`.

Run: `uv run pytest -q`
Expected: `156 passed`. `janus.py` is 693 lines.

- [ ] **Step 7: Try it by hand once**

From the worktree root:

```bash
mkdir -p /tmp/janus-graph-try && cp janus.py /tmp/janus-graph-try/ && cd /tmp/janus-graph-try
printf 'from janus import node, END\n\n@node(next={"ok": "b", "no": END})\ndef a(s):\n    return "ok"\n\n@node(next=END)\ndef b(s):\n    pass\n' > flow.py
python3 janus.py graph; echo "exit $?"
printf 'from janus import step\nstep("x", lambda: 1)\n' > flow.py
python3 janus.py graph; echo "exit $?"; ls
cd - && rm -rf /tmp/janus-graph-try
```

Expected: `flowchart LR` / `  a -- ok --> b` / `  a -- no --> END` / `  b --> END` / `  END([END])` / `exit 0`; then `janus: flow.py runs steps at load time; only node flows have a graph` / `exit 1` and `ls` shows `flow.py janus.py` only (no `journal.yaml`).

- [ ] **Step 8: Commit**

```bash
git add janus.py tests/test_nodes.py
git commit -m "feat(engine): graph command prints a node flow as mermaid" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `status` names the current visit

Design §2.6: "`status` gains one line when the journal has a path: `at: review#2 (visit 2 of review)`"; §2.9 test 11: "`status` prints the `at:` line for a node journal and nothing new for a script journal."

**Files:**
- Modify: `janus.py` (`cmd_status`)
- Modify: `tests/test_nodes.py` (append)

**Interfaces:**
- Consumes: `JOURNAL["path"]` as Task 3 writes it.
- Produces: the first output line `at: <node>#<visit> (visit <visit> of <node>)` when the journal has a non-empty `path`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_nodes.py`:

```python


def test_status_prints_the_at_line_for_a_node_journal_only(root, monkeypatch, capsys):
    (root / "journal.yaml").write_text(
        "flow: flow.py\nstarted: x\nsteps:\n  review#2/review#1: {kind: codex, status: running, attempt: 1}\n"
        "graph: {start: review, nodes: [{name: review, next: {'': null}}]}\n"
        "path:\n- {node: review, visit: 1, started: x, finished: x, next: ''}\n"
        "- {node: review, visit: 2, started: x}\n", encoding="utf-8")
    assert run(root, monkeypatch, "status") == 0
    assert capsys.readouterr().out == (
        "at: review#2 (visit 2 of review)\n"
        "no open gate\n"
        "last steps:\n"
        "  review#2/review#1: codex running (attempt 1)\n"
        "next: python janus.py run (re-executes review#2/review#1)\n")
    (root / "journal.yaml").write_text(
        "flow: flow.py\nstarted: x\nsteps:\n  plan#1: {kind: codex, status: done, attempt: 1}\n", encoding="utf-8")
    assert run(root, monkeypatch, "status") == 0
    assert capsys.readouterr().out == (
        "no open gate\nlast steps:\n  plan#1: codex done (attempt 1)\nnext: python janus.py run\n")
```

- [ ] **Step 2: Run the test to see it fail**

Run: `uv run pytest -q tests/test_nodes.py`
Expected: `1 failed, 28 passed`; the diff shows the missing first line `- at: review#2 (visit 2 of review)`.

- [ ] **Step 3: Print the line**

In `janus.py`, in `cmd_status`, replace

```python
        print("no journal; nothing has run yet\nnext: python janus.py run")
        return 0
    steps: Dict[str, Any] = JOURNAL["steps"]
```

with

```python
        print("no journal; nothing has run yet\nnext: python janus.py run")
        return 0
    if JOURNAL.get("path"):
        last = JOURNAL["path"][-1]
        print(f"at: {last['node']}#{last['visit']} (visit {last['visit']} of {last['node']})")
    steps: Dict[str, Any] = JOURNAL["steps"]
```

- [ ] **Step 4: Run the test to see it pass, then the whole suite**

Run: `uv run pytest -q tests/test_nodes.py`
Expected: `29 passed`.

Run: `uv run pytest -q`
Expected: `157 passed`; `tests/test_status_reset.py`'s exact-output assertions are untouched because a script journal has no `path`. `janus.py` is 696 lines.

- [ ] **Step 5: Commit**

```bash
git add janus.py tests/test_nodes.py
git commit -m "feat(engine): status names the current node visit" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `init`, a starter goal folder

Design §2.7: the folder, the seven files, the starter flow verbatim, the six printed steps, no `git init`, and the test list ("`init` into `tmp_path/goal` creates the files listed; a second `init` into the same folder raises; `graph` in the folder prints the three-node map; `run` with the fake codex answering `done: true` exits 2 at `approve#1/gate#1`, and after `yes` a second run exits 0 with `finish` in the path").

**Files:**
- Modify: `janus.py` (five string constants and `cmd_init` before `COMMANDS`, `COMMANDS["init"]`, the `folder` argument in `main`)
- Create: `tests/test_init.py`

**Interfaces:**
- Consumes: `JanusError`, `main`, and, in the test, `graph` (Task 4) and the runner (Task 3).
- Produces: `STARTER_FLOW`, `STARTER_PREAMBLE`, `STARTER_DRAFT`, `STARTER_FILES` (`{relative path: text}`), `INIT_STEPS`, `cmd_init(folder: Optional[str]) -> int`, `python janus.py init <folder>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_init.py`:

```python
"""`init` (design 2026-09-24 section 2.7): a starter goal folder that runs as it is."""
import janus
from helpers import read_journal

FILES = {"janus.py", "JANUS.md", "flow.py", "prompts/_preamble.md", "prompts/draft.md", ".gitignore"}
MERMAID = "flowchart LR\n  draft --> approve\n  approve -- yes --> finish\n  approve -- no --> draft\n" \
          "  finish --> END\n  END([END])\n"


def answer(root, text):
    path = root / "JANUS.md"
    path.write_text(path.read_text(encoding="utf-8").replace("\nanswer:\n", f"\nanswer: {text}\n"), encoding="utf-8")


def test_init_creates_the_starter_folder_and_refuses_a_second_time(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert janus.main(["init", "goal"]) == 0
    goal = tmp_path / "goal"
    assert {str(p.relative_to(goal)) for p in goal.rglob("*") if p.is_file()} == FILES
    assert (goal / "janus.py").read_text(encoding="utf-8") == open(janus.__file__, encoding="utf-8").read()
    assert (goal / "JANUS.md").read_text(encoding="utf-8") == \
        "# Goal\nDescribe what Codex must achieve; every prompt sees this text as {{goal}}.\n"
    assert (goal / ".gitignore").read_text(encoding="utf-8") == "*/\n!prompts/\n!journals/\n"
    assert (goal / "prompts" / "draft.md").read_text(encoding="utf-8").startswith(
        "---\noutput:\n  done: bool\n  summary: str\n  blockers: list[str]\n---\n")
    assert "{{previous}}" in (goal / "prompts" / "draft.md").read_text(encoding="utf-8")
    assert "{{findings}}" in (goal / "prompts" / "draft.md").read_text(encoding="utf-8")
    assert (goal / "prompts" / "_preamble.md").read_text(encoding="utf-8").startswith("{{goal}}\n")
    out = capsys.readouterr().out
    assert out.startswith("created goal\nnext, in this folder:\n  1. edit JANUS.md") and "6. python janus_ui.py" in out
    assert janus.main(["init", "goal"]) == 1
    assert capsys.readouterr().err == "janus: goal exists and is not empty\n"
    assert janus.main(["init"]) == 1
    assert capsys.readouterr().err == "janus: init needs a folder: python janus.py init <folder>\n"


def test_init_copies_janus_ui_when_it_sits_beside_the_engine(tmp_path, monkeypatch):
    engine = tmp_path / "engine"
    engine.mkdir()
    (engine / "janus.py").write_text("# engine\n", encoding="utf-8")
    (engine / "janus_ui.py").write_text("# ui\n", encoding="utf-8")
    monkeypatch.setattr(janus, "__file__", str(engine / "janus.py"))
    monkeypatch.chdir(tmp_path)
    assert janus.main(["init", "goal"]) == 0
    assert (tmp_path / "goal" / "janus.py").read_text(encoding="utf-8") == "# engine\n"
    assert (tmp_path / "goal" / "janus_ui.py").read_text(encoding="utf-8") == "# ui\n"


def test_the_starter_flow_has_a_graph_and_runs_to_its_gate_and_to_the_end(tmp_path, fake_codex, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert janus.main(["init", "goal"]) == 0
    goal = tmp_path / "goal"
    monkeypatch.chdir(goal)
    capsys.readouterr()
    assert janus.main(["graph"]) == 0
    assert capsys.readouterr().out == MERMAID
    fake_codex.script([{"output": {"done": True, "summary": "wrote the thing", "blockers": []}}])
    assert janus.main(["run"]) == 2
    journal = read_journal(goal)
    assert list(journal["steps"]) == ["draft#1/draft#1/1", "approve#1/gate#1"]
    assert journal["steps"]["approve#1/gate#1"]["status"] == "open"
    assert "## Gate: approve#1/gate#1\nIs this done? Answer yes, or write what to change.\n\n    wrote the thing\n" \
        in (goal / "JANUS.md").read_text(encoding="utf-8")
    prompt = fake_codex.calls()[0]["prompt"]
    assert prompt.startswith("Describe what Codex must achieve; every prompt sees this text as {{goal}}.\n\nRules:")
    assert "Do the work the goal describes, in the current folder." in prompt
    answer(goal, "yes")
    assert janus.main(["run"]) == 0
    journal = read_journal(goal)
    assert [e["node"] for e in journal["path"]] == ["draft", "approve", "finish"]
    assert "done: wrote the thing" in (goal / "JANUS.md").read_text(encoding="utf-8")
    assert len(fake_codex.calls()) == 1
```

These tests use `tmp_path` directly (not the `root` fixture): `init` builds the goal folder itself. `fake_codex` also lives under `tmp_path` (`fake-bin/`), outside `goal/`. The second test monkeypatches `janus.__file__`, which `cmd_init` reads through `Path(__file__)`, to a folder that has a `janus_ui.py` beside the engine. The prompt assertion shows the preamble (`{{goal}}` rendered, then `Rules:`) is prepended to `draft.md`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `uv run pytest -q tests/test_init.py`
Expected: `3 failed`, each with `janus.py: error: argument command: invalid choice: 'init' (choose from 'graph', 'reset', 'run', 'status')` and `assert 1 == 0`.

- [ ] **Step 3: Add the starter templates, `cmd_init` and the command**

In `janus.py`, replace

```python
COMMANDS = {"run": cmd_run, "status": cmd_status, "reset": cmd_reset, "graph": cmd_graph}
```

with

```python
STARTER_FLOW = '''\
from janus import END, human_gate, log, node, ralph

@node(next="approve")
def draft(s):
    s.result = ralph("prompts/draft.md", until=lambda r: r["done"], max_iter=3,
                     findings=getattr(s, "findings", ""))

@node(next={"yes": "finish", "no": "draft"})
def approve(s):
    answer = human_gate("Is this done? Answer yes, or write what to change.", show=s.result["summary"])
    if answer.strip().lower() == "yes":
        return "yes"
    s.findings = answer
    return "no"

@node(next=END)
def finish(s):
    log("done: " + s.result["summary"])
'''

STARTER_PREAMBLE = '''\
{{goal}}

Rules: report blockers instead of guessing; never echo secrets (tokens, passwords, keys); commit your own
work and report the commit.
'''

STARTER_DRAFT = '''\
---
output:
  done: bool
  summary: str
  blockers: list[str]
---
Do the work the goal describes, in the current folder.

Your earlier attempt (empty on the first attempt):
{{previous}}

What the human asked to change (empty on the first draft):
{{findings}}

When the work is complete answer done: true with a summary of what you did and where; otherwise answer
done: false, say in summary how far you got and list in blockers what stops you.
'''

STARTER_FILES = {"JANUS.md": "# Goal\nDescribe what Codex must achieve; every prompt sees this text as {{goal}}.\n",
                 "flow.py": STARTER_FLOW, "prompts/_preamble.md": STARTER_PREAMBLE,
                 "prompts/draft.md": STARTER_DRAFT, ".gitignore": "*/\n!prompts/\n!journals/\n"}

INIT_STEPS = """\
next, in this folder:
  1. edit JANUS.md: describe the goal under # Goal
  2. edit prompts/draft.md, or add prompts; each declares its output fields in front matter
  3. edit flow.py: one function per node, next= says where it goes
  4. python janus.py graph    # print the map
  5. python janus.py run      # run it; answer gates in JANUS.md and run again
  6. python janus_ui.py       # watch it in the browser"""


def cmd_init(folder: Optional[str]) -> int:
    """Create a goal folder with a copy of this engine and the starter node flow (design 2.7)."""
    if not folder:
        raise JanusError("init needs a folder: python janus.py init <folder>")
    target = Path(folder)
    if target.exists() and any(target.iterdir()):
        raise JanusError(f"{target} exists and is not empty")
    (target / "prompts").mkdir(parents=True, exist_ok=True)
    here = Path(__file__).resolve()
    shutil.copy(str(here), str(target / "janus.py"))
    if (here.parent / "janus_ui.py").exists():
        shutil.copy(str(here.parent / "janus_ui.py"), str(target / "janus_ui.py"))
    for name, text in STARTER_FILES.items():
        (target / name).write_text(text, encoding="utf-8")
    print(f"created {target}\n{INIT_STEPS}")
    return 0


COMMANDS = {"run": cmd_run, "status": cmd_status, "reset": cmd_reset, "graph": cmd_graph, "init": cmd_init}
```

`STARTER_FLOW` is the starter flow of design §2.7 character for character. `{{goal}}` in the `JANUS.md` placeholder is literal text inside the goal, which `goal()` returns as a value; it is never rendered again, so the braces are harmless.

In `main`, replace

```python
    parser.add_argument("command", choices=sorted(COMMANDS))
```

with

```python
    parser.add_argument("command", choices=sorted(COMMANDS))
    parser.add_argument("folder", nargs="?", help="init: the goal folder to create")
```

and replace

```python
        return COMMANDS[args.command]()
```

with

```python
        return cmd_init(args.folder) if args.command == "init" else COMMANDS[args.command]()
```

- [ ] **Step 4: Run the tests to see them pass, then the whole suite**

Run: `uv run pytest -q tests/test_init.py`
Expected: `3 passed`.

Run: `uv run pytest -q`
Expected: `160 passed`. `janus.py` is 776 lines.

- [ ] **Step 5: Try it by hand once**

From the worktree root:

```bash
rm -rf /tmp/janus-init-try && python3 janus.py init /tmp/janus-init-try && cd /tmp/janus-init-try && ls -A && python3 janus.py graph && python3 janus.py status; cd - && python3 janus.py init /tmp/janus-init-try; echo "exit $?"; rm -rf /tmp/janus-init-try
```

Expected: `created /tmp/janus-init-try` and the six steps; `.gitignore JANUS.md flow.py janus.py prompts`; the three-node mermaid (`draft --> approve`, `approve -- yes --> finish`, `approve -- no --> draft`, `finish --> END`, `END([END])`); `no journal; nothing has run yet` / `next: python janus.py run`; then `janus: /tmp/janus-init-try exists and is not empty` and `exit 1`.

- [ ] **Step 6: Commit**

```bash
git add janus.py tests/test_init.py
git commit -m "feat(engine): init creates a starter goal folder" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Spec v0.3

Design §2.8: header (v0.3, one sentence on nodes); §4 (`node` and `END` in the primitive list, the node prefix rule in the Keys paragraph); §5 (the journal example gains `graph:` and `path:`, the Replay paragraph gains the path check); §6 (`graph` and `init`); §9 (tests 13 to 19); §13 (one line on staying a script). Sections 10 and 14 are slice 5's and are not touched.

**Files:**
- Modify: `janus-4.0-spec.md`

Every edit below quotes the old text exactly as it stands at `67f6917`; each old text occurs once in the file. Fenced blocks inside the old/new text are shown with four-backtick outer fences.

- [ ] **Step 1: Header**

Replace

```markdown
**Status:** implementation specification, v0.2 (v0.1 superseded Janus 3.0 after the design session on 2026-09-22; v0.2 adds section 14 on loops and reshapes the example around them, 2026-09-23)
```

with

```markdown
**Status:** implementation specification, v0.3 (v0.1 superseded Janus 3.0 after the design session on 2026-09-22; v0.2 adds section 14 on loops and reshapes the example around them, 2026-09-23; v0.3 adds node flows, where a flow is a state machine of small functions whose edges the engine records and draws, 2026-09-24)
```

- [ ] **Step 2: Section 4, the primitive list and the Keys paragraph**

Replace

````markdown
log(text) -> None
    # Appends a line to "## Progress" in JANUS.md and prints it.

class Exhausted(Exception):   # .last is the final ralph result
class JanusError(Exception):  # engine and flow errors that stop the run
```

**Keys.** A step key identifies a journal entry. The default key is the prompt file stem followed by `#` and a counter of calls with that stem in this run, so the third `codex("prompts/implement.md")` is `implement#3`. `step` requires an explicit key. Inside loops, flows pass an explicit key that survives edits to the flow, such as `f"implement/{task_id}"`. Ralph iterations are keyed `<key>/<n>` starting at 1. Two live steps with the same key in one run is a `JanusError`.
````

with

````markdown
log(text) -> None
    # Appends a line to "## Progress" in JANUS.md and prints it.

node(next) -> decorator
    # Registers the decorated function as a node named after the function; the first node defined is
    # the start. `next` is a node name (one edge; the function returns None), END (the flow ends after
    # this node; the function returns None) or {"label": name_or_END, ...} (the function returns a
    # label). The function takes the state `s`, a SimpleNamespace made fresh for every run. A flow
    # that defines nodes is walked by the engine after flow.py has loaded; one that defines none is a
    # script flow and has already run. A duplicate name, a `next` of another shape, an empty dict or
    # a non-string label is a JanusError at decoration; a target that names no node is one before the
    # first visit; a return value that is not a declared label is one after the node's steps ran.

END                           # sentinel: the flow ends here

class Exhausted(Exception):   # .last is the final ralph result
class JanusError(Exception):  # engine and flow errors that stop the run
```

**Keys.** A step key identifies a journal entry. The default key is the prompt file stem followed by `#` and a counter of calls with that stem in this run, so the third `codex("prompts/implement.md")` is `implement#3`. `step` requires an explicit key. Inside loops, flows pass an explicit key that survives edits to the flow, such as `f"implement/{task_id}"`. Ralph iterations are keyed `<key>/<n>` starting at 1. Two live steps with the same key in one run is a `JanusError`. Inside a node flow every key, explicit or default, is prefixed with the visit it runs in, `<node>#<visit>/`, and the default counters start again at each visit: the `codex("prompts/plan.md")` in the third visit of `implement` is `implement#3/plan#1`, a `ralph` there iterates `implement#3/implement#1/<n>`, `step("wait", fn)` is `implement#3/wait` and a `human_gate` is `implement#3/gate#1`. Visit counts are replayed with the path, so a node flow needs no explicit keys in loops.
````

- [ ] **Step 3: Section 5, the journal example and the Replay paragraph**

Replace

````markdown
  implement/1/1:
    kind: codex
    status: failed
    attempt: 2
    error: "codex exec exited with 1: ..."
```

The file is written atomically, through a temporary file and rename, at every status change.
````

with

````markdown
  implement/1/1:
    kind: codex
    status: failed
    attempt: 2
    error: "codex exec exited with 1: ..."
graph:                      # node flows only: the map, {start, nodes: [{name, next: {label: target}}]}
  start: plan
  nodes:
  - name: plan
    next: {'': approve}     # '' is the one unlabelled edge; null is END
  - name: approve
    next: {yes: finish, no: plan}
path:                       # node flows only: one entry per visit, in order
- {node: plan, visit: 1, started: ..., finished: ..., next: ''}
- {node: approve, visit: 1, started: ...}   # no finished: this visit was interrupted and resumes
```

The file is written atomically, through a temporary file and rename, at every status change, and once more when `run` ends so that the path's last entry is saved. A journal written by Janus 4.0, or by a script flow, has no `graph` and no `path`.
````

Then replace

```markdown
The flow must produce the same sequence of keys on every run, given the same journal. Explicit keys in loops are how a flow stays deterministic when it is edited.
```

with

```markdown
The flow must produce the same sequence of keys on every run, given the same journal. Explicit keys in loops are how a flow stays deterministic when it is edited.

A node flow is walked from its start node after `flow.py` has loaded, and every visit is checked against `path`: the node of visit `n` must be the node recorded there (`flow changed: visit 2 was b, now c` otherwise), and a finished visit must return the label it returned before (`flow changed: a#1 went to 'right' before, now 'left'`). A finished visit runs again with replayed steps and is not re-recorded; the last, unfinished entry is the interrupted visit and is resumed in place with its visit count and `started` kept. `graph` is rewritten at the start of every run.
```

- [ ] **Step 4: Section 6, the commands**

Replace

````markdown
```bash
python janus.py run      # execute flow.py with replay until end, open gate or failure
python janus.py status   # open gate if any, last five steps, next action
python janus.py reset    # move journal.yaml to journals/<timestamp>.yaml and remove open gates from JANUS.md
```

`run` imports `flow.py` from the current folder as a module and executes it top to bottom. Uncaught exceptions from the flow, including `Exhausted`, are written to `## Progress` with the step key that raised and the run exits with code 1.
````

with

````markdown
```bash
python janus.py run      # execute flow.py with replay until end, open gate or failure
python janus.py status   # open gate if any, last five steps, next action; a node flow's current visit first
python janus.py reset    # move journal.yaml to journals/<timestamp>.yaml and remove open gates from JANUS.md
python janus.py graph    # print a node flow's map as mermaid; fails for a script flow
python /path/to/janus.py init <folder>   # create a goal folder with a starter node flow
```

`run` imports `flow.py` from the current folder as a module and executes it top to bottom; when it registered nodes, the engine then walks them from the start node. Uncaught exceptions from the flow, including `Exhausted`, are written to `## Progress` with the step key that raised and the run exits with code 1.

`graph` loads `flow.py` with steps disabled: a script flow's first primitive call fails with `flow.py runs steps at load time; only node flows have a graph`, and so does a file that registers no node. The output is one `flowchart LR` line per edge (`plan --> approve`, `review -- failed --> start_round`) and `END([END])` once when any edge ends the flow; it pastes into a README. `status` prints `at: review#2 (visit 2 of review)` first when the journal has a path.

`init` creates `<folder>` (an error when it exists and is not empty) with a copy of the running `janus.py` (and of `janus_ui.py` when it sits beside it), a `JANUS.md` with a placeholder goal, a three-node `flow.py` (draft with a ralph, approve with a gate that sends the answer back as findings, finish), `prompts/_preamble.md`, `prompts/draft.md` and a `.gitignore`, then prints the six steps to take next. It does not run `git init`.
````

- [ ] **Step 5: Section 9, tests 13 to 19**

Replace

```markdown
12. A return loop (section 14): a `while` flow whose gate answer sends it back to an earlier stage re-executes only the new round's keys on the next run, a gate inside the second round resumes in the second round, and a finished loop replays without executing anything.

About thirty tests.
```

with

```markdown
12. A return loop (section 14): a `while` flow whose gate answer sends it back to an earlier stage re-executes only the new round's keys on the next run, a gate inside the second round resumes in the second round, and a finished loop replays without executing anything.
13. Node registration: `graph()` lists nodes in definition order with normalised edges; a duplicate name, a bad `next` and an empty dict raise `JanusError` at decoration; an unknown target fails `run` and `graph` before any visit.
14. Node walk and keys: `a -> b -> END` runs with keys `a#1/plan#1`, `b#1/plan#1` and two finished path entries; inside a visit every primitive's key carries the `<node>#<visit>/` prefix and the default counters restart.
15. Return values: a label chosen from a Codex result is recorded as the taken edge; an undeclared label and a value returned by a single-edge node exit 1 with their messages, the node's steps staying `done`.
16. Loops: `a -> a` three times then END counts visits `a#1`, `a#2`, `a#3`; a second run executes nothing and leaves the path unchanged.
17. Interruptions in a node: a gate exits 2 under `b#1/gate#1` and the next run resumes in `b`; a failing step leaves the visit without `finished` and runs again as attempt 2; a flow edited so that visit 2 is another node, or a finished visit that takes another edge, exits 1 with `flow changed`.
18. `graph`: the mermaid of a node flow; the load-time message and exit 1 for a script flow with the fake `codex` never called; `to_mermaid` with classes and counts; `status` prints `at:` for a node journal and nothing new for a script journal.
19. `init` creates the starter files, refuses a non-empty folder, its `graph` prints the three-node map, and its `run` stops at `approve#1/gate#1` and ends with `finish` in the path after `yes`.

About thirty tests in 4.0; sixty after 4.1.
```

- [ ] **Step 6: Section 13, staying a script**

Replace

```markdown
Janus 4.0 gives the flow author full Python and asks in return that the flow be deterministic in its step keys. The engine does not protect against a flow that forgets `step()` around a side effect, uses a changing default key in a loop, or lets Codex commit to the wrong branch. Those are visible in `flow.py` and the prompts, which is where they can be fixed. Engine features are added only after a real flow shows that prompts and Python cannot express something safely.
```

with

```markdown
Janus 4.0 gives the flow author full Python and asks in return that the flow be deterministic in its step keys. The engine does not protect against a flow that forgets `step()` around a side effect, uses a changing default key in a loop, or lets Codex commit to the wrong branch. Those are visible in `flow.py` and the prompts, which is where they can be fixed. Engine features are added only after a real flow shows that prompts and Python cannot express something safely.

A flow may stay a script: plain Python with explicit keys in its loops, as sections 10 and 14 of v0.2 wrote it. It runs exactly as before and forgoes what only nodes give: the map (`graph`), the recorded path, the `at:` line and the live page.
```

- [ ] **Step 7: Check and commit**

Run: `git diff --stat janus-4.0-spec.md`
Expected: `1 file changed, 45 insertions(+), 6 deletions(-)`; `grep -c "v0.3" janus-4.0-spec.md` prints `1`; `grep -n "^13\. Node registration\|^19\. \`init\`" janus-4.0-spec.md` prints both lines.

Run: `uv run pytest -q`
Expected: `160 passed` (nothing but the spec changed).

```bash
git add janus-4.0-spec.md
git commit -m "docs(spec): v0.3, node flows: node and END, visit-prefixed keys, graph and path, graph and init" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage.** §2.1 primitives, normalisation, registration errors → Task 1; validation before the first visit → Task 1 (`validate_nodes`), Task 3 (`run`), Task 4 (`graph`); the fresh `SimpleNamespace` and "gates raise `SystemExit(2)` ... the runner lets it through" → Task 3 (`s` in `run_nodes`, `test_a_gate_inside_a_node_...`). §2.2 the key table → Task 2 (`test_inside_a_node_visit_...` asserts all five rows), `NODE = None` outside the runner → Task 2 (`begin()` reset, `test_outside_the_runner_...`) and Task 3 (`NODE = None` after the walk), `COUNTERS` emptied per visit → Task 3 (`NODE, COUNTERS = ..., {}`; the loop test's `a#2/plan#1` proves the counter restarts). §2.3 the walk, both `flow changed` messages, path entries with `started`/`finished`/`next`, the resumed unfinished entry, the `finally` write and its condition, `CURRENT` with the prefix in the Progress line → Task 3 (every one has a test; the Progress lines are asserted with their keys). §2.4 the table → Task 3 (`check_label`, `test_an_undeclared_label_...`, `test_a_single_edge_...`; the dict-returns-`None` row is covered by `check_label`'s last branch, `returned` not a declared string). §2.5 `graph()` shape and storage, `to_mermaid` with counts, `END([END])` once, `class`/`classDef` only with `classes` → Tasks 1, 3, 4. §2.6 `graph`, `DRY`, the message for both cases, `status` `at:` → Tasks 4, 5. §2.7 files, starter flow verbatim, six steps, no `git init`, the four-part test → Task 6. §2.8 all six bullets → Task 7. §2.9 tests 1 to 11 → tests in Tasks 1 to 5 as mapped in each task's commentary. Sections 3 and 4 are not planned; what they consume (labelled edges with `END` in a dict, `to_mermaid(graph, classes, counts)`, `graph`/`path` in the journal, `find_section` unchanged) exists after Task 4.
- **The code was assembled and replayed.** Every engine edit and every test in this plan was applied by script to a clean clone at `67f6917`, task by task, running the new tests red on the previous task's engine and green after the edits, then the whole suite: Task 1 red `10 failed` (`AttributeError: module 'janus' has no attribute 'node'`), green `10 passed`, suite `138 passed`, 600 lines; Task 2 red `2 failed, 10 passed` (`has no attribute 'NODE'`), suite `140 passed`, 602 lines; Task 3 red `10 failed, 13 passed` (`assert 0 == 1`, `assert 0 == 2`, `FileNotFoundError` on `journal.yaml`), suite `151 passed`, 653 lines; Task 4 red `5 failed, 23 passed` (`invalid choice: 'graph'`, `has no attribute 'to_mermaid'`), suite `156 passed`, 693 lines; Task 5 red `1 failed, 28 passed`, suite `157 passed`, 696 lines; Task 6 red `3 failed` (`invalid choice: 'init'`), suite `160 passed in 12.99s`, 776 lines. The replayed `janus.py` is byte-identical to the rehearsal copy that the manual checks of Tasks 4 and 6 were run against (`init` as a subprocess, then `graph`, `status`, a second `init`, and `graph` on a script flow: outputs as the steps state). The spec edits of Task 7 were applied by the same script method (`45 insertions(+), 6 deletions(-)`). The engine tests also pass under Python 3.9. `awk 'length > 120'` prints nothing for `janus.py`, `tests/test_nodes.py` and `tests/test_init.py`.
- **Type and name consistency.** `node(next)`, `graph()`, `validate_nodes()`, `check_label(name, edges, returned)`, `run_nodes()`, `write_journal()`, `load_flow()`, `to_mermaid(graph, classes=None, counts=None)`, `cmd_graph()`, `cmd_init(folder)` are defined once and called with those names and arities in every later task; `NODES[name]` is the `(name, fn, edges)` tuple everywhere it is unpacked; the journal fields `graph`, `path`, `node`, `visit`, `started`, `finished`, `next` are the same strings in `run_nodes`, `cmd_status`, the spec example of Task 7 and every test; the error strings in the engine, the tests and the spec's §5 and §6 are identical.
- **Placeholder scan.** No "TBD", "TODO", "handle edge cases" or "similar to Task N": every code step carries its code in full and every edit quotes the old and the new text. The old texts of Tasks 2 to 6 are the new texts of the tasks before them, so the tasks must be executed in order.
- **Deliberate limitations.** `graph` runs `flow.py`'s module-level code, so a script flow that calls `log()` before its first step writes one Progress line before the refusal; the spec only asks that no step runs. `init` copies the engine with `shutil.copy` and does not chmod it; it is run with `python janus.py`, not as an executable. The starter `draft.md` cannot be tried against real Codex in this slice (no trial is planned here); its schema and placeholders are checked by the `init` test through the fake `codex`. The 700-line target is missed by 76 lines, explained under *Design decisions*.
