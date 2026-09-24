# Janus 4.1 Slice 6: The Live Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One new file at the repository root, `janus_ui.py`, that serves a live web view of a goal folder: `python janus_ui.py [--port N]` from the folder shows the header totals, the open gate, the flow's map with the path taken coloured on it, the step tree, one step's detail, and the Progress and Decisions sections, polling `journal.yaml` and `JANUS.md` every two seconds without ever writing to them.

**Architecture:** `build_state(root, now=None)` is a pure function from the two files to the mapping of design §4.2 (Tasks 1 to 3, built up field by field: files, steps and totals first; then the tree, `current` and the gate; then the path, the mermaid classes and counts and the tree's `next` labels). `make_server(root, port)` wraps it in a `ThreadingHTTPServer` on `127.0.0.1` with two routes, and `main(argv)` parses `--port` (Task 4). The page is one string constant `PAGE`, vanilla HTML, CSS and JS, that polls `/state.json` and rebuilds the DOM; mermaid comes from a CDN and is re-rendered only when its text changes (Task 5). The engine is imported for `find_section` and `to_mermaid` only. Task 6 writes the spec paragraph, one docstring line, and runs the manual check.

**Tech Stack:** Python 3.9+ (`from __future__ import annotations`; no `match`, no `X | Y` types), PyYAML 6, `http.server` from the standard library, pytest via `uv` (`/snap/bin/uv`), mermaid 11 from `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js` at run time only. No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-24-janus-nodes-and-ui-design.md` at `01258a8`, section 4 (4.1 to 4.6). Section 2 describes the engine facts this slice reads: §2.2 the `<node>#<visit>/` key prefix, §2.3 the journal's `graph` and `path`, §2.5 `to_mermaid(graph, classes, counts)`, §2.10 `session` and `usage` on codex entries. Section 3 is slice 5 (the example rewrite), not this slice. Executors read the spec's section 4 and this plan.

**Where the work happens:** a git worktree at `.worktrees/slice6-ui` on branch `slice6-ui`, already created from `main` at `01258a8` (`git worktree list` shows it; `.worktrees/` is in `.git/info/exclude`). **Every path in this plan is relative to that worktree root**; `uv run pytest -q` is run from it.

## Global Constraints

Copied from the design spec where it binds this slice, plus the controller's rulings; every task's requirements include this section.

- Design §4.1: "One file at the repository root, `janus_ui.py`, Python 3.9+, standard library plus PyYAML; copied into a goal folder next to `janus.py`." "`python janus_ui.py [--port N]` from the goal folder serves `http://127.0.0.1:8765`, loopback only, and prints the URL once. Routes: `GET /` the page (`text/html`), `GET /state.json` (`application/json`, `Cache-Control: no-store`); everything else 404. Request logging is silenced." "Two functions carry it: `build_state(root, now=None) -> dict` and `make_server(root, port) -> ThreadingHTTPServer`; `main(argv)` parses `--port`, prints the URL, runs `serve_forever` until Ctrl-C. A port in use prints `janus_ui: port 8765 is in use; try --port 8766` and exits 1." "It imports `janus` for `find_section` and `to_mermaid` only; it never calls `begin()`, never writes, never commits. Size target: under 450 lines including the page."
- Design §4.2, the field table, verbatim where it decides a value: `folder` = "`root.resolve().name`"; `flow`, `started` "from the journal; `"flow.py"` and null without one"; `updated` "journal mtime as ISO seconds, or null"; `error` "null, or one line when `journal.yaml` exists but is not valid YAML or not a mapping; the rest is then as for a missing journal"; `goal` "text of `# Goal`, `""` when missing"; `steps` "journal order, one item per mapping entry (non-mappings skipped)"; `current` "first `running` or `open` key; else the last `failed`; else null"; `gate` "for the first `open` entry: `{"key", "kind", "question", "section"}`, `section` being the verbatim `## Gate: <key>` section of JANUS.md joined with newlines, `""` when absent; else null"; `path` "the journal's `path` list as is, `[]` when absent"; `mermaid` "`to_mermaid(graph, classes, counts)` when the journal has `graph`, else null. `classes`: every node with a finished visit is `visited`; the node of the last path entry, when that entry is unfinished, gets `running`, `open` or `failed` after the status of `current` (`running` when there is no current step yet). `counts` come from the finished path entries"; `progress`, `decisions` "the lines of those sections after the heading, `[]` when absent"; `totals` "`{"steps", "done", "failed", "running", "open", "answered", "codex_seconds", "tokens"}`; `codex_seconds` sums kinds `codex` and `ai_gate`; `tokens` = `{"input", "cached", "output", "total", "sessions"}` summed over entries with `usage` (section 2.10)".
- Design §4.2, a step item: "`key`, `kind`, `status`, `attempt` (null for gates), `session` and `usage` (from the entry, null when absent), `started`, `finished`, `seconds` (whole seconds; running and open count to `now`; null when `started` is missing or unparsable), `summary` (one line, 160 chars with `...`: `result.summary` or `result.text` when strings for `done`; first line of `answer` for `answered`; of `error` for `failed`; of `question` for `open`; `""` for `running`), `detail` (`yaml.safe_dump` of the entry, `sort_keys=False, allow_unicode=True`)."
- Design §4.2, the tree: "nodes `{"name", "key", "status", "seconds", "next", "children"}` where `key` is the full prefix. A journal key's node carries its status and seconds; a group rolls up `running` if any child is `running` or `open`, else `failed` if any is `failed`, else `done`. A top-level node whose name is `<node>#<visit>` of a path entry gets `next` = that entry's label (`""` for an unlabelled edge, null when unfinished); other nodes have `next` null. Children keep first-appearance order. A key that is both an entry and a prefix keeps its own status and lists its children."
- Design §4.3: "One HTML string `PAGE` at the end of the file; vanilla JS and CSS; the only external resource is mermaid from `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js`." Header "folder, flow, started, updated, totals (`12 steps, 10 done, 1 failed, codex 23m10s, 1.2M tokens in 9 sessions`), a dot green after a successful poll and red after a failed one (error text as its title); `state.error` in red." Gate banner "only when `gate` is set: key, question, `section` in a `<pre>`, and "Answer it in JANUS.md, then run `python janus.py run` again."" Map "when `mermaid` is set, the rendered diagram ... visited green, running blue, open amber, failed red, unvisited grey. Re-rendered only when the mermaid text changes ... If `window.mermaid` is missing (offline) the mermaid text is shown in a `<pre>` instead. Hidden for a script flow." Tree "one row per node, indented by depth, colour by status, label = last key segment, `#n` when attempt > 1, duration as `12s`, `3m04s`, `1h02m`, `usage.total` as `41k tok` on codex rows that have it, and for a top-level visit its `next` label as `→ failed`. Groups toggle on click; leaves select. Ancestors of `current` are expanded on load and `current` is highlighted; the user's toggles survive polls (a `Set` of collapsed keys). "nothing has run yet" when `steps` is empty." Detail "the selected step's key, kind, status, attempt, started, finished, seconds and its `detail` in a `<pre>`; falls back to `current`." Below "Progress and Decisions, raw lines in a `<pre>` each." Polling "`fetch("/state.json")` every 2 s; a failed fetch keeps the last state and reddens the dot. The DOM of the tree, detail and panels is rebuilt from the state on each poll." "Dark background, monospace for keys and YAML, sans-serif for prose, 1000 px and up; no responsive work."
- Design §4.4, the error table: no `journal.yaml` → "empty `steps` and `tree`, null `current`, `gate`, `mermaid`; page says "nothing has run yet""; corrupt journal → "`error` set, otherwise as above"; entry not a mapping → skipped; bad timestamps → `seconds` null; no `JANUS.md` → "`goal` `""`, `progress`/`decisions` `[]`, `gate.section` `""`"; script flow → "`path` `[]`, `mermaid` null, map hidden; everything else works"; flow not running → "the page still works; it views files, not a process".
- Design §4.5: the twelve `build_state` cases and the server test ("`make_server(root, 0)` in a thread; `/` 200 `text/html` containing `<title>`, `/state.json` 200 JSON dict with `steps`, `/nope` 404; `server.shutdown()`"), all in `tests/test_ui.py`. "Manual check before the slice closes: run `janus_ui.py` against the trial 3 folder under `~/janus-trial/` and against a folder mid-gate, and look."
- Design §4.6: "One paragraph in spec section 6 after the `graph` line, one sentence in the example README's "Starting a goal folder", and the module docstring." **Controller ruling:** this slice does **not** touch `examples/angular-upgrade/README.md`; slice 5 rewrites that README and adds the sentence there. Task 6 writes the spec paragraph and the docstring line only.
- Controller rulings on shape: `janus_ui.py` is one file at the repository root; standard library plus PyYAML; imports `janus` for `find_section` and `to_mermaid` only; never writes a file, never calls `begin()`, never commits; under 450 lines including `PAGE` (this plan lands at **406**); Python 3.9+. The page is vanilla HTML, CSS and JS in one string constant `PAGE`; mermaid from the URL above is the only external resource; a missing `window.mermaid` shows the mermaid text in a `<pre>`; the diagram is re-rendered only when the mermaid text changes; dark theme.
- Controller rulings on the server: `make_server(root, port) -> ThreadingHTTPServer` bound to `127.0.0.1`, a handler serving `/` and `/state.json` (`Cache-Control: no-store`), 404 otherwise, `log_message` silenced; `main(argv)` parses `--port` (default 8765), prints the URL, `serve_forever` until KeyboardInterrupt; a port in use prints `janus_ui: port N is in use; try --port N+1` and returns 1.
- Engine facts read from `janus.py` at `01258a8` and relied on: `find_section(lines, heading)` returns `(start, end)` with the heading line at `start`, or `None`; a `## Gate: ` section ends at a reserved heading or at a blank line that precedes any heading, so the joined section carries no trailing blank line; `to_mermaid(graph, classes=None, counts=None)` takes `counts` keyed by `(node, label)` tuples, prints `class <name> <cls>` lines in `classes` order and then the four `classDef` lines of `CLASS_STYLES` (`visited fill:#1b5e20,stroke:#66bb6a`, `running fill:#0d47a1,stroke:#42a5f5`, `open fill:#e65100,stroke:#ffb74d`, `failed fill:#b71c1c,stroke:#ef5350`); a path entry is `{"node", "visit", "started"}` plus `"finished", "next"` once the visit returned; a step entry is `{"kind", "status", "attempt", "started"}` then `finished` and `result`/`error`, with `session` and `usage: {"input", "cached", "output", "total"}` after `result` on codex entries; gates have `kind: gate|decision`, `status: open|answered`, `question`, `started`, then `answer`, `finished`, and no `attempt`; `cmd_status` sums tokens with `sum(u.get(k, 0) ...)` over entries whose `usage` is a dict and counts those entries as sessions, which the page's `totals.tokens` must agree with; `cmd_init` copies `janus_ui.py` when it sits beside `janus.py`.
- Tooling: `uv run pytest -q` from the worktree root is the verification command of every task. The suite is **180 passed** before this plan and **201 passed** after it (180 → 186 after Task 1 → 192 after Task 2 → 199 after Task 3 → 201 after Task 4; Tasks 5 and 6 add none).
- Commits: `type(scope): subject`, scope `ui` for `janus_ui.py` and its tests, `spec` for the engine spec. Two trailers in a separate `-m` so they sit after a blank line: `git commit -m "type(scope): subject" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MghcFnosThAtjAmtNQrbEw"`.
- No line over 120 characters in `janus_ui.py`, `tests/test_ui.py` or `tests/test_init.py`.

## Verified facts about this machine

Checked on 2026-09-24 while writing this plan; the numbers are observed, not assumed.

- The repository `/home/race-day/janus` is on `main` at `01258a8`, clean; `uv run pytest -q` gives **180 passed in 12.44s**; `janus.py` is 829 lines. The worktree `.worktrees/slice6-ui` exists on branch `slice6-ui` at the same commit and is clean. `python3` is 3.12.3, PyYAML 6.0.1, `uv` at `/snap/bin/uv`.
- **`tests/test_init.py` breaks the moment `janus_ui.py` exists** at the repository root: `test_init_creates_the_starter_folder_and_refuses_a_second_time` asserts the exact file set of an `init` folder, and `cmd_init` copies `janus_ui.py` when it sits beside `janus.py` (`Extra items in the left set: 'janus_ui.py'`, observed). Task 1 therefore edits that test's `FILES` constant and adds one assertion that the copy is byte-identical to `janus_ui.__file__`. No other existing test is touched.
- All code in this plan was assembled in a copy of the repository under the session scratchpad and replayed from a clean copy task by task by a script that extracts this plan's code blocks: each task's tests were run red on the previous task's module, the edits applied, the tests run green and the whole suite run; the observed outputs are quoted in the steps. `tests/test_ui.py` also passes under Python 3.9 (`uv run --python 3.9 --isolated --with pyyaml --with pytest pytest -q tests/test_ui.py`: **21 passed**). The real repository was not modified.
- **The page was looked at in a real browser** (Playwright, Chromium, 1280×1000) against a folder created by `python janus.py init`, run once with a fake `codex` (final message `done: true`, stderr `session id: ...`, a rollout file under a fake `CODEX_HOME`) so it stopped at `approve#1/gate#1`. Observed: mermaid 11 loads from the CDN and renders `draft` green (`visited`), `approve` amber (`open`), `finish` and `END` grey, the `(1)` count and the `yes`/`no` labels; the gate banner shows the key, the question, the verbatim section and the closing sentence; the header reads `2 steps, 1 done, 1 open, 42k tokens in 1 sessions` with a green dot; the tree shows `draft#1` collapsed with `0s →` and `approve#1` expanded with `gate#1` highlighted as current and selected; clicking `draft#1` expands it and clicking a row selects it; the detail shows the gate's fields and YAML. A copy of the page with the mermaid URL replaced by an unreachable one shows the mermaid text in a `<pre>` under "Map" and everything else unchanged. The only console errors are the browser's own `favicon.ico` 404 (expected: everything but the two routes is 404) and, in the offline copy, the failed script load. Screenshots: `.playwright-mcp/slice6-rehearsal-gate.png`, `-expanded.png`, `-offline.png` (git-excluded). Not rehearsed: a long-running flow polled live over minutes, and the trial 3 folder under `~/janus-trial/` (slice 5 has not produced it); Task 6's manual check covers the first, the controller's screenshots the second.
- Two page details were changed after looking: an unlabelled edge printed `→ next` (the tree row now prints a bare `→` for `""`), and mermaid's edge labels sat on light grey boxes (`edgeLabelBackground` is set to the page background). One server detail: `main`'s URL line did not appear in a log file until exit because stdout is block-buffered when piped, so the `print` has `flush=True`.

## Design decisions fixed here (where the spec leaves room)

- **`updated` is null for a corrupt journal.** §4.2 says "the rest is then as for a missing journal"; the mtime is part of "the rest". The error line collapses PyYAML's multi-line message into one line: `journal.yaml is not valid YAML: while parsing a flow sequence in "<unicode string>", line 1, column 1 expected ',' or ']', but got '<stream end>' in "<unicode string>", line 1, column 16`; a list or an empty file gives `journal.yaml is not a mapping`.
- **Timestamps may already be `datetime` objects.** The engine writes `now()` strings which `yaml.safe_dump` quotes, so they load back as strings; a hand-written journal with unquoted `2026-09-24T10:00:00` loads as `datetime.datetime`. `parse_time` accepts both, and `/state.json` is dumped with `json.dumps(state, default=str)` so a `datetime` inside `path` cannot break the page. `now` may be an ISO string or a `datetime`; `None` means the clock.
- **`seconds` for a group** is the sum of its children's non-null seconds (null when none has one); the spec gives a group no rule and a visit row with a duration is what the tree is for. A key that is both an entry and a prefix keeps its own seconds.
- **`summary` truncation** keeps 157 characters plus `...` so the line is exactly 160. A `done` step whose `result` is not a mapping (a `step()` returning a string) gets `""`, as the spec lists only `result.summary` and `result.text`. Missing or unknown `status` gives `""`.
- **`gate.section` includes the `## Gate: <key>` heading line**: "verbatim section" is what `find_section` spans, heading first, and the banner's `<pre>` is meant to show what the human will edit. The lines are joined with `\n`; `find_section` already excludes the blank line before the next heading. `progress` and `decisions` are the raw lines after the heading with nothing stripped (a trailing blank line stays; the page's `<pre>` does not mind).
- **`mermaid` needs `graph` to be a mapping with a `nodes` list**; anything else is treated as "no graph" (null). The class of the unfinished last visit's node is `current`'s status when that is `running`, `open` or `failed`, and `running` otherwise (no current step, or a current step with an unexpected status). A node that was finished earlier and is the unfinished last visit keeps its dict position but gets the live class (`visited` is overridden). `counts` are a `Counter` over `(node, next)` of the finished entries, passed as a plain dict.
- **The tree's `next` for an unlabelled finished edge is `""`** (spec), and the page prints it as a bare `→`; a labelled edge prints `→ failed`; an unfinished visit prints nothing.
- **Tree collapse state on load:** the page keeps a `Set` of collapsed keys, so the default is expanded. On the first successful poll every group that is not an ancestor of `current` is added to the set (so "ancestors of `current` are expanded on load" is what the user sees: one open branch, the rest folded to visit rows with their rollup colour and `→` label); groups that appear in later polls are new work and start expanded. Clicking a group toggles it; clicking a key that has a step selects it; a key that is both does both.
- **Colours:** the map relies on the `classDef` lines `to_mermaid` already emits (`CLASS_STYLES` in `janus.py`), so the page's CSS does not restyle mermaid classes; the tree rows use the same four hues in CSS (`--done: #66bb6a`, `--running: #42a5f5`, `--open: #ffb74d`, `--failed: #ef5350`) and `answered` shares the green. Unvisited nodes take mermaid's dark theme with `primaryColor: #3a3f47` (grey). Mermaid is initialised with `startOnLoad: false`, `theme: "dark"`, `securityLevel: "strict"`.
- **Server errors:** an exception inside `build_state` while serving `/state.json` answers 500 with `TypeName: message` as `text/plain`; the page treats a non-2xx as a failed poll (red dot, title `HTTP 500: ...`) and keeps the last state. `self.path` is split on `?` so `/state.json?x=1` still routes. `main` catches `OSError` with `errno.EADDRINUSE` only; other socket errors propagate. The URL line is `janus_ui: <folder> at http://127.0.0.1:<port> (Ctrl-C stops)`.
- **`--port` validation** is argparse's own (`type=int`); an invalid value exits 2 through argparse, which is fine here (no gate exit code to protect, unlike `janus.py`).
- **Test journals are written with `yaml.safe_dump`** through a `write_journal(root, steps, **extra)` helper, and entries with an `entry(kind, status, ...)` helper that mirrors the engine's field order (gates get no `attempt`); the tests need neither `begin()` nor the fake `codex`. `NOW` is `2026-09-24T10:10:00` and the three timestamps `T0`, `T1`, `T2` are 0 s, 12 s and 184 s after 10:00:00, so durations are 12, 184, 172 and 600 (to `NOW`).
- **The stub `PAGE` of Task 4** is a three-line HTML document with a `<title>` so the server test can pass before the page exists; Task 5 replaces the whole constant and extends the test with assertions the stub cannot satisfy.

