"""The example flow, end to end, with the engine's fake `codex` and a stubbed TeamCity."""
import yaml

import janus

PLAN = {"summary": "One repository, app, goes from Angular 15 to Angular 16.",
        "tasks": [{"id": "app", "repo": "app", "title": "Upgrade app to Angular 16",
                   "objective": "app is on Angular 15.2. Run ng update to 16 and keep the tests green.",
                   "build_type": "app_Build"}]}
NOT_DONE = {"done": False, "commit": "", "summary": "ng update ran; the build still fails.",
            "blockers": ["app.component.ts does not compile"]}
DONE = {"done": True, "commit": "a" * 40, "summary": "Angular 16, build and tests green.", "blockers": []}
FIXED = {"done": True, "commit": "b" * 40, "summary": "Fixed the failing title spec.", "blockers": []}
REVIEW_OK = {"summary": "The upgrade is complete and no test was weakened.", "passed": True, "reasons": []}
REVIEW_BAD = {"summary": "The upgrade skips a spec.", "passed": False,
              "reasons": ["app: app.component.spec.ts is marked xdescribe"]}
BUILD = {"id": 42, "webUrl": "http://tc/viewLog.html?buildId=42", "state": "finished"}


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


def test_the_flow_plans_gates_implements_reviews_and_ends_at_the_merge_gate(goal_folder, fake_codex, monkeypatch):
    fake_codex.script([{"output": PLAN}, {"output": NOT_DONE}, {"output": DONE}, {"output": REVIEW_OK}])
    assert run(goal_folder, monkeypatch) == 2
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    answer(goal_folder, "merged")
    assert run(goal_folder, monkeypatch) == 0
    steps = journal_of(goal_folder)["steps"]
    assert list(steps) == ["plan", "approve-plan", "implement/app/1", "implement/app/2", "review", "merge"]
    assert [e["status"] for e in steps.values()] == ["done", "answered", "done", "done", "done", "answered"]
    assert "ci/app" not in steps
    assert len(fake_codex.calls()) == 4


