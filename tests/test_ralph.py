import pytest

import janus
from helpers import read_journal, write_prompt


def test_context_values_reach_the_prompt_and_call_arguments_win(root, fake_codex):
    write_prompt(root, "p", "{{branch}}|{{goal}}|{{n}}", output={"ok": "bool"})
    fake_codex.script([{"output": {"ok": True}}])
    janus.context(branch="ai/upgrade", goal="goal from context", n=1)
    janus.codex("prompts/p.md", n=2)
    assert fake_codex.calls()[0]["prompt"] == "ai/upgrade|goal from context|2"


def test_ralph_stops_at_until_and_keys_iterations_under_the_key(root, fake_codex):
    write_prompt(root, "implement", "go", output={"done": "bool"})
    fake_codex.script([{"output": {"done": False}}, {"output": {"done": False}}, {"output": {"done": True}}])
    result = janus.ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=5, key="implement/1")
    assert result == {"done": True}
    assert list(read_journal(root)["steps"]) == ["implement/1/1", "implement/1/2", "implement/1/3"]
    assert len(fake_codex.calls()) == 3


def test_ralph_default_key_uses_the_prompt_stem_counter(root, fake_codex):
    write_prompt(root, "implement", "go", output={"done": "bool"})
    fake_codex.script([{"output": {"done": True}}])
    janus.ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=2)
    assert list(read_journal(root)["steps"]) == ["implement#1/1"]


def test_ralph_passes_previous_as_empty_then_as_the_previous_result(root, fake_codex):
    write_prompt(root, "implement", "prev: [{{previous}}]", output={"done": "bool"})
    fake_codex.script([{"output": {"done": False}}, {"output": {"done": True}}])
    janus.ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=5, key="implement/1")
    assert [c["prompt"] for c in fake_codex.calls()] == ["prev: []", "prev: [done: false]"]


def test_ralph_raises_exhausted_with_the_last_result(root, fake_codex):
    write_prompt(root, "implement", "go", output={"done": "bool", "note": "str"})
    fake_codex.script([{"output": {"done": False, "note": "still failing"}}])
    with pytest.raises(janus.Exhausted) as exc:
        janus.ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=2, key="implement/1")
    assert exc.value.last == {"done": False, "note": "still failing"}
    assert len(fake_codex.calls()) == 2
    assert list(read_journal(root)["steps"]) == ["implement/1/1", "implement/1/2"]


def test_ralph_replay_executes_only_the_unfinished_iteration(root, fake_codex):
    write_prompt(root, "implement", "go", output={"done": "bool"})
    fake_codex.script([{"output": {"done": False}}, {"output": {"done": False}}, {"output": {"done": True}}])
    janus.ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=5, key="implement/1")
    journal = read_journal(root)
    journal["steps"]["implement/1/3"]["status"] = "running"  # as if killed during the third iteration
    (root / "journal.yaml").write_text(janus.yaml.safe_dump(journal, sort_keys=False), encoding="utf-8")
    janus.begin(root)
    result = janus.ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=5, key="implement/1")
    assert result == {"done": True}
    assert len(fake_codex.calls()) == 4
    assert read_journal(root)["steps"]["implement/1/3"]["attempt"] == 2


def test_ai_gate_adds_passed_and_reasons_to_the_schema_and_returns_passed(root, fake_codex):
    write_prompt(root, "review", "Review it", output={"summary": "str"})
    fake_codex.script([{"output": {"summary": "s", "passed": False, "reasons": ["tests skipped"]}}])
    assert janus.ai_gate("prompts/review.md", key="review") is False
    schema = fake_codex.calls()[0]["schema"]
    assert schema["properties"]["passed"] == {"type": "boolean"}
    assert schema["properties"]["reasons"] == {"type": "array", "items": {"type": "string"}}
    assert schema["required"] == ["summary", "passed", "reasons"]
    entry = read_journal(root)["steps"]["review"]
    assert entry["kind"] == "ai_gate" and entry["result"]["reasons"] == ["tests skipped"]


def test_ai_gate_on_a_prompt_with_no_front_matter_still_gets_the_schema(root, fake_codex):
    """finding 5e: a prompt without an output declaration still gets {passed, reasons} in the
    schema, and ai_gate still returns the bool."""
    write_prompt(root, "review", "Review it")  # no output= means no front matter at all
    fake_codex.script([{"output": {"passed": True, "reasons": []}}])
    assert janus.ai_gate("prompts/review.md", key="review") is True
    schema = fake_codex.calls()[0]["schema"]
    assert schema["properties"]["passed"] == {"type": "boolean"}
    assert schema["properties"]["reasons"] == {"type": "array", "items": {"type": "string"}}
    assert schema["required"] == ["passed", "reasons"]