## File structure

| Path | Responsibility | Task |
|---|---|---|
| `janus_ui.py` | New. Module docstring, imports, constants, `read_journal()`, `parse_time()`, `seconds()`, `summary()`, `step_item()`, `section_lines()`, `build_state()` with files, steps, goal, totals, errors | 1 |
| `tests/test_ui.py` | New. Helpers `entry`, `write_journal`, `visit`, `state`, `names`; cases 1, 2, 8, 9 (6 tests) | 1 |
| `tests/test_init.py` | `FILES` gains `janus_ui.py`; one assertion on the copied file | 1 |
| `janus_ui.py` | `build_tree()` (no labels yet), `gate_of()`, `current`, `progress`, `decisions` | 2 |
| `tests/test_ui.py` | Cases 3, 4, 5, 6, 7, 10 (6 tests) | 2 |
| `janus_ui.py` | `path`, `mermaid_of()`, `build_tree(steps, path)` with `next` labels | 3 |
| `tests/test_ui.py` | Cases 11 (three tests, one parametrised over four states) and 12 (7 tests) | 3 |
| `janus_ui.py` | `Handler`, `make_server()`, `main()`, stub `PAGE`, `__main__` guard | 4 |
| `tests/test_ui.py` | The server test and the port-in-use test (2 tests) | 4 |
| `janus_ui.py` | The full `PAGE` | 5 |
| `tests/test_ui.py` | Page assertions in the server test | 5 |
| `janus-4.0-spec.md` | §6: one line in the command block, one paragraph | 6 |
| `janus.py` | One docstring line | 6 |

Unchanged: `tests/conftest.py`, `tests/helpers.py`, every other test file, `examples/angular-upgrade/` (slice 5), `skills/`, `pyproject.toml`.

