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


# --- 2.2 keys inside a node ----------------------------------------------------

def test_inside_a_node_visit_every_key_is_prefixed_with_the_visit(root, fake_codex, monkeypatch):
    write_prompt(root, "plan", "plan", output={"ok": "bool"})
    write_prompt(root, "implement", "implement", output={"done": "bool"})
    fake_codex.script([{"output": {"ok": True}}, {"output": {"done": False}}, {"output": {"done": True}}])
    monkeypatch.setattr(janus, "NODE", "implement#3")
    janus.codex("prompts/plan.md")
    janus.ralph("prompts/implement.md", until=lambda r: r["done"], max_iter=3)
    janus.step("wait", lambda: "waited")
    with pytest.raises(SystemExit):
        janus.human_gate("Go on?")
    with pytest.raises(SystemExit):
        janus.decision("What now?", ["a", "b"], key="what-now")
    assert list(read_journal(root)["steps"]) == [
        "implement#3/plan#1", "implement#3/implement#1/1", "implement#3/implement#1/2", "implement#3/wait",
        "implement#3/gate#1", "implement#3/what-now"]
    assert "## Gate: implement#3/gate#1" in (root / "JANUS.md").read_text(encoding="utf-8")


def test_outside_the_runner_keys_are_unchanged(root):
    assert janus.NODE is None
    janus.step("push", lambda: 1)
    assert janus.make_key("prompts/plan.md", None) == "plan#1"
    assert list(read_journal(root)["steps"]) == ["push"]


# --- 2.3 and 2.4 the runner ---------------------------------------------------

WALK = """\
from janus import node, END, codex

@node(next="b")
def a(s):
    s.plan = codex("prompts/plan.md")

@node(next=END)
def b(s):
    codex("prompts/plan.md", tasks=s.plan["tasks"])
"""

LABELS = """\
from janus import node, END, codex

@node(next={"left": "l", "right": "r"})
def a(s):
    return codex("prompts/plan.md")["go"]

@node(next=END)
def l(s):
    pass

@node(next=END)
def r(s):
    pass
"""

LOOP = """\
from janus import node, END, codex

@node(next={"again": "a", "stop": END})
def a(s):
    s.n = getattr(s, "n", 0) + 1
    codex("prompts/plan.md")
    return "again" if s.n < 3 else "stop"
"""

GATE = """\
from janus import node, END, step, human_gate

@node(next="b")
def a(s):
    s.work = step("work", lambda: "built")

@node(next={"yes": "c", "no": "a"})
def b(s):
    return "yes" if human_gate("Good?", show=s.work) == "yes" else "no"

@node(next=END)
def c(s):
    step("finish", lambda: "finished")
"""


def test_walk_visits_a_then_b_and_records_two_finished_visits(root, fake_codex, monkeypatch):
    (root / "flow.py").write_text(WALK, encoding="utf-8")
    write_prompt(root, "plan", "Plan {{goal}}", output={"tasks": "list[str]"})
    fake_codex.script([{"output": {"tasks": ["x"]}}])
    assert run(root, monkeypatch) == 0
    journal = read_journal(root)
    assert list(journal["steps"]) == ["a#1/plan#1", "b#1/plan#1"]
    assert journal["graph"] == {"start": "a", "nodes": [{"name": "a", "next": {"": "b"}},
                                                        {"name": "b", "next": {"": None}}]}
    assert [(e["node"], e["visit"], e["next"]) for e in journal["path"]] == [("a", 1, ""), ("b", 1, "")]
    assert all(e["started"] and e["finished"] for e in journal["path"])
    assert len(fake_codex.calls()) == 2


def test_a_label_chosen_from_a_codex_result_is_recorded_as_the_taken_edge(root, fake_codex, monkeypatch):
    (root / "flow.py").write_text(LABELS, encoding="utf-8")
    write_prompt(root, "plan", "Which way?", output={"go": "str"})
    fake_codex.script([{"output": {"go": "right"}}])
    assert run(root, monkeypatch) == 0
    path = read_journal(root)["path"]
    assert [(e["node"], e["next"]) for e in path] == [("a", "right"), ("r", "")]


def test_an_undeclared_label_exits_1_with_the_message_and_keeps_the_step_done(root, fake_codex, monkeypatch):
    (root / "flow.py").write_text(LABELS, encoding="utf-8")
    write_prompt(root, "plan", "Which way?", output={"go": "str"})
    fake_codex.script([{"output": {"go": "up"}}])
    assert run(root, monkeypatch) == 1
    journal = read_journal(root)
    assert journal["steps"]["a#1/plan#1"]["status"] == "done"
    assert "finished" not in journal["path"][0]
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert "a#1/plan#1: JanusError: node a returned 'up'; declared: left, right\n" in text


def test_a_single_edge_node_that_returns_a_value_exits_1_with_its_message(root, monkeypatch):
    (root / "flow.py").write_text(
        "from janus import node, END\n\n@node(next=END)\ndef a(s):\n    return 'yes'\n", encoding="utf-8")
    assert run(root, monkeypatch) == 1
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert "flow: JanusError: node a declares one edge but returned 'yes'\n" in text


