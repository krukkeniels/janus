"""Upgrade every Angular application in this folder, one major at a time.

Three nested loops (spec sections 10 and 14): `for target in MAJORS` outside, `while True` rounds
inside a major, and the task and CI loops inside a round. Codex plans and upgrades, CI verifies the
exact commit, a fresh Codex reviews, a human reviews, a human merges, Codex proposes a test plan and
QA validates; every "no" along the way ends the round and the next round starts with the findings.
Every key carries every enclosing loop's counter or id, so a rerun replays the finished rounds and
executes only what is new, and the counters come from this file's own control flow, never from
the journal.
"""
from janus import codex, context, decision, human_gate, log, ralph

MAJORS = [16]           # the majors to reach, in order; [16, 17, 18] walks three upgrades in one goal
MAX_IMPLEMENT = 5       # ralph iterations of one implement task


def task_line(record):
    return "%s [%s] %s -- %s" % (record["id"], record["repo"], record["commit"] or "no commit", record["title"])


def run_task(k, task, finished, findings):
    """Implement one task in a ralph. Returns the record for `finished`."""
    key = "%s/implement/%s" % (k, task["id"])
    result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                   key=key, cwd=task["repo"], task=task, done_so_far=finished, findings=findings)
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
    rnd = 0
    while True:
        rnd += 1
        k = "%s/r%d" % (prefix, rnd)
        findings = run_round(k, rnd, plan, findings)
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
