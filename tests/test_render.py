import pytest

import janus


def test_render_replaces_simple_placeholders():
    assert janus.render("hello {{name}} and {{ name }}", {"name": "bob"}) == "hello bob and bob"


def test_render_follows_dotted_paths_into_dicts_and_lists():
    variables = {"plan": {"tasks": [{"id": 7, "title": "shell"}]}}
    assert janus.render("{{plan.tasks.0.title}}#{{plan.tasks.0.id}}", variables) == "shell#7"


def test_render_writes_non_strings_as_yaml():
    variables = {"task": {"id": 1, "tags": ["a", "b"]}, "n": 3, "ok": True}
    assert janus.render("{{task}}|{{n}}|{{ok}}", variables) == "id: 1\ntags:\n- a\n- b|3|true"


def test_render_undefined_placeholder_raises_janus_error():
    with pytest.raises(janus.JanusError, match=r"undefined placeholder \{\{task.name\}\}"):
        janus.render("{{task.name}}", {"task": {"id": 1}})


def test_load_prompt_splits_the_output_front_matter_from_the_body(root):
    (root / "prompts" / "plan.md").write_text("---\noutput:\n  summary: str\n---\nPlan {{goal}}.\n", encoding="utf-8")
    assert janus.load_prompt("prompts/plan.md") == ({"summary": "str"}, "Plan {{goal}}.\n")


def test_load_prompt_without_front_matter_has_no_output(root):
    (root / "prompts" / "free.md").write_text("Just text.\n", encoding="utf-8")
    assert janus.load_prompt("prompts/free.md") == (None, "Just text.\n")