Names used across tasks. Module constants: `JOURNAL_FILE`, `GOAL_FILE`, `SUMMARY_WIDTH = 160`, `CODEX_KINDS = ("codex", "ai_gate")`, `TOKEN_KEYS`, `PAGE: str`. Functions: `read_journal(root: Path) -> (journal: dict, updated: Optional[str], error: Optional[str])`, `parse_time(value) -> Optional[datetime]`, `seconds(entry, now: datetime) -> Optional[int]`, `summary(entry) -> str`, `step_item(key, entry, now) -> dict`, `section_lines(lines, heading) -> List[str]`, `build_tree(steps, path) -> List[dict]` (Task 2 defines it as `build_tree(steps)`; Task 3 adds `path`), `gate_of(steps, raw, lines) -> Optional[dict]`, `mermaid_of(graph, path, current: Optional[dict]) -> Optional[str]`, `build_state(root, now=None) -> dict`, `class Handler(BaseHTTPRequestHandler)` with class attribute `root`, `make_server(root, port) -> ThreadingHTTPServer`, `main(argv=None) -> int`. In `tests/test_ui.py`: `NOW`, `T0`, `T1`, `T2`, `GRAPH`, `CLASSDEFS`, `entry(kind, status, started=T0, finished=None, **fields)`, `write_journal(root, steps, **extra)`, `visit(node, n, next=None)`, `state(root, **steps)`, `names(nodes)`.

---

### Task 1: `build_state` core: files, steps, summaries, seconds, totals, errors

Design §4.2 (`folder`, `flow`, `started`, `updated`, `error`, `goal`, `steps`, `totals` and the step item), §4.4 rows "no `journal.yaml`", "corrupt journal", "entry not a mapping", "bad timestamps", "no `JANUS.md`"; §4.5 cases 1, 2, 8, 9. The fields of later tasks (`tree`, `current`, `gate`, `path`, `mermaid`, `progress`, `decisions`) are returned with their "missing journal" values here and computed in Tasks 2 and 3.

**Files:**
- Create: `janus_ui.py`
- Create: `tests/test_ui.py`
- Modify: `tests/test_init.py` (the `FILES` constant and the first test)

**Interfaces:**
- Consumes: `janus.find_section(lines, heading) -> Optional[Tuple[int, int]]`; `janus.to_mermaid` is imported now and used in Task 3.
- Produces: `build_state(root, now=None) -> dict` with every key of §4.2; `read_journal`, `parse_time`, `seconds`, `summary`, `step_item`, `section_lines` as listed under *File structure*; the test helpers `entry`, `write_journal`, `visit`, `state`, `names` and the constants `NOW`, `T0`, `T1`, `T2`, `GRAPH`, `CLASSDEFS`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_ui.py`:

```python
"""The live page (design 2026-09-24 section 4): ``build_state`` from files written by hand, and the server."""
import http.client
import json
import threading

import pytest
import yaml

import janus_ui

NOW = "2026-09-24T10:10:00"
T0, T1, T2 = "2026-09-24T10:00:00", "2026-09-24T10:00:12", "2026-09-24T10:03:04"
GRAPH = {"start": "a", "nodes": [{"name": "a", "next": {"go": "b", "stop": None}}, {"name": "b", "next": {"": "a"}}]}
CLASSDEFS = ("  classDef visited fill:#1b5e20,stroke:#66bb6a\n  classDef running fill:#0d47a1,stroke:#42a5f5\n"
             "  classDef open fill:#e65100,stroke:#ffb74d\n  classDef failed fill:#b71c1c,stroke:#ef5350")


def entry(kind, status, started=T0, finished=None, **fields):
    """A journal entry as the engine writes it: gates carry no attempt, finished only once it is set."""
    e = {"kind": kind, "status": status}
    if kind not in ("gate", "decision"):
        e["attempt"] = fields.pop("attempt", 1)
    e["started"] = started
    if finished is not None:
        e["finished"] = finished
    e.update(fields)
    return e


def write_journal(root, steps, **extra):
    journal = {"flow": "flow.py", "started": T0, "steps": steps}
    journal.update(extra)
    (root / "journal.yaml").write_text(yaml.safe_dump(journal, sort_keys=False, allow_unicode=True), encoding="utf-8")


def visit(node, n, next=None):
    e = {"node": node, "visit": n, "started": T0}
    if next is not None:
        e.update(finished=T1, next=next)
    return e


def state(root, **steps):
    write_journal(root, steps)
    return janus_ui.build_state(root, now=NOW)


def names(nodes):
    return [(n["name"], names(n["children"])) for n in nodes]


# --- 1, 2: no journal, corrupt journal ------------------------------------------

def test_a_missing_journal_gives_the_empty_state(tmp_path):
    assert janus_ui.build_state(tmp_path, now=NOW) == {
        "folder": tmp_path.name, "flow": "flow.py", "started": None, "updated": None, "error": None, "goal": "",
        "steps": [], "tree": [], "current": None, "gate": None, "path": [], "mermaid": None,
        "progress": [], "decisions": [],
        "totals": {"steps": 0, "done": 0, "failed": 0, "running": 0, "open": 0, "answered": 0, "codex_seconds": 0,
                   "tokens": {"input": 0, "cached": 0, "output": 0, "total": 0, "sessions": 0}}}


@pytest.mark.parametrize("text, error", [
    ("[not a mapping", "journal.yaml is not valid YAML: "),
    ("- a list\n", "journal.yaml is not a mapping"),
    ("", "journal.yaml is not a mapping"),
])
def test_a_corrupt_journal_sets_error_and_reads_as_missing(tmp_path, text, error):
    (tmp_path / "journal.yaml").write_text(text, encoding="utf-8")
    st = janus_ui.build_state(tmp_path, now=NOW)
    assert st["error"].startswith(error) and "\n" not in st["error"]
    assert (st["steps"], st["tree"], st["current"], st["gate"], st["mermaid"], st["updated"]) == \
        ([], [], None, None, None, None)
    assert st["totals"]["steps"] == 0


# --- 8: seconds and summaries ---------------------------------------------------------

def test_seconds_and_summaries_per_status(tmp_path):
    long = "x" * 200
    st = state(tmp_path, **{
        "done": entry("codex", "done", finished=T2, result={"summary": "planned\nmore", "text": "no"}),
        "text": entry("codex", "done", finished=T1, result={"text": long}),
        "plain": entry("step", "done", finished=T1, result="a string result"),
        "answered": entry("gate", "answered", finished=T1, answer="yes\nbut later"),
        "failed": entry("codex", "failed", finished=T1, error="codex exec exited with 3\ntrace"),
        "running": entry("codex", "running"),
        "open": entry("gate", "open", question="Merge it?\nSay merged."),
        "nostart": entry("codex", "running", started=None),
        "badstart": entry("codex", "done", started="yesterday", finished=T1),
        "nofinish": entry("codex", "done")})
    by = {s["key"]: s for s in st["steps"]}
    assert [s["key"] for s in st["steps"]] == list(by)
    assert (by["done"]["seconds"], by["done"]["summary"]) == (184, "planned")
    assert (by["text"]["seconds"], by["text"]["summary"]) == (12, "x" * 157 + "...")
    assert by["plain"]["summary"] == ""
    assert (by["answered"]["seconds"], by["answered"]["summary"], by["answered"]["attempt"]) == (12, "yes", None)
    assert (by["failed"]["seconds"], by["failed"]["summary"]) == (12, "codex exec exited with 3")
    assert (by["running"]["seconds"], by["running"]["summary"]) == (600, "")
    assert (by["open"]["seconds"], by["open"]["summary"]) == (600, "Merge it?")
    assert by["nostart"]["seconds"] is None and by["nostart"]["started"] is None
    assert by["badstart"]["seconds"] is None and by["nofinish"]["seconds"] is None
    assert by["done"]["detail"] == yaml.safe_dump(by["done"] and {
        "kind": "codex", "status": "done", "attempt": 1, "started": T0, "finished": T2,
        "result": {"summary": "planned\nmore", "text": "no"}}, sort_keys=False, allow_unicode=True)
    assert (by["done"]["session"], by["done"]["usage"], by["done"]["started"], by["done"]["finished"]) == \
        (None, None, T0, T2)


# --- 9: totals --------------------------------------------------------------------------

def test_totals_count_statuses_codex_seconds_and_tokens(tmp_path):
    usage = {"input": 100, "cached": 40, "output": 10, "total": 110}
    st = state(tmp_path, **{
        "plan#1": entry("codex", "done", finished=T1, session="a", usage=usage),
        "fix/1": entry("codex", "failed", finished=T2, error="e", session="b"),
        "fix/2": entry("codex", "done", finished=T1, session="c", usage={"input": 50, "cached": 0, "output": 5,
                                                                          "total": 55}),
        "check#1": entry("ai_gate", "done", finished=T1, result=True),
        "wait": entry("step", "done", finished=T2, result=None),
        "gate#1": entry("gate", "answered", finished=T1, answer="yes"),
        "gate#2": entry("gate", "open", question="q"),
        "now": entry("codex", "running")})
    assert st["totals"] == {"steps": 8, "done": 4, "failed": 1, "running": 1, "open": 1, "answered": 1,
                            "codex_seconds": 12 + 184 + 12 + 12 + 600,
                            "tokens": {"input": 150, "cached": 40, "output": 15, "total": 165, "sessions": 2}}
    by = {s["key"]: s for s in st["steps"]}
    assert (by["plan#1"]["session"], by["plan#1"]["usage"]) == ("a", usage)
    assert (by["fix/1"]["session"], by["fix/1"]["usage"]) == ("b", None)
    assert st["flow"] == "flow.py" and st["started"] == T0 and st["updated"] is not None and st["error"] is None
```

The totals of case 9 use the numbers of `tests/test_usage.py::test_status_prints_the_tokens_line_when_any_entry_has_usage` (`165 total, 150 in (40 cached), 15 out over 2 sessions`), so the page and `status` are checked against the same sums.

In `tests/test_init.py`, replace

```python
import janus
from helpers import read_journal

FILES = {"janus.py", "JANUS.md", "flow.py", "prompts/_preamble.md", "prompts/draft.md", ".gitignore"}
```

with

```python
import janus
import janus_ui
from helpers import read_journal

FILES = {"janus.py", "janus_ui.py", "JANUS.md", "flow.py", "prompts/_preamble.md", "prompts/draft.md", ".gitignore"}
```

and replace

```python
    assert (goal / "janus.py").read_text(encoding="utf-8") == open(janus.__file__, encoding="utf-8").read()
```

with

```python
    assert (goal / "janus.py").read_text(encoding="utf-8") == open(janus.__file__, encoding="utf-8").read()
    assert (goal / "janus_ui.py").read_text(encoding="utf-8") == open(janus_ui.__file__, encoding="utf-8").read()
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `uv run pytest -q tests/test_ui.py tests/test_init.py`
Expected: `2 errors` at collection, both `ModuleNotFoundError: No module named 'janus_ui'`.

- [ ] **Step 3: Write the module**

Create `janus_ui.py`:

```python
#!/usr/bin/env python3
"""Janus UI: a live view of one goal folder in the browser (design 2026-09-24 section 4).
``python janus_ui.py [--port N]`` from the goal folder serves http://127.0.0.1:8765 on loopback only. It reads
``journal.yaml`` and ``JANUS.md`` on every poll and never writes, never runs the flow, never commits."""
from __future__ import annotations

import argparse
import datetime as dt
import errno
import json
import sys
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from janus import find_section, to_mermaid

JOURNAL_FILE = "journal.yaml"
GOAL_FILE = "JANUS.md"
SUMMARY_WIDTH = 160
CODEX_KINDS = ("codex", "ai_gate")
TOKEN_KEYS = ("input", "cached", "output", "total")


# --- state -----------------------------------------------------------------

def read_journal(root: Path) -> Tuple[Dict[str, Any], Optional[str], Optional[str]]:
    """(journal, updated, error): the mapping, its mtime as ISO seconds, one error line. A missing file gives
    ({}, None, None); a corrupt one ({}, None, "journal.yaml ...") so the rest reads as for a missing journal."""
    path = root / JOURNAL_FILE
    if not path.exists():
        return {}, None, None
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        return {}, None, f"{JOURNAL_FILE} is not valid YAML: {' '.join(str(exc).split())}"
    if not isinstance(loaded, dict):
        return {}, None, f"{JOURNAL_FILE} is not a mapping"
    return loaded, dt.datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"), None


def parse_time(value: Any) -> Optional[dt.datetime]:
    """An engine timestamp (ISO seconds, a string or already a datetime when YAML resolved it), else None."""
    if isinstance(value, dt.datetime):
        return value
    try:
        return dt.datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


def seconds(entry: Dict[str, Any], now: dt.datetime) -> Optional[int]:
    """Whole seconds from ``started`` to ``finished``, or to ``now`` while running or open; None when unparsable."""
    started = parse_time(entry.get("started"))
    finished = now if entry.get("status") in ("running", "open") else parse_time(entry.get("finished"))
    return None if started is None or finished is None else int((finished - started).total_seconds())


def summary(entry: Dict[str, Any]) -> str:
    """One line of at most 160 characters: the result's summary or text, the answer, the error or the question."""
    status, result = entry.get("status"), entry.get("result")
    if status == "done":
        text = next((result[k] for k in ("summary", "text") if isinstance(result, dict)
                     and isinstance(result.get(k), str)), "")
    else:
        field = {"answered": "answer", "failed": "error", "open": "question"}.get(status)
        text = entry.get(field) if field else ""
    line = str(text).splitlines()[0] if text else ""
    return line if len(line) <= SUMMARY_WIDTH else line[:SUMMARY_WIDTH - 3] + "..."


def step_item(key: str, entry: Dict[str, Any], now: dt.datetime) -> Dict[str, Any]:
    usage = entry.get("usage")
    return {"key": key, "kind": entry.get("kind"), "status": entry.get("status"), "attempt": entry.get("attempt"),
            "session": entry.get("session"), "usage": usage if isinstance(usage, dict) else None,
            "started": entry.get("started"), "finished": entry.get("finished"), "seconds": seconds(entry, now),
            "summary": summary(entry), "detail": yaml.safe_dump(entry, sort_keys=False, allow_unicode=True)}


def section_lines(lines: List[str], heading: str) -> List[str]:
    span = find_section(lines, heading)
    return [] if span is None else lines[span[0] + 1:span[1]]


def build_state(root: Path, now: Any = None) -> Dict[str, Any]:
    """The page's state from journal.yaml and JANUS.md (design 4.2); ``now`` (ISO string or datetime) for tests."""
    root, clock = Path(root), parse_time(now) or dt.datetime.now()
    journal, updated, error = read_journal(root)
    raw = journal.get("steps") if isinstance(journal.get("steps"), dict) else {}
    steps = [step_item(str(k), e, clock) for k, e in raw.items() if isinstance(e, dict)]
    goal_path = root / GOAL_FILE
    lines = goal_path.read_text(encoding="utf-8").splitlines() if goal_path.exists() else []
    used = [s["usage"] for s in steps if s["usage"]]
    tokens = {k: sum(u.get(k, 0) for u in used) for k in TOKEN_KEYS}
    tokens["sessions"] = len(used)
    totals = {"steps": len(steps), **{st: sum(1 for s in steps if s["status"] == st)
                                      for st in ("done", "failed", "running", "open", "answered")},
              "codex_seconds": sum(s["seconds"] or 0 for s in steps if s["kind"] in CODEX_KINDS), "tokens": tokens}
    return {"folder": root.resolve().name, "flow": journal.get("flow", "flow.py"), "started": journal.get("started"),
            "updated": updated, "error": error, "goal": "\n".join(section_lines(lines, "# Goal")).strip(),
            "steps": steps, "tree": [], "current": None,
            "gate": None, "path": [],
            "mermaid": None,
            "progress": [], "decisions": [],
            "totals": totals}
```

The imports `argparse`, `errno`, `json`, `sys`, `Counter`, `BaseHTTPRequestHandler`, `ThreadingHTTPServer` and `to_mermaid` are used by Tasks 3 and 4; they are placed now so later tasks only append code and edit `build_state`.

- [ ] **Step 4: Run the tests to see them pass, then the whole suite**

Run: `uv run pytest -q tests/test_ui.py tests/test_init.py`
Expected: `10 passed` (6 in `test_ui.py`, 4 in `test_init.py`).

Run: `uv run pytest -q`
Expected: `186 passed`. `janus_ui.py` is 108 lines.

- [ ] **Step 5: Commit**

```bash
git add janus_ui.py tests/test_ui.py tests/test_init.py
git commit -m "feat(ui): build_state reads the journal and goal file into steps, totals and errors" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MghcFnosThAtjAmtNQrbEw"
```

---

### Task 2: The tree, `current`, the gate, progress and decisions

Design §4.2 (`tree`, `current`, `gate`, `progress`, `decisions`), §4.4 row "no `JANUS.md`"; §4.5 cases 3, 4, 5, 6, 7, 10. The tree's `next` labels need the path and come in Task 3; here every `next` is null.

**Files:**
- Modify: `janus_ui.py` (new functions before `build_state`; three edits inside it)
- Modify: `tests/test_ui.py` (append)

**Interfaces:**
- Consumes: `step_item` output (`key`, `status`, `seconds`, `kind`), `section_lines`, `find_section`.
- Produces: `build_tree(steps) -> List[dict]` (Task 3 changes it to `build_tree(steps, path)`), `gate_of(steps, raw, lines) -> Optional[dict]`; `current` as a key or null; `progress` and `decisions` lists.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_ui.py`:

```python


# --- 3, 4, 5: the tree -------------------------------------------------------------

def test_tree_nests_keys_split_on_slash_in_first_appearance_order(tmp_path):
    st = state(tmp_path, **{"review#2/review#1": entry("codex", "done", finished=T1),
                            "implement#1/implement#1/1": entry("codex", "done", finished=T1),
                            "implement#1/implement#1/2": entry("codex", "done", finished=T2),
                            "implement#1/wait": entry("step", "done", finished=T1)})
    assert names(st["tree"]) == [("review#2", [("review#1", [])]),
                                 ("implement#1", [("implement#1", [("1", []), ("2", [])]), ("wait", [])])]
    ralph = st["tree"][1]["children"][0]
    assert ralph["key"] == "implement#1/implement#1" and ralph["children"][1]["key"] == "implement#1/implement#1/2"
    assert [c["seconds"] for c in ralph["children"]] == [12, 184] and ralph["seconds"] == 196
    assert st["tree"][1]["seconds"] == 208 and st["tree"][0]["children"][0]["seconds"] == 12
    assert all(n["next"] is None for n in st["tree"])


def test_a_group_rolls_up_running_over_failed_over_done(tmp_path):
    st = state(tmp_path, **{"a#1/x": entry("codex", "done", finished=T1), "a#1/y": entry("codex", "running"),
                            "b#1/x": entry("codex", "failed", finished=T1, error="boom"),
                            "b#1/y": entry("codex", "done", finished=T1),
                            "c#1/gate#1": entry("gate", "open", question="ok?"),
                            "d#1/x": entry("codex", "done", finished=T1),
                            "d#1/gate#1": entry("gate", "answered", finished=T1, answer="yes")})
    assert [(n["name"], n["status"]) for n in st["tree"]] == \
        [("a#1", "running"), ("b#1", "failed"), ("c#1", "running"), ("d#1", "done")]
    assert st["tree"][2]["seconds"] == 600


def test_a_key_that_is_both_an_entry_and_a_prefix_keeps_its_status_and_lists_its_children(tmp_path):
    st = state(tmp_path, **{"build": entry("step", "done", finished=T2, result="built"),
                            "build/1": entry("codex", "failed", finished=T1, error="no")})
    assert names(st["tree"]) == [("build", [("1", [])])]
    assert (st["tree"][0]["status"], st["tree"][0]["seconds"]) == ("done", 184)
    assert (st["tree"][0]["children"][0]["status"], st["tree"][0]["children"][0]["seconds"]) == ("failed", 12)
    assert st["current"] == "build/1"


# --- 6, 7: current and the gate -----------------------------------------------------

def test_current_is_the_first_running_or_open_else_the_last_failed(tmp_path):
    done, running = entry("codex", "done", finished=T1), entry("codex", "running")
    failed, gate = entry("codex", "failed", finished=T1, error="x"), entry("gate", "open", question="q")
    assert state(tmp_path, a=done, b=failed, c=running, d=gate)["current"] == "c"
    assert state(tmp_path, a=gate, b=running)["current"] == "a"
    assert state(tmp_path, a=failed, b=done, c=failed)["current"] == "c"
    assert state(tmp_path, a=done, b=done)["current"] is None
    assert state(tmp_path)["current"] is None


def test_gate_carries_the_verbatim_section_or_an_empty_string(tmp_path):
    (tmp_path / "JANUS.md").write_text(
        "# Goal\nUpgrade the widget.\n\n## Gate: blocked#1/decision#1\nRetry or stop?\n    One of: retry, stop.\n\n"
        "    round 3 of 3\n\nanswer:\n\n## Progress\n- 2026-09-24T10:00:00 hi\n", encoding="utf-8")
    st = state(tmp_path, **{"plan#1": entry("codex", "done", finished=T1),
                            "blocked#1/decision#1": entry("decision", "open", question="Retry or stop?\nOne of: ..."),
                            "other#1/gate#1": entry("gate", "open", question="second")})
    assert st["gate"] == {"key": "blocked#1/decision#1", "kind": "decision", "question": "Retry or stop?\nOne of: ...",
                          "section": "## Gate: blocked#1/decision#1\nRetry or stop?\n    One of: retry, stop.\n\n"
                                     "    round 3 of 3\n\nanswer:"}
    assert st["goal"] == "Upgrade the widget." and st["progress"] == ["- 2026-09-24T10:00:00 hi"]
    (tmp_path / "JANUS.md").unlink()
    st = janus_ui.build_state(tmp_path, now=NOW)
    assert st["gate"]["section"] == "" and st["goal"] == "" and st["progress"] == [] and st["decisions"] == []
    assert state(tmp_path, **{"plan#1": entry("codex", "done", finished=T1)})["gate"] is None


# --- 10: progress and decisions -------------------------------------------------------

