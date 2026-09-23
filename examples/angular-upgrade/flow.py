"""Upgrade every Angular application in this folder, one major at a time.

Three nested loops (spec sections 10 and 14): `for target in MAJORS` outside, `while True` rounds
inside a major, and the task and CI loops inside a round. Codex plans and upgrades, CI verifies the
exact commit, a fresh Codex reviews, a human reviews, a human merges, Codex proposes a test plan and
QA validates; every "no" along the way ends the round and the next round starts with the findings.
Every key carries every enclosing loop's counter or id, so a rerun replays the finished rounds and
executes only what is new, and the counters come from this file's own control flow, never from
the journal.
"""
from janus import Exhausted, codex, context, decision, human_gate, log, ralph, step

import teamcity

MAJORS = [16]           # the majors to reach, in order; [16, 17, 18] walks three upgrades in one goal
MAX_ROUNDS = 3          # rounds per major before the flow asks whether to keep going
MAX_IMPLEMENT = 5       # ralph iterations of one implement task
MAX_CI = 3              # CI verdicts one task may wait for in one round: implement, then each fix
MAX_FIX = 3             # ralph iterations of one fix
CI_TIMEOUT = 7200       # seconds one CI wait may take before it gives up on that build


class SendBack(Exception):
    """Ends the round from inside the task loop; `.findings` is what the next round's Codex reads."""

    def __init__(self, findings):
        Exception.__init__(self, findings)
        self.findings = findings


def stop_run(reason):
    log(reason)
    raise SystemExit(1)


def task_line(record):
    return "%s [%s] %s -- %s" % (record["id"], record["repo"], record["commit"] or "no commit", record["title"])


def ask_after_exhausted(key, exc, task, attempts):
    """The blocker report of a ralph that gave up (spec section 14), keyed `<key>/exhausted`.
    `retry` ends the round with the blockers as the next round's findings, `stop` ends the run with
    exit 1, and `skip` returns so that the caller keeps what was committed and goes on."""
    report = "\n".join(exc.last["blockers"]) or exc.last["summary"]
    choice = decision(
        "Task %s gave up at '%s' after %d attempts. Retry it in the next round (the blockers become"
        " the findings), skip what is left of it, or stop the run?" % (task["id"], key, attempts),
        ["retry", "skip", "stop"], key="%s/exhausted" % key,
        show={"summary": exc.last["summary"], "blockers": exc.last["blockers"]})
    if choice == "stop":
        stop_run("task %s stopped the run at %s" % (task["id"], key))
    if choice == "retry":
        raise SendBack("Task %s gave up at %s:\n%s" % (task["id"], key, report))
    log("task %s: %s skipped by the human" % (task["id"], key))


def verify_in_ci(k, task, result):
    """The CI return loop: wait for the build of the exact commit; a red build gets a fix, and the fix
    commit is waited for in turn, up to MAX_CI verdicts. Returns the result CI last judged."""
    build = None
    for n in range(1, MAX_CI + 1):
        ci_key = "%s/ci/%s/%d" % (k, task["id"], n)
        build = step(ci_key, lambda: teamcity.wait_for_build(task["build_type"], result["commit"],
                                                             timeout=CI_TIMEOUT))
        log("task %s build %d of %d %s: %s" % (task["id"], n, MAX_CI, build["status"], build["url"]))
        if build["status"] == "SUCCESS":
            return result
        if build["status"] in ("NOT_FOUND", "TIMEOUT"):
            choice = decision(  # nothing here is fixable by Codex: the build never gave a verdict
                "TeamCity gave no verdict for task %s (%s). Continue without a CI check, or stop"
                " the run?" % (task["id"], build["status"]),
                ["skip", "stop"], key="%s/missing" % ci_key,
                show={"commit": result["commit"], "status": build["status"], "url": build["url"]})
            if choice == "stop":
                stop_run("task %s stopped the run: no CI verdict" % task["id"])
            log("task %s continues without a CI verdict" % task["id"])
            return result
        if n == MAX_CI:
            break
        fix_key = "%s/fix/%s/%d" % (k, task["id"], n)
        try:
            result = ralph("prompts/fix.md", until=lambda r: r["done"], max_iter=MAX_FIX, key=fix_key,
                           cwd=task["repo"], task=task, build=build)
        except Exhausted as exc:  # `skip` keeps the implement commit, red build and all
            ask_after_exhausted(fix_key, exc, task, MAX_FIX)
            return result
    choice = decision(
        "Task %s is still red after %d CI verdicts. Retry it in the next round (the failure becomes"
        " the findings), skip it and keep the commits, or stop the run?" % (task["id"], MAX_CI),
        ["retry", "skip", "stop"], key="%s/ci/%s/red" % (k, task["id"]),
        show={"commit": result["commit"], "url": build["url"], "excerpt": build["excerpt"]})
    if choice == "stop":
        stop_run("task %s stopped the run: still red after %d CI verdicts" % (task["id"], MAX_CI))
    if choice == "retry":
        raise SendBack("Task %s is still red after %d CI verdicts (%s):\n%s"
                       % (task["id"], MAX_CI, build["url"], build["excerpt"]))
    log("task %s continues with a red build, as the human decided" % task["id"])
    return result


