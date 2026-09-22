import pytest

import janus
from helpers import read_journal, write_prompt


def test_codex_runs_exec_with_the_spec_flags_schema_and_prompt_on_stdin(root, fake_codex):
    (root / "app").mkdir()
    write_prompt(root, "plan", "Plan for {{goal}}", output={"summary": "str"})
    fake_codex.script([{"output": {"summary": "ok"}}])
    assert janus.codex("prompts/plan.md", cwd="app") == {"summary": "ok"}
    [call] = fake_codex.calls()
    argv = call["argv"]
    assert argv[:4] == ["exec", "-C", str(root / "app"), "--dangerously-bypass-approvals-and-sandbox"]
    assert argv[4] == "--output-schema" and argv[6] == "--output-last-message" and argv[-1] == "-"
    assert call["prompt"] == "Plan for Upgrade the widget."
    assert call["schema"] == janus.build_schema({"summary": "str"})
    entry = read_journal(root)["steps"]["plan#1"]
    assert (entry["kind"], entry["status"], entry["result"]) == ("codex", "done", {"summary": "ok"})


def test_codex_default_keys_count_calls_per_prompt_stem(root, fake_codex):
    write_prompt(root, "implement", "go", output={"done": "bool"})
    write_prompt(root, "review", "look", output={"done": "bool"})
    fake_codex.script([{"output": {"done": True}}])
    janus.codex("prompts/implement.md")
    janus.codex("prompts/review.md")
    janus.codex("prompts/implement.md", key="implement/explicit")
    janus.codex("prompts/implement.md")
    assert list(read_journal(root)["steps"]) == ["implement#1", "review#1", "implement/explicit", "implement#2"]


def test_codex_prepends_the_rendered_preamble_and_renders_goal_and_attempt(root, fake_codex):
    write_prompt(root, "_preamble", "Rules for: {{goal}}\n")
    write_prompt(root, "plan", "Attempt {{attempt}} of {{goal}}\n", output={"summary": "str"})
    fake_codex.script([{"output": {"summary": "ok"}}])
    janus.codex("prompts/plan.md")
    assert fake_codex.calls()[0]["prompt"] == "Rules for: Upgrade the widget.\n\nAttempt 1 of Upgrade the widget.\n"


def test_codex_prompt_without_output_returns_the_final_message_as_text(root, fake_codex):
    write_prompt(root, "free", "Say hi")
    fake_codex.script([{"text": "hello there\n"}])
    assert janus.codex("prompts/free.md") == {"text": "hello there"}
    assert "--output-schema" not in fake_codex.calls()[0]["argv"]


def test_codex_undefined_placeholder_fails_the_step_before_codex_starts(root, fake_codex):
    write_prompt(root, "plan", "{{missing}}", output={"summary": "str"})
    with pytest.raises(janus.JanusError, match="undefined placeholder"):
        janus.codex("prompts/plan.md")
    assert fake_codex.calls() == []
    entry = read_journal(root)["steps"]["plan#1"]
    assert entry["status"] == "failed" and "undefined placeholder {{missing}}" in entry["error"]


def test_codex_invalid_output_declaration_fails_the_step_before_codex_starts(root, fake_codex):
    write_prompt(root, "plan", "x", output={"summary": "text"})
    with pytest.raises(janus.JanusError, match="invalid output declaration"):
        janus.codex("prompts/plan.md")
    assert fake_codex.calls() == []
    assert read_journal(root)["steps"]["plan#1"]["status"] == "failed"


def test_codex_non_zero_exit_fails_with_the_last_twenty_stderr_lines(root, fake_codex):
    write_prompt(root, "plan", "x", output={"summary": "str"})
    fake_codex.script([{"exit": 3, "stderr": "\n".join(f"line {i}" for i in range(1, 31))}])
    with pytest.raises(janus.JanusError, match="codex exec exited with 3"):
        janus.codex("prompts/plan.md")
    error = read_journal(root)["steps"]["plan#1"]["error"]
    assert error.startswith("codex exec exited with 3: line 11\n") and error.endswith("line 30")
    assert "line 10\n" not in error


def test_codex_missing_final_message_fails_the_step(root, fake_codex):
    write_prompt(root, "plan", "x", output={"summary": "str"})
    fake_codex.script([{"stderr": "quota exceeded"}])
    with pytest.raises(janus.JanusError, match="without a final message: quota exceeded"):
        janus.codex("prompts/plan.md")
    assert read_journal(root)["steps"]["plan#1"]["status"] == "failed"


def test_codex_answer_that_does_not_match_the_schema_fails_the_step(root, fake_codex):
    write_prompt(root, "plan", "x", output={"summary": "str"})
    fake_codex.script([{"output": {"summary": 5}}])
    with pytest.raises(janus.JanusError, match=r"does not match the output schema \(\$.summary: expected string\)"):
        janus.codex("prompts/plan.md")
    assert read_journal(root)["steps"]["plan#1"]["status"] == "failed"


def test_codex_re_executed_after_running_renders_attempt_as_2(root, fake_codex):
    """spec section 5, Replay: a 'running' step is executed again with attempt incremented, and
    prompts see the new {{attempt}} (finding 5b)."""
    write_prompt(root, "plan", "Attempt {{attempt}}", output={"summary": "str"})
    (root / "journal.yaml").write_text(
        "flow: flow.py\nstarted: x\nsteps:\n  plan#1: {kind: codex, status: running, attempt: 1, started: x}\n",
        encoding="utf-8")
    janus.begin(root)
    fake_codex.script([{"output": {"summary": "ok"}}])
    assert janus.codex("prompts/plan.md") == {"summary": "ok"}
    assert fake_codex.calls()[0]["prompt"] == "Attempt 2"
    assert read_journal(root)["steps"]["plan#1"]["attempt"] == 2


def test_codex_re_executed_after_failed_renders_attempt_as_2(root, fake_codex):
    """spec section 5, Replay: a 'failed' step is likewise executed again with attempt incremented
    (finding 5b)."""
    write_prompt(root, "plan", "Attempt {{attempt}}", output={"summary": "str"})
    (root / "journal.yaml").write_text(
        "flow: flow.py\nstarted: x\nsteps:\n  plan#1: {kind: codex, status: failed, attempt: 1, error: boom}\n",
        encoding="utf-8")
    janus.begin(root)
    fake_codex.script([{"output": {"summary": "ok"}}])
    assert janus.codex("prompts/plan.md") == {"summary": "ok"}
    assert fake_codex.calls()[0]["prompt"] == "Attempt 2"


def test_codex_replay_does_not_call_codex_again(root, fake_codex):
    write_prompt(root, "plan", "x", output={"summary": "str"})
    fake_codex.script([{"output": {"summary": "ok"}}])
    janus.codex("prompts/plan.md")
    janus.begin(root)
    assert janus.codex("prompts/plan.md") == {"summary": "ok"}
    assert len(fake_codex.calls()) == 1
