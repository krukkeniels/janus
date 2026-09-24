# Janus 4.1: node flows and a live view

**Status:** design, approved in chat on 2026-09-24. Supersedes the UI-only spec of 2026-09-23 (removed in the same commit), which relied on a hand-kept map of the flow.

## 1. Why

Two findings from the slice 3 trial drive this:

1. `flow.py` is hard to read. Its shape lives in nested loops, exceptions used as jumps (`SendBack`, `Exhausted`) and hand-built key strings such as `"%s/ci/%s/%d" % (k, task["id"], n)`. To learn what happens after the AI review fails you trace three functions.
2. A status page that shows "the flow" needs to know the flow's edges. The engine cannot see them in arbitrary Python, and a map kept by hand next to the code drifts.

Both are solved by one change: a flow becomes **a state machine whose states are small Python functions**. Each node declares where it can go. The engine enforces the declaration at runtime, records the map and the path taken in the journal, and the page draws exactly that. The flow stays Python (the decision of 2026-09-22 holds); loops, gates and ralphs are unchanged; they become edges one can see.

Three slices follow, each with its own plan: **slice 4** the engine (nodes, graph, path, `graph` command, spec v0.3), **slice 5** the example rewritten as nodes with a real-Codex trial, **slice 6** the page.

## 2. Nodes in the engine (slice 4)

### 2.1 Primitives added to `janus.py`

```python
END = ...                      # sentinel: the flow ends here

node(next) -> decorator
    # Registers the decorated function as a node named after the function. `next` is one of:
    #   "name"                        one edge, unlabelled; the function must return None
    #   {"label": "name", ...}        one edge per label; the function returns a label
    #   END                           the flow ends after this node; the function must return None
    # A dict value may be END: {"stop": END}. Nodes are registered in definition order and the
    # first one defined is the start node. The function takes one argument, the state `s`.
```

- `NODES: Dict[str, Node]` in the engine; `Node = (name, fn, edges)` where `edges: Dict[str, Optional[str]]` is the normalised form: a single edge becomes `{"": target}`, `END` becomes `None`. Normalising at registration keeps the runner and the graph export to one shape.
- Registration errors are `JanusError` at decoration time: a duplicate node name, `next` of a type not listed above, a dict with a non-string label, an empty dict.
- Validation errors are `JanusError` before the first visit: a target that names no node.
- The state `s` is a `types.SimpleNamespace()` created fresh for each run. The engine never persists it; every run rebuilds it by replaying, exactly as today's counters are rebuilt from control flow.
- A node function may call every primitive. Gates raise `SystemExit(2)` from inside a node as they do today; the runner lets it through.

### 2.2 Keys inside a node

While node `X` is in its `n`-th visit the engine sets `NODE = "X#n"` and empties `COUNTERS`. `make_key` returns `f"{NODE}/{key}"` where `key` is the explicit key or `<stem>#<count within this visit>`. So:

| Call inside the third visit of `implement` | Key |
|---|---|
| `codex("prompts/plan.md")` | `implement#3/plan#1` |
| `ralph("prompts/implement.md", ...)` iteration 2 | `implement#3/implement#1/2` |
| `step("wait", fn)` | `implement#3/wait` |
| `human_gate(q)` | `implement#3/gate#1` |
| `decision(q, opts, key="what-now")` | `implement#3/what-now` |

Visit counts are deterministic given the journal, because replay reproduces the path. The rule that "the flow must produce the same keys on every run given the same journal" is unchanged; a node flow gets it for free and no longer needs explicit keys in loops. The engine sets `NODE = None` outside the runner so script flows (2.3) key exactly as before. `step` goes through `make_key` so it gets the prefix too.

### 2.3 The runner

`cmd_run` executes `flow.py` as today. If, after that, `NODES` is empty the run is over: the file was a script flow and it has already run. Otherwise the runner walks the graph:

