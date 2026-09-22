# Janus 4.0
## A small durable flow engine for Codex

**Status:** implementation specification, v0.1 (supersedes Janus 3.0 v0.2 after the design session on 2026-09-22)
**Reference example:** upgrade an Angular application from 15 to 16, shipped as `examples/angular-upgrade/`.

### Why 4.0

Janus 3.0 was a fixed runner for one workflow: plan, approve, implement per repository, verify in TeamCity, review, hand over. Every exceptional path in that workflow was an engine feature, and its two implementation plans ran to 7,600 lines before a line of code had been tried. The design session on 2026-09-22 replaced it with a different product: a **generic flow engine**. The human writes the goal, the prompts and the flow. Janus runs fresh Codex processes, feeds their structured output into the flow, stops at gates, journals every step and resumes after a crash or a human answer. Janus knows nothing about Git, Angular, Bitbucket or TeamCity. The Angular upgrade is an example flow, not engine code.

Decisions made in that session, all binding here:

| Question | Decision |
|---|---|
| How a flow is written | A Python file using a handful of Janus primitives. Loops are plain `for` and `while`. No DSL, no interpreter. |
| What a human gate does | Writes its question into `JANUS.md` and exits. The human answers in the file and runs again. Replay from the journal resumes at the gate. |
| How Codex output reaches the flow | Each prompt file declares its `output` fields in YAML front matter. Janus builds the JSON schema; `codex()` returns a dict with those keys. |
| What the engine knows about Git, Bitbucket, TeamCity | Nothing. Flows do that in prompts or in plain Python. |
| Where state lives | `JANUS.md` for humans, `journal.yaml` for the machine. Janus commits both after every step. |
| Ralph loop iterations | Fresh Codex each time; the previous result is available as `{{previous}}`. |

## 1. Principle

**The human defines the flow, the goal and the prompts. Codex does the work. Janus runs the steps, keeps the journal and stops at gates.**

- One engine file, `janus.py`. Python 3.9 or newer, standard library plus PyYAML. Target under 500 lines.
- Every primitive call is a journaled step. Rerunning a flow replays finished steps from the journal and executes only what is not finished. That single mechanism gives crash resume, gate resume and resume on another machine.
- The engine has no retry policy, no domain rules, no HTTP client and no secrets. Those belong to the flow and its prompts, where they are visible and editable.
- Janus is not a daemon. `run` is a process that ends when the flow ends, a gate opens or a step fails.

## 2. Scope

**Included**

- The primitives in section 4 and the three commands in section 6.
- Journal, replay, gates, ralph loops, generic journaled steps.
- Prompt files with an output schema and template placeholders, plus an optional preamble prepended to every prompt.
- Commit and push of `JANUS.md` and `journal.yaml` after each step when the folder is a Git repository.
- pytest suite with a fake `codex` on `PATH`.
- The Angular 15 to 16 example flow, tried on a throwaway app with a local bare remote and real Codex.

**Not included**

- Any knowledge of Git branches, pull requests, CI systems or Angular in the engine.
- Retry counters, timeouts or guardrails in the engine. A flow expresses those with `ralph`, `step` and ordinary Python.
- Parallel steps. Flows are sequential.
- A YAML or Markdown flow language.
- Redaction. The engine never holds a token; prompts must tell Codex not to echo secrets.
- Journal compaction. Added when a real long-running loop shows the need.
- Multiple flows or multiple active journals per folder.

## 3. Files and workspace

The folder Janus is started from is the goal. It is normally a small Git repository whose tracked content is the Janus files; product checkouts inside it are ignored through `.gitignore`.

```text
angular-16-upgrade/
  janus.py              # the engine, copied or symlinked from this repository
  flow.py               # the flow, written by the human
  prompts/
    _preamble.md        # optional; prepended to every prompt
    plan.md
    implement.md
    ...
  JANUS.md              # goal, open gates, decisions, progress
  journal.yaml          # machine state, written by Janus
  journals/             # archived journals from `reset`
  .gitignore            # "*/" for product clones, "!prompts/", "!journals/"
  ui-kit/               # product clone, ignored
  shell/
```

A new goal starts by copying an example folder, editing `# Goal` in `JANUS.md`, adjusting `flow.py` and the prompts, and running `python janus.py run`. Prompt paths in `flow.py` are relative to the goal folder.

## 4. Primitives

All primitives live in `janus.py` and are imported by `flow.py` with `from janus import ...`. Every one of them is a journaled step except `goal`, `context` and `log`.

```python
goal() -> str
    # The text of the "# Goal" section of JANUS.md.

context(**vars) -> None
    # Values available to every prompt render from now on, e.g. context(branch="ai/angular-15-to-16").

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

log(text) -> None
    # Appends a line to "## Progress" in JANUS.md and prints it.

class Exhausted(Exception):   # .last is the final ralph result
class JanusError(Exception):  # engine and flow errors that stop the run
```

