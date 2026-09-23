# Janus 4.0
## A small durable flow engine for Codex

**Status:** implementation specification, v0.2 (v0.1 superseded Janus 3.0 after the design session on 2026-09-22; v0.2 adds section 14 on loops and reshapes the example around them, 2026-09-23)
**Reference example:** upgrade an Angular application from 15 to 16, shipped as `examples/angular-upgrade/`.

### Why 4.0

Janus 3.0 was a fixed runner for one workflow: plan, approve, implement per repository, verify in TeamCity, review, hand over. Every exceptional path in that workflow was an engine feature, and its two implementation plans ran to 7,600 lines before a line of code had been tried. The design session on 2026-09-22 replaced it with a different product: a **generic flow engine**. The human writes the goal, the prompts and the flow. Janus runs fresh Codex processes, feeds their structured output into the flow, stops at gates, journals every step and resumes after a crash or a human answer. Janus knows nothing about Git, Angular, Bitbucket or TeamCity. The Angular upgrade is an example flow, not engine code.

Decisions made in that session, all binding here:

| Question | Decision |
|---|---|
| How a flow is written | A Python file using a handful of Janus primitives. Loops are plain `for` and `while`, including loops that return to an earlier stage after a gate says no (section 14). No DSL, no interpreter. |
| What a human gate does | Writes its question into `JANUS.md` and exits. The human answers in the file and runs again. Replay from the journal resumes at the gate. |
| How Codex output reaches the flow | Each prompt file declares its `output` fields in YAML front matter. Janus builds the JSON schema; `codex()` returns a dict with those keys. |
| What the engine knows about Git, Bitbucket, TeamCity | Nothing. Flows do that in prompts or in plain Python. |
| Where state lives | `JANUS.md` for humans, `journal.yaml` for the machine. Janus commits both after every step. |
| Ralph loop iterations | Fresh Codex each time; the previous result is available as `{{previous}}`. |

## 1. Principle

**The human defines the flow, the goal and the prompts. Codex does the work. Janus runs the steps, keeps the journal and stops at gates.**

- One engine file, `janus.py`. Python 3.9 or newer, standard library plus PyYAML. Target under 500 lines; slice 1 landed at 560 after the review fixes, and trimming is welcome but not at the cost of the rules below.
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

The human writes the answer after `answer:` on the same line or on the following lines, and runs again. Answer text may contain `##` lines; it ends at the next engine-owned heading (`# Goal`, `## Progress`, `## Decisions`, `## Gate:`) or at a blank line that is followed by a heading, so a human section placed below a gate is neither consumed nor deleted. The engine indents the question's continuation lines so a question may also contain `##` lines. The engine reads it, journals the gate as `answered`, removes the section and appends `question`, `answer` and date under `## Decisions`. An empty answer leaves the gate open. A `decision` answer outside its options appends a note under the gate and keeps it open.

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
12. A return loop (section 14): a `while` flow whose gate answer sends it back to an earlier stage re-executes only the new round's keys on the next run, a gate inside the second round resumes in the second round, and a finished loop replays without executing anything.

About thirty tests.

## 10. The example: `examples/angular-upgrade/`

Files: `flow.py`, `prompts/_preamble.md`, `prompts/plan.md`, `prompts/implement.md`, `prompts/review.md`, `prompts/fix.md`, `prompts/testplan.md`, `teamcity.py`, `JANUS.md` with a sample goal, `.gitignore`, `README.md`.

The example is the flow drawn on 2026-09-23 as the upgrade practice: Codex plans and upgrades, CI verifies the exact commit, a fresh Codex session reviews the diff, a human reviews, a human merges, Codex proposes a manual test strategy, QA validates, and every "no" along the way sends the work back to Codex with the findings. Each Angular major is one pass through that; the flow moves to the next major after a direction check. In Janus terms it is three nested loops (section 14): `for target in MAJORS` outside, `while True` rounds inside a major, and the task and CI loops inside a round.

