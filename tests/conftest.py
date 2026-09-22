import pytest

import janus

GOAL_MD = "# Goal\nUpgrade the widget.\n"


@pytest.fixture
def root(tmp_path):
    """A goal folder with a JANUS.md and an empty prompts/ folder; the engine is begun there."""
    (tmp_path / "JANUS.md").write_text(GOAL_MD, encoding="utf-8")
    (tmp_path / "prompts").mkdir()
    janus.begin(tmp_path)
    return tmp_path
