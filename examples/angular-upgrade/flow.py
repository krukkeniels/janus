"""Upgrade every Angular application in this folder, one repository at a time.

Plan with Codex, let a human approve the plan, implement each task in a ralph loop, wait for
TeamCity when it is configured, let Codex review the result and let the human merge. Every step
has an explicit key, so editing this file does not shift the keys of finished steps.
"""
from janus import Exhausted, ai_gate, codex, context, decision, human_gate, log, ralph, step

import teamcity

BRANCH = "ai/angular-15-to-16"
MAX_IMPLEMENT = 5
MAX_FIX = 3

context(branch=BRANCH)

plan = codex("prompts/plan.md", key="plan")
human_gate(
    "Approve this plan? Answer 'yes' to run it. To change it, edit the goal or the prompts,"
    " run `python janus.py reset` and start again.",
    key="approve-plan",
    show={"summary": plan["summary"],
          "tasks": ["%s [%s] %s" % (t["id"], t["repo"], t["title"]) for t in plan["tasks"]]},
)

finished = []
for task in plan["tasks"]:
    key = "implement/%s" % task["id"]
    try:
        result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                       key=key, cwd=task["repo"], task=task)
    except Exhausted as exc:
        choice = decision(
            "Task %s is not done after %d attempts. Retry it, skip it, or stop the run?"
            % (task["id"], MAX_IMPLEMENT),
            ["retry", "skip", "stop"], key="%s/exhausted" % key,
            show={"summary": exc.last["summary"], "blockers": exc.last["blockers"]})
        if choice == "stop":
            log("task %s stopped the run" % task["id"])
            raise SystemExit(1)
        if choice == "skip":
            log("task %s skipped by the human" % task["id"])
            continue
        result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                       key="%s/retry" % key, cwd=task["repo"], task=task)
    if teamcity.configured() and task["build_type"] != "none":
        build = step("ci/%s" % task["id"],
                     lambda: teamcity.wait_for_build(task["build_type"], result["commit"]))
        log("task %s build %s: %s" % (task["id"], build["status"], build["url"]))
        if build["status"] != "SUCCESS":
            result = ralph("prompts/fix.md", until=lambda r: r["done"], max_iter=MAX_FIX,
                           key="fix/%s" % task["id"], cwd=task["repo"], task=task, build=build)
    finished.append({"id": task["id"], "repo": task["repo"], "title": task["title"],
                     "commit": result["commit"]})
    log("task %s done: %s" % (task["id"], result["summary"]))

if not ai_gate("prompts/review.md", key="review", tasks=finished):
    human_gate(
        "The review did not pass. Its reasons are in journal.yaml under the step 'review'."
        " Fix what it found, or answer 'accepted' to continue anyway.",
        key="review-findings")

human_gate(
    "Every task is committed on %s. Review the branches, open and merge the pull requests,"
    " then answer 'merged'." % BRANCH,
    key="merge", show=finished)
log("flow finished")
