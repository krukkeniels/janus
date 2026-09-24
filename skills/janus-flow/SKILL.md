---
name: janus-flow
description: "Write or change a Janus goal folder: the goal in JANUS.md, one prompt per Codex job with an output schema, and flow.py as @node functions with declared edges. Use when asked to create, extend or debug a Janus flow."
metadata:
  short-description: Write a Janus flow
---

# Writing a Janus flow

Janus is a small durable flow engine for Codex: one file, `janus.py`, in a goal folder. The human writes
the goal, the prompts and the flow; Janus runs fresh `codex exec` processes, journals every step in
`journal.yaml`, stops at human gates (the question goes into `JANUS.md`, the human answers there and runs
again) and resumes by replay: finished steps return their stored results, only unfinished work executes.

## A goal folder

```text
janus.py              # the engine, copied in by `python /path/to/janus/janus.py init <folder>`
janus_ui.py           # optional live view: python janus_ui.py
JANUS.md              # "# Goal" (every prompt sees it as {{goal}}), then gates, decisions and progress
flow.py               # the flow: @node functions
prompts/_preamble.md  # optional; prepended to every prompt
prompts/<job>.md      # one file per Codex job, with an `output` schema in YAML front matter
journal.yaml          # written by Janus; never edit it
.gitignore            # "*/", "!prompts/", "!journals/": product checkouts inside the folder are ignored
```

The six authoring steps: 1. edit the goal in `JANUS.md`; 2. edit or add prompts; 3. edit `flow.py`;
4. `python janus.py graph` to see the map; 5. `python janus.py run`, answer gates in `JANUS.md`, run
again; 6. `python janus_ui.py` to watch. `python janus.py status` shows where a run stands.

## Primitives (`from janus import ...`)

```python
goal() -> str                 # the text of the "# Goal" section of JANUS.md
context(**vars) -> None       # values available to every prompt render from now on
codex(prompt, key=None, cwd=".", **vars) -> dict
    # One fresh `codex exec` in cwd. The prompt file is rendered with vars, the result is shaped by the
    # prompt's output schema, journaled under key and returned as a dict.
ralph(prompt, until, max_iter, key=None, cwd=".", **vars) -> dict
    # codex() repeated until `until(result)` is true. Each iteration is a fresh process and sees the
    # previous result as {{previous}}. Returns the result that satisfied `until`. Raises Exhausted(last)
    # after max_iter iterations without success.
human_gate(question, key=None, show=None) -> str
    # Writes a "## Gate: <key>" section with the question and `show` to JANUS.md, journals the gate as
    # open and exits with code 2. On a later run, returns the human's answer.
decision(question, options, key=None, show=None) -> str
    # human_gate whose answer must be one of options. Any other answer keeps the gate open with a note.
ai_gate(prompt, key=None, cwd=".", **vars) -> bool
    # codex() with the fields {passed: bool, reasons: list[str]} added to the prompt's output schema.
    # Returns passed. The whole result is in the journal.
step(key, fn) -> result
    # Runs fn() once and journals its return value, which must be YAML-serialisable. Replay returns the
    # stored value without calling fn. Use it for every side effect that must not repeat: a push, a
    # test run, a CI poll.
log(text) -> None             # appends a line to "## Progress" in JANUS.md and prints it
node(next) -> decorator
    # Registers the decorated function as a node named after the function; the first node defined is
    # the start. `next` is a node name (one edge; the function returns None), END (the flow ends after
    # this node; the function returns None) or {"label": name_or_END, ...} (the function returns a
    # label). The function takes the state `s`, a SimpleNamespace made fresh for every run.
END                           # sentinel: the flow ends here
class Exhausted(Exception)    # .last is the final ralph result
class JanusError(Exception)   # engine and flow errors that stop the run
```

Exit codes of `python janus.py run`: 0 the flow ended, 2 a gate is open, 1 a step failed or the flow raised.

## Node rules

- One function per stage of the work, decorated with `@node(next=...)`; the first one defined starts.
- `next` is a node name, a dict of label to node name (a value may be `END`), or `END`.
- A single-edge node returns nothing. A multi-edge node returns one of its labels, and only a label:
  `return "passed" if result["passed"] else "failed"`. Returning anything else stops the run.
- Keep everything a later node needs on `s` (`s.plan`, `s.findings`, `s.round`). `s` is rebuilt on every
  run by replaying the nodes, so never read `journal.yaml`, the clock or a random source to choose an
  edge: the same journal must give the same path.
- A loop is an edge backwards, `{"again": "draft", "done": "finish"}`, with a counter on `s` that bounds it;
  past the bound go to a node that opens a `decision(["retry", "stop"])`.