**Keys.** A step key identifies a journal entry. The default key is the prompt file stem followed by `#` and a counter of calls with that stem in this run, so the third `codex("prompts/implement.md")` is `implement#3`. `step` requires an explicit key. Inside loops, flows pass an explicit key that survives edits to the flow, such as `f"implement/{task_id}"`. Ralph iterations are keyed `<key>/<n>` starting at 1. Two live steps with the same key in one run is a `JanusError`.

**Rendering.** Placeholders are `{{name}}` and `{{name.field.subfield}}`, with dotted access into dicts and lists by index. Values that are not strings are rendered as YAML. A placeholder that resolves to nothing fails the step before Codex starts. The variables of a render are, in rising precedence: the reserved values `goal`, `attempt` and, in ralph, `previous`; the values from `context()`; the keyword arguments of the call. `previous` is absent in the first ralph iteration and renders as an empty string. If `prompts/_preamble.md` exists it is rendered with the same variables and prepended to the prompt body, separated by a blank line.

**Output schema.** The prompt's front matter holds an `output` mapping. Field types are `str`, `int`, `float`, `bool`, `list[T]` where `T` is a scalar or a nested mapping, a nested mapping for an object, and `one_of: [a, b, c]` for an enumerated string. All fields are required and no additional properties are allowed, which is the form Codex's strict structured output accepts. A prompt without `output` returns `{"text": <final message>}`.

## 5. Journal, replay and gates

**Journal.** `journal.yaml` is one mapping:

```yaml
flow: flow.py
started: 2026-09-22T10:15:00
steps:
  plan#1:
    kind: codex
    status: done            # running | done | failed | open | answered
    attempt: 1
    started: ...
    finished: ...
    result: {tasks: [...], summary: "..."}
  approve-plan:
    kind: gate
    status: answered
    question: Approve this plan?
    answer: "yes"
  implement/1/1:
    kind: codex
    status: failed
    attempt: 2
    error: "codex exec exited with 1: ..."
```

The file is written atomically, through a temporary file and rename, at every status change.

**Replay.** `run` loads the journal and executes `flow.py` from the top. Each primitive computes its key and looks it up:

- `done` or `answered`: return the stored result or answer without executing anything.
- `running`: the step was interrupted. Increment `attempt` and execute it again. Prompts see the new `{{attempt}}` and can tell Codex to inspect the working tree.
- `failed`: execute again with `attempt` incremented.
- `open`: the gate has no answer yet. Exit with code 2 again.
- absent: journal `running`, execute, journal `done` with the result.

The flow must produce the same sequence of keys on every run, given the same journal. Explicit keys in loops are how a flow stays deterministic when it is edited.

**Gates in JANUS.md.** An open gate looks like this:

```markdown
## Gate: approve-plan
Approve this plan?

    tasks:
      - Upgrade ui-kit to Angular 16
      - Upgrade shell using the ui-kit prerelease

answer:
```

The human writes the answer after `answer:` on the same line or on the following lines, and runs again. The engine reads it, journals the gate as `answered`, removes the section and appends `question`, `answer` and date under `## Decisions`. An empty answer leaves the gate open. A `decision` answer outside its options appends a note under the gate and keeps it open.

**Exit codes.** `0` the flow ended. `2` a gate is open. `1` a step failed or the flow raised.

**Git.** After every journal write, if the goal folder is a Git repository, the engine stages `JANUS.md` and `journal.yaml`, commits with the message `janus: <key> <status>`, and pushes if the current branch has an upstream. A failed commit or push is logged as a warning and does not stop the run. The local journal is authoritative.

## 6. CLI

```bash
python janus.py run      # execute flow.py with replay until end, open gate or failure
python janus.py status   # open gate if any, last five steps, next action
python janus.py reset    # move journal.yaml to journals/<timestamp>.yaml and remove open gates from JANUS.md
```

`run` imports `flow.py` from the current folder as a module and executes it top to bottom. Uncaught exceptions from the flow, including `Exhausted`, are written to `## Progress` with the step key that raised and the run exits with code 1.

## 7. Codex invocation

`codex()` writes the schema and the rendered prompt to a temporary directory and runs:

```bash
codex exec -C <cwd> --dangerously-bypass-approvals-and-sandbox \
  --output-schema <schema.json> --output-last-message <last.json> -
```

The prompt goes in on stdin, never on the command line. The user's own `~/.codex/config.toml` supplies model and reasoning effort; Janus passes no model flags. Codex runs at full access because the machine Janus runs on is already a sandbox, as decided for Janus 3.0. A non-zero exit, a missing final message or JSON that does not validate against the schema fails the step.

## 8. Errors

- A rendering error or an invalid `output` declaration fails the step before Codex starts.
- A failed Codex process fails the step with the last twenty lines of stderr in `error`.
- A `step()` whose function raises fails with the exception text.
- A failed step stops the run with exit 1. The next `run` executes it again. Retry policy is the flow's concern, expressed with `ralph` or a `while` loop.
- `Exhausted` not caught by the flow stops the run with the last result in `## Progress`. The intended pattern is to catch it and open a `human_gate`, as the example shows.

## 9. Tests

