import os
import shutil
import subprocess
import sys

import yaml

import janus
from helpers import read_journal, write_prompt

FLOW = """\
from janus import codex, step, log

plan = codex("prompts/plan.md")
for task in plan["tasks"]:
    step(f"echo/{task}", lambda: task.upper())
log("all tasks echoed")
"""


def run(root, monkeypatch, *argv):
    monkeypatch.chdir(root)
    return janus.main(list(argv) or ["run"])


def test_run_executes_the_flow_and_a_second_run_replays_every_step(root, fake_codex, monkeypatch):
    (root / "flow.py").write_text(FLOW, encoding="utf-8")
    write_prompt(root, "plan", "Plan {{goal}}", output={"tasks": "list[str]"})
    fake_codex.script([{"output": {"tasks": ["a", "b"]}}])
    assert run(root, monkeypatch) == 0
    first = read_journal(root)
    assert run(root, monkeypatch) == 0
    second = read_journal(root)
    assert len(fake_codex.calls()) == 1
    assert first == second
    assert list(first["steps"]) == ["plan#1", "echo/a", "echo/b"]
    assert first["steps"]["echo/b"]["result"] == "B"


def test_run_exits_2_at_an_open_gate(root, monkeypatch):
    (root / "flow.py").write_text("from janus import human_gate\nhuman_gate('Go on?', key='go')\n", encoding="utf-8")
    assert run(root, monkeypatch) == 2
    assert read_journal(root)["steps"]["go"]["status"] == "open"


def test_run_writes_an_uncaught_exception_to_progress_with_the_step_key(root, monkeypatch):
    (root / "flow.py").write_text(
        "from janus import step\n\ndef boom():\n    raise ValueError('bad sha')\n\nstep('push', boom)\n",
        encoding="utf-8")
    assert run(root, monkeypatch) == 1
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert "## Progress\n- " in text and text.endswith(" push: ValueError: bad sha\n")
    assert read_journal(root)["steps"]["push"]["status"] == "failed"


def test_run_writes_the_last_result_of_an_uncaught_exhausted_to_progress(root, fake_codex, monkeypatch):
    (root / "flow.py").write_text(
        "from janus import ralph\nralph('prompts/fix.md', until=lambda r: r['done'], max_iter=2, key='fix/1')\n",
        encoding="utf-8")
    write_prompt(root, "fix", "fix it", output={"done": "bool", "note": "str"})
    fake_codex.script([{"output": {"done": False, "note": "flaky"}}])
    assert run(root, monkeypatch) == 1
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert " fix/1: ralph exhausted; last result:\n  done: false\n  note: flaky\n" in text


def test_progress_line_is_written_for_an_exception_that_follows_a_replayed_step(root, monkeypatch):
    """cmd_run's exception handler must log unconditionally, even though the last replayed step left
    REPLAYING True (finding 4); log() itself must keep skipping the Progress line for a plain replay."""
    (root / "flow.py").write_text(
        "from janus import step\n\nstep('a', lambda: 1)\nraise ValueError('kaboom')\n", encoding="utf-8")
    assert run(root, monkeypatch) == 1  # first run: 'a' executes fresh, then the flow raises
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert text.count("a: ValueError: kaboom") == 1
    assert run(root, monkeypatch) == 1  # second run: 'a' is a full replay, then the flow raises again
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert text.count("a: ValueError: kaboom") == 2


def test_run_without_flow_py_exits_1(root, monkeypatch, capsys):
    assert run(root, monkeypatch) == 1
    assert "flow.py not found" in capsys.readouterr().err


def test_run_as_a_script_shares_engine_state_with_the_flow(root, fake_codex):
    shutil.copy(janus.__file__, root / "janus.py")
    (root / "flow.py").write_text(FLOW, encoding="utf-8")
    write_prompt(root, "plan", "Plan {{goal}}", output={"tasks": "list[str]"})
    fake_codex.script([{"output": {"tasks": ["a"]}}])
    proc = subprocess.run([sys.executable, "janus.py", "run"], cwd=str(root), capture_output=True, text=True,
                          env=dict(os.environ))
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == "all tasks echoed\nflow ended\n"
    journal = yaml.safe_load((root / "journal.yaml").read_text(encoding="utf-8"))
    assert list(journal["steps"]) == ["plan#1", "echo/a"]
    assert journal["steps"]["echo/a"] == {**journal["steps"]["echo/a"], "status": "done", "result": "A"}