def test_progress_and_decisions_are_the_section_lines_verbatim(tmp_path):
    (tmp_path / "JANUS.md").write_text(
        "# Goal\nDo it.\n\n## Progress\n- 2026-09-24T10:00:00 plan#1: started\n  detail line\n\n"
        "## Decisions\n- 2026-09-24 gate#1: Merge it?\n  answer: yes\n", encoding="utf-8")
    st = janus_ui.build_state(tmp_path, now=NOW)
    assert st["progress"] == ["- 2026-09-24T10:00:00 plan#1: started", "  detail line", ""]
    assert st["decisions"] == ["- 2026-09-24 gate#1: Merge it?", "  answer: yes"]
    assert st["goal"] == "Do it."
```

The gate section in case 7 ends at `answer:` without a trailing newline: `find_section` ends a `## Gate: ` section at the blank line that precedes the next heading (observed, see *Verified facts*).

- [ ] **Step 2: Run the tests to see them fail**

Run: `uv run pytest -q tests/test_ui.py`
Expected: `6 failed, 6 passed`; the three tree tests fail on `names(st["tree"])` or the rollup list (`assert [] == [...]`, the tree is still `[]`), the current test with `assert None == 'c'`, the gate test with `assert None == {...}`, the progress test with `assert [] == [...]`.

- [ ] **Step 3: Build the tree, pick `current`, read the gate and the two sections**

In `janus_ui.py`, replace

```python
def build_state(root: Path, now: Any = None) -> Dict[str, Any]:
```

with

```python
def build_tree(steps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keys split on '/': a journal key's node carries its status and seconds, a group rolls its children up
    (running if any is running or open, else failed if any failed, else done) and sums their seconds."""
    roots: List[Dict[str, Any]] = []
    nodes: Dict[str, Dict[str, Any]] = {}
    for item in steps:
        siblings, prefix = roots, ""
        for part in item["key"].split("/"):
            prefix = f"{prefix}/{part}" if prefix else part
            if prefix not in nodes:
                nodes[prefix] = {"name": part, "key": prefix, "status": None, "seconds": None, "next": None,
                                 "children": []}
                siblings.append(nodes[prefix])
            siblings = nodes[prefix]["children"]
        nodes[item["key"]].update(status=item["status"], seconds=item["seconds"])

    def roll(node: Dict[str, Any]) -> None:
        for child in node["children"]:
            roll(child)
        if node["status"] is None and node["children"]:
            statuses = [c["status"] for c in node["children"]]
            node["status"] = ("running" if any(s in ("running", "open") for s in statuses)
                              else "failed" if "failed" in statuses else "done")
            timed = [c["seconds"] for c in node["children"] if c["seconds"] is not None]
            node["seconds"] = sum(timed) if timed else None

    for root in roots:
        roll(root)
    return roots


def gate_of(steps: List[Dict[str, Any]], raw: Dict[str, Any], lines: List[str]) -> Optional[Dict[str, Any]]:
    """The first open entry with its verbatim ``## Gate: <key>`` section of JANUS.md (heading included)."""
    for s in steps:
        if s["status"] == "open":
            span = find_section(lines, f"## Gate: {s['key']}")
            return {"key": s["key"], "kind": s["kind"], "question": raw[s["key"]].get("question"),
                    "section": "\n".join(lines[span[0]:span[1]]) if span else ""}
    return None


def build_state(root: Path, now: Any = None) -> Dict[str, Any]:
```

In `janus_ui.py`, inside `build_state`, replace

```python
    goal_path = root / GOAL_FILE
```

with

```python
    live = [s for s in steps if s["status"] in ("running", "open")]
    failed = [s for s in steps if s["status"] == "failed"]
    current = live[0] if live else failed[-1] if failed else None
    goal_path = root / GOAL_FILE
```

and replace

```python
            "steps": steps, "tree": [], "current": None,
            "gate": None, "path": [],
```

with

```python
            "steps": steps, "tree": build_tree(steps), "current": current["key"] if current else None,
            "gate": gate_of(steps, raw, lines), "path": [],
```

and replace

```python
            "progress": [], "decisions": [],
```

with

```python
            "progress": section_lines(lines, "## Progress"), "decisions": section_lines(lines, "## Decisions"),
```

- [ ] **Step 4: Run the tests to see them pass, then the whole suite**

Run: `uv run pytest -q tests/test_ui.py`
Expected: `12 passed`.

Run: `uv run pytest -q`
Expected: `192 passed`. `janus_ui.py` is 152 lines.

- [ ] **Step 5: Commit**

```bash
git add janus_ui.py tests/test_ui.py
git commit -m "feat(ui): the step tree with rollups, the current step, the open gate and the goal file sections" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MghcFnosThAtjAmtNQrbEw"
```

---

### Task 3: `path`, `mermaid` classes and counts, tree `next` labels

