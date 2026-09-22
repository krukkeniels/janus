import re

import pytest
import yaml

import janus


def test_goal_returns_the_goal_section_text(root):
    (root / "JANUS.md").write_text(
        "# Goal\nUpgrade the widget.\n\n### Notes\nkeep it small\n\n## Decisions\n- none\n", encoding="utf-8")
    assert janus.goal() == "Upgrade the widget.\n\n### Notes\nkeep it small"


def test_goal_without_a_goal_section_raises(root):
    (root / "JANUS.md").write_text("# Something else\ntext\n", encoding="utf-8")
    with pytest.raises(janus.JanusError, match="no '# Goal' section"):
        janus.goal()


def test_log_appends_a_dated_line_to_progress_and_prints(root, capsys):
    (root / "JANUS.md").write_text("# Goal\nx\n\n## Progress\n\n## Decisions\n", encoding="utf-8")
    janus.log("task 1 done")
    assert capsys.readouterr().out == "task 1 done\n"
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    progress = text.split("## Progress\n")[1].split("## Decisions")[0]
    assert re.fullmatch(r"- \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d task 1 done\n\n", progress)


def test_log_creates_the_progress_section_when_missing(root):
    janus.log("first\nsecond line")
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert text.startswith("# Goal\nUpgrade the widget.\n\n## Progress\n- ")
    assert text.endswith(" first\n  second line\n")
    assert janus.goal() == "Upgrade the widget."


def test_begin_starts_a_fresh_journal_when_none_exists(root):
    assert janus.JOURNAL["flow"] == "flow.py"
    assert janus.JOURNAL["steps"] == {}
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d", janus.JOURNAL["started"])
    assert not (root / "journal.yaml").exists()


def test_begin_loads_an_existing_journal(root):
    (root / "journal.yaml").write_text(
        "flow: flow.py\nstarted: '2026-01-01T00:00:00'\nsteps:\n  a#1: {kind: codex, status: done, result: {x: 1}}\n",
        encoding="utf-8")
    janus.begin(root)
    assert janus.JOURNAL["started"] == "2026-01-01T00:00:00"
    assert janus.JOURNAL["steps"]["a#1"]["result"] == {"x": 1}


def test_save_journal_writes_yaml_and_leaves_no_temporary_file(root):
    janus.JOURNAL["steps"]["a#1"] = {"kind": "step", "status": "done", "result": 1}
    janus.save_journal("a#1", "done")
    data = yaml.safe_load((root / "journal.yaml").read_text(encoding="utf-8"))
    assert list(data) == ["flow", "started", "steps"]
    assert data["steps"]["a#1"]["result"] == 1
    assert sorted(p.name for p in root.iterdir()) == ["JANUS.md", "journal.yaml", "prompts"]