```
validate targets
JOURNAL["graph"] = graph()                      # 2.5; persisted at the next journal write
s = SimpleNamespace(); name = start; index = 0  # index counts visits from the start of the path
while name is not None:
    visit = VISITS[name] = VISITS.get(name, 0) + 1
    entry = JOURNAL["path"][index] if index < len(JOURNAL["path"]) else None
    if entry is not None and entry["node"] != name:   # finished or interrupted, either way the flow changed
        raise JanusError(f"flow changed: visit {index + 1} was {entry['node']}, now {name}")
    if entry is None:
        entry = {"node": name, "visit": visit, "started": now()}; JOURNAL["path"].append(entry)
    NODE = f"{name}#{visit}"; COUNTERS = {}
    label = normalise(fn(s))                    # "" for a single edge, the returned label otherwise
    check label is declared (2.4)
    if entry.get("finished") and entry["next"] != label:
        raise JanusError(f"flow changed: {NODE} went to {entry['next']!r} before, now {label!r}")
    entry.update(finished=now(), next=label)
    name = edges[label]; index += 1
NODE = None
```

- A path entry is appended in memory when the visit starts and reaches disk at the next journal write (the first step inside the node saves it, marked `running`) or at the end of the run. `cmd_run`'s `finally` writes the journal (`write_atomic`, then `git_commit("janus: run ended")`) so a run that ends inside step-less nodes still persists its path. Today the `finally` only commits; it gains the write, which happens only when `journal.yaml` already exists or the run recorded a path, so a script flow that ran no step still leaves no journal behind.
- A finished visit is checked, not re-recorded: on replay the node runs again with replayed results (as every flow does today), and its outcome must match. An entry without `finished` is the visit that was interrupted (crash, gate, failure) and is resumed in place: its `visit` count is trusted, its `started` is kept.
- `JOURNAL["path"]` defaults to `[]` in `begin()` like `steps`. A journal from Janus 4.0 has no `graph` and no `path`; a script flow never writes them, and `status`/`reset` ignore them.
- `CURRENT` (used by the error log line) keeps holding the last claimed step key, which now carries the node prefix, so the `## Progress` line after a failure names the node.

### 2.4 Return values

| Declared `next` | Function returned | Effect |
|---|---|---|
| `"name"` or `END` | `None` | edge `""` |
| `"name"` or `END` | anything else | `JanusError("node X declares one edge but returned 'y'")` |
| dict | a key of the dict | that edge |
| dict | anything else, including `None` | `JanusError("node X returned 'y'; declared: a, b, c")` |

The error is raised after the node's steps ran and were journaled, so the fix is to correct the flow and run again: the steps replay, the node returns the right label.

### 2.5 Graph and mermaid

`graph()` returns `{"start": name, "nodes": [{"name": n, "next": {label: target_or_null}}, ...]}` in registration order. It is stored under `JOURNAL["graph"]` at the start of every node run (overwriting; a real divergence is caught by the path check).

`to_mermaid(graph, classes=None, counts=None) -> str` renders:

```
flowchart LR
  plan --> approve
  review -- passed --> human_review
  review -- failed --> start_round
  blocked -- stop --> END
  END([END])
```

- One line per edge, in node order then label order as declared. An unlabelled edge (`""`) prints `a --> b`. With `counts` (a mapping `(node, label) -> int`) a taken edge prints `-- failed (2) -->` or, unlabelled, `-- (2) -->`.
- `END([END])` is emitted once when any edge targets END (lower-case `end` is a reserved word in mermaid flowcharts, so neither the id nor the label uses it).
- With `classes` (a mapping node name -> class name) each mapped node gets `class name cls` and the four `classDef` lines (`visited`, `running`, `open`, `failed`) are emitted with fill and stroke only. Without `classes` no `classDef` lines are printed, so `python janus.py graph` output pastes into a README.
- Node ids are the Python function names, which are valid mermaid ids.

### 2.6 CLI

```bash
python janus.py graph    # print the flow's map as mermaid; fails for a script flow
```

