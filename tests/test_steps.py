import pytest
import yaml

import janus
from helpers import read_journal


def test_step_runs_its_function_once_and_journals_the_result(root):
    calls = []

    def push():
        calls.append(1)
        return {"sha": "abc"}

    assert janus.step("push", push) == {"sha": "abc"}
    assert calls == [1]
    entry = read_journal(root)["steps"]["push"]
    assert (entry["kind"], entry["status"], entry["attempt"], entry["result"]) == ("step", "done", 1, {"sha": "abc"})
    assert entry["started"] and entry["finished"]


def test_step_replay_returns_the_stored_value_without_calling_the_function(root):
    janus.step("push", lambda: 1)
    janus.begin(root)

    def must_not_run():
        raise AssertionError("fn called on replay")

    assert janus.step("push", must_not_run) == 1


def test_running_step_is_executed_again_with_attempt_incremented(root):
    (root / "journal.yaml").write_text(
        "flow: flow.py\nstarted: x\nsteps:\n  push: {kind: step, status: running, attempt: 1, started: x}\n",
        encoding="utf-8")
    janus.begin(root)
    assert janus.run_step("push", "step", lambda attempt: attempt) == 2
    entry = read_journal(root)["steps"]["push"]
    assert (entry["status"], entry["attempt"], entry["result"]) == ("done", 2, 2)


def test_failed_step_is_executed_again_with_attempt_incremented(root):
    (root / "journal.yaml").write_text(
        "flow: flow.py\nstarted: x\nsteps:\n  push: {kind: step, status: failed, attempt: 2, error: boom}\n",
        encoding="utf-8")
    janus.begin(root)
    assert janus.run_step("push", "step", lambda attempt: attempt) == 3
    entry = read_journal(root)["steps"]["push"]
    assert (entry["status"], entry["attempt"]) == ("done", 3)
    assert "error" not in entry


def test_step_whose_function_raises_is_journaled_failed_and_reraises(root):
    def push():
        raise RuntimeError("no remote")

    with pytest.raises(RuntimeError, match="no remote"):
        janus.step("push", push)
    entry = read_journal(root)["steps"]["push"]
    assert (entry["status"], entry["attempt"], entry["error"]) == ("failed", 1, "RuntimeError: no remote")
    assert "result" not in entry


def test_step_result_must_be_yaml_serialisable(root):
    with pytest.raises(yaml.YAMLError):
        janus.step("bad", lambda: object())
    entry = read_journal(root)["steps"]["bad"]
    assert entry["status"] == "failed" and entry["error"].startswith("RepresenterError: ")


def test_duplicate_live_key_in_one_run_raises_janus_error(root):
    janus.step("push", lambda: 1)
    with pytest.raises(janus.JanusError, match="duplicate step key in one run: push"):
        janus.step("push", lambda: 2)
    assert read_journal(root)["steps"]["push"]["result"] == 1


def test_log_after_a_replayed_step_prints_but_does_not_repeat_the_progress_line(root, capsys):
    janus.step("push", lambda: 1)
    janus.log("pushed")
    janus.begin(root)
    janus.step("push", lambda: 1)
    janus.log("pushed")
    janus.step("tag", lambda: 2)
    janus.log("tagged")
    progress = (root / "JANUS.md").read_text(encoding="utf-8")
    assert progress.count("pushed") == 1
    assert progress.count("tagged") == 1
    assert capsys.readouterr().out.count("pushed") == 2
