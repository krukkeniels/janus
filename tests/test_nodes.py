"""Node flows (design 2026-09-24 section 2): registration, keys inside a node, the runner, graph and mermaid."""
import pytest

import janus
from helpers import read_journal, write_prompt


def run(root, monkeypatch, *argv):
    monkeypatch.chdir(root)
    return janus.main(list(argv) or ["run"])


def answer(root, text):
    path = root / "JANUS.md"
    path.write_text(path.read_text(encoding="utf-8").replace("\nanswer:\n", f"\nanswer: {text}\n"), encoding="utf-8")


# --- 2.1 registration --------------------------------------------------------

def test_nodes_register_in_order_with_normalised_edges(root):
    @janus.node(next="b")
    def a(s):
        pass

    @janus.node(next={"left": "c", "right": "a", "stop": janus.END})
    def b(s):
        pass

    @janus.node(next=janus.END)
    def c(s):
        pass

    assert janus.graph() == {"start": "a", "nodes": [
        {"name": "a", "next": {"": "b"}},
        {"name": "b", "next": {"left": "c", "right": "a", "stop": None}},
        {"name": "c", "next": {"": None}},
    ]}
    assert janus.NODES["b"][1] is b
    janus.validate_nodes()


def test_duplicate_node_name_raises_at_decoration(root):
    @janus.node(next=janus.END)
    def a(s):
        pass

    with pytest.raises(janus.JanusError, match="duplicate node name: a"):
        @janus.node(next=janus.END)
        def a(s):  # noqa: F811
            pass


@pytest.mark.parametrize("bad", [3, None, {}, {1: "a"}, {"go": 3}, ["a"]])
def test_bad_next_raises_at_decoration(root, bad):
    with pytest.raises(janus.JanusError, match="node next must be a name, END or a non-empty dict"):
        janus.node(next=bad)
    assert janus.NODES == {}


def test_unknown_target_fails_validation_before_any_visit(root):
    @janus.node(next="nowhere")
    def a(s):
        pass

    with pytest.raises(janus.JanusError, match="node a goes to 'nowhere', which is not a node"):
        janus.validate_nodes()


def test_begin_empties_the_node_registry(root):
    @janus.node(next=janus.END)
    def a(s):
        pass

    janus.begin(root)
    assert janus.NODES == {} and janus.graph() == {"start": None, "nodes": []}