pytest in `tests/`, run with `uv run pytest -q`. Codex is replaced by a fake `codex` executable on `PATH` that returns scripted JSON and records its calls. Git behaviour is tested in a temporary repository with a local bare remote. There is no HTTP stub because the engine makes no HTTP calls.

Coverage required:

1. Template rendering: dotted access, YAML rendering of non-strings, preamble prepending, undefined placeholder fails before Codex.
2. Schema building for every supported type, including `one_of` and nested lists.
3. A flow run twice yields the same journal and the fake `codex` is called once per step.
4. A `running` step is executed again with `attempt` incremented; a `failed` step likewise.
5. Gate cycle: `run` exits 2 and writes the section; an answer is read, journaled and moved to `## Decisions`; an empty answer keeps the gate open; a `decision` rejects an answer outside its options.
6. `ralph` returns on `until`, keys iterations `<key>/<n>`, passes `previous`, raises `Exhausted` with `.last`.
7. `step()` runs its function once and never on replay.
8. `context()` values and call arguments reach the prompt with the documented precedence.
9. Journal and `JANUS.md` are committed after each step; a failing push warns and continues.
10. `reset` archives the journal and removes open gates.
11. Duplicate live keys raise `JanusError`.

About thirty tests.

## 10. The example: `examples/angular-upgrade/`

Files: `flow.py`, `prompts/_preamble.md`, `prompts/plan.md`, `prompts/implement.md`, `prompts/review.md`, `prompts/fix.md`, `teamcity.py`, `JANUS.md` with a sample goal, `.gitignore`.

The flow, in outline:

```python
from janus import goal, context, codex, ralph, human_gate, decision, ai_gate, step, log, Exhausted
import teamcity

context(branch="ai/angular-15-to-16")

plan = codex("prompts/plan.md")                       # reads every repo, proposes ordered tasks
human_gate("Approve this plan? Edit prompts or the goal and reset if not.", key="approve-plan", show=plan)

for task in plan["tasks"]:
    key = f"implement/{task['id']}"
    try:
        result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=5, key=key, task=task)
    except Exhausted as e:
        choice = decision(f"Task {task['id']} not done after 5 attempts.", ["retry", "skip", "stop"],
                          key=f"{key}/exhausted", show=e.last)
        if choice == "stop":
            raise SystemExit(1)
        if choice == "skip":
            continue
        result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=5, key=f"{key}/retry", task=task)
    if teamcity.configured():
        build = step(f"ci/{task['id']}", lambda: teamcity.wait_for_build(task["build_type"], result["commit"]))
        if build["status"] != "SUCCESS":
            ralph("prompts/fix.md", until=lambda r: r["done"], max_iter=3, key=f"fix/{task['id']}", build=build, task=task)
    log(f"task {task['id']} done: {result['summary']}")

if not ai_gate("prompts/review.md", key="review"):
    human_gate("AI review found issues; see journal.", key="review-findings")
human_gate("PRs are ready. Review, merge, then answer 'merged'.", key="merge")
```

`prompts/_preamble.md` carries the rules that Janus 3.0 had in its engine: work only on `{{branch}}`, commit and push your own work and report the commit SHA, never merge or publish a release, never weaken or skip tests, report blockers instead of guessing. `teamcity.py` is about forty lines of `urllib`: find the build for a commit, poll until finished, return status, URL and a failure excerpt. It reads its URL and token from the environment and is used only when those are set.

The example is tried on the throwaway Angular 15 application with a local bare remote and real Codex, without TeamCity. The trial report goes into the example's `README.md`.

## 11. Slices

1. **Engine.** `janus.py`, tests, `status`, `reset`. Verified by the test suite and by running a tiny flow with a fake `codex`.
2. **Example and trial.** The example folder, the trial on the throwaway app, the README. This slice may change the engine; if the example needs something the primitives cannot express, the engine is wrong, not the example.

## 12. Acceptance criteria

1. A flow of plain Python using only the primitives runs to completion with a fake `codex`, and a second `run` executes no step again.
2. Killing `run` during a Codex step and running again re-executes only that step, with `attempt` incremented.
3. A `human_gate` exits with code 2 and writes the section; answering in `JANUS.md` and running again continues after the gate, and the answer appears under `## Decisions`.
4. `ralph` stops at `until`, and the flow can catch `Exhausted` and open a gate.
5. A prompt's `output` declaration determines the keys of the returned dict, and a malformed Codex answer fails the step rather than reaching the flow.
6. `janus.py` contains no reference to Git branches, pull requests, TeamCity, Bitbucket or Angular, apart from committing its own two files.
7. The Angular example runs on the throwaway app with real Codex through plan, approval gate, implementation loop and review gate.
8. `janus.py` stays one file with only the standard library and PyYAML as imports.

## 13. Deliberate trade-off

Janus 4.0 gives the flow author full Python and asks in return that the flow be deterministic in its step keys. The engine does not protect against a flow that forgets `step()` around a side effect, uses a changing default key in a loop, or lets Codex commit to the wrong branch. Those are visible in `flow.py` and the prompts, which is where they can be fixed. Engine features are added only after a real flow shows that prompts and Python cannot express something safely.
