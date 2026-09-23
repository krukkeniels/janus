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