Design §4.2 (`path`, `mermaid`, the tree's `next`), §4.4 row "script flow"; §2.3 (path entries), §2.5 (`to_mermaid`); §4.5 cases 11 and 12.

**Files:**
- Modify: `janus_ui.py` (`build_tree` gains `path`; `mermaid_of` before `build_state`; three edits inside it)
- Modify: `tests/test_ui.py` (append)

**Interfaces:**
- Consumes: `janus.to_mermaid(graph, classes, counts)` with `counts` keyed by `(node, label)`; the journal's `graph` and `path`.
- Produces: `build_tree(steps, path)`, `mermaid_of(graph, path, current) -> Optional[str]`; `path` and `mermaid` in the state; `next` on top-level tree nodes.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_ui.py`:

```python


# --- 11, 12: mermaid classes and counts, tree next labels ----------------------------

def test_mermaid_is_null_for_a_script_journal(tmp_path):
    st = state(tmp_path, **{"plan#1": entry("codex", "done", finished=T1)})
    assert st["mermaid"] is None and st["path"] == []


@pytest.mark.parametrize("steps, cls", [
    ({}, "running"),
    ({"b#2/plan#1": entry("codex", "running")}, "running"),
    ({"b#2/gate#1": entry("gate", "open", question="q")}, "open"),
    ({"b#2/plan#1": entry("codex", "failed", finished=T1, error="e")}, "failed"),
])
def test_mermaid_classes_follow_the_path_and_current(tmp_path, steps, cls):
    path = [visit("a", 1, "go"), visit("b", 1, ""), visit("a", 2, "go"), visit("b", 2)]
    write_journal(tmp_path, steps, graph=GRAPH, path=path)
    st = janus_ui.build_state(tmp_path, now=NOW)
    assert st["path"] == path
    assert st["mermaid"] == ("flowchart LR\n  a -- go (2) --> b\n  a -- stop --> END\n  b -- (1) --> a\n  END([END])\n"
                             f"  class a visited\n  class b {cls}\n" + CLASSDEFS)


def test_mermaid_after_the_flow_ended_marks_every_node_visited(tmp_path):
    write_journal(tmp_path, {"a#1/plan#1": entry("codex", "done", finished=T1)}, graph=GRAPH,
                  path=[visit("a", 1, "stop")])
    assert janus_ui.build_state(tmp_path, now=NOW)["mermaid"] == \
        ("flowchart LR\n  a -- go --> b\n  a -- stop (1) --> END\n  b --> a\n  END([END])\n  class a visited\n"
         + CLASSDEFS)


def test_tree_next_labels_come_from_the_finished_path_entries(tmp_path):
    write_journal(tmp_path, {"a#1/plan#1": entry("codex", "done", finished=T1),
                             "b#1/gate#1": entry("gate", "answered", finished=T1, answer="ok"),
                             "a#2/plan#1": entry("codex", "done", finished=T1),
                             "b#2/plan#1": entry("codex", "running"),
                             "loose": entry("step", "done", finished=T1)},
                  graph=GRAPH, path=[visit("a", 1, "go"), visit("b", 1, ""), visit("a", 2, "go"), visit("b", 2)])
    st = janus_ui.build_state(tmp_path, now=NOW)
    assert [(n["name"], n["next"]) for n in st["tree"]] == \
        [("a#1", "go"), ("b#1", ""), ("a#2", "go"), ("b#2", None), ("loose", None)]
    assert all(c["next"] is None for n in st["tree"] for c in n["children"])
    assert st["current"] == "b#2/plan#1"
```

The parametrised case covers the four classes of the unfinished last visit: no step under it yet (`running`), a running step, an open gate, a failed step. `b` was finished at visit 1, so it is first `visited` and then overridden; its `class` line keeps the second position.

- [ ] **Step 2: Run the tests to see them fail**

Run: `uv run pytest -q tests/test_ui.py`
Expected: `6 failed, 13 passed`; the four parametrised class tests fail at `assert st["path"] == path` (`assert [] == [{'node': 'a', ...}]`, the `path` is still `[]`), the ended-flow test with `AssertionError: assert None == ('flowchart LR\n  a -- go --> b ...`, the labels test with `assert [('a#1', None), ...] == [('a#1', 'go'), ...]`. `test_mermaid_is_null_for_a_script_journal` already passes.

- [ ] **Step 3: Read the path, classify the nodes, label the visits**

In `janus_ui.py`, replace

```python
def build_tree(steps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keys split on '/': a journal key's node carries its status and seconds, a group rolls its children up
    (running if any is running or open, else failed if any failed, else done) and sums their seconds."""
```

with

```python
def build_tree(steps: List[Dict[str, Any]], path: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keys split on '/': a journal key's node carries its status and seconds, a group rolls its children up
    (running if any is running or open, else failed if any failed, else done) and sums their seconds; a top-level
    node named after a finished path visit gets that visit's label as ``next``."""
```

and replace

```python
    for root in roots:
        roll(root)
    return roots
```

with

```python
    labels = {f"{e['node']}#{e['visit']}": e.get("next") for e in path if e.get("finished")}
    for root in roots:
        roll(root)
        root["next"] = labels.get(root["key"])
    return roots
```

and replace

```python
def build_state(root: Path, now: Any = None) -> Dict[str, Any]:
```

with

```python
def mermaid_of(graph: Any, path: List[Dict[str, Any]], current: Optional[Dict[str, Any]]) -> Optional[str]:
    """The map with every finished visit's node ``visited``, the unfinished last visit's node after ``current``'s
    status (``running`` without a current step), and ``(n)`` counts on the edges the finished visits took."""
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
        return None
    finished = [e for e in path if e.get("finished")]
    classes = {e["node"]: "visited" for e in finished}
    if path and not path[-1].get("finished"):
        status = current["status"] if current else "running"
        classes[path[-1]["node"]] = status if status in ("running", "open", "failed") else "running"
    return to_mermaid(graph, classes, dict(Counter((e["node"], e.get("next", "")) for e in finished)))


def build_state(root: Path, now: Any = None) -> Dict[str, Any]:
```

In `janus_ui.py`, inside `build_state`, replace

```python
    steps = [step_item(str(k), e, clock) for k, e in raw.items() if isinstance(e, dict)]
```

with

```python
    steps = [step_item(str(k), e, clock) for k, e in raw.items() if isinstance(e, dict)]
    path = [e for e in journal.get("path", []) if isinstance(e, dict)] if isinstance(journal.get("path"), list) else []
```

and replace

```python
            "steps": steps, "tree": build_tree(steps), "current": current["key"] if current else None,
            "gate": gate_of(steps, raw, lines), "path": [],
            "mermaid": None,
```

with

```python
            "steps": steps, "tree": build_tree(steps, path), "current": current["key"] if current else None,
            "gate": gate_of(steps, raw, lines), "path": path,
            "mermaid": mermaid_of(journal.get("graph"), path, current),
```

- [ ] **Step 4: Run the tests to see them pass, then the whole suite**

Run: `uv run pytest -q tests/test_ui.py`
Expected: `19 passed`.

Run: `uv run pytest -q`
Expected: `199 passed`. `janus_ui.py` is 169 lines.

- [ ] **Step 5: Commit**

```bash
git add janus_ui.py tests/test_ui.py
git commit -m "feat(ui): the path, mermaid classes and counts, and next labels on the visit rows" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MghcFnosThAtjAmtNQrbEw"
```

---

### Task 4: The server and `main`

Design §4.1 (routes, headers, loopback, silenced logging, `make_server`, `main`, the port-in-use line); §4.5 the server test. `PAGE` is a three-line stub here; Task 5 writes the page.

**Files:**
- Modify: `janus_ui.py` (append the server section, the stub `PAGE` and the `__main__` guard)
- Modify: `tests/test_ui.py` (append)

**Interfaces:**
- Consumes: `build_state(root)`.
- Produces: `Handler` (class attribute `root: Path`), `make_server(root, port) -> ThreadingHTTPServer` (with `port` 0 the chosen port is `server.server_address[1]`), `main(argv=None) -> int`, `PAGE: str` (replaced whole in Task 5).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_ui.py`:

```python


# --- the server --------------------------------------------------------------------------

def test_server_serves_the_page_and_the_state_and_404s_the_rest(tmp_path):
    write_journal(tmp_path, {"plan#1": entry("codex", "done", finished=T1, result={"summary": "ok"})})
    server = janus_ui.make_server(tmp_path, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
        conn.request("GET", "/")
        r = conn.getresponse()
        body = r.read().decode("utf-8")
        assert (r.status, r.getheader("Content-Type")) == (200, "text/html; charset=utf-8")
        assert "<title>" in body
        conn.request("GET", "/state.json")
        r = conn.getresponse()
        st = json.loads(r.read().decode("utf-8"))
        assert (r.status, r.getheader("Content-Type"), r.getheader("Cache-Control")) == \
            (200, "application/json", "no-store")
        assert st["folder"] == tmp_path.name and [s["key"] for s in st["steps"]] == ["plan#1"]
        conn.request("GET", "/nope")
        r = conn.getresponse()
        r.read()
        assert r.status == 404
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_main_reports_a_port_in_use(tmp_path, monkeypatch, capsys):
    taken = janus_ui.make_server(tmp_path, 0)
    try:
        port = taken.server_address[1]
        monkeypatch.chdir(tmp_path)
        assert janus_ui.main(["--port", str(port)]) == 1
        assert capsys.readouterr().err == f"janus_ui: port {port} is in use; try --port {port + 1}\n"
    finally:
        taken.server_close()
```

The second test needs no thread: a bound, listening socket is enough for a second bind on the same port to fail with `EADDRINUSE` (observed; `ThreadingHTTPServer`'s `allow_reuse_address` only frees `TIME_WAIT` ports).

- [ ] **Step 2: Run the tests to see them fail**

Run: `uv run pytest -q tests/test_ui.py`
Expected: `2 failed, 19 passed`, both `AttributeError: module 'janus_ui' has no attribute 'make_server'`.

- [ ] **Step 3: Write the handler, the server factory and `main`**

Append to `janus_ui.py`:

```python


# --- server ----------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    root = Path(".")  # make_server sets it on a subclass

    def do_GET(self) -> None:
        route = self.path.split("?")[0]
        if route == "/":
            self.reply(200, "text/html; charset=utf-8", PAGE.encode("utf-8"))
        elif route == "/state.json":
            try:
                body = json.dumps(build_state(self.root), default=str).encode("utf-8")
            except Exception as exc:  # the page keeps its last state and reddens the dot with this text
                self.reply(500, "text/plain; charset=utf-8", f"{type(exc).__name__}: {exc}".encode("utf-8"))
                return
            self.reply(200, "application/json", body)
        else:
            self.reply(404, "text/plain; charset=utf-8", b"not found\n")

    def reply(self, code: int, content_type: str, body: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - the base class names it so
        pass


def make_server(root: Path, port: int) -> ThreadingHTTPServer:
    """A loopback server for ``root``; port 0 picks a free one (``server.server_address[1]`` tells which)."""
    handler = type("JanusHandler", (Handler,), {"root": Path(root)})
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="janus_ui.py", description="Janus UI: a live view of this goal folder")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    try:
        server = make_server(Path.cwd(), args.port)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise
        print(f"janus_ui: port {args.port} is in use; try --port {args.port + 1}", file=sys.stderr)
        return 1
    print(f"janus_ui: {Path.cwd().resolve().name} at http://127.0.0.1:{args.port} (Ctrl-C stops)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


# --- page ------------------------------------------------------------------

PAGE = r"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Janus</title></head><body>Janus</body></html>
"""

if __name__ == "__main__":
    sys.exit(main())
```

`Cache-Control: no-store` goes on every reply (the spec asks for it on `/state.json`; on `/` it only means a reload fetches the page again, which is what one wants after editing `PAGE`).

- [ ] **Step 4: Run the tests to see them pass, then the whole suite**

Run: `uv run pytest -q tests/test_ui.py`
Expected: `21 passed`.

Run: `uv run pytest -q`
Expected: `201 passed`. `janus_ui.py` is 237 lines.

- [ ] **Step 5: Try it by hand**

From the worktree root, with `tests/` as an example of a folder without a journal:

```bash
(cd tests && python3 ../janus_ui.py --port 8791 & sleep 1; curl -s -i http://127.0.0.1:8791/state.json | head -5; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8791/nope; kill %1)
```

Expected: the line `janus_ui: tests at http://127.0.0.1:8791 (Ctrl-C stops)`, then `HTTP/1.0 200 OK`, `Content-Type: application/json`, `Cache-Control: no-store`, then `404`. Nothing else is printed (request logging is silenced).

- [ ] **Step 6: Commit**

```bash
git add janus_ui.py tests/test_ui.py
git commit -m "feat(ui): serve the page and state.json on loopback; main parses --port" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MghcFnosThAtjAmtNQrbEw"
```

---

### Task 5: The page

Design §4.3 in full; §4.4 rows "no `journal.yaml`" (page says "nothing has run yet") and "script flow" (map hidden). The page cannot be unit-tested here beyond what it contains; the server test gains assertions on the strings the design names, and the module is looked at in a browser in Task 6.

**Files:**
- Modify: `janus_ui.py` (replace the stub `PAGE`)
- Modify: `tests/test_ui.py` (one assertion in the server test)

**Interfaces:**
- Consumes: the state of §4.2 as JSON from `/state.json`; the mermaid text with `class` and `classDef` lines from `to_mermaid`.
- Produces: `PAGE`, the whole page.

- [ ] **Step 1: Extend the server test**

In `tests/test_ui.py`, replace

```python
        assert "<title>" in body
```

with

```python
        assert "<title>" in body and "nothing has run yet" in body and "/state.json" in body
        assert "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js" in body
        assert body.count("https://") == 1  # mermaid is the only external resource
```

- [ ] **Step 2: Run the test to see it fail**

Run: `uv run pytest -q tests/test_ui.py -k server`
Expected: `1 failed, 20 deselected`; the assertion `"nothing has run yet" in body` fails against the stub page.

- [ ] **Step 3: Write the page**

In `janus_ui.py`, replace

```python
PAGE = r"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Janus</title></head><body>Janus</body></html>
"""
```

with

```python
PAGE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Janus</title>
<style>
  :root { --bg: #14161a; --panel: #1c1f25; --line: #2c313a; --fg: #d6d9de; --dim: #8a919c;
          --done: #66bb6a; --running: #42a5f5; --open: #ffb74d; --failed: #ef5350; }
  body { margin: 0; padding: 16px 24px; background: var(--bg); color: var(--fg); min-width: 1000px;
         font: 14px/1.45 system-ui, sans-serif; }
  code, pre, .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
  pre { background: var(--panel); border: 1px solid var(--line); padding: 10px; margin: 0; white-space: pre-wrap;
        overflow-wrap: anywhere; max-height: 60vh; overflow: auto; }
  h1 { font-size: 18px; margin: 0 0 4px; } h2 { font-size: 14px; color: var(--dim); margin: 18px 0 6px; }
  #head { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  #dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--dim); }
  #dot.ok { background: var(--done); } #dot.bad { background: var(--failed); }
  .meta { color: var(--dim); } #error { color: var(--failed); }
  #gate { border: 1px solid var(--open); background: #2a2113; padding: 10px 12px; margin-top: 14px; }
  #gate b { color: var(--open); }
  #map { margin-top: 8px; } #map svg { max-width: 100%; height: auto; }
  #cols { display: grid; grid-template-columns: minmax(360px, 1fr) 2fr; gap: 20px; margin-top: 4px; }
  .row { display: flex; gap: 8px; padding: 2px 6px; cursor: pointer; border-radius: 3px; white-space: nowrap; }
  .row:hover { background: var(--panel); } .row.current { outline: 1px solid var(--running); }
  .row.selected { background: var(--line); }
  .row .name { flex: 1; } .row .meta { font-size: 12px; }
  .done, .answered { color: var(--done); } .running { color: var(--running); }
  .open { color: var(--open); } .failed { color: var(--failed); }
  .arrow { width: 12px; display: inline-block; color: var(--dim); }
  #detail dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 8px; }
  #detail dt { color: var(--dim); } #detail dd { margin: 0; }
  #panels { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
</style>
</head>
<body>
<div id="head"><h1 id="folder">Janus</h1><span id="dot" title="waiting for the first poll"></span>
  <span id="totals" class="meta"></span><span id="error"></span></div>
<div id="meta" class="meta"></div>
<div id="gate" hidden></div>
<div id="mapwrap" hidden><h2>Map</h2><div id="map"></div></div>
<div id="cols">
  <div><h2>Steps</h2><div id="tree" class="mono"></div></div>
  <div><h2>Detail</h2><div id="detail"></div></div>
</div>
<div id="panels">
  <div><h2>Progress</h2><pre id="progress"></pre></div>
  <div><h2>Decisions</h2><pre id="decisions"></pre></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
"use strict";
const collapsed = new Set();   // the user's toggles survive polls
let selected = null, lastMermaid = null, renders = 0, loaded = false;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls;
                                 if (text !== undefined) e.textContent = text; return e; };
const pad = (n) => String(n).padStart(2, "0");
const dur = (s) => s == null ? "" : s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m" + pad(s % 60) + "s"
                   : Math.floor(s / 3600) + "h" + pad(Math.floor(s % 3600 / 60)) + "m";
const tok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n);

function ancestors(key) {  // "a/b/c" -> ["a", "a/b"]
  const parts = key.split("/"), out = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

function renderHeader(st) {
  $("folder").textContent = st.folder;
  const t = st.totals, bits = [t.steps + " steps", t.done + " done"];
  for (const k of ["failed", "running", "open", "answered"]) if (t[k]) bits.push(t[k] + " " + k);
  if (t.codex_seconds) bits.push("codex " + dur(t.codex_seconds));
  if (t.tokens.sessions) bits.push(tok(t.tokens.total) + " tokens in " + t.tokens.sessions + " sessions");
  $("totals").textContent = bits.join(", ");
  $("error").textContent = st.error || "";
  $("meta").textContent = st.flow + (st.started ? ", started " + st.started : "")
                          + (st.updated ? ", updated " + st.updated : "") + (st.goal ? " — " + st.goal : "");
}

function renderGate(g) {
  const box = $("gate");
  box.hidden = !g; box.replaceChildren();
  if (!g) return;
  box.append(el("div", "", ""), el("div", "", g.question || ""), el("pre", "", g.section || ""),
             el("div", "meta", "Answer it in JANUS.md, then run `python janus.py run` again."));
  box.firstChild.append(el("b", "", "Gate " + g.key), el("span", "meta", "  (" + g.kind + ")"));
}

async function renderMap(text) {
  $("mapwrap").hidden = !text;
  if (!text || text === lastMermaid) return;   // re-rendered only when the text changes: no flicker
  lastMermaid = text;
  const map = $("map");
  if (!window.mermaid) { map.replaceChildren(el("pre", "", text)); return; }
  try {
    const { svg } = await mermaid.render("janusmap" + (++renders), text);
    map.innerHTML = svg;
  } catch (e) { map.replaceChildren(el("pre", "", text + "\n\n" + e)); }
}

function renderTree(st) {
  const tree = $("tree"), byKey = {};
  for (const s of st.steps) byKey[s.key] = s;
  tree.replaceChildren();
  if (!st.steps.length) { tree.append(el("div", "meta", "nothing has run yet")); return; }
  if (selected && !byKey[selected]) selected = null;
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const step = byKey[n.key], group = n.children.length > 0, shut = collapsed.has(n.key);
      const row = el("div", "row " + (n.status || "") + (n.key === st.current ? " current" : "")
                            + (n.key === (selected || st.current) ? " selected" : ""));
      row.style.paddingLeft = (6 + depth * 18) + "px";
      row.append(el("span", "arrow", group ? (shut ? "▸" : "▾") : ""));
      row.append(el("span", "name", n.name + (step && step.attempt > 1 ? " #" + step.attempt : "")));
      if (step && step.usage && step.usage.total != null)
        row.append(el("span", "meta", tok(step.usage.total) + " tok"));
      if (n.seconds != null) row.append(el("span", "meta", dur(n.seconds)));
      if (n.next != null) row.append(el("span", "meta", "→ " + n.next));
      row.onclick = () => {
        if (group) collapsed.has(n.key) ? collapsed.delete(n.key) : collapsed.add(n.key);
        if (step) selected = n.key;
        render(st);
      };
      tree.append(row);
      if (group && !shut) walk(n.children, depth + 1);
    }
  };
  walk(st.tree, 0);
}

function renderDetail(st) {
  const box = $("detail"), key = selected || st.current;
  const step = st.steps.find((s) => s.key === key);
  box.replaceChildren();
  if (!step) { box.append(el("div", "meta", key ? key : "select a step")); return; }
  const dl = el("dl");
  for (const [k, v] of [["key", step.key], ["kind", step.kind], ["status", step.status], ["attempt", step.attempt],
                        ["started", step.started], ["finished", step.finished], ["seconds", dur(step.seconds)]]) {
    dl.append(el("dt", "", k), el("dd", k === "status" ? step.status : "mono", v == null ? "" : String(v)));
  }
  box.append(dl, el("pre", "", step.detail));
}

function render(st) {
  if (!loaded) {   // on load every group is collapsed except the ancestors of current
    loaded = true;
    const keep = new Set(st.current ? ancestors(st.current) : []);
    const mark = (nodes) => { for (const n of nodes) { if (n.children.length && !keep.has(n.key)) collapsed.add(n.key);
                                                       mark(n.children); } };
    mark(st.tree);
  }
  renderHeader(st); renderGate(st.gate); renderMap(st.mermaid); renderTree(st); renderDetail(st);
  $("progress").textContent = st.progress.join("\n"); $("decisions").textContent = st.decisions.join("\n");
}

async function poll() {
  try {
    const r = await fetch("/state.json", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status + ": " + (await r.text()).trim());
    render(await r.json());
    $("dot").className = "ok"; $("dot").title = "live";
  } catch (e) { $("dot").className = "bad"; $("dot").title = String(e); }
}

if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict",
  themeVariables: { primaryColor: "#3a3f47", primaryBorderColor: "#8a919c", primaryTextColor: "#e6e9ee",
                    lineColor: "#8a919c", edgeLabelBackground: "#14161a", fontFamily: "system-ui, sans-serif" } });
