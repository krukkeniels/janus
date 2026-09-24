"""Token usage per Codex step (design 2026-09-24 section 2.10): the session id from the transcript, the
totals from the rollout file under CODEX_HOME, both next to ``result`` in the journal entry."""
import json

import pytest

import janus
from helpers import read_journal, write_prompt

SESSION = "01a0cf56-62a3-7972-ba18-fa8c73d313b2"
OTHER = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee"


def usage_event(input_tokens, cached, output, total, info=True):
    payload = {"type": "token_count"}
    if info:
        payload["info"] = {"total_token_usage": {
            "input_tokens": input_tokens, "cached_input_tokens": cached, "cache_write_input_tokens": 0,
            "output_tokens": output, "reasoning_output_tokens": 7, "total_tokens": total},
            "last_token_usage": {}, "model_context_window": 258400}
        payload["rate_limits"] = {}
    return json.dumps({"timestamp": "2026-09-23T17:36:38.958Z", "ordinal": 28, "type": "event_msg", "payload": payload})


ROLLOUT = "\n".join([
    usage_event(1000, 100, 50, 1050),
    json.dumps({"timestamp": "x", "type": "response_item", "payload": {"type": "message", "content": []}}),
    usage_event(41083, 30848, 476, 41559),
]) + "\n"


@pytest.fixture
def codex_home(tmp_path, monkeypatch):
    """A CODEX_HOME with one session rollout; returns a writer for more."""
    home = tmp_path / "codex-home"
    monkeypatch.setenv("CODEX_HOME", str(home))

    def write(session, text, day="2026/09/23"):
        folder = home / "sessions" / day
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"rollout-2026-09-23T19-35-40-{session}.jsonl").write_text(text, encoding="utf-8")

    write(SESSION, ROLLOUT)
    return write


def test_read_usage_returns_the_last_token_count_event(codex_home):
    assert janus.read_usage(SESSION) == {"input": 41083, "cached": 30848, "output": 476, "total": 41559}


def test_read_usage_returns_none_for_a_missing_file_bad_json_or_missing_keys(codex_home):
    assert janus.read_usage(OTHER) is None
    codex_home(OTHER, "not json\n")
    assert janus.read_usage(OTHER) is None
    codex_home(OTHER, json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": {"x": 1}}}) + "\n")
    assert janus.read_usage(OTHER) is None
    codex_home(OTHER, json.dumps({"type": "event_msg", "payload": {"type": "turn_complete"}}) + "\n")
    assert janus.read_usage(OTHER) is None


def test_read_usage_skips_a_token_count_event_without_info(codex_home):
    codex_home(OTHER, usage_event(10, 0, 5, 15) + "\n" + usage_event(0, 0, 0, 0, info=False) + "\n")
    assert janus.read_usage(OTHER) == {"input": 10, "cached": 0, "output": 5, "total": 15}


def test_codex_step_records_session_and_usage_next_to_the_result(root, fake_codex, codex_home):
    write_prompt(root, "plan", "Plan {{goal}}", output={"summary": "str"})
    fake_codex.script([{"output": {"summary": "ok"}, "stderr": f"session id: {SESSION}"}])
    assert janus.codex("prompts/plan.md") == {"summary": "ok"}
    entry = read_journal(root)["steps"]["plan#1"]
    assert list(entry) == ["kind", "status", "attempt", "started", "finished", "result", "session", "usage"]
    assert entry["session"] == SESSION
    assert entry["usage"] == {"input": 41083, "cached": 30848, "output": 476, "total": 41559}
    assert entry["result"] == {"summary": "ok"}


def test_a_session_without_a_rollout_file_records_the_id_only(root, fake_codex, codex_home):
    write_prompt(root, "plan", "Plan", output={"summary": "str"})
    fake_codex.script([{"output": {"summary": "ok"}, "stderr": f"session id: {OTHER}"}])
    janus.codex("prompts/plan.md")
    entry = read_journal(root)["steps"]["plan#1"]
    assert entry["session"] == OTHER and "usage" not in entry


def test_a_transcript_without_a_session_id_records_neither(root, fake_codex, codex_home):
    write_prompt(root, "plan", "Plan", output={"summary": "str"})
    fake_codex.script([{"output": {"summary": "ok"}, "stderr": "thinking...\nsession id is not on its own line"}])
    janus.codex("prompts/plan.md")
    entry = read_journal(root)["steps"]["plan#1"]
    assert "session" not in entry and "usage" not in entry


def test_a_failed_codex_step_keeps_the_session_and_usage_it_captured(root, fake_codex, codex_home):
    write_prompt(root, "plan", "Plan", output={"summary": "str"})
    fake_codex.script([{"exit": 3, "stderr": f"session id: {SESSION}\nboom"}])
    with pytest.raises(janus.JanusError, match="codex exec exited with 3"):
        janus.codex("prompts/plan.md")
    entry = read_journal(root)["steps"]["plan#1"]
    assert entry["status"] == "failed" and entry["session"] == SESSION and entry["usage"]["total"] == 41559


def test_each_ralph_iteration_records_its_own_session_and_a_step_records_none(root, fake_codex, codex_home):
    codex_home(OTHER, usage_event(5, 0, 1, 6) + "\n")
    write_prompt(root, "fix", "fix", output={"done": "bool"})
    fake_codex.script([{"output": {"done": False}, "stderr": f"session id: {SESSION}"},
                       {"output": {"done": True}, "stderr": f"session id: {OTHER}"}])
    janus.ralph("prompts/fix.md", until=lambda r: r["done"], max_iter=2, key="fix")
    janus.step("push", lambda: "pushed")
    steps = read_journal(root)["steps"]
    assert (steps["fix/1"]["session"], steps["fix/1"]["usage"]["total"]) == (SESSION, 41559)
    assert (steps["fix/2"]["session"], steps["fix/2"]["usage"]["total"]) == (OTHER, 6)
    assert "session" not in steps["push"] and "usage" not in steps["push"]


def test_status_prints_the_tokens_line_when_any_entry_has_usage(root, monkeypatch, capsys):
    (root / "journal.yaml").write_text(
        "flow: flow.py\nstarted: x\nsteps:\n"
        "  plan#1: {kind: codex, status: done, attempt: 1, session: a,\n"
        "           usage: {input: 100, cached: 40, output: 10, total: 110}}\n"
        "  fix/1: {kind: codex, status: failed, attempt: 1, session: b}\n"
        "  fix/2: {kind: codex, status: done, attempt: 1, session: c,\n"
        "          usage: {input: 50, cached: 0, output: 5, total: 55}}\n",
        encoding="utf-8")
    monkeypatch.chdir(root)
    assert janus.main(["status"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("tokens: 165 total, 150 in (40 cached), 15 out over 2 sessions\nno open gate\n")
    (root / "journal.yaml").write_text(
        "flow: flow.py\nstarted: x\nsteps:\n  plan#1: {kind: codex, status: done, attempt: 1}\n", encoding="utf-8")
    assert janus.main(["status"]) == 0
    assert capsys.readouterr().out.startswith("no open gate\n")
