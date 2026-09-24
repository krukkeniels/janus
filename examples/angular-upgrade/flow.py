"""Upgrade every Angular application in this folder, one major at a time.

A node flow (spec sections 10 and 14): each stage is a function decorated with `@node(next=...)`
that says where it can go, and the engine walks them from `start`, records the map and the path
in `journal.yaml` and checks every visit against it on replay. Codex plans and upgrades, CI
verifies the exact commit, a fresh Codex reviews, a human reviews, a human merges, Codex proposes
a test plan and QA validates; every "no" along the way is an edge back to `start_round`, and the
next round's implement prompt reads why in `{{findings}}`. Everything a later node needs lives on
the state `s`, which the flow rebuilds on every run from the replayed steps, never from the
journal or the clock. Keys are automatic: the third visit of `implement` journals its ralph as
`implement#3/implement#1/<n>`. `python janus.py graph` prints the map.
"""
from janus import END, Exhausted, codex, context, decision, human_gate, log, node, ralph, step

import teamcity

MAJORS = [16]           # the majors to reach, in order; [16, 17, 18] walks three upgrades in one goal
MAX_ROUNDS = 3          # rounds per major before the flow asks whether to keep going
MAX_IMPLEMENT = 5       # ralph iterations of one implement task
MAX_CI = 3              # CI verdicts one task may wait for in one round: implement, then each fix
MAX_FIX = 3             # ralph iterations of one fix
CI_TIMEOUT = 7200       # seconds one CI wait may take before it gives up on that build


def task_line(record):
    return "%s [%s] %s -- %s" % (record["id"], record["repo"], record["commit"] or "no commit", record["title"])


def send_back(s, findings):
    """Ends the round here: `findings` is what the next round's implement and review prompts read."""
    s.findings = findings
    log("round %d of Angular %d came back: %s" % (s.round, s.target, " ".join(findings.split())[:160]))


def give_up(s, what, attempts):
    """The blocker report of a ralph that gave up (`s.last` is its final result), shared by
    `implement_exhausted` and `fix_exhausted`. `retry` ends the round with the blockers as the next
    round's findings, `skip` keeps what was committed, `stop` ends the flow. Returns the choice."""
    report = "\n".join(s.last["blockers"]) or s.last["summary"]
    choice = decision(
        "Task %s gave up at %s after %d attempts. Retry it in the next round (the blockers become"
        " the findings), skip what is left of it, or stop the run?" % (s.task["id"], what, attempts),
        ["retry", "skip", "stop"], show={"summary": s.last["summary"], "blockers": s.last["blockers"]})
    if choice == "retry":
        send_back(s, "Task %s gave up at %s:\n%s" % (s.task["id"], what, report))
    elif choice == "skip":
        log("task %s: %s skipped by the human" % (s.task["id"], what))
    else:
        log("task %s stopped the run at %s, as the human decided" % (s.task["id"], what))
    return choice


@node(next="next_major")
def start(s):
    s.majors = list(MAJORS)
    s.major_index = -1


@node(next="plan")
def next_major(s):
    s.major_index += 1
    s.target = s.majors[s.major_index]
    context(branch="ai/angular-%d-to-%d" % (s.target - 1, s.target), target=s.target)
    s.round, s.allowed, s.findings = 0, MAX_ROUNDS, ""


@node(next="approve")
def plan(s):
    s.plan = codex("prompts/plan.md")


@node(next="start_round")
def approve(s):
    human_gate(
        "Approve this plan for Angular %d? Answer 'yes' to run it. To change it, edit the goal or the"
        " prompts, run `python janus.py reset` and start again." % s.target,
        show={"summary": s.plan["summary"],
              "tasks": ["%s [%s] %s" % (t["id"], t["repo"], t["title"]) for t in s.plan["tasks"]]})


@node(next={"go": "next_task", "too_many": "blocked"})
def start_round(s):
    if s.round >= s.allowed:  # the allowance is used up; `blocked` raises it or ends the flow
        return "too_many"
    s.round += 1
    s.task_index, s.finished = 0, []
    return "go"


@node(next={"retry": "start_round", "stop": END})
def blocked(s):
    choice = decision(
        "%d rounds did not finish Angular %d. Keep going for %d more, or stop the run?"
        % (s.round, s.target, MAX_ROUNDS), ["retry", "stop"], show=s.findings)
    if choice == "retry":  # the allowance grows and the round counter goes on: rounds never repeat
        s.allowed += MAX_ROUNDS
    else:
        log("Angular %d stopped by the human after %d rounds" % (s.target, s.round))
    return choice


@node(next={"task": "implement", "all_done": "review"})
def next_task(s):
    if s.task_index >= len(s.plan["tasks"]):
        return "all_done"
    s.task = s.plan["tasks"][s.task_index]
    return "task"


@node(next={"ci": "ci", "done": "task_done", "gave_up": "implement_exhausted"})
def implement(s):
    s.ci_count = 0
    try:
        s.result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                         cwd=s.task["repo"], task=s.task, done_so_far=s.finished, findings=s.findings)
    except Exhausted as exc:
        s.last = exc.last
        return "gave_up"
    if teamcity.configured() and s.task["build_type"] != "none":
        return "ci"
    return "done"


@node(next={"retry": "start_round", "skip": "next_task", "stop": END})
def implement_exhausted(s):
    choice = give_up(s, "implement", MAX_IMPLEMENT)
    if choice == "skip":  # nothing verified was produced: the task is left out of the round's review
        s.task_index += 1
    return choice