```python
from janus import goal, context, codex, ralph, human_gate, decision, step, log, Exhausted
import teamcity

MAJORS = [16]           # the majors to reach, in order; [16, 17, 18] walks three upgrades in one goal
MAX_ROUNDS = 3          # rounds per major before the flow asks whether to keep going
MAX_IMPLEMENT = 5       # ralph iterations of one implement task
MAX_CI = 3              # CI verdicts one task may wait for in one round: implement, then each fix
MAX_FIX = 3             # ralph iterations of one fix

for target in MAJORS:
    prefix = f"v{target}"
    context(branch=f"ai/angular-{target - 1}-to-{target}", target=target)
    plan = codex("prompts/plan.md", key=f"{prefix}/plan")
    human_gate("Approve this plan?", key=f"{prefix}/approve-plan", show=...)

    findings = ""       # why the previous round came back: review reasons, human findings, QA findings, blockers
    allowed = MAX_ROUNDS
    rnd = 0
    while True:
        rnd += 1
        if rnd > allowed:
            if decision(f"{rnd - 1} rounds did not finish Angular {target}. Keep going?", ["retry", "stop"],
                        key=f"{prefix}/r{rnd}/blocked", show=findings) == "stop":
                raise SystemExit(1)
            allowed += MAX_ROUNDS
        k = f"{prefix}/r{rnd}"

        finished = []
        for task in plan["tasks"]:
            # implement: a ralph; Exhausted -> decision retry (next round, blockers become findings) | skip | stop
            result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                           key=f"{k}/implement/{task['id']}", cwd=task["repo"], task=task,
                           done_so_far=finished, findings=findings)
            # CI return loop: wait for the exact commit; a red build gets a fix and the fix commit is waited for too
            if teamcity.configured() and task["build_type"] != "none":
                for n in range(1, MAX_CI + 1):
                    build = step(f"{k}/ci/{task['id']}/{n}",
                                 lambda: teamcity.wait_for_build(task["build_type"], result["commit"]))
                    if build["status"] == "SUCCESS":
                        break
                    if build["status"] in ("NOT_FOUND", "TIMEOUT"):
                        ...  # decision skip | stop, keyed f"{k}/ci/{task['id']}/{n}/missing"; nothing for Codex to fix
                        break
                    result = ralph("prompts/fix.md", until=lambda r: r["done"], max_iter=MAX_FIX,
                                   key=f"{k}/fix/{task['id']}/{n}", cwd=task["repo"], task=task, build=build)
                else:
                    ...  # MAX_CI verdicts and still red: the blocker report, a decision keyed f"{k}/ci/{task['id']}/red"
            finished.append({...})

        review = codex("prompts/review.md", key=f"{k}/review", tasks=finished)   # declares passed and reasons itself
        if not review["passed"]:
            findings = "AI review of round %d:\n%s" % (rnd, "\n".join(review["reasons"]))
            log(f"round {rnd}: AI review sent the work back")
            continue
        answer = human_gate("Review the pull requests. Answer 'approved', or write your findings.",
                            key=f"{k}/human-review", show=finished)
        if answer.strip().lower() != "approved":
            findings = f"Human review of round {rnd}:\n{answer}"
            continue
        human_gate("Merge the pull requests to the release branch, then answer 'merged'.", key=f"{k}/merge")
        testplan = codex("prompts/testplan.md", key=f"{k}/testplan", tasks=finished)  # read-only
        answer = human_gate("QA: run the test plan on the release branch. Answer 'passed', or write your findings.",
                            key=f"{k}/qa", show=testplan["steps"])
        if answer.strip().lower() != "passed":
            findings = f"QA of round {rnd}:\n{answer}"
            continue
        log(f"Angular {target} reached in {rnd} round(s)")
        break

    if target != MAJORS[-1] and decision("Direction check: continue to the next major?", ["next", "stop"],
                                         key=f"{prefix}/direction") == "stop":
        break
```

What the diagram's boxes became:

| Diagram | Flow |
|---|---|
| Run Controller: start autonomous run | `python janus.py run`; every rerun after a gate is the same run resumed |
| Codex: plan, upgrade and fix | `{prefix}/plan` once per major; `{k}/implement/<id>/<n>` once per round, with `{{findings}}` from the round before |
| TeamCity: green for the exact commit? | `{k}/ci/<id>/<n>`, a `step()` around `teamcity.wait_for_build`, keyed per verdict so a fix commit is verified too |
| Can Codex resolve it within run limits? | `MAX_FIX` iterations of `{k}/fix/<id>/<v>`, where `<v>` is the CI verdict the fix answers, at most `MAX_CI` verdicts; past that, the blocker report |
| Run Controller: stop and produce blocker report | a `decision` with the last result as `show`: `retry` (next round, blockers become findings), `skip`, `stop` |
| Fresh Codex session: review full diff | `{k}/review`, a `codex()` whose prompt declares `passed` and `reasons` so the flow can hand the reasons back |
| Developer: human code review | `{k}/human-review`, a `human_gate`; `approved` moves on, anything else is the findings of the next round |
| Authorized human: merge | `{k}/merge` |
| Codex: propose manual test strategy | `{k}/testplan`, read-only, shown at the QA gate |
| QA: validate on release branch | `{k}/qa`, a `human_gate`; `passed` ends the major, anything else is the findings of the next round |
| Team: fix tooling; AI lead: update playbook, replan | done by humans while the `blocked` or `exhausted` decision is open; `retry` starts the next round |
| Architect: direction check | `{prefix}/direction`, a `decision` between majors |
| AI lead: review metrics, update live playbook | outside the flow; `journal.yaml` and `## Progress` are the metrics |

`prompts/_preamble.md` carries the rules that Janus 3.0 had in its engine: work only on `{{branch}}`, commit and push your own work and report the commit SHA, never merge or publish a release, never weaken or skip tests, report blockers instead of guessing. `teamcity.py` is about forty lines of `urllib`: find the build for a commit, poll until finished, return status, URL and a failure excerpt. It reads its URL and token from the environment and is used only when those are set.

The example is tried on the throwaway Angular 15 application with a local bare remote and real Codex, without TeamCity. The trial report goes into the example's `README.md`. The slice 3 trial answers the human review of round 1 with a finding, so that round 2 runs with real Codex and the return loop is exercised end to end.

## 11. Slices

1. **Engine.** `janus.py`, tests, `status`, `reset`. Verified by the test suite and by running a tiny flow with a fake `codex`.
2. **Example and trial.** The example folder, the trial on the throwaway app, the README. This slice may change the engine; if the example needs something the primitives cannot express, the engine is wrong, not the example.
3. **Loops.** Section 14, the engine test of coverage item 12, the example reshaped into the loops of section 10, and a second trial that goes through round 2. Same rule as slice 2: the engine changes only if a loop cannot be expressed without it. Writing the section showed none is needed: a return loop with a gate in its second round was run by hand on 2026-09-23 with the slice 2 engine and resumed correctly.

## 12. Acceptance criteria

1. A flow of plain Python using only the primitives runs to completion with a fake `codex`, and a second `run` executes no step again.
2. Killing `run` during a Codex step and running again re-executes only that step, with `attempt` incremented.
3. A `human_gate` exits with code 2 and writes the section; answering in `JANUS.md` and running again continues after the gate, and the answer appears under `## Decisions`.
4. `ralph` stops at `until`, and the flow can catch `Exhausted` and open a gate.
5. A prompt's `output` declaration determines the keys of the returned dict, and a malformed Codex answer fails the step rather than reaching the flow.
6. `janus.py` contains no reference to Git branches, pull requests, TeamCity, Bitbucket or Angular, apart from committing its own two files.
7. The Angular example runs on the throwaway app with real Codex through plan, approval gate, implementation loop and review gate.
8. `janus.py` stays one file with only the standard library and PyYAML as imports.
9. A round of the Angular example is sent back by a human review answer, round 2 runs with real Codex under `r2/` keys, the second run of the finished flow executes nothing, and every earlier round stays in the journal untouched.

## 13. Deliberate trade-off

Janus 4.0 gives the flow author full Python and asks in return that the flow be deterministic in its step keys. The engine does not protect against a flow that forgets `step()` around a side effect, uses a changing default key in a loop, or lets Codex commit to the wrong branch. Those are visible in `flow.py` and the prompts, which is where they can be fixed. Engine features are added only after a real flow shows that prompts and Python cannot express something safely.