poll(); setInterval(poll, 2000);
</script>
</body>
</html>
"""
```

How the page meets §4.3, piece by piece: **header** `#folder`, `#meta` (flow, started, updated, goal), `#totals` built by `renderHeader` (`12 steps, 10 done, 1 failed, codex 23m10s, 1.2M tokens in 9 sessions`; counts of zero and empty token totals are left out), `#dot` green with title `live` after a good poll and red with the error as title after a bad one, `#error` in red. **Gate banner** `#gate`, hidden unless `gate` is set, with the key in bold, the question, the section in a `<pre>` and the closing sentence. **Map** `#mapwrap`, hidden when `mermaid` is null (script flow); `renderMap` keeps `lastMermaid` and calls `mermaid.render` only when the text changed; without `window.mermaid` (or when rendering throws) the text goes into a `<pre>`; the four classes are coloured by the `classDef` lines in the text, unvisited nodes by the theme's grey `primaryColor`. **Tree** `#tree`: `renderTree` walks `state.tree`, indents by depth, colours rows by status class, labels with `name` plus ` #n` when the step's attempt is above 1, then `41k tok` from `usage.total`, the duration from `dur` (`12s`, `3m04s`, `1h02m`), and `→ label` for a top-level visit; groups toggle through the `collapsed` set, keys with a step select; `current` gets the `current` outline and is the default selection; "nothing has run yet" when `steps` is empty; on the first render every group outside the ancestors of `current` is collapsed. **Detail** `#detail`: key, kind, status, attempt, started, finished, seconds and `detail` in a `<pre>`, for `selected` or else `current`. **Below** `#progress` and `#decisions` `<pre>`s. **Polling** `poll` every 2 s with `cache: "no-store"`; a failed fetch or a non-2xx keeps the DOM as it was and reddens the dot. All text goes in through `textContent`, so journal content can never become markup; the only `innerHTML` is mermaid's own SVG.

- [ ] **Step 4: Run the test to see it pass, then the whole suite**

Run: `uv run pytest -q tests/test_ui.py`
Expected: `21 passed`.

Run: `uv run pytest -q`
Expected: `201 passed`. `janus_ui.py` is 406 lines (under the 450 target), `awk 'length > 120' janus_ui.py` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add janus_ui.py tests/test_ui.py
git commit -m "feat(ui): the page: header, gate banner, mermaid map, step tree, detail and sections, polled every 2 s" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MghcFnosThAtjAmtNQrbEw"
```

---

### Task 6: Docs and the manual check

Design §4.6 (the spec paragraph and the docstring; the README sentence is slice 5's, see *Global Constraints*) and §4.5's manual check ("against a folder mid-gate, and look"; the trial 3 folder does not exist until slice 5 runs, so the controller will look at it then).

**Files:**
- Modify: `janus-4.0-spec.md` (section 6)
- Modify: `janus.py` (the module docstring, lines 2 to 3)

**Interfaces:**
- Consumes: `python janus_ui.py [--port N]` as Task 4 defines it.
- Produces: nothing for code.

- [ ] **Step 1: The spec paragraph**

In `janus-4.0-spec.md`, replace

```
python janus.py graph    # print a node flow's map as mermaid; fails for a script flow
python /path/to/janus.py init <folder>   # create a goal folder with a starter node flow
```

with

```
python janus.py graph    # print a node flow's map as mermaid; fails for a script flow
python /path/to/janus.py init <folder>   # create a goal folder with a starter node flow
python janus_ui.py [--port N]            # serve a live view of this goal folder at http://127.0.0.1:8765
```

and replace

```
`init` creates `<folder>` (an error when it exists and is not an empty folder) with a copy of the running `janus.py` (and of `janus_ui.py` when it sits beside it), a `JANUS.md` with a placeholder goal, a three-node `flow.py` (draft with a ralph, approve with a gate that sends the answer back as findings, finish), `prompts/_preamble.md`, `prompts/draft.md` and a `.gitignore`, then prints the six steps to take next. It does not run `git init`.
```

with

```
`init` creates `<folder>` (an error when it exists and is not an empty folder) with a copy of the running `janus.py` (and of `janus_ui.py` when it sits beside it), a `JANUS.md` with a placeholder goal, a three-node `flow.py` (draft with a ralph, approve with a gate that sends the answer back as findings, finish), `prompts/_preamble.md`, `prompts/draft.md` and a `.gitignore`, then prints the six steps to take next. It does not run `git init`.

`janus_ui.py`, copied into the goal folder by `init`, is a separate program and not part of the engine: `python janus_ui.py` from the goal folder serves a page on loopback only (`--port` changes the default 8765; a port in use prints `janus_ui: port 8765 is in use; try --port 8766` and exits 1) that re-reads `journal.yaml` and `JANUS.md` every two seconds and shows the open gate with its section of `JANUS.md`, the flow's map with the nodes coloured by the path taken (visited, running, open, failed) and the edges counted, the steps as a tree keyed like the journal with durations and token usage, one step's journal entry, and the `## Progress` and `## Decisions` sections. It imports `find_section` and `to_mermaid` from `janus.py`, never writes a file and never runs the flow; it works whether or not a run is in progress, and for a script flow it shows everything but the map. Answers still go into `JANUS.md`; the page says so under the gate.
```

- [ ] **Step 2: The docstring line**

In `janus.py`, replace

```python
"""Janus 4.0: a small durable flow engine for Codex. One file, standard library plus PyYAML.
A flow imports the primitives with ``from janus import ...``; see janus-4.0-spec.md sections 4 to 9."""
```

with

```python
"""Janus 4.0: a small durable flow engine for Codex. One file, standard library plus PyYAML.
A flow imports the primitives with ``from janus import ...``; see janus-4.0-spec.md sections 4 to 9.
``janus_ui.py`` beside this file is the live page of a goal folder (spec section 6); it only reads."""
```

- [ ] **Step 3: Run the whole suite**

Run: `uv run pytest -q`
Expected: `201 passed` (`tests/test_init.py` compares `init`'s copy of `janus.py` with the file itself, so the docstring change is neutral).

- [ ] **Step 4: Manual check: a folder mid-gate**

Outside the repository, with the worktree's engine (`WT` below is the absolute path of the worktree root, for example `/home/race-day/janus/.worktrees/slice6-ui`):

```bash
WT=/home/race-day/janus/.worktrees/slice6-ui
D=/tmp/janus-ui-check && rm -rf $D && mkdir -p $D/bin $D/codex-home/sessions/2026/09/24 && cd $D
cat > bin/codex <<'EOF'
#!/usr/bin/env python3
"""A codex stand-in: answers done: true and prints a session id, like the test suite's fake."""
import sys
argv = sys.argv[1:]
sys.stdin.read()
out = argv[argv.index("--output-last-message") + 1]
open(out, "w").write('{"done": true, "summary": "Wrote the thing in src/thing.py and committed it as 1a2b3c.", '
                     '"blockers": []}')