def test_every_prompt_renders_with_the_branch_the_goal_and_the_task(goal_folder, fake_codex, monkeypatch):
    fake_codex.script([{"output": PLAN}, {"output": NOT_DONE}, {"output": DONE}, {"output": REVIEW_OK}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    run(goal_folder, monkeypatch)
    plan, first, second, review = fake_codex.calls()
    assert plan["cwd"].endswith("angular-16-upgrade")
    assert first["cwd"].endswith("angular-16-upgrade/app")
    assert "ai/angular-15-to-16" in plan["prompt"] and "Upgrade every Angular application" in plan["prompt"]
    assert plan["schema"]["properties"]["tasks"]["items"]["required"] == \
        ["id", "repo", "title", "objective", "build_type"]
    assert "Upgrade app to Angular 16" in first["prompt"] and "This is attempt 1" in first["prompt"]
    assert "ng update ran; the build still fails." in second["prompt"]
    assert "Upgrade app to Angular 16" in review["prompt"] and "a" * 40 in review["prompt"]
    assert review["schema"]["properties"]["passed"] == {"type": "boolean"}


def test_a_second_run_of_the_finished_flow_changes_nothing(goal_folder, fake_codex, monkeypatch):
    fake_codex.script([{"output": PLAN}, {"output": DONE}, {"output": REVIEW_OK}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    run(goal_folder, monkeypatch)
    answer(goal_folder, "merged")
    assert run(goal_folder, monkeypatch) == 0
    before = journal_of(goal_folder)
    assert run(goal_folder, monkeypatch) == 0
    assert journal_of(goal_folder) == before
    assert len(fake_codex.calls()) == 3


def test_an_exhausted_implement_loop_opens_a_decision_and_skip_continues(goal_folder, fake_codex, monkeypatch):
    fake_codex.script([{"output": PLAN}] + [{"output": NOT_DONE}] * 5 + [{"output": REVIEW_OK}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    gate = journal_of(goal_folder)["steps"]["implement/app/exhausted"]
    assert (gate["kind"], gate["status"]) == ("decision", "open")
    assert "app.component.ts does not compile" in (goal_folder / "JANUS.md").read_text(encoding="utf-8")
    answer(goal_folder, "skip")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert list(steps) == ["plan", "approve-plan"] + ["implement/app/%d" % n for n in range(1, 6)] + \
        ["implement/app/exhausted", "review", "merge"]
    assert steps["implement/app/exhausted"]["answer"] == "skip"


def test_stop_at_the_exhausted_decision_ends_the_run_with_exit_1(goal_folder, fake_codex, monkeypatch):
    fake_codex.script([{"output": PLAN}] + [{"output": NOT_DONE}] * 5)
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    run(goal_folder, monkeypatch)
    answer(goal_folder, "stop")
    assert run(goal_folder, monkeypatch) == 1
    steps = journal_of(goal_folder)["steps"]
    assert steps["implement/app/exhausted"]["answer"] == "stop"
    assert "review" not in steps


def test_a_successful_teamcity_build_is_journaled_and_no_fix_loop_runs(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    fake_codex.script([{"output": PLAN}, {"output": DONE}, {"output": REVIEW_OK}])
    teamcity_server.serve([{"build": [dict(BUILD, status="SUCCESS")]}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["ci/app"]["result"] == {"status": "SUCCESS", "url": "http://tc/viewLog.html?buildId=42",
                                         "excerpt": ""}
    assert "fix/app/1" not in steps
    assert "revision%3A%28version%3A" + "a" * 40 in teamcity_server.requests()[0]["path"]


def test_a_build_type_of_none_skips_the_teamcity_wait(goal_folder, fake_codex, teamcity_server, monkeypatch):
    plan = {"summary": PLAN["summary"], "tasks": [dict(PLAN["tasks"][0], build_type="none")]}
    fake_codex.script([{"output": plan}, {"output": DONE}, {"output": REVIEW_OK}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert "ci/app" not in steps
    assert "fix/app/1" not in steps
    assert teamcity_server.requests() == []
    answer(goal_folder, "merged")
    assert run(goal_folder, monkeypatch) == 0


def test_a_failing_teamcity_build_runs_the_fix_loop_with_the_failed_tests(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    fake_codex.script([{"output": PLAN}, {"output": DONE}, {"output": FIXED}, {"output": REVIEW_OK}])
    teamcity_server.serve([{"build": [dict(BUILD, status="FAILURE")]},
                           {"testOccurrence": [{"name": "AppComponent should render title"}]}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["ci/app"]["result"]["status"] == "FAILURE"
    assert steps["fix/app/1"]["result"]["commit"] == "b" * 40
    fix_prompt = fake_codex.calls()[2]["prompt"]
    assert "AppComponent should render title" in fix_prompt and "http://tc/viewLog.html?buildId=42" in fix_prompt
    assert "b" * 40 in (goal_folder / "JANUS.md").read_text(encoding="utf-8")


def test_retry_at_the_exhausted_decision_runs_a_second_loop_that_finishes(goal_folder, fake_codex, monkeypatch):
    fake_codex.script([{"output": PLAN}] + [{"output": NOT_DONE}] * 5 + [{"output": DONE}, {"output": REVIEW_OK}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    answer(goal_folder, "retry")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["implement/app/exhausted"]["answer"] == "retry"
    assert steps["implement/app/retry/1"]["result"]["commit"] == "a" * 40
    assert "implement/app/retry/2" not in steps
    answer(goal_folder, "merged")
    assert run(goal_folder, monkeypatch) == 0


def test_a_retry_loop_that_is_exhausted_too_opens_its_own_decision(goal_folder, fake_codex, monkeypatch):
    fake_codex.script([{"output": PLAN}] + [{"output": NOT_DONE}] * 10 + [{"output": REVIEW_OK}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    run(goal_folder, monkeypatch)
    answer(goal_folder, "retry")
    assert run(goal_folder, monkeypatch) == 2
    gate = journal_of(goal_folder)["steps"]["implement/app/retry/exhausted"]
    assert (gate["kind"], gate["status"]) == ("decision", "open")
    answer(goal_folder, "skip")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert list(steps)[-3:] == ["implement/app/retry/exhausted", "review", "merge"]
    assert steps["implement/app/retry/exhausted"]["answer"] == "skip"


def test_a_review_that_does_not_pass_opens_the_findings_gate_and_accepted_continues(
        goal_folder, fake_codex, monkeypatch):
    fake_codex.script([{"output": PLAN}, {"output": DONE}, {"output": REVIEW_BAD}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["review"]["result"]["passed"] is False
    assert (steps["review-findings"]["kind"], steps["review-findings"]["status"]) == ("gate", "open")
    answer(goal_folder, "accepted")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["review-findings"]["answer"] == "accepted"
    assert steps["merge"]["status"] == "open"
    answer(goal_folder, "merged")
    assert run(goal_folder, monkeypatch) == 0


def test_an_exhausted_fix_loop_opens_a_decision_and_skip_keeps_the_implement_commit(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    fake_codex.script([{"output": PLAN}, {"output": DONE}] + [{"output": NOT_DONE}] * 3 + [{"output": REVIEW_OK}])
    teamcity_server.serve([{"build": [dict(BUILD, status="FAILURE")]},
                           {"testOccurrence": [{"name": "AppComponent should render title"}]}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    gate = journal_of(goal_folder)["steps"]["fix/app/exhausted"]
    assert (gate["kind"], gate["status"]) == ("decision", "open")
    answer(goal_folder, "skip")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["fix/app/exhausted"]["answer"] == "skip"
    assert steps["merge"]["status"] == "open"
    assert "a" * 40 in (goal_folder / "JANUS.md").read_text(encoding="utf-8")


def test_a_build_teamcity_cannot_find_opens_a_decision_instead_of_the_fix_loop(
        goal_folder, fake_codex, teamcity_server, monkeypatch):
    fake_codex.script([{"output": PLAN}, {"output": DONE}, {"output": REVIEW_OK}])
    teamcity_server.serve([{"count": 0}])
    run(goal_folder, monkeypatch)
    answer(goal_folder, "yes")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["ci/app"]["result"]["status"] == "NOT_FOUND"
    assert (steps["ci/app/missing"]["kind"], steps["ci/app/missing"]["status"]) == ("decision", "open")
    assert "fix/app/1" not in steps
    answer(goal_folder, "skip")
    assert run(goal_folder, monkeypatch) == 2
    steps = journal_of(goal_folder)["steps"]
    assert steps["ci/app/missing"]["answer"] == "skip"
    assert "fix/app/1" not in steps
    assert "a" * 40 in (goal_folder / "JANUS.md").read_text(encoding="utf-8")
    answer(goal_folder, "merged")
    assert run(goal_folder, monkeypatch) == 0