def test_a_loop_counts_visits_and_a_second_run_executes_nothing(root, fake_codex, monkeypatch):
    (root / "flow.py").write_text(LOOP, encoding="utf-8")
    write_prompt(root, "plan", "again", output={"ok": "bool"})
    fake_codex.script([{"output": {"ok": True}}])
    assert run(root, monkeypatch) == 0
    first = read_journal(root)
    assert list(first["steps"]) == ["a#1/plan#1", "a#2/plan#1", "a#3/plan#1"]
    assert [(e["node"], e["visit"], e["next"]) for e in first["path"]] == \
        [("a", 1, "again"), ("a", 2, "again"), ("a", 3, "stop")]
    assert run(root, monkeypatch) == 0
    assert read_journal(root) == first
    assert len(fake_codex.calls()) == 3


def test_a_gate_inside_a_node_exits_2_and_the_next_run_resumes_in_that_node(root, monkeypatch):
    (root / "flow.py").write_text(GATE, encoding="utf-8")
    assert run(root, monkeypatch) == 2
    journal = read_journal(root)
    assert list(journal["steps"]) == ["a#1/work", "b#1/gate#1"]
    assert "## Gate: b#1/gate#1" in (root / "JANUS.md").read_text(encoding="utf-8")
    assert [(e["node"], "finished" in e) for e in journal["path"]] == [("a", True), ("b", False)]
    answer(root, "no")
    assert run(root, monkeypatch) == 2  # b -> a (visit 2) -> b (visit 2) opens its gate
    journal = read_journal(root)
    assert list(journal["steps"]) == ["a#1/work", "b#1/gate#1", "a#2/work", "b#2/gate#1"]
    assert [(e["node"], e["visit"]) for e in journal["path"]] == [("a", 1), ("b", 1), ("a", 2), ("b", 2)]
    assert journal["path"][1]["next"] == "no"
    answer(root, "yes")
    assert run(root, monkeypatch) == 0
    journal = read_journal(root)
    assert list(journal["steps"])[-1] == "c#1/finish"
    assert [(e["node"], e["next"]) for e in journal["path"]][-2:] == [("b", "yes"), ("c", "")]


def test_an_interrupted_visit_has_no_finished_and_its_step_runs_again_as_attempt_2(root, monkeypatch):
    (root / "flow.py").write_text(
        "from janus import node, END, step\n"
        "import os\n\n"
        "@node(next=END)\n"
        "def a(s):\n"
        "    step('push', lambda: os.environ['PUSH_OK'] == '1' or (_ for _ in ()).throw(RuntimeError('no remote')))\n",
        encoding="utf-8")
    monkeypatch.setenv("PUSH_OK", "0")
    assert run(root, monkeypatch) == 1
    journal = read_journal(root)
    assert journal["steps"]["a#1/push"]["status"] == "failed"
    assert "finished" not in journal["path"][-1] and journal["path"][-1]["node"] == "a"
    started = journal["path"][-1]["started"]
    monkeypatch.setenv("PUSH_OK", "1")
    assert run(root, monkeypatch) == 0
    journal = read_journal(root)
    assert (journal["steps"]["a#1/push"]["status"], journal["steps"]["a#1/push"]["attempt"]) == ("done", 2)
    assert len(journal["path"]) == 1 and journal["path"][0]["started"] == started
    assert journal["path"][0]["next"] == ""


def test_a_flow_whose_second_visit_changed_node_exits_1_with_flow_changed(root, monkeypatch):
    (root / "flow.py").write_text(GATE, encoding="utf-8")
    assert run(root, monkeypatch) == 2
    (root / "flow.py").write_text(GATE.replace('@node(next="b")', '@node(next="c")'), encoding="utf-8")
    assert run(root, monkeypatch) == 1
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert "a#1/work: JanusError: flow changed: visit 2 was b, now c\n" in text


def test_a_finished_visit_that_takes_another_edge_exits_1_with_flow_changed(root, fake_codex, monkeypatch):
    (root / "flow.py").write_text(LABELS, encoding="utf-8")
    write_prompt(root, "plan", "Which way?", output={"go": "str"})
    fake_codex.script([{"output": {"go": "right"}}])
    assert run(root, monkeypatch) == 0
    (root / "flow.py").write_text(LABELS.replace('return codex("prompts/plan.md")["go"]',
                                                 'codex("prompts/plan.md"); return "left"'), encoding="utf-8")
    assert run(root, monkeypatch) == 1
    text = (root / "JANUS.md").read_text(encoding="utf-8")
    assert "a#1/plan#1: JanusError: flow changed: a#1 went to 'right' before, now 'left'\n" in text


def test_an_unknown_target_fails_run_before_any_visit(root, monkeypatch):
    (root / "flow.py").write_text(
        "from janus import node\n\n@node(next='nowhere')\ndef a(s):\n    raise AssertionError('visited')\n",
        encoding="utf-8")
    assert run(root, monkeypatch) == 1
    assert not (root / "journal.yaml").exists()
    assert "flow: JanusError: node a goes to 'nowhere', which is not a node\n" in \
        (root / "JANUS.md").read_text(encoding="utf-8")


def test_a_script_flow_that_ran_no_step_leaves_no_journal(root, monkeypatch):
    (root / "flow.py").write_text("print('hello')\n", encoding="utf-8")
    assert run(root, monkeypatch) == 0
    assert not (root / "journal.yaml").exists()
