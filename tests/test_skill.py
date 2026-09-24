"""The Codex skill for writing flows (design 2026-09-24 section 2.11) cannot fall behind the engine's API."""
from pathlib import Path

import yaml

import janus

SKILL = Path(janus.__file__).resolve().parent / "skills" / "janus-flow" / "SKILL.md"
PUBLIC = ["node", "END", "codex", "ralph", "ai_gate", "human_gate", "decision", "step", "log", "goal", "context",
          "Exhausted", "JanusError"]


def test_skill_file_has_the_codex_front_matter():
    text = SKILL.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    front = yaml.safe_load(text.split("\n---\n", 1)[0][4:])
    assert front["name"] == "janus-flow"
    assert front["description"].startswith("Write or change a Janus goal folder")
    assert front["metadata"] == {"short-description": "Write a Janus flow"}


def test_skill_names_every_public_primitive_and_stays_short():
    text = SKILL.read_text(encoding="utf-8")
    for name in PUBLIC:
        assert name in text, name
        assert getattr(janus, name) is not None
    assert len(text.splitlines()) < 200


def test_init_tells_where_the_skill_is(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert janus.main(["init", "goal"]) == 0
    assert "cp -r <janus repository>/skills/janus-flow ~/.codex/skills/" in capsys.readouterr().out
