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
CI_TIMEOUT = 7200  # seconds the CI poll may take before it gives up on this build

context(branch=BRANCH)


def ask_after_exhausted(key, exc, task):
    """Open the decision a ralph that gave up needs: `skip` returns, `stop` ends the run with 1.
    The decision is keyed `<key>/exhausted`, so it is stable against edits to this file."""
    choice = decision(
        "The loop '%s' of task %s gave up. Skip what is left of it, or stop the run?"
        % (key, task["id"]),
        ["skip", "stop"], key="%s/exhausted" % key,
        show={"summary": exc.last["summary"], "blockers": exc.last["blockers"]})
    if choice == "stop":
        log("task %s stopped the run at %s" % (task["id"], key))
        raise SystemExit(1)
    log("task %s: %s was skipped by the human" % (task["id"], key))
    return choice


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
                       key=key, cwd=task["repo"], task=task, done_so_far=finished)
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
        try:
            result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                           key="%s/retry" % key, cwd=task["repo"], task=task,
                           done_so_far=finished)
        except Exhausted as exc:  # nothing was implemented, so there is no commit to record
            ask_after_exhausted("%s/retry" % key, exc, task)
            continue
    if teamcity.configured() and task["build_type"] != "none":
        build = step("ci/%s" % task["id"],
                     lambda: teamcity.wait_for_build(task["build_type"], result["commit"],
                                                     timeout=CI_TIMEOUT))
        log("task %s build %s: %s" % (task["id"], build["status"], build["url"]))
        if build["status"] in ("NOT_FOUND", "TIMEOUT"):
            choice = decision(  # nothing here is fixable by Codex: the build never gave a verdict
                "TeamCity gave no verdict for task %s (%s). Continue without a CI check, or stop"
                " the run?" % (task["id"], build["status"]),
                ["skip", "stop"], key="ci/%s/missing" % task["id"],
                show={"status": build["status"], "url": build["url"]})
            if choice == "stop":
                log("task %s stopped the run: no CI verdict" % task["id"])
                raise SystemExit(1)
            log("task %s continues without a CI verdict" % task["id"])
        elif build["status"] == "FAILURE":
            try:
                result = ralph("prompts/fix.md", until=lambda r: r["done"], max_iter=MAX_FIX,
                               key="fix/%s" % task["id"], cwd=task["repo"], task=task, build=build)
            except Exhausted as exc:  # `skip` keeps the implement commit, red build and all
                ask_after_exhausted("fix/%s" % task["id"], exc, task)
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
