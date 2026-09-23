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


def test_past_max_rounds_the_blocked_decision_opens_and_retry_continues_to_round_4(
        goal_folder, fake_codex, monkeypatch):
    sent_back = [{"output": DONE}, {"output": REVIEW_BAD}]
    run_to_human_review(goal_folder, fake_codex, monkeypatch, sent_back * 3 + ONE_ROUND)
    steps = journal_of(goal_folder)["steps"]
    gate = steps["v16/r4/blocked"]
    assert (gate["kind"], gate["status"]) == ("decision", "open")
    assert "3 rounds did not finish Angular 16" in gate["question"]
    assert list(steps)[-3:] == ["v16/r3/implement/app/1", "v16/r3/review", "v16/r4/blocked"]
    text = (goal_folder / "JANUS.md").read_text(encoding="utf-8")
    assert "    AI review of round 3:\n    app: app.component.spec.ts is marked xdescribe" in text
    answer(goal_folder, "retry")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r4/blocked"]["answer"] == "retry"
    assert list(steps)[-3:] == ["v16/r4/implement/app/1", "v16/r4/review", "v16/r4/human-review"]
    assert "AI review of round 3:" in fake_codex.calls()[7]["prompt"]
    assert "v16/r5/blocked" not in steps and "v16/r1/implement/app/2" not in steps


def test_stop_at_the_blocked_decision_ends_the_run_with_exit_1(goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, [{"output": DONE}, {"output": REVIEW_BAD}] * 3)
    answer(goal_folder, "stop")
    assert run(goal_folder, monkeypatch) == 1
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r4/blocked"]["answer"] == "stop" and "v16/r4/implement/app/1" not in steps
    assert "stopped by the human after 3 rounds" in (goal_folder / "JANUS.md").read_text(encoding="utf-8")


def test_retry_at_an_exhausted_implement_loop_starts_round_2_with_the_blockers_as_findings(
        goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, [{"output": NOT_DONE}] * 5 + ONE_ROUND)
    gate = journal_of(goal_folder)["steps"]["v16/r1/implement/app/exhausted"]
    assert (gate["kind"], gate["status"]) == ("decision", "open")
    assert "app.component.ts does not compile" in (goal_folder / "JANUS.md").read_text(encoding="utf-8")
    answer(goal_folder, "retry")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert list(steps) == ["v16/plan", "v16/approve-plan"] + ["v16/r1/implement/app/%d" % n for n in range(1, 6)] \
        + ["v16/r1/implement/app/exhausted", "v16/r2/implement/app/1", "v16/r2/review", "v16/r2/human-review"]
    assert "v16/r1/review" not in steps
    round_2 = fake_codex.calls()[6]["prompt"]
    assert "Task app gave up at v16/r1/implement/app:\napp.component.ts does not compile" in round_2


def test_skip_at_an_exhausted_implement_loop_leaves_the_task_out_of_the_round(goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, [{"output": NOT_DONE}] * 5 + ONE_ROUND[1:])
    answer(goal_folder, "skip")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/implement/app/exhausted"]["answer"] == "skip"
    assert list(steps)[-2:] == ["v16/r1/review", "v16/r1/human-review"]
    assert "named by its `repo`:\n\n[]\n" in fake_codex.calls()[6]["prompt"]  # the review sees an empty round


def test_stop_at_an_exhausted_implement_loop_ends_the_run_with_exit_1(goal_folder, fake_codex, monkeypatch):
    run_to_human_review(goal_folder, fake_codex, monkeypatch, [{"output": NOT_DONE}] * 5)
    answer(goal_folder, "stop")
    assert run(goal_folder, monkeypatch) == 1
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/implement/app/exhausted"]["answer"] == "stop" and "v16/r1/review" not in steps


def test_a_green_build_is_journaled_under_the_first_verdict_and_no_fix_runs(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    teamcity_server.serve(GREEN)
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND)
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/ci/app/1"]["result"] == {"status": "SUCCESS", "url": "http://tc/viewLog.html?buildId=42",
                                                  "excerpt": ""}
    assert "v16/r1/ci/app/2" not in steps and "v16/r1/fix/app/1/1" not in steps
    assert "revision%3A%28version%3A" + "a" * 40 in teamcity_server.requests()[0]["path"]


def test_a_build_type_of_none_skips_the_teamcity_wait(goal_folder, fake_codex, teamcity_server, monkeypatch):
    plan = {"summary": PLAN["summary"], "tasks": [dict(PLAN["tasks"][0], build_type="none")]}
    fake_codex.script([{"output": plan}] + ONE_ROUND)
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    assert "v16/r1/ci/app/1" not in journal_of(goal_folder)["steps"]
    assert teamcity_server.requests() == []