@node(next={"green": "task_done", "red": "fix", "no_verdict": "ci_missing", "still_red": "ci_red"})
def ci(s):
    """One TeamCity verdict on the task's latest commit; a fix commit comes back here for its own."""
    s.ci_count += 1
    build_type, commit = s.task["build_type"], s.result["commit"]
    s.build = step("wait", lambda: teamcity.wait_for_build(build_type, commit, timeout=CI_TIMEOUT))
    log("task %s build %d of %d %s: %s" % (s.task["id"], s.ci_count, MAX_CI, s.build["status"], s.build["url"]))
    if s.build["status"] == "SUCCESS":
        return "green"
    if s.build["status"] in ("NOT_FOUND", "TIMEOUT"):  # nothing here is fixable by Codex
        return "no_verdict"
    return "still_red" if s.ci_count == MAX_CI else "red"


@node(next={"skip": "task_done", "stop": END})
def ci_missing(s):
    choice = decision(
        "TeamCity gave no verdict for task %s (%s). Continue without a CI check, or stop the run?"
        % (s.task["id"], s.build["status"]), ["skip", "stop"],
        show={"commit": s.result["commit"], "status": s.build["status"], "url": s.build["url"]})
    if choice == "skip":
        log("task %s continues without a CI verdict" % s.task["id"])
    else:
        log("task %s stopped the run: no CI verdict, as the human decided" % s.task["id"])
    return choice


@node(next={"ci": "ci", "gave_up": "fix_exhausted"})
def fix(s):
    try:
        s.result = ralph("prompts/fix.md", until=lambda r: r["done"], max_iter=MAX_FIX,
                         cwd=s.task["repo"], task=s.task, build=s.build)
    except Exhausted as exc:  # `s.result` stays the commit CI last judged
        s.last = exc.last
        return "gave_up"
    return "ci"


@node(next={"retry": "start_round", "skip": "task_done", "stop": END})
def fix_exhausted(s):
    return give_up(s, "fix", MAX_FIX)  # `skip` keeps the commits, red build and all


@node(next={"retry": "start_round", "skip": "task_done", "stop": END})
def ci_red(s):
    choice = decision(
        "Task %s is still red after %d CI verdicts. Retry it in the next round (the failure becomes"
        " the findings), skip it and keep the commits, or stop the run?" % (s.task["id"], MAX_CI),
        ["retry", "skip", "stop"],
        show={"commit": s.result["commit"], "url": s.build["url"], "excerpt": s.build["excerpt"]})
    if choice == "retry":
        send_back(s, "Task %s is still red after %d CI verdicts (%s):\n%s"
                  % (s.task["id"], MAX_CI, s.build["url"], s.build["excerpt"]))
    elif choice == "skip":
        log("task %s continues with a red build, as the human decided" % s.task["id"])
    else:
        log("task %s stopped the run: still red after %d CI verdicts, as the human decided"
            % (s.task["id"], MAX_CI))
    return choice


@node(next="next_task")
def task_done(s):
    s.finished.append({"id": s.task["id"], "repo": s.task["repo"], "title": s.task["title"],
                       "commit": s.result["commit"]})
    log("task %s finished: %s" % (s.task["id"], s.result["summary"]))
    s.task_index += 1


@node(next={"passed": "human_review", "failed": "start_round"})
def review(s):
    review = codex("prompts/review.md", tasks=s.finished, findings=s.findings)
    s.summary = review["summary"]
    if review["passed"]:
        return "passed"
    send_back(s, "AI review of round %d:\n%s" % (s.round, "\n".join(review["reasons"])))
    return "failed"


@node(next={"approved": "merge", "findings": "start_round"})
def human_review(s):
    answer = human_gate(
        "Review the pull requests of round %d. Answer 'approved', or write your findings: anything"
        " else you write is what Codex works on in the next round." % s.round,
        show={"summary": s.summary, "tasks": [task_line(t) for t in s.finished]})
    if answer.strip().lower() == "approved":
        return "approved"
    send_back(s, "Human review of round %d:\n%s" % (s.round, answer))
    return "findings"


@node(next="testplan")
def merge(s):
    human_gate("Merge the pull requests of round %d to the release branch, then answer 'merged'." % s.round,
               show=[task_line(t) for t in s.finished])


@node(next="qa")
def testplan(s):
    s.testplan = codex("prompts/testplan.md", tasks=s.finished)


@node(next={"passed": "major_done", "findings": "start_round"})
def qa(s):
    answer = human_gate(
        "QA: run this test plan on the release branch. Answer 'passed', or write your findings:"
        " anything else you write is what Codex works on in the next round.",
        show={"summary": s.testplan["summary"], "steps": s.testplan["steps"]})
    if answer.strip().lower() == "passed":
        return "passed"
    send_back(s, "QA of round %d:\n%s" % (s.round, answer))
    return "findings"


@node(next={"next": "next_major", "stop": END, "all_done": END})
def major_done(s):
    log("Angular %d reached in %d round(s)" % (s.target, s.round))
    if s.major_index + 1 == len(s.majors):
        return "all_done"
    choice = decision(
        "Direction check: Angular %d is done. Continue to Angular %d, or stop here?"
        % (s.target, s.majors[s.major_index + 1]), ["next", "stop"])
    if choice == "stop":
        log("stopped after Angular %d, as the human decided" % s.target)
    return choice
