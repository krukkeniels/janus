import re

import pytest

import janus
from helpers import read_journal


def open_gate(root, answer=None, **kwargs):
    """Open (or re-enter) a gate expecting exit 2; optionally write an answer afterwards."""
    with pytest.raises(SystemExit) as exc:
        janus.human_gate("Approve this plan?", key="approve-plan", **kwargs)
    assert exc.value.code == 2
    if answer is not None:
        path = root / "JANUS.md"
        path.write_text(path.read_text(encoding="utf-8").replace("answer:\n", f"answer:{answer}\n"), encoding="utf-8")


def test_human_gate_writes_the_section_journals_open_and_exits_2(root, capsys):
    open_gate(root, show={"tasks": ["a", "b"]})
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert text == ("# Goal\nUpgrade the widget.\n\n## Gate: approve-plan\nApprove this plan?\n\n"
                    "    tasks:\n    - a\n    - b\n\nanswer:\n")
    entry = read_journal(root)["steps"]["approve-plan"]
    assert (entry["kind"], entry["status"], entry["question"]) == ("gate", "open", "Approve this plan?")
    assert "gate open: approve-plan" in capsys.readouterr().out


def test_answer_is_journaled_moved_to_decisions_returned_and_replayed(root):
    open_gate(root, answer=" yes")
    janus.begin(root)
    assert janus.human_gate("Approve this plan?", key="approve-plan") == "yes"
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert "## Gate:" not in text
    assert re.search(r"## Decisions\n- \d{4}-\d\d-\d\d approve-plan: Approve this plan\?\n  answer: yes\n", text)
    entry = read_journal(root)["steps"]["approve-plan"]
    assert (entry["status"], entry["answer"]) == ("answered", "yes")
    janus.begin(root)
    assert janus.human_gate("Approve this plan?", key="approve-plan") == "yes"


def test_answer_may_continue_on_the_following_lines(root):
    open_gate(root, answer="\nchange task 2\nthen go")
    janus.begin(root)
    assert janus.human_gate("Approve this plan?", key="approve-plan") == "change task 2\nthen go"
    assert "  answer: change task 2\n  then go\n" in (root / "JANUS.md").read_text(encoding="utf-8")


def test_empty_answer_keeps_the_gate_open_and_exits_2_again(root):
    open_gate(root)
    janus.begin(root)
    open_gate(root)
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert text.count("## Gate: approve-plan") == 1
    assert read_journal(root)["steps"]["approve-plan"]["status"] == "open"


def test_decision_rejects_an_answer_outside_its_options_with_a_note(root):
    with pytest.raises(SystemExit):
        janus.decision("Continue?", ["retry", "skip"], key="d")
    path = root / "JANUS.md"
    path.write_text(path.read_text(encoding="utf-8").replace("answer:\n", "answer: maybe\n"), encoding="utf-8")
    janus.begin(root)
    with pytest.raises(SystemExit) as exc:
        janus.decision("Continue?", ["retry", "skip"], key="d")
    assert exc.value.code == 2
    text = path.read_text(encoding="utf-8")
    assert text.endswith('## Gate: d\nContinue?\n\nNote: "maybe" is not one of: retry, skip.\n\nanswer:\n')
    entry = read_journal(root)["steps"]["d"]
    assert (entry["kind"], entry["status"]) == ("decision", "open")


def test_decision_returns_an_answer_within_its_options(root):
    with pytest.raises(SystemExit):
        janus.decision("Continue?", ["retry", "skip"], key="d")
    path = root / "JANUS.md"
    path.write_text(path.read_text(encoding="utf-8").replace("answer:\n", "answer: skip\n"), encoding="utf-8")
    janus.begin(root)
    assert janus.decision("Continue?", ["retry", "skip"], key="d") == "skip"
    assert read_journal(root)["steps"]["d"]["status"] == "answered"


def test_human_gate_and_decision_without_a_key_default_to_gate1_and_decision1(root):
    """spec section 4, Keys: the default key rule applies to gates too (finding 5d)."""
    with pytest.raises(SystemExit):
        janus.human_gate("Approve?")
    with pytest.raises(SystemExit):
        janus.decision("Continue?", ["retry", "skip"])
    assert set(read_journal(root)["steps"]) == {"gate#1", "decision#1"}


def test_multiline_question_with_a_heading_line_is_still_answerable(root):
    """A '## x'-shaped line inside a multi-line question must not fool find_section into ending
    the gate section early (finding 1, question case)."""
    question = "Approve this?\n## Plan\nSee tasks above."
    with pytest.raises(SystemExit):
        janus.human_gate(question, key="approve-multi")
    janus.begin(root)
    with pytest.raises(SystemExit):  # a second run before an answer must not append a duplicate section
        janus.human_gate(question, key="approve-multi")
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert text.count("## Gate: approve-multi") == 1
    path = root / "JANUS.md"
    path.write_text(text.replace("answer:\n", "answer: yes\n"), encoding="utf-8")
    janus.begin(root)
    assert janus.human_gate(question, key="approve-multi") == "yes"
    assert read_journal(root)["steps"]["approve-multi"]["status"] == "answered"


def test_multiline_answer_with_a_heading_line_is_returned_and_recorded_in_full(root):
    """A '## x'-shaped line inside a human's multi-line answer must not truncate the gate section
    before the engine's own answer: marker (finding 1, answer case)."""
    open_gate(root, answer="\n## Reason\ntoo risky")
    janus.begin(root)
    assert janus.human_gate("Approve this plan?", key="approve-plan") == "## Reason\ntoo risky"
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert "## Gate:" not in text
    assert "  answer: ## Reason\n  too risky\n" in text


def test_question_starting_with_answer_prefix_is_not_mistaken_for_the_marker(root):
    """read_answer must find the engine's own answer: line, not a question line that happens to
    start with 'answer:' (finding 1, Task 7 deferred minor)."""
    question = "answer: is this workable?"
    with pytest.raises(SystemExit):
        janus.human_gate(question, key="weird")
    path = root / "JANUS.md"
    path.write_text(path.read_text(encoding="utf-8").replace("answer:\n", "answer: yes\n"), encoding="utf-8")
    janus.begin(root)
    assert janus.human_gate(question, key="weird") == "yes"