## 14. Loops and return loops

Every loop in a flow is ordinary Python. The engine has no loop primitive and needs none; what it asks for is that every step inside a loop has a key that names its iteration. These are the patterns, from the simplest to the one the example is built on.

**Bounded loop.** A `for` over a known list or range, with the index or the item's id in the key.

```python
for task in plan["tasks"]:
    codex("prompts/implement.md", key=f"implement/{task['id']}", task=task)
for n in range(1, 4):
    step(f"ci/{n}", lambda: teamcity.wait_for_build(...))
```

**Ralph loop.** The bounded loop the engine provides for "call Codex until its result satisfies a predicate": `ralph()` keys its iterations `<key>/<n>` and hands each one the previous result as `{{previous}}`.

**Return loop.** The diagram shape "go back to Codex when a later check says no". It is a `while True` around the whole stretch that may be repeated, with a round counter, and every key inside the body carries the round: `f"r{rnd}/..."`. A checkpoint that fails records why in a variable, `findings`, and `continue`s; a checkpoint that passes falls through; the end of the body `break`s.

```python
findings = ""                   # a string, empty in the first round, like {{previous}} in a ralph
rnd = 0
while True:
    rnd += 1
    k = f"r{rnd}"
    work = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=5, key=f"{k}/implement",
                 findings=findings)
    review = codex("prompts/review.md", key=f"{k}/review", commit=work["commit"])
    if not review["passed"]:
        findings = "\n".join(review["reasons"])
        continue
    answer = human_gate("Approve, or write your findings.", key=f"{k}/human-review", show=work)
    if answer.strip().lower() != "approved":
        findings = answer
        continue
    break
```

Why this works with replay: `run` executes the flow from the top every time. Round 1's steps are `done` and its gate is `answered`, so they return their stored results without executing; the flow takes the same branches it took last time, arrives at round 2 with the same `findings`, and the first key it meets that is not in the journal is the step that runs. A gate inside round 2 opens, exits with code 2, and the next run replays rounds 1 and 2 up to that gate. The round counter is never read from the journal; it is recomputed by the flow from the replayed answers, which is what keeps the keys deterministic (section 5).

**Feeding the reason back.** The next round's Codex must know why the last one came back. Pass it as a call variable and reference it in the prompt (`{{findings}}`), the way `{{previous}}` works inside a ralph. A `human_gate` answer is free text and is the natural carrier: one gate serves both as the approval and as the findings box, the flow only compares the answer with the pass word. When the check is Codex's own, declare `passed` and `reasons` in the prompt's `output` and call `codex()` rather than `ai_gate()`, so the reasons come back to the flow and not only into the journal.

**Bounding a return loop.** `while True` needs an exit the flow controls. Count the rounds and, past the limit, open a `decision` keyed with the round (`f"r{rnd}/blocked"`) that offers `retry` or `stop`; `retry` raises the limit and lets the loop go on, so the keys of the rounds that follow stay fresh. Never reset the counter to reuse `r1`: those keys are `done` and would replay.

**The blocker report.** When a ralph gives up, `Exhausted.last` is the report. Catch it and open a `decision` with the report as `show`. `retry` ends the round and starts the next one with the blockers as `findings`; `skip` keeps what was committed and continues the round; `stop` raises `SystemExit(1)`. The human does the tooling or access work while the gate is open and answers when it is done. `reset` is not the way back: it archives the journal, and every finished round with it.

**Nested loops.** Loops compose by prefixing keys: a major, a round, a task and a ralph iteration give `v16/r2/implement/ui-kit/3`. Any depth is fine; the journal is a flat mapping and the keys are strings.

**Two rules.** Every key in a loop body carries every enclosing loop's counter or id, and the flow derives those counters from its own control flow, never from the journal, the clock or a random source. Break either and a later run replays the wrong step under a reused key, silently.

**What is deliberately not there.** No journal compaction: a long loop makes a long journal, and `status` shows the last five steps. No loop primitive: the day a flow needs one that `while` cannot express is the day to add it, as section 13 says.