def test_a_red_build_gets_a_fix_whose_commit_is_verified_by_the_second_verdict(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    teamcity_server.serve(RED + GREEN)
    run_to_human_review(goal_folder, fake_codex, monkeypatch, [{"output": DONE}, {"output": FIXED}] + ONE_ROUND[1:])
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/ci/app/1"]["result"]["status"] == "FAILURE"
    assert steps["v16/r1/fix/app/1/1"]["result"]["commit"] == "b" * 40
    assert steps["v16/r1/ci/app/2"]["result"]["status"] == "SUCCESS"
    assert "v16/r1/ci/app/3" not in steps
    fix_prompt = fake_codex.calls()[2]["prompt"]
    assert "AppComponent should render title" in fix_prompt and "http://tc/viewLog.html?buildId=42" in fix_prompt
    paths = [r["path"] for r in teamcity_server.requests()]
    assert "revision%3A%28version%3A" + "a" * 40 in paths[0]
    assert "revision%3A%28version%3A" + "b" * 40 in paths[2]  # the fix commit, not the implement commit
    assert "b" * 40 in (goal_folder / "JANUS.md").read_text(encoding="utf-8")


def test_max_ci_red_verdicts_open_the_red_decision_and_skip_keeps_the_commits(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    teamcity_server.serve(RED * 3)
    run_to_human_review(goal_folder, fake_codex, monkeypatch,
                        [{"output": DONE}, {"output": FIXED}, {"output": FIXED}] + ONE_ROUND[1:])
    steps = journal_of(goal_folder)["steps"]
    assert (steps["v16/r1/ci/app/red"]["kind"], steps["v16/r1/ci/app/red"]["status"]) == ("decision", "open")
    assert [k for k in steps if "/ci/" in k or "/fix/" in k] == \
        ["v16/r1/ci/app/1", "v16/r1/fix/app/1/1", "v16/r1/ci/app/2", "v16/r1/fix/app/2/1", "v16/r1/ci/app/3",
         "v16/r1/ci/app/red"]
    answer(goal_folder, "skip")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/ci/app/red"]["answer"] == "skip"
    assert list(steps)[-2:] == ["v16/r1/review", "v16/r1/human-review"]


def test_retry_at_the_red_decision_starts_round_2_with_the_failure_as_findings(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    teamcity_server.serve(RED * 3 + GREEN)
    run_to_human_review(goal_folder, fake_codex, monkeypatch,
                        [{"output": DONE}, {"output": FIXED}, {"output": FIXED}, {"output": DONE_2}] + ONE_ROUND[1:])
    answer(goal_folder, "retry")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert list(steps)[-4:] == ["v16/r2/implement/app/1", "v16/r2/ci/app/1", "v16/r2/review", "v16/r2/human-review"]
    assert "Task app is still red after 3 CI verdicts (http://tc/viewLog.html?buildId=42):\n" \
           "AppComponent should render title" in fake_codex.calls()[4]["prompt"]


def test_an_exhausted_fix_loop_opens_its_decision_and_skip_keeps_the_implement_commit(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    teamcity_server.serve(RED)
    run_to_human_review(goal_folder, fake_codex, monkeypatch,
                        [{"output": DONE}] + [{"output": NOT_DONE}] * 3 + ONE_ROUND[1:])
    gate = journal_of(goal_folder)["steps"]["v16/r1/fix/app/1/exhausted"]
    assert (gate["kind"], gate["status"]) == ("decision", "open")
    answer(goal_folder, "skip")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/fix/app/1/exhausted"]["answer"] == "skip"
    assert "v16/r1/ci/app/2" not in steps and steps["v16/r1/human-review"]["status"] == "open"
    assert "a" * 40 in (goal_folder / "JANUS.md").read_text(encoding="utf-8")


def test_a_build_teamcity_cannot_find_opens_the_missing_decision_instead_of_a_fix(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    teamcity_server.serve([{"count": 0}])
    run_to_human_review(goal_folder, fake_codex, monkeypatch, ONE_ROUND)
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/ci/app/1"]["result"]["status"] == "NOT_FOUND"
    assert (steps["v16/r1/ci/app/1/missing"]["kind"], steps["v16/r1/ci/app/1/missing"]["status"]) == \
        ("decision", "open")
    assert "v16/r1/fix/app/1/1" not in steps
    answer(goal_folder, "skip")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["v16/r1/ci/app/1/missing"]["answer"] == "skip" and "v16/r1/ci/app/2" not in steps
    assert steps["v16/r1/human-review"]["status"] == "open"
