"""The example flow, end to end, with the engine's fake `codex` and a stubbed TeamCity.

Every test drives `janus.main(["run"])` in a copied goal folder the way a human would: run, answer
the one open gate in JANUS.md, run again. The keys carry the major, the round and the task
(`v16/r1/implement/app/1`), as spec section 14 asks of every loop.
"""
import yaml

import janus

PLAN = {"summary": "One repository, app, goes from Angular 15 to Angular 16.",
        "tasks": [{"id": "app", "repo": "app", "title": "Upgrade app to Angular 16",
                   "objective": "app is on Angular 15.2. Run ng update to 16 and keep the tests green.",
                   "build_type": "app_Build"}]}
NOT_DONE = {"done": False, "commit": "", "summary": "ng update ran; the build still fails.",
            "blockers": ["app.component.ts does not compile"]}
DONE = {"done": True, "commit": "a" * 40, "summary": "Angular 16, build and tests green.", "blockers": []}
DONE_2 = {"done": True, "commit": "c" * 40, "summary": "Round 2: the findings are addressed.", "blockers": []}
FIXED = {"done": True, "commit": "b" * 40, "summary": "Fixed the failing title spec.", "blockers": []}
REVIEW_OK = {"passed": True, "reasons": [], "summary": "The upgrade is complete and no test was weakened."}
REVIEW_BAD = {"passed": False, "reasons": ["app: app.component.spec.ts is marked xdescribe"],
              "summary": "The upgrade skips a spec."}
TESTPLAN = {"steps": ["Open / and see the title", "Navigate to /about and back"],
            "summary": "Bootstrapping and routing are the risk of this round."}
BUILD = {"id": 42, "webUrl": "http://tc/viewLog.html?buildId=42", "state": "finished"}
RED = [{"build": [dict(BUILD, status="FAILURE")]},
       {"testOccurrence": [{"name": "AppComponent should render title"}]}]
GREEN = [{"build": [dict(BUILD, status="SUCCESS")]}]
ONE_ROUND = [{"output": DONE}, {"output": REVIEW_OK}, {"output": TESTPLAN}]
ROUND_1 = ["v16/r1/implement/app/1", "v16/r1/review", "v16/r1/human-review", "v16/r1/merge",
           "v16/r1/testplan", "v16/r1/qa"]


def run(folder, monkeypatch):
    monkeypatch.chdir(folder)
    return janus.main(["run"])


def answer(folder, text):
    """Answer the one open gate: only one is ever open at a time."""
    path = folder / "JANUS.md"
    path.write_text(path.read_text(encoding="utf-8").replace("\nanswer:\n", "\nanswer: %s\n" % text),
                    encoding="utf-8")


def journal_of(folder):
    return yaml.safe_load((folder / "journal.yaml").read_text(encoding="utf-8"))


def run_to_human_review(folder, fake_codex, monkeypatch, script):
    """Plan, approve, and run the first round up to its human review gate."""
    fake_codex.script([{"output": PLAN}] + script)
    assert run(folder, monkeypatch) == 2
    answer(folder, "yes")
    assert run(folder, monkeypatch) == 2


def test_one_round_that_passes_every_check_ends_at_qa_passed(goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND)
    answer(goal_folder, "approved")
    assert run(goal_folder, monkeypatch) == 2
    answer(goal_folder, "merged")
    assert run(goal_folder, monkeypatch) == 2
    answer(goal_folder, "passed")
    assert run(goal_folder, monkeypatch) == 0
    steps = journal_of(goal_folder)["steps"]
    assert list(steps) == ["v16/plan", "v16/approve-plan"] + ROUND_1
    assert [e["status"] for e in steps.values()] == \
        ["done", "answered", "done", "done", "answered", "answered", "done", "answered"]
    assert steps["v16/r1/review"]["kind"] == "codex" and steps["v16/r1/review"]["result"]["passed"] is True
    assert "v16/r1/ci/app/1" not in steps and "v16/direction" not in steps
    assert len(fake_codex.calls()) == 4
    assert "Angular 16 reached in 1 round(s)" in (goal_folder / "JANUS.md").read_text(encoding="utf-8")