`graph` executes `flow.py` with `DRY = True`. `claim()` raises `JanusError("flow.py runs steps at load time; only node flows have a graph")` when `DRY` is set, so a script flow cannot run a step by accident. If `NODES` is empty after loading, the same message is printed and the exit code is 1. `status` gains one line when the journal has a path: `at: review#2 (visit 2 of review)`.

### 2.7 Spec v0.3 edits to `janus-4.0-spec.md`

- Header: v0.3, one sentence on nodes.
- Section 4: `node` and `END` added to the primitive list; the Keys paragraph gains the node prefix rule (2.2).
- Section 5: the journal example gains `graph:` and `path:`; the Replay paragraph gains the path check.
- Section 6: `graph`.
- Section 9: tests 13 to 18 (see 2.8).
- Section 10 and 14: rewritten in slice 5 (section 3 of this document).
- Section 13: one line that a flow may stay a script and what it forgoes (graph, page).

### 2.8 Tests (`tests/test_nodes.py`)

All with the fake `codex` and a flow written to `tmp_path` by the test. The existing suite must stay green unchanged, which is the proof that script flows are untouched.

1. Registration: three nodes, `graph()` lists them in order with normalised edges; duplicate name, bad `next` type and empty dict raise `JanusError` at decoration; an unknown target raises it when `run` or `graph` validates, before any visit.
2. Walk: `a -> b -> END`, both with one codex step; `run` exits 0, keys are `a#1/plan#1` and `b#1/plan#1`, `path` has two finished entries with `next: ""`.
3. Labels: `a` returns `"left"` or `"right"` from a codex result; the taken edge is recorded; a return of an undeclared label exits 1 with the message and the step under `a` is still `done` in the journal.
4. Single edge returning a value exits 1 with its message.
5. Loop: `a -> a` three times then END, driven by a counter on `s`; keys `a#1/..`, `a#2/..`, `a#3/..`; a second run executes nothing (fake codex called three times in total) and the path is unchanged.
6. Gate inside a node: exits 2, JANUS.md has `## Gate: b#1/gate#1`; answered, the next run resumes in `b` and continues.
7. Interrupted visit: a node whose step raises exits 1; `path[-1]` has no `finished`; the next run re-executes that step under the same key with attempt 2.
8. Flow changed: after a run, rewrite the flow so visit 2 is a different node; `run` exits 1 with `flow changed: visit 2 was b, now c`.
9. `graph` command: prints the mermaid of 2.5 for a node flow; exits 1 with the load-time message for a script flow and calls the fake codex zero times.
10. `to_mermaid` with `classes` and `counts` renders the class lines and `(n)` labels.
11. `status` prints the `at:` line for a node journal and nothing new for a script journal.

## 3. The example as nodes (slice 5)

`examples/angular-upgrade/flow.py` is rewritten; the prompts keep their contracts except one change below; `teamcity.py` is unchanged.

### 3.1 State

`s` carries: `majors` (copy of `MAJORS`), `major_index`, `target`, `plan`, `round`, `allowed`, `findings`, `task_index`, `task`, `finished`, `result`, `ci_count`, `build`, `last` (the report of a ralph that gave up).

### 3.2 Nodes

