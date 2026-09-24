"""`init` (design 2026-09-24 section 2.7): a starter goal folder that runs as it is."""
import janus
from helpers import read_journal

FILES = {"janus.py", "JANUS.md", "flow.py", "prompts/_preamble.md", "prompts/draft.md", ".gitignore"}
MERMAID = "flowchart LR\n  draft --> approve\n  approve -- yes --> finish\n  approve -- no --> draft\n" \
          "  finish --> END\n  END([END])\n"


def answer(root, text):
    path = root / "JANUS.md"
    path.write_text(path.read_text(encoding="utf-8").replace("\nanswer:\n", f"\nanswer: {text}\n"), encoding="utf-8")


def test_init_creates_the_starter_folder_and_refuses_a_second_time(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert janus.main(["init", "goal"]) == 0
    goal = tmp_path / "goal"
    assert {str(p.relative_to(goal)) for p in goal.rglob("*") if p.is_file()} == FILES
    assert (goal / "janus.py").read_text(encoding="utf-8") == open(janus.__file__, encoding="utf-8").read()
    assert (goal / "JANUS.md").read_text(encoding="utf-8") == \
        "# Goal\nDescribe what Codex must achieve; every prompt sees this text as {{goal}}.\n"
    assert (goal / ".gitignore").read_text(encoding="utf-8") == "*/\n!prompts/\n!journals/\n"
    assert (goal / "prompts" / "draft.md").read_text(encoding="utf-8").startswith(
        "---\noutput:\n  done: bool\n  summary: str\n  blockers: list[str]\n---\n")
    assert "{{previous}}" in (goal / "prompts" / "draft.md").read_text(encoding="utf-8")
    assert "{{findings}}" in (goal / "prompts" / "draft.md").read_text(encoding="utf-8")
    assert (goal / "prompts" / "_preamble.md").read_text(encoding="utf-8").startswith("{{goal}}\n")
    out = capsys.readouterr().out
    assert out.startswith("created goal\nnext, in this folder:\n  1. edit JANUS.md") and "6. python janus_ui.py" in out
    assert janus.main(["init", "goal"]) == 1
    assert capsys.readouterr().err == "janus: goal exists and is not an empty folder\n"
    assert janus.main(["init"]) == 1
    assert capsys.readouterr().err == "janus: init needs a folder: python janus.py init <folder>\n"


def test_init_copies_janus_ui_when_it_sits_beside_the_engine(tmp_path, monkeypatch):
    engine = tmp_path / "engine"
    engine.mkdir()
    (engine / "janus.py").write_text("# engine\n", encoding="utf-8")
    (engine / "janus_ui.py").write_text("# ui\n", encoding="utf-8")
    monkeypatch.setattr(janus, "__file__", str(engine / "janus.py"))
    monkeypatch.chdir(tmp_path)
    assert janus.main(["init", "goal"]) == 0
    assert (tmp_path / "goal" / "janus.py").read_text(encoding="utf-8") == "# engine\n"
    assert (tmp_path / "goal" / "janus_ui.py").read_text(encoding="utf-8") == "# ui\n"


def test_the_starter_flow_has_a_graph_and_runs_to_its_gate_and_to_the_end(tmp_path, fake_codex, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert janus.main(["init", "goal"]) == 0
    goal = tmp_path / "goal"
    monkeypatch.chdir(goal)
    capsys.readouterr()
    assert janus.main(["graph"]) == 0
    assert capsys.readouterr().out == MERMAID
    fake_codex.script([{"output": {"done": True, "summary": "wrote the thing", "blockers": []}}])
    assert janus.main(["run"]) == 2
    journal = read_journal(goal)
    assert list(journal["steps"]) == ["draft#1/draft#1/1", "approve#1/gate#1"]
    assert journal["steps"]["approve#1/gate#1"]["status"] == "open"
    assert "## Gate: approve#1/gate#1\nIs this done? Answer yes, or write what to change.\n\n    wrote the thing\n" \
        in (goal / "JANUS.md").read_text(encoding="utf-8")
    prompt = fake_codex.calls()[0]["prompt"]
    assert prompt.startswith("Describe what Codex must achieve; every prompt sees this text as {{goal}}.\n\nRules:")
    assert "Do the work the goal describes, in the current folder." in prompt
    answer(goal, "yes")
    assert janus.main(["run"]) == 0
    journal = read_journal(goal)
    assert [e["node"] for e in journal["path"]] == ["draft", "approve", "finish"]
    assert "done: wrote the thing" in (goal / "JANUS.md").read_text(encoding="utf-8")
    assert len(fake_codex.calls()) == 1


def test_init_refuses_a_path_that_is_a_regular_file(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "taken").write_text("occupied\n", encoding="utf-8")
    assert janus.main(["init", str(tmp_path / "taken")]) == 1
    err = capsys.readouterr().err
    assert "janus: " in err
    assert "exists and is not an empty folder" in err
