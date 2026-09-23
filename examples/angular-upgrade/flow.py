"""Upgrade every Angular application in this folder, one repository at a time.

Plan with Codex, let a human approve the plan, implement each task in a ralph loop, let Codex
review the result and let the human merge. Every step has an explicit key, so editing this file
does not shift the keys of finished steps.
"""
from janus import ai_gate, codex, context, human_gate, log, ralph

BRANCH = "ai/angular-15-to-16"
MAX_IMPLEMENT = 5

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
    result = ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=MAX_IMPLEMENT,
                   key="implement/%s" % task["id"], cwd=task["repo"], task=task)
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
