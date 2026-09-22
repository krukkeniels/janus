import yaml

import janus

JOURNAL = {
    "flow": "flow.py",
    "started": "2026-09-22T10:00:00",
    "steps": {
        "plan#1": {"kind": "codex", "status": "done", "attempt": 1},
        "implement/1/1": {"kind": "codex", "status": "done", "attempt": 1},
        "implement/1/2": {"kind": "codex", "status": "done", "attempt": 2},
        "ci/1": {"kind": "step", "status": "done", "attempt": 1},
        "implement/2/1": {"kind": "codex", "status": "done", "attempt": 1},
        "approve-plan": {"kind": "gate", "status": "open", "question": "Approve this plan?"},
    },
}

DECISIONS = "# Goal\nUpgrade.\n\n## Decisions\n- 2026-09-22 x: y\n  answer: z\n"
JANUS_MD = DECISIONS + "\n## Gate: approve-plan\nApprove this plan?\n\nanswer:\n\n## Gate: other\nOther?\n\nanswer:\n"


def run(root, monkeypatch, command):
    monkeypatch.chdir(root)
    return janus.main([command])


def test_status_shows_the_open_gate_the_last_five_steps_and_the_next_action(root, monkeypatch, capsys):
    (root / "journal.yaml").write_text(yaml.safe_dump(JOURNAL, sort_keys=False), encoding="utf-8")
    assert run(root, monkeypatch, "status") == 0
    assert capsys.readouterr().out == (
        "open gate: approve-plan\n"
        "  Approve this plan?\n"
        "last steps:\n"
        "  implement/1/1: codex done (attempt 1)\n"
        "  implement/1/2: codex done (attempt 2)\n"
        "  ci/1: step done (attempt 1)\n"
        "  implement/2/1: codex done (attempt 1)\n"
        "  approve-plan: gate open (attempt -)\n"
        "next: answer 'approve-plan' in JANUS.md, then python janus.py run\n"
    )


def test_status_points_at_the_step_that_will_be_re_executed(root, monkeypatch, capsys):
    (root / "journal.yaml").write_text(
        "flow: flow.py\nstarted: x\nsteps:\n  plan#1: {kind: codex, status: failed, attempt: 1, error: boom}\n",
        encoding="utf-8")
    assert run(root, monkeypatch, "status") == 0
    out = capsys.readouterr().out
    assert out.startswith("no open gate\n") and out.endswith("next: python janus.py run (re-executes plan#1)\n")


def test_status_without_a_journal_points_at_run(root, monkeypatch, capsys):
    assert run(root, monkeypatch, "status") == 0
    assert capsys.readouterr().out == "no journal; nothing has run yet\nnext: python janus.py run\n"


def test_status_with_a_corrupt_journal_returns_1_with_a_clean_message(root, monkeypatch, capsys):
    """finding 6: an empty or malformed journal.yaml must not crash with a raw traceback."""
    (root / "journal.yaml").write_text("", encoding="utf-8")
    assert run(root, monkeypatch, "status") == 1
    assert capsys.readouterr().err == "janus: journal.yaml is not a valid journal: empty\n"


def test_missing_command_returns_1_not_2(root, monkeypatch, capsys):
    """finding 7: argparse's usual exit 2 for a usage error collides with '2 = a gate is open'."""
    monkeypatch.chdir(root)
    assert janus.main([]) == 1
    capsys.readouterr()


def test_unknown_command_returns_1_not_2(root, monkeypatch, capsys):
    monkeypatch.chdir(root)
    assert janus.main(["bogus"]) == 1
    capsys.readouterr()


def test_reset_archives_the_journal_and_removes_open_gates(root, monkeypatch):
    (root / "journal.yaml").write_text(yaml.safe_dump(JOURNAL, sort_keys=False), encoding="utf-8")
    (root / "JANUS.md").write_text(JANUS_MD, encoding="utf-8")
    assert run(root, monkeypatch, "reset") == 0
    assert not (root / "journal.yaml").exists()
    [archive] = list((root / "journals").iterdir())
    assert archive.suffix == ".yaml" and yaml.safe_load(archive.read_text(encoding="utf-8")) == JOURNAL
    assert (root / "JANUS.md").read_text(encoding="utf-8") == DECISIONS


def test_reset_archives_a_corrupt_journal_without_crashing(root, monkeypatch):
    """NB2: reset must archive journal.yaml without parsing it, so a corrupt journal does not
    make reset fail instead of clearing the way for a fresh run."""
    (root / "journal.yaml").write_text("", encoding="utf-8")
    assert run(root, monkeypatch, "reset") == 0
    assert not (root / "journal.yaml").exists()
    [archive] = list((root / "journals").iterdir())
    assert archive.read_text(encoding="utf-8") == ""