| Node | `next` | Does |
|---|---|---|
| `start` | `next_major` | `s.majors = list(MAJORS); s.major_index = -1` |
| `next_major` | `plan` | `major_index += 1`; `s.target`; `context(branch=..., target=...)`; `round = 0`, `allowed = MAX_ROUNDS`, `findings = ""` |
| `plan` | `approve` | `s.plan = codex("prompts/plan.md")` |
| `approve` | `start_round` | `human_gate` with the plan summary and task lines as `show` |
| `start_round` | `go: next_task`, `too_many: blocked` | `round += 1`, `task_index = 0`, `finished = []`; `too_many` when `round > allowed` |
| `blocked` | `retry: start_round`, `stop: END` | `decision(..., ["retry", "stop"], show=s.findings)`; `retry` adds `MAX_ROUNDS` to `allowed`; `stop` logs "Angular N stopped by the human after M rounds" |
| `next_task` | `task: implement`, `all_done: review` | `s.task = tasks[task_index]` when one is left |
| `implement` | `ci: ci`, `done: task_done`, `gave_up: implement_exhausted` | `s.ci_count = 0`; ralph `implement.md` with `task`, `done_so_far=s.finished`, `findings`; `ci` when `teamcity.configured()` and `build_type != "none"` |
| `implement_exhausted` | `retry: start_round`, `skip: next_task`, `stop: END` | decision with `s.last` summary and blockers; `retry` sets `findings` to the blocker report; `skip` logs and `task_index += 1` |
| `ci` | `green: task_done`, `red: fix`, `no_verdict: ci_missing`, `still_red: ci_red` | `ci_count += 1`; `step("wait", ...)`; logs the verdict; `still_red` when red and `ci_count == MAX_CI` |
| `ci_missing` | `skip: task_done`, `stop: END` | decision as today |
| `fix` | `ci: ci`, `gave_up: fix_exhausted` | ralph `fix.md` with `task`, `build`; updates `s.result` |
| `fix_exhausted` | `retry: start_round`, `skip: task_done`, `stop: END` | as `implement_exhausted`; `skip` keeps the commits |
| `ci_red` | `retry: start_round`, `skip: task_done`, `stop: END` | decision as today; `retry` sets `findings` from the build excerpt |
| `task_done` | `next_task` | appends the record to `finished`, logs "task X finished", `task_index += 1` |
| `review` | `passed: human_review`, `failed: start_round` | `codex("prompts/review.md", tasks=s.finished, findings=s.findings)`; `failed` sets `findings = "AI review of round N:\n" + reasons` |
| `human_review` | `approved: merge`, `findings: start_round` | gate as today; anything but `approved` becomes `findings` |
| `merge` | `testplan` | gate "answer merged" |
| `testplan` | `qa` | `codex("prompts/testplan.md", tasks=s.finished)` |
| `qa` | `passed: major_done`, `findings: start_round` | gate as today |
| `major_done` | `next: next_major`, `stop: END`, `all_done: END` | logs "Angular N reached in M round(s)"; `all_done` when no major is left, else the direction decision |

Rules kept from today: a skipped implement task is left out of the round's review; `retry` never resets `round`; `findings` is the empty string in round 1. `stop` now ends the flow with exit 0 through END (it was `SystemExit(1)`); the `## Progress` line says who stopped it. `SendBack`, `stop_run`, `run_round`, `run_task`, `verify_in_ci` and `ask_after_exhausted` are gone.

### 3.3 Prompt change

`review.md` gets a `{{findings}}` paragraph: "The previous round came back with these findings; work that answers them is requested, not a defect: {{findings}}". This closes the trial 2 finding where the AI review rejected the edit the human had asked for. `implement.md` already has `{{findings}}`.

### 3.4 Docs

- README: "The steps it journals" becomes "The nodes" with the table of 3.2 and the mermaid from `python janus.py graph`; "Loops" is rewritten as "how a round comes back" in terms of edges; "Starting a goal folder" mentions `graph`. Trials 1 and 2 stay as history with a note that their keys are 4.0 keys.
- Spec sections 10 and 14 are rewritten around the node table; section 14's two rules about keys become one: a node flow needs no explicit keys.

### 3.5 Tests and trial

- `examples/angular-upgrade/tests/test_flow.py` is rewritten for the node keys (`implement#1/implement#1/1`, `review#1/review#1`, gates `approve#1/gate#1`, `human_review#1/gate#1`); every scenario it covers today (happy path, review send-back, human send-back, exhausted at implement with each answer, CI red then fix, blocked past MAX_ROUNDS, direction) is kept, plus: the path's `next` labels of a send-back round, and `python janus.py graph` on the example matching the README diagram.
- Trial 3 with real Codex on the throwaway app, one round sent back by the human as in trial 2, evidence under `~/janus-trial/slice5-*`, report in the README. Acceptance: the journal's `path` reads as the sequence the mermaid shows, and the round-2 review no longer rejects the requested edit.