- Anything with a side effect that must not repeat (a push, a test run, a poll) goes in `step(key, fn)`.
- Keys are automatic: inside the third visit of `implement`, `codex("prompts/plan.md")` is journaled as
  `implement#3/plan#1` and `step("wait", fn)` as `implement#3/wait`. Pass `key=` only when two calls in
  one visit would otherwise get the same key (two `codex("prompts/plan.md")` in one node are `plan#1` and
  `plan#2` already; two `step("wait", ...)` are not).
- Gates exit the process; never catch `SystemExit`. Catch `Exhausted` around a `ralph` when the flow
  should ask the human what to do next; `exc.last` is the report to show.
- A label must be an identifier; a node name may not be a mermaid keyword (`end`, `graph`, `style`, `class`, `click`).

## Prompt rules

- Front matter declares the fields Codex must return, all required, no extras:
  ```yaml
  ---
  output:
    done: bool
    summary: str
    blockers: list[str]
    verdict: {one_of: [passed, failed]}
    tasks:
      - {id: str, title: str}
  ---
  ```
  Types: `str`, `int`, `float`, `bool`, `list[T]` (`T` a scalar), a one-item list of a mapping for a list
  of objects, a nested mapping for an object, `one_of: [a, b, c]` for an enumerated string. A prompt
  without `output` returns `{"text": <final message>}`.
- Placeholders: `{{name}}` and `{{name.field}}` with dotted access into dicts and lists by index; a
  non-string renders as YAML; a placeholder that resolves to nothing fails the step before Codex starts.
  Variables in rising precedence: the reserved `goal`, `attempt` and (inside a ralph) `previous`; the
  values from `context()`; the keyword arguments of the call. Pass strings for things that may be empty
  (`findings=""`) and use them whole, never dotted.
- `{{previous}}` exists only inside a `ralph` (empty in its first iteration).
- `prompts/_preamble.md` is rendered with the same variables as each prompt it precedes, for every
  call: keep it to `goal`, `attempt` and `context()` values, or a call that lacks a placeholder fails.
- `show=` at a gate is rewritten into `JANUS.md` on every stalled run: pass a summary and short lines,
  not whole results.

## Example 1: draft, approve, finish (what `init` writes)

```python
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
```

`prompts/draft.md` declares `done: bool`, `summary: str`, `blockers: list[str]` and uses `{{findings}}`
and `{{previous}}`. The map (`python janus.py graph`): `draft --> approve`, `approve -- yes --> finish`,
`approve -- no --> draft`, `finish --> END`.

## Example 2: a review loop with a bound

```python
from janus import END, Exhausted, codex, decision, human_gate, log, node, ralph

MAX_ROUNDS = 3

@node(next="draft")
def start(s):
    s.round, s.findings = 0, ""

@node(next={"ok": "check", "gave_up": "blocked"})
def draft(s):
    s.round += 1
    try:
        s.result = ralph("prompts/draft.md", until=lambda r: r["done"], max_iter=3, findings=s.findings)
    except Exhausted as exc:
        s.findings = "the draft gave up:\n" + "\n".join(exc.last["blockers"])
        return "gave_up"
    return "ok"

@node(next={"passed": "approve", "failed": "draft", "too_many": "blocked"})
def check(s):
    review = codex("prompts/check.md", summary=s.result["summary"])   # output: passed: bool, reasons: list[str]
    if review["passed"]:
        return "passed"
    s.findings = "review of round %d:\n%s" % (s.round, "\n".join(review["reasons"]))
    return "failed" if s.round < MAX_ROUNDS else "too_many"

@node(next={"retry": "draft", "stop": END})
def blocked(s):
    return decision("Keep going?", ["retry", "stop"], show=s.findings)

@node(next={"yes": "finish", "no": "draft"})
def approve(s):
    answer = human_gate("Is this done? Answer yes, or write what to change.", show=s.result["summary"])
    if answer.strip().lower() == "yes":
        return "yes"
    s.findings = answer
    return "no"

@node(next=END)
def finish(s):
    log("done in %d round(s): %s" % (s.round, s.result["summary"]))
```

`retry` at `blocked` goes back to `draft`, which is visit 4 of `draft` with fresh keys; the round counter
is only ever advanced by the flow itself.

## Before handing back

1. `python janus.py graph` prints the map; every edge you intended is on it and nothing is unreachable.
2. Read each prompt against the variables its call passes (plus `goal`, `attempt`, `context()` values and,
   in a ralph, `previous`): no placeholder may be undefined, and every field the flow reads is declared.
3. `flow.py` catches `Exhausted` where a human should decide, and never catches `SystemExit`.
4. `python janus.py run` with the gates answered in `JANUS.md` reaches `END`; a second run executes nothing.
