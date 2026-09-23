# Janus UI: a live view of a goal folder

**Status:** design, approved in chat on 2026-09-23. Implements nothing in the engine; adds one file.

## 1. Purpose

A human running a Janus flow wants to see, without reading YAML, what the flow has done, what it is doing now and what it is waiting for. `python janus.py status` prints five lines; this page shows the whole journal as a tree, the open gate, the decisions and the progress log, and refreshes itself while the flow runs.

Decided 2026-09-23: a local web page rather than a terminal view, because the content (expandable Codex results, review reasons, gate questions, human answers) needs expand, collapse and scrolling. The terminal case stays with `status` and `watch -n 2 python janus.py status`.

## 2. Shape

- One new file at the repository root, `janus_ui.py`, Python 3.9+, standard library plus the PyYAML the engine already needs. A goal folder gets a copy next to `janus.py`, the same way `janus.py` itself is copied there.
- Run `python janus_ui.py` from the goal folder. It serves `http://127.0.0.1:8765`; `--port N` overrides the port. It binds the loopback address only and prints the URL once at start.
- Routes: `GET /` returns the page (`text/html`), `GET /state.json` returns the state (`application/json`, `Cache-Control: no-store`). Every other path is 404. Request logging is off (`log_message` overridden) so the terminal stays readable.
- Two functions carry the design: `build_state(root, now=None)` (section 3) and `make_server(root, port)`, which returns a `ThreadingHTTPServer` whose handler serves the two routes; `main(argv)` parses `--port`, calls `make_server`, prints the URL and runs `serve_forever` until Ctrl-C.
- `janus_ui.py` imports `janus` for `find_section` only, which is pure (takes lines, returns a span). It never calls `begin()`, never writes a file, never commits. `janus.py` is not changed.
- Size target: under 400 lines including the embedded page.

## 3. State

`build_state(root: Path, now: datetime | None = None) -> dict` is a pure function that reads `journal.yaml` and `JANUS.md` on every call. Both files are written atomically by the engine, so a read never sees a torn file; no watcher, no cache. `now` defaults to the current time and is a parameter so tests can fix it.

The returned mapping:

| Field | Value |
|---|---|
| `folder` | `root.resolve().name` |
| `flow` | the journal's `flow`, or `"flow.py"` when there is no journal |
| `started` | the journal's `started`, or null |
| `updated` | the journal file's mtime as an ISO string with seconds, or null |
| `error` | null, or a one-line message when `journal.yaml` exists but is not a mapping or not valid YAML. The rest of the state is then as for a missing journal, so the page still renders the goal |
| `goal` | the text of `# Goal` in JANUS.md, or `""` when the file or section is missing |
| `steps` | list, journal order, one item per journal entry (see below) |
| `tree` | list of nodes (see below) |
| `current` | the key of the first entry whose status is `running` or `open`; else the key of the last entry whose status is `failed`; else null |
| `gate` | for the first entry with status `open`: `{"key", "kind", "question", "section"}` where `section` is the verbatim lines of the `## Gate: <key>` section from JANUS.md (question, show, note, `answer:`) joined with newlines, or `""` when the section is not there; else null |
| `progress` | the lines of `## Progress` in JANUS.md after the heading, as a list; `[]` when absent |
| `decisions` | the lines of `## Decisions`, same rule |
| `totals` | `{"steps": n, "done": n, "failed": n, "running": n, "open": n, "answered": n, "codex_seconds": s}` where `codex_seconds` sums `seconds` over entries of kind `codex` and `ai_gate` |

A step item:

| Field | Value |
|---|---|
| `key` | the journal key |
| `kind` | `codex`, `ai_gate`, `step`, `gate` or `decision`; unknown kinds pass through as written |
| `status` | `running`, `done`, `failed`, `open` or `answered`; unknown statuses pass through |
| `attempt` | the entry's `attempt`, or null for gates |
| `started`, `finished` | the entry's timestamps, or null |
| `seconds` | `finished - started` rounded to a whole number; for `running` and `open` entries `now - started`; null when `started` is missing or unparsable |
| `summary` | one line: for a `done` entry with a dict result, `result["summary"]` if it is a string, else `result["text"]` if it is a string, else `""`; for `answered`, the first line of `answer`; for `failed`, the first line of `error`; for `open`, the first line of `question`; for `running`, `""`. Truncated to 160 characters with `...` |
| `detail` | `yaml.safe_dump(entry, sort_keys=False, allow_unicode=True)` of the whole journal entry, so the page can show it in a `<pre>` without knowing the entry's shape |

The tree. Keys are split on `/`. Each segment becomes a node `{"name", "key", "status", "seconds", "children"}` where `key` is the full key up to that segment (`v16/r1/implement` for the third segment of `v16/r1/implement/app/1`). A node whose `key` is a journal key carries that entry's `status` and `seconds`; a node without an entry is a group and rolls up its children: `running` if any child is `running` or `open`, else `failed` if any child is `failed`, else `done`. Children keep journal order of first appearance. Top-level nodes are the list. Keys such as `implement#3` have no `/` and become top-level leaves. A key that is both an entry and a prefix of other keys (`v16/r1/implement/app/1` next to `v16/r1/implement/app/1/exhausted`) is a leaf-with-children: its own status wins, its children are still listed.