## 4. The page (slice 6)

### 4.1 Shape

- One file at the repository root, `janus_ui.py`, Python 3.9+, standard library plus PyYAML; copied into a goal folder next to `janus.py`.
- `python janus_ui.py [--port N]` from the goal folder serves `http://127.0.0.1:8765`, loopback only, and prints the URL once. Routes: `GET /` the page (`text/html`), `GET /state.json` (`application/json`, `Cache-Control: no-store`); everything else 404. Request logging is silenced.
- Two functions carry it: `build_state(root, now=None) -> dict` and `make_server(root, port) -> ThreadingHTTPServer`; `main(argv)` parses `--port`, prints the URL, runs `serve_forever` until Ctrl-C. A port in use prints `janus_ui: port 8765 is in use; try --port 8766` and exits 1.
- It imports `janus` for `find_section` and `to_mermaid` only; it never calls `begin()`, never writes, never commits. Size target: under 450 lines including the page.

### 4.2 State

`build_state` reads `journal.yaml` and `JANUS.md` on every call (both are written atomically, so no torn reads; no watcher, no cache). `now` is a parameter for tests.

| Field | Value |
|---|---|
| `folder` | `root.resolve().name` |
| `flow`, `started` | from the journal; `"flow.py"` and null without one |
| `updated` | journal mtime as ISO seconds, or null |
| `error` | null, or one line when `journal.yaml` exists but is not valid YAML or not a mapping; the rest is then as for a missing journal |
| `goal` | text of `# Goal`, `""` when missing |
| `steps` | journal order, one item per mapping entry (non-mappings skipped) |
| `tree` | keys split on `/`, see below |
| `current` | first `running` or `open` key; else the last `failed`; else null |
| `gate` | for the first `open` entry: `{"key", "kind", "question", "section"}`, `section` being the verbatim `## Gate: <key>` section of JANUS.md joined with newlines, `""` when absent; else null |
| `path` | the journal's `path` list as is, `[]` when absent |
| `mermaid` | `to_mermaid(graph, classes, counts)` when the journal has `graph`, else null. `classes`: every node with a finished visit is `visited`; the node of the last path entry, when that entry is unfinished, gets `running`, `open` or `failed` after the status of `current` (`running` when there is no current step yet). `counts` come from the finished path entries |
| `progress`, `decisions` | the lines of those sections after the heading, `[]` when absent |
| `totals` | `{"steps", "done", "failed", "running", "open", "answered", "codex_seconds"}`; `codex_seconds` sums kinds `codex` and `ai_gate` |

A step item: `key`, `kind`, `status`, `attempt` (null for gates), `started`, `finished`, `seconds` (whole seconds; running and open count to `now`; null when `started` is missing or unparsable), `summary` (one line, 160 chars with `...`: `result.summary` or `result.text` when strings for `done`; first line of `answer` for `answered`; of `error` for `failed`; of `question` for `open`; `""` for `running`), `detail` (`yaml.safe_dump` of the entry, `sort_keys=False, allow_unicode=True`).

The tree: nodes `{"name", "key", "status", "seconds", "next", "children"}` where `key` is the full prefix. A journal key's node carries its status and seconds; a group rolls up `running` if any child is `running` or `open`, else `failed` if any is `failed`, else `done`. A top-level node whose name is `<node>#<visit>` of a path entry gets `next` = that entry's label (`""` for an unlabelled edge, null when unfinished); other nodes have `next` null. Children keep first-appearance order. A key that is both an entry and a prefix keeps its own status and lists its children.

### 4.3 Page