def test_every_prompt_renders_with_the_branch_the_target_the_task_and_empty_findings(
        goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, [{"output": NOT_DONE}] + ONE_ROUND)
    plan, first, second, review = fake_codex.calls()[:4]
    assert plan["cwd"].endswith("angular-16-upgrade") and first["cwd"].endswith("angular-16-upgrade/app")
    assert "ai/angular-15-to-16" in plan["prompt"] and "Plan the upgrade to Angular 16." in plan["prompt"]
    assert "Upgrade every Angular application" in plan["prompt"]
    assert plan["schema"]["properties"]["tasks"]["items"]["required"] == \
        ["id", "repo", "title", "objective", "build_type"]
    assert "Upgrade app to Angular 16" in first["prompt"] and "This is attempt 1" in first["prompt"]
    assert "do not start over, and make sure this round resolves every finding.\n\n\n\nWhat the previous" \
        in first["prompt"]  # {{findings}} is the empty string in round 1, like {{previous}} in iteration 1
    assert "ng update ran; the build still fails." in second["prompt"]
    assert "Upgrade app to Angular 16" in review["prompt"] and "a" * 40 in review["prompt"]
    assert "The target of this round is Angular 16." in review["prompt"]
    assert review["schema"]["required"] == ["passed", "reasons", "summary"]
    answer(goal_folder, "approved")
    run(goal_folder, monkeypatch)
    answer(goal_folder, "merged")
    run(goal_folder, monkeypatch)
    testplan = fake_codex.calls()[4]
    assert "a" * 40 in testplan["prompt"] and testplan["schema"]["required"] == ["steps", "summary"]
    text = (goal_folder / "JANUS.md").read_text(encoding="utf-8")
    assert "## Gate: v16/r1/qa" in text and "- Open / and see the title" in text


def test_a_failed_ai_review_sends_the_work_back_and_round_2_implements_with_the_reasons(
        goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch,
                        [{"output": DONE}, {"output": REVIEW_BAD}, {"output": DONE_2}] + ONE_ROUND[1:])
    steps = journal_of(goal_folder)["steps"]
    assert list(steps) == ["v16/plan", "v16/approve-plan", "v16/r1/implement/app/1", "v16/r1/review",
                           "v16/r2/implement/app/1", "v16/r2/review", "v16/r2/human-review"]
    assert steps["v16/r1/review"]["result"]["passed"] is False
    assert "v16/r1/human-review" not in steps
    round_2 = fake_codex.calls()[3]["prompt"]
    assert "AI review of round 1:\napp: app.component.spec.ts is marked xdescribe" in round_2
    text = (goal_folder / "JANUS.md").read_text(encoding="utf-8")
    assert "round 1 of Angular 16 came back: AI review of round 1:" in text
    assert "c" * 40 in text  # the human review of round 2 shows round 2's commit


def test_human_review_findings_become_the_findings_of_round_2(goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND[:2] + [{"output": DONE_2}] + ONE_ROUND[1:])
    round_1 = dict(journal_of(goal_folder)["steps"]["v16/r1/implement/app/1"])
    answer(goal_folder, "Also update zone.js to the version Angular 16 recommends")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/human-review"]["answer"] == "Also update zone.js to the version Angular 16 recommends"
    assert list(steps)[-3:] == ["v16/r2/implement/app/1", "v16/r2/review", "v16/r2/human-review"]
    assert steps["v16/r1/implement/app/1"] == round_1  # round 1 replayed, untouched
    assert "Human review of round 1:\nAlso update zone.js to the version Angular 16 recommends" \
        in fake_codex.calls()[3]["prompt"]
    answer(goal_folder, "approved")
    assert run(goal_folder, monkeypatch) == 2
    assert journal_of(goal_folder)["steps"]["v16/r2/merge"]["status"] == "open"
    assert len(fake_codex.calls()) == 5


def test_qa_findings_become_the_findings_of_round_2_and_round_2_can_finish(goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND + [{"output": DONE_2}] + ONE_ROUND[1:])
    answer(goal_folder, "approved")
    run(goal_folder, monkeypatch)
    answer(goal_folder, "merged")
    assert run(goal_folder, monkeypatch) == 2
    answer(goal_folder, "The login form no longer submits on Enter")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/qa"]["answer"] == "The login form no longer submits on Enter"
    assert list(steps)[-3:] == ["v16/r2/implement/app/1", "v16/r2/review", "v16/r2/human-review"]
    assert "QA of round 1:\nThe login form no longer submits on Enter" in fake_codex.calls()[4]["prompt"]
    for text in ("approved", "merged", "passed"):
        answer(goal_folder, text)
        code = run(goal_folder, monkeypatch)
    assert code == 0
    steps = journal_of(goal_folder)["steps"]
    assert list(steps) == ["v16/plan", "v16/approve-plan"] + ROUND_1 + [k.replace("/r1/", "/r2/") for k in ROUND_1]
    assert "Angular 16 reached in 2 round(s)" in (goal_folder / "JANUS.md").read_text(encoding="utf-8")