print("session id: 0aaa0000-0000-7000-8000-000000000001", file=sys.stderr)
EOF
chmod +x bin/codex
echo '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":41083,"cached_input_tokens":30848,"cache_write_input_tokens":0,"output_tokens":476,"reasoning_output_tokens":67,"total_tokens":41559}}}}' > codex-home/sessions/2026/09/24/rollout-2026-09-24T10-00-00-0aaa0000-0000-7000-8000-000000000001.jsonl
python3 $WT/janus.py init demo && cd demo && git init -q
PATH=$D/bin:$PATH CODEX_HOME=$D/codex-home python3 janus.py run; echo "exit $?"
python3 janus.py status
python3 janus_ui.py
```

Expected: `run` prints the session line and `gate open: approve#1/gate#1. Answer it in JANUS.md and run again.` and exits 2; `status` prints `at: approve#1 (visit 1 of approve)`, `tokens: 41559 total, 41083 in (30848 cached), 476 out over 1 sessions` and `open gate: approve#1/gate#1`; `janus_ui.py` prints `janus_ui: demo at http://127.0.0.1:8765 (Ctrl-C stops)` and keeps running.

Open `http://127.0.0.1:8765` in a browser and check, against §4.3:

1. Header: `demo`, a green dot, `2 steps, 1 done, 1 open, 42k tokens in 1 sessions`, the flow, started and updated times, the placeholder goal text.
2. Gate banner: `Gate approve#1/gate#1 (gate)`, the question, the `## Gate:` section with the indented summary and `answer:` in a `<pre>`, the sentence "Answer it in JANUS.md, then run `python janus.py run` again."
3. Map: `draft` green, `approve` amber, `finish` and `END` grey; `(1)` on the `draft → approve` edge; `yes` and `no` labels.
4. Tree: `draft#1` collapsed (`0s →`), `approve#1` expanded with `gate#1` outlined as current; click `draft#1` to open it, then `draft#1` inside it, then `1`: it shows `42k tok`; click a row: the detail changes.
5. Detail: the gate's key, kind `gate`, status `open` in amber, empty attempt, started, empty finished, a growing duration, and its YAML.
6. Progress and Decisions: empty `<pre>`s (the starter flow logs nothing before the gate).
7. Then, with the page open, edit `JANUS.md`: set `answer: yes` and run `PATH=$D/bin:$PATH CODEX_HOME=$D/codex-home python3 janus.py run` in a second terminal (exit 0, `flow ended`). Within 2 s the page shows: no gate banner; `finish` green and `approve` green on the map with `yes (1)`; `approve#1` with `→ yes`; Progress with the `done: Wrote the thing ...` line; Decisions with the answer; the map does not flicker on later polls (its text no longer changes).
8. Stop the server with Ctrl-C (it exits 0, quietly); run `python3 janus_ui.py` twice in two terminals: the second prints `janus_ui: port 8765 is in use; try --port 8766` and exits 1.
9. Delete `journal.yaml` (`rm journal.yaml`) with a server running: the page says "nothing has run yet", the map is hidden, the dot stays green. Write `[broken` into `journal.yaml`: the header shows `journal.yaml is not valid YAML: ...` in red.

The controller takes screenshots afterwards; nothing here is automated. Leave `/tmp/janus-ui-check` in place for that.

- [ ] **Step 5: Commit**

```bash
git add janus-4.0-spec.md janus.py
git commit -m "docs(spec): describe janus_ui.py in section 6 and the engine docstring" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MghcFnosThAtjAmtNQrbEw"
```

---

## Self-review notes

- **Spec coverage, §4.1.** One file at the root, 3.9+, stdlib plus PyYAML → Task 1 (imports; the 3.9 run in *Verified facts*); `[--port N]`, loopback, URL printed once, the two routes with their content types and `Cache-Control`, 404 otherwise, silenced logging → Task 4 (`Handler`, `make_server`, `main`, both tests, the hand check in Step 5); `build_state`, `make_server`, `main` signatures → Tasks 1 and 4; the port-in-use line → Task 4 (`test_main_reports_a_port_in_use`); imports `find_section` and `to_mermaid` only, never `begin()`, never writes, never commits → the module has no other `janus` name and no `open(..., "w")`, `write_text` or `subprocess`; under 450 lines → 405 after Task 5.
- **Spec coverage, §4.2.** Every field of the table has a test: `folder`, `flow`, `started`, `updated`, `error`, `goal` → cases 1, 2, 7, 9, 10; `steps` and the step item's twelve keys → cases 8 and 9 (`detail` compared against `yaml.safe_dump` of the entry as written; `attempt` null for a gate; `session`/`usage` present and null); `tree` with nesting, first-appearance order, rollups, entry-with-children, `next` → cases 3, 4, 5, 12; `current` → case 6 (and 5); `gate` present, absent file, absent gate → case 7; `path` as is or `[]` → cases 11 and 12; `mermaid` null for a script flow, `visited`/`running`/`open`/`failed`, `(n)` counts, all visited after END → case 11 (three tests); `progress`/`decisions` → cases 7 and 10; `totals` with `codex_seconds` over `codex` and `ai_gate` only and `tokens` with `sessions` → case 9. The "non-mappings skipped" rule is implemented (`isinstance(e, dict)` in `build_state` and for path entries) and is covered by case 2's `"- a list"` at the journal level; a non-mapping *entry* has no dedicated test, which the reviewer may add in Task 1 (`"junk": 3` in `state(...)`, expecting it absent from `steps`).
- **Spec coverage, §4.3 and §4.4.** Each bullet of §4.3 is mapped to a page element in Task 5 Step 3's closing paragraph; the error table of §4.4 is covered by cases 1, 2, 8 (bad timestamps), 7 (no `JANUS.md`), 11 (script flow) and by the page's "nothing has run yet" and hidden map, checked by hand in Task 6 Step 4 items 4 and 9. "Flow not running" needs no code: the module reads files.
- **Spec coverage, §4.5 and §4.6.** Twelve cases → 19 tests in Tasks 1 to 3 as numbered in the test file's comments; the server test as specified plus the port test → Task 4. The spec paragraph and the docstring → Task 6; the README sentence → slice 5 by the controller's ruling. The manual check → Task 6 Step 4 for the mid-gate folder; the trial 3 folder is the controller's, after slice 5.
- **The code was assembled and replayed.** A script extracted every `Create`, `Append to` and `replace ... with` block of this plan in order, applied them to a clean copy of the repository at `01258a8` and ran the quoted commands after each step: Task 1 red `2 errors during collection` (`ModuleNotFoundError: No module named 'janus_ui'`), green `10 passed`, suite `186 passed`, 108 lines; Task 2 red `6 failed, 6 passed`, green `12 passed`, suite `192 passed`, 152 lines; Task 3 red `6 failed, 13 passed`, green `19 passed`, suite `199 passed`, 169 lines; Task 4 red `2 failed, 19 passed` (`has no attribute 'make_server'`), green `21 passed`, suite `201 passed`, 237 lines; Task 5 red `1 failed, 20 deselected` on the stub page, green `21 passed`, suite `201 passed`, 406 lines; Task 6 suite `201 passed`, the spec diff `3 insertions(+)` (one command line, one blank line, one paragraph), the docstring one line longer. The replayed `janus_ui.py` differs from the rehearsal copy that was served to the browser only in the order of three function definitions (`section_lines`, `gate_of`, the `labels` line of `build_tree`); the `PAGE` string, the server and every function body are identical, and the replayed `tests/test_ui.py` passes under Python 3.9 (`21 passed`). `awk 'length > 120'` prints nothing for `janus_ui.py`, `tests/test_ui.py` and `tests/test_init.py`.
- **Type and name consistency.** `build_state(root, now=None)`, `read_journal(root)`, `parse_time(value)`, `seconds(entry, now)`, `summary(entry)`, `step_item(key, entry, now)`, `section_lines(lines, heading)`, `gate_of(steps, raw, lines)`, `mermaid_of(graph, path, current)`, `make_server(root, port)`, `main(argv=None)` are defined once and called with those names and arities; `build_tree` is `build_tree(steps)` in Task 2 and `build_tree(steps, path)` from Task 3 on, and both the definition and the one call site change in Task 3. The state keys in `build_state`'s return, in the tests and in the page's JS (`st.folder`, `st.totals.tokens.sessions`, `st.gate.section`, `n.children`, `step.usage.total`, `st.current`, `st.mermaid`, `st.progress`) are the same strings. The tree node keys `name`, `key`, `status`, `seconds`, `next`, `children` match §4.2 and the JS. The four class names `visited`, `running`, `open`, `failed` are the engine's `CLASS_STYLES` keys, the strings `mermaid_of` assigns and the strings the tests expect.
- **Placeholder scan.** No "TBD", "TODO", "handle edge cases" or "similar to Task N"; every code step carries its code in full and every edit quotes the old and the new text. The old texts of Tasks 2 to 5 are the new texts of the tasks before them, so the tasks must be executed in order. The only stub is Task 4's three-line `PAGE`, replaced whole in Task 5 and given in full in both.
- **Deliberate limitations.** The page is not unit-tested beyond string presence; its behaviour was observed in a browser (see *Verified facts*) and is checked by hand in Task 6. `build_state` reads both files whole on every poll (2 s); journals are kilobytes. The tree collapses everything but `current`'s branch on load, so a ralph's iterations need two clicks to reach (visit, then ralph); the spec asks for exactly the ancestors of `current` to be open. The server answers `favicon.ico` with 404 like every other path, which the browser logs once per load. Mermaid renders with `securityLevel: "strict"`, so node names are plain text; the engine already restricts them to identifiers. No test covers `main`'s happy path (`serve_forever` until Ctrl-C); Task 4 Step 5 and Task 6 Step 4 run it by hand.