One HTML string `PAGE` at the end of the file; vanilla JS and CSS; the only external resource is mermaid from `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js`.

- **Header:** folder, flow, started, updated, totals (`12 steps, 10 done, 1 failed, codex 23m10s`), a dot green after a successful poll and red after a failed one (error text as its title); `state.error` in red.
- **Gate banner:** only when `gate` is set: key, question, `section` in a `<pre>`, and "Answer it in JANUS.md, then run `python janus.py run` again."
- **Map:** when `mermaid` is set, the rendered diagram; the four classes are styled by the page's CSS as visited green, running blue, open amber, failed red, unvisited grey. Re-rendered only when the mermaid text changes, so the picture does not flicker on every poll. If `window.mermaid` is missing (offline) the mermaid text is shown in a `<pre>` instead. Hidden for a script flow.
- **Left, the tree:** one row per node, indented by depth, colour by status, label = last key segment, `#n` when attempt > 1, duration as `12s`, `3m04s`, `1h02m`, and for a top-level visit its `next` label as `→ failed`. Groups toggle on click; leaves select. Ancestors of `current` are expanded on load and `current` is highlighted; the user's toggles survive polls (a `Set` of collapsed keys). "nothing has run yet" when `steps` is empty.
- **Right, the detail:** the selected step's key, kind, status, attempt, started, finished, seconds and its `detail` in a `<pre>`; falls back to `current`.
- **Below:** Progress and Decisions, raw lines in a `<pre>` each.
- **Polling:** `fetch("/state.json")` every 2 s; a failed fetch keeps the last state and reddens the dot. The DOM of the tree, detail and panels is rebuilt from the state on each poll.
- Dark background, monospace for keys and YAML, sans-serif for prose, 1000 px and up; no responsive work.

### 4.4 Errors

| Situation | Behaviour |
|---|---|
| no `journal.yaml` | empty `steps` and `tree`, null `current`, `gate`, `mermaid`; page says "nothing has run yet" |
| corrupt journal | `error` set, otherwise as above |
| entry not a mapping | skipped |
| bad timestamps | `seconds` null |
| no `JANUS.md` | `goal` `""`, `progress`/`decisions` `[]`, `gate.section` `""` |
| script flow | `path` `[]`, `mermaid` null, map hidden; everything else works |
| flow not running | the page still works; it views files, not a process |

### 4.5 Tests (`tests/test_ui.py`)

`build_state` with a fixed `now`, folders written directly under `tmp_path`:

1. Missing journal; 2. corrupt journal (`"[not a mapping"` and `"- a list"`); 3. tree nesting from `review#2/review#1`, `implement#1/implement#1/1`, `implement#1/implement#1/2`, `implement#1/wait`; 4. rollup running then failed; 5. entry-with-children; 6. `current` rules; 7. gate section extraction present and absent; 8. seconds and summaries for done, answered (two-line answer), failed, running, missing `started`; 9. totals; 10. progress and decisions verbatim; 11. `mermaid` null for a script journal; with `graph` and `path`: `visited`/`running`/`open`/`failed` classes and `(n)` counts as expected; 12. tree `next` labels from the path.

Server: `make_server(root, 0)` in a thread; `/` 200 `text/html` containing `<title>`, `/state.json` 200 JSON dict with `steps`, `/nope` 404; `server.shutdown()`.

Manual check before the slice closes: run `janus_ui.py` against the trial 3 folder under `~/janus-trial/` and against a folder mid-gate, and look.

### 4.6 Docs

One paragraph in spec section 6 after the `graph` line, one sentence in the example README's "Starting a goal folder", and the module docstring.

## 5. Out of scope, deliberately

Answering gates from the page (the file is the interface). A YAML or DSL flow (a node is Python because rounds, fan-out over tasks and blocker reports need it). Persisting `s` (replay rebuilds it). Static detection of unreachable nodes (`graph` output makes them visible). Live Codex transcript. Watching several folders. Authentication or non-loopback binding. Journal compaction.