def test_a_second_run_of_the_finished_flow_changes_nothing(goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND)
    for text in ("approved", "merged", "passed"):
        answer(goal_folder, text)
        code = run(goal_folder, monkeypatch)
    assert code == 0
    before = (goal_folder / "journal.yaml").read_text(encoding="utf-8")
    assert run(goal_folder, monkeypatch) == 0
    assert (goal_folder / "journal.yaml").read_text(encoding="utf-8") == before
    assert len(fake_codex.calls()) == 4


def test_a_later_task_sees_what_the_earlier_tasks_of_the_round_finished(goal_folder, fake_codex, monkeypatch):
    (goal_folder / "ui-kit").mkdir()
    plan = {"summary": PLAN["summary"],
            "tasks": [PLAN["tasks"][0],
                      {"id": "ui-kit", "repo": "ui-kit", "title": "Upgrade ui-kit to Angular 16",
                       "objective": "ui-kit is on Angular 15.2 and app depends on it.", "build_type": "none"}]}
    second = {"done": True, "commit": "d" * 40, "summary": "ui-kit is on 16.", "blockers": []}
    fake_codex.script([{"output": plan}, {"output": DONE}, {"output": second}] + ONE_ROUND[1:])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    first_prompt, later_prompt = fake_codex.calls()[1]["prompt"], fake_codex.calls()[2]["prompt"]
    assert "Tasks already finished in this round" in first_prompt and "[]" in first_prompt
    assert "a" * 40 in later_prompt and "Upgrade app to Angular 16" in later_prompt
    steps = journal_of(goal_folder)["steps"]
    assert "v16/r1/implement/ui-kit/1" in steps and steps["v16/r1/human-review"]["status"] == "open"


def test_two_majors_run_in_order_when_the_direction_check_says_next(goal_folder, fake_codex, monkeypatch):
    flow = (goal_folder / "flow.py").read_text(encoding="utf-8")
    assert "MAJORS = [16] " in flow
    (goal_folder / "flow.py").write_text(flow.replace("MAJORS = [16] ", "MAJORS = [16, 17]"), encoding="utf-8")
    plan_17 = {"summary": "app goes from Angular 16 to 17.",
               "tasks": [dict(PLAN["tasks"][0], title="Upgrade app to Angular 17")]}
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND + [{"output": plan_17}] + ONE_ROUND)
    for text in ("approved", "merged", "passed"):
        answer(goal_folder, text)
        assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert (steps["v16/direction"]["kind"], steps["v16/direction"]["status"]) == ("decision", "open")
    assert "Continue to Angular 17" in steps["v16/direction"]["question"]
    answer(goal_folder, "next")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert list(steps)[-2:] == ["v17/plan", "v17/approve-plan"]
    plan_prompt = fake_codex.calls()[4]["prompt"]
    assert "ai/angular-16-to-17" in plan_prompt and "Plan the upgrade to Angular 17." in plan_prompt
    assert "ai/angular-15-to-16" not in plan_prompt
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    for text in ("approved", "merged", "passed"):
        answer(goal_folder, text)
        code = run(goal_folder, monkeypatch)
    assert code == 0
    steps = journal_of(goal_folder)["steps"]
    assert "v17/r1/qa" in steps and "v17/direction" not in steps
    assert len(fake_codex.calls()) == 8


def test_the_direction_check_can_stop_after_the_first_major(goal_folder, fake_codex, monkeypatch):
    flow = (goal_folder / "flow.py").read_text(encoding="utf-8")
    (goal_folder / "flow.py").write_text(flow.replace("MAJORS = [16] ", "MAJORS = [16, 17]"), encoding="utf-8")
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND)
    for text in ("approved", "merged", "passed"):
        answer(goal_folder, text)
        assert run(goal_folder, monkeypatch) == 2
    answer(goal_folder, "stop")
    assert run(goal_folder, monkeypatch) == 0
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/direction"]["answer"] == "stop" and "v17/plan" not in steps
    assert len(fake_codex.calls()) == 4