def run_task(k, task, finished, findings):
    """Implement one task in a ralph, then verify it in CI when TeamCity is configured. Returns the
    record for `finished`, or None when the human skipped the task at the blocker report."""
    key = "%s/implement/%s" % (k, task["id"])
    try:
        result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                       key=key, cwd=task["repo"], task=task, done_so_far=finished, findings=findings)
    except Exhausted as exc:  # `retry` raised SendBack and `stop` exited; only `skip` returns here
        ask_after_exhausted(key, exc, task, MAX_IMPLEMENT)
        return None
    if teamcity.configured() and task["build_type"] != "none":
        result = verify_in_ci(k, task, result)
    log("task %s done: %s" % (task["id"], result["summary"]))
    return {"id": task["id"], "repo": task["repo"], "title": task["title"], "commit": result["commit"]}


def run_round(k, rnd, plan, findings):
    """One round of one major: every task, the AI review, the human review, the merge, the test plan
    and QA. Returns None when QA passed, otherwise the findings the next round starts with."""
    finished = []
    for task in plan["tasks"]:
        record = run_task(k, task, finished, findings)
        if record is not None:
            finished.append(record)
    review = codex("prompts/review.md", key="%s/review" % k, tasks=finished)
    if not review["passed"]:
        return "AI review of round %d:\n%s" % (rnd, "\n".join(review["reasons"]))
    answer = human_gate(
        "Review the pull requests of round %d. Answer 'approved', or write your findings: anything"
        " else you write is what Codex works on in the next round." % rnd,
        key="%s/human-review" % k,
        show={"review": review["summary"], "tasks": [task_line(t) for t in finished]})
    if answer.strip().lower() != "approved":
        return "Human review of round %d:\n%s" % (rnd, answer)
    human_gate("Merge the pull requests of round %d to the release branch, then answer 'merged'." % rnd,
               key="%s/merge" % k, show=[task_line(t) for t in finished])
    testplan = codex("prompts/testplan.md", key="%s/testplan" % k, tasks=finished)
    answer = human_gate(
        "QA: run this test plan on the release branch. Answer 'passed', or write your findings:"
        " anything else you write is what Codex works on in the next round.",
        key="%s/qa" % k, show={"summary": testplan["summary"], "steps": testplan["steps"]})
    if answer.strip().lower() != "passed":
        return "QA of round %d:\n%s" % (rnd, answer)
    return None


for i, target in enumerate(MAJORS):
    prefix = "v%d" % target
    context(branch="ai/angular-%d-to-%d" % (target - 1, target), target=target)
    plan = codex("prompts/plan.md", key="%s/plan" % prefix)
    human_gate(
        "Approve this plan for Angular %d? Answer 'yes' to run it. To change it, edit the goal or the"
        " prompts, run `python janus.py reset` and start again." % target,
        key="%s/approve-plan" % prefix,
        show={"summary": plan["summary"],
              "tasks": ["%s [%s] %s" % (t["id"], t["repo"], t["title"]) for t in plan["tasks"]]})

    findings = ""       # why the previous round came back: review reasons, human findings, QA findings, blockers
    allowed = MAX_ROUNDS
    rnd = 0
    while True:
        rnd += 1
        if rnd > allowed:  # `retry` raises the allowance and never resets the counter: r1.. are done
            choice = decision(
                "%d rounds did not finish Angular %d. Keep going for %d more, or stop the run?"
                % (rnd - 1, target, MAX_ROUNDS),
                ["retry", "stop"], key="%s/r%d/blocked" % (prefix, rnd), show=findings)
            if choice == "stop":
                stop_run("Angular %d stopped by the human after %d rounds" % (target, rnd - 1))
            allowed += MAX_ROUNDS
        k = "%s/r%d" % (prefix, rnd)
        try:
            findings = run_round(k, rnd, plan, findings)
        except SendBack as back:
            findings = back.findings
        if findings is None:
            log("Angular %d reached in %d round(s)" % (target, rnd))
            break
        log("round %d of Angular %d came back: %s" % (rnd, target, findings.splitlines()[0]))

    if i + 1 < len(MAJORS):
        choice = decision(
            "Direction check: Angular %d is done. Continue to Angular %d, or stop here?" % (target, MAJORS[i + 1]),
            ["next", "stop"], key="%s/direction" % prefix)
        if choice == "stop":
            log("stopped after Angular %d, as the human decided" % target)
            break