## 4. Page

One HTML string, `PAGE`, at the end of `janus_ui.py`. Vanilla JS and CSS inline; no library, no build step, no external request. Layout:

- **Header:** folder, flow, started, updated, totals (`n steps, d done, f failed, codex 12m34s`), and a dot that is green after a successful poll and red after a failed one, with the error text as its title. When `state.error` is set the header shows it in red.
- **Gate banner:** shown only when `gate` is not null: the key, the question, the `section` text in a `<pre>`, and the line "Answer it in JANUS.md, then run `python janus.py run` again."
- **Left column, the tree:** one row per node, indented by depth, with a status color (running: blue, open: amber, failed: red, done and answered: green, group: inherits its rollup), the last key segment as the label, the attempt as `#n` when it is above 1, and the duration formatted `12s`, `3m04s` or `1h02m`. Groups toggle open and closed on click; leaves select. Groups containing `current` are expanded on load and `current` is highlighted; the user's own toggles are kept across polls (a `Set` of collapsed keys in memory).
- **Right column, the detail:** the selected step's key, kind, status, attempt, started, finished, seconds and its `detail` YAML in a `<pre>`. Nothing selected shows `current`'s detail when there is one.
- **Below, two panels:** Progress and Decisions, each the raw lines in a `<pre>`, newest at the bottom.
- **Polling:** `fetch("/state.json")` every 2 seconds via `setInterval`; a failed fetch turns the dot red and keeps the last state on screen. The selected key and the collapsed set survive a refresh. Rendering rebuilds the DOM from the state each time (a few hundred rows at most; a long loop of several hundred steps is still fine).
- Dark background, monospace for keys and YAML, sans-serif for prose; works at 1000px width and above. No responsive design work.

## 5. Errors

| Situation | Behaviour |
|---|---|
| no `journal.yaml` | state with empty `steps`, `tree`, null `current`, null `gate`; the page says "nothing has run yet" in the tree column |
| `journal.yaml` invalid YAML or not a mapping | `error` set, otherwise as above; the page shows the error in the header |
| an entry that is not a mapping | skipped, counted nowhere |
| timestamps missing or unparsable | `seconds` null, no crash |
| no `JANUS.md` | `goal` `""`, `progress` and `decisions` `[]`, `gate.section` `""` |
| port in use | `OSError` from the server prints `janus_ui: port 8765 is in use; try --port 8766` and exits 1 |
| flow not running | the page still works; it is a view of the files, not of a process |

## 6. Tests

`tests/test_ui.py`, pytest, using a `tmp_path` goal folder written directly (the existing `root` fixture also works but the UI does not need `begin()`). `build_state` tests, each with a fixed `now`:

1. Missing journal: empty steps and tree, `current` null, `goal` read from JANUS.md.
2. Corrupt journal (`"[not a mapping"` and `"- a list"`): `error` set, no exception.
3. Tree nesting: keys `v16/plan`, `v16/r1/implement/app/1`, `v16/r1/implement/app/2`, `v16/r1/review` give the expected nested names and the group `v16/r1/implement/app` rolls up `done`.
4. Rollup: a `running` leaf makes every ancestor `running`; a `failed` leaf with no running sibling makes the ancestors `failed`.
5. Leaf-with-children: `a/b` done and `a/b/exhausted` open; `a/b` keeps `done` and lists one child.
6. `current`: running wins over an earlier failed; a lone failed is current; a finished journal gives null.
7. Gate: an `open` decision entry plus a `## Gate:` section in JANUS.md gives `gate.section` equal to the section text; a missing section gives `""`.
8. Seconds and summaries: done codex with `summary`, answered gate with a two-line answer (first line only), failed step with `error`, running codex with `now` (seconds counted to `now`), missing `started` (null).
9. Totals: counts per status and `codex_seconds` covering `codex` and `ai_gate` only.
10. Progress and decisions lines come back verbatim.

Server test: `make_server(root, port=0)` returns an unstarted `ThreadingHTTPServer` bound to an ephemeral port; run `serve_forever` in a thread, read the port from `server.server_address[1]`, then with `http.client`: `/` is 200 and `text/html` containing `<title>`, `/state.json` is 200 `application/json` and parses to a dict with `steps`, `/nope` is 404; then call `server.shutdown()`.

Run: `uv run pytest -q tests/test_ui.py`, and the whole suite stays green.

## 7. Docs

- Spec `janus-4.0-spec.md` section 6 (CLI): one line under the code block, "`python janus_ui.py [--port N]` serves a live read-only view of the folder at `http://127.0.0.1:8765`: the step tree, the open gate, decisions and progress, refreshed every two seconds. It is a view of `journal.yaml` and `JANUS.md`, not of a process; it works whether or not a run is going."
- `examples/angular-upgrade/README.md`, section "Starting a goal folder from it": add `janus_ui.py` to the files to copy and one sentence on running it.
- Module docstring in `janus_ui.py` says the same in two lines.

## 8. Out of scope, deliberately

Answering gates from the page (the engine owns the JANUS.md format; the file is the interface). Steps that have not run yet (the flow is arbitrary Python; the engine cannot know them). The live Codex transcript (it goes to the run's stderr, the engine keeps no copy). Watching several folders. Authentication or non-loopback binding. Any change to `janus.py`.
