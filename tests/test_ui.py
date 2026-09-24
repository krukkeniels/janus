"""The live page (design 2026-09-24 section 4): ``build_state`` from files written by hand, and the server."""
import http.client
import json
import threading

import pytest
import yaml

import janus_ui

NOW = "2026-09-24T10:10:00"
T0, T1, T2 = "2026-09-24T10:00:00", "2026-09-24T10:00:12", "2026-09-24T10:03:04"
GRAPH = {"start": "a", "nodes": [{"name": "a", "next": {"go": "b", "stop": None}}, {"name": "b", "next": {"": "a"}}]}
CLASSDEFS = ("  classDef visited fill:#1b5e20,stroke:#66bb6a\n  classDef running fill:#0d47a1,stroke:#42a5f5\n"
             "  classDef open fill:#e65100,stroke:#ffb74d\n  classDef failed fill:#b71c1c,stroke:#ef5350")


def entry(kind, status, started=T0, finished=None, **fields):
    """A journal entry as the engine writes it: gates carry no attempt, finished only once it is set."""
    e = {"kind": kind, "status": status}
    if kind not in ("gate", "decision"):
        e["attempt"] = fields.pop("attempt", 1)
    e["started"] = started
    if finished is not None:
        e["finished"] = finished
    e.update(fields)
    return e


def write_journal(root, steps, **extra):
    journal = {"flow": "flow.py", "started": T0, "steps": steps}
    journal.update(extra)
    (root / "journal.yaml").write_text(yaml.safe_dump(journal, sort_keys=False, allow_unicode=True), encoding="utf-8")


def visit(node, n, next=None):
    e = {"node": node, "visit": n, "started": T0}
    if next is not None:
        e.update(finished=T1, next=next)
    return e


def state(root, **steps):
    write_journal(root, steps)
    return janus_ui.build_state(root, now=NOW)


def names(nodes):
    return [(n["name"], names(n["children"])) for n in nodes]


# --- 1, 2: no journal, corrupt journal ------------------------------------------

def test_a_missing_journal_gives_the_empty_state(tmp_path):
    assert janus_ui.build_state(tmp_path, now=NOW) == {
        "folder": tmp_path.name, "flow": "flow.py", "started": None, "updated": None, "error": None, "goal": "",
        "steps": [], "tree": [], "current": None, "gate": None, "path": [], "mermaid": None,
        "progress": [], "decisions": [],
        "totals": {"steps": 0, "done": 0, "failed": 0, "running": 0, "open": 0, "answered": 0, "codex_seconds": 0,
                   "tokens": {"input": 0, "cached": 0, "output": 0, "total": 0, "sessions": 0}}}


@pytest.mark.parametrize("text, error", [
    ("[not a mapping", "journal.yaml is not valid YAML: "),
    ("- a list\n", "journal.yaml is not a mapping"),
    ("", "journal.yaml is not a mapping"),
])
def test_a_corrupt_journal_sets_error_and_reads_as_missing(tmp_path, text, error):
    (tmp_path / "journal.yaml").write_text(text, encoding="utf-8")
    st = janus_ui.build_state(tmp_path, now=NOW)
    assert st["error"].startswith(error) and "\n" not in st["error"]
    assert (st["steps"], st["tree"], st["current"], st["gate"], st["mermaid"], st["updated"]) == \
        ([], [], None, None, None, None)
    assert st["totals"]["steps"] == 0


# --- 8: seconds and summaries ---------------------------------------------------------

def test_seconds_and_summaries_per_status(tmp_path):
    long = "x" * 200
    st = state(tmp_path, **{
        "done": entry("codex", "done", finished=T2, result={"summary": "planned\nmore", "text": "no"}),
        "text": entry("codex", "done", finished=T1, result={"text": long}),
        "plain": entry("step", "done", finished=T1, result="a string result"),
        "answered": entry("gate", "answered", finished=T1, answer="yes\nbut later"),
        "failed": entry("codex", "failed", finished=T1, error="codex exec exited with 3\ntrace"),
        "running": entry("codex", "running"),
        "open": entry("gate", "open", question="Merge it?\nSay merged."),
        "nostart": entry("codex", "running", started=None),
        "badstart": entry("codex", "done", started="yesterday", finished=T1),
        "nofinish": entry("codex", "done")})
    by = {s["key"]: s for s in st["steps"]}
    assert [s["key"] for s in st["steps"]] == list(by)
    assert (by["done"]["seconds"], by["done"]["summary"]) == (184, "planned")
    assert (by["text"]["seconds"], by["text"]["summary"]) == (12, "x" * 157 + "...")
    assert by["plain"]["summary"] == ""
    assert (by["answered"]["seconds"], by["answered"]["summary"], by["answered"]["attempt"]) == (12, "yes", None)
    assert (by["failed"]["seconds"], by["failed"]["summary"]) == (12, "codex exec exited with 3")
    assert (by["running"]["seconds"], by["running"]["summary"]) == (600, "")
    assert (by["open"]["seconds"], by["open"]["summary"]) == (600, "Merge it?")
    assert by["nostart"]["seconds"] is None and by["nostart"]["started"] is None
    assert by["badstart"]["seconds"] is None and by["nofinish"]["seconds"] is None
    assert by["done"]["detail"] == yaml.safe_dump(by["done"] and {
        "kind": "codex", "status": "done", "attempt": 1, "started": T0, "finished": T2,
        "result": {"summary": "planned\nmore", "text": "no"}}, sort_keys=False, allow_unicode=True)
    assert (by["done"]["session"], by["done"]["usage"], by["done"]["started"], by["done"]["finished"]) == \
        (None, None, T0, T2)


# --- 9: totals --------------------------------------------------------------------------

def test_totals_count_statuses_codex_seconds_and_tokens(tmp_path):
    usage = {"input": 100, "cached": 40, "output": 10, "total": 110}
    st = state(tmp_path, **{
        "plan#1": entry("codex", "done", finished=T1, session="a", usage=usage),
        "fix/1": entry("codex", "failed", finished=T2, error="e", session="b"),
        "fix/2": entry("codex", "done", finished=T1, session="c", usage={"input": 50, "cached": 0, "output": 5,
                                                                          "total": 55}),
        "check#1": entry("ai_gate", "done", finished=T1, result=True),
        "wait": entry("step", "done", finished=T2, result=None),
        "gate#1": entry("gate", "answered", finished=T1, answer="yes"),
        "gate#2": entry("gate", "open", question="q"),
        "now": entry("codex", "running")})
    assert st["totals"] == {"steps": 8, "done": 4, "failed": 1, "running": 1, "open": 1, "answered": 1,
                            "codex_seconds": 12 + 184 + 12 + 12 + 600,
                            "tokens": {"input": 150, "cached": 40, "output": 15, "total": 165, "sessions": 2}}
    by = {s["key"]: s for s in st["steps"]}
    assert (by["plan#1"]["session"], by["plan#1"]["usage"]) == ("a", usage)
    assert (by["fix/1"]["session"], by["fix/1"]["usage"]) == ("b", None)
    assert st["flow"] == "flow.py" and st["started"] == T0 and st["updated"] is not None and st["error"] is None


# --- 3, 4, 5: the tree -------------------------------------------------------------

def test_tree_nests_keys_split_on_slash_in_first_appearance_order(tmp_path):
    st = state(tmp_path, **{"review#2/review#1": entry("codex", "done", finished=T1),
                            "implement#1/implement#1/1": entry("codex", "done", finished=T1),
                            "implement#1/implement#1/2": entry("codex", "done", finished=T2),
                            "implement#1/wait": entry("step", "done", finished=T1)})
    assert names(st["tree"]) == [("review#2", [("review#1", [])]),
                                 ("implement#1", [("implement#1", [("1", []), ("2", [])]), ("wait", [])])]
    ralph = st["tree"][1]["children"][0]
    assert ralph["key"] == "implement#1/implement#1" and ralph["children"][1]["key"] == "implement#1/implement#1/2"
    assert [c["seconds"] for c in ralph["children"]] == [12, 184] and ralph["seconds"] == 196
    assert st["tree"][1]["seconds"] == 208 and st["tree"][0]["children"][0]["seconds"] == 12
    assert all(n["next"] is None for n in st["tree"])


def test_a_group_rolls_up_running_over_failed_over_done(tmp_path):
    st = state(tmp_path, **{"a#1/x": entry("codex", "done", finished=T1), "a#1/y": entry("codex", "running"),
                            "b#1/x": entry("codex", "failed", finished=T1, error="boom"),
                            "b#1/y": entry("codex", "done", finished=T1),
                            "c#1/gate#1": entry("gate", "open", question="ok?"),
                            "d#1/x": entry("codex", "done", finished=T1),
                            "d#1/gate#1": entry("gate", "answered", finished=T1, answer="yes")})
    assert [(n["name"], n["status"]) for n in st["tree"]] == \
        [("a#1", "running"), ("b#1", "failed"), ("c#1", "running"), ("d#1", "done")]
    assert st["tree"][2]["seconds"] == 600


def test_a_key_that_is_both_an_entry_and_a_prefix_keeps_its_status_and_lists_its_children(tmp_path):
    st = state(tmp_path, **{"build": entry("step", "done", finished=T2, result="built"),
                            "build/1": entry("codex", "failed", finished=T1, error="no")})
    assert names(st["tree"]) == [("build", [("1", [])])]
    assert (st["tree"][0]["status"], st["tree"][0]["seconds"]) == ("done", 184)
    assert (st["tree"][0]["children"][0]["status"], st["tree"][0]["children"][0]["seconds"]) == ("failed", 12)
    assert st["current"] == "build/1"


# --- 6, 7: current and the gate -----------------------------------------------------

def test_current_is_the_first_running_or_open_else_the_last_failed(tmp_path):
    done, running = entry("codex", "done", finished=T1), entry("codex", "running")
    failed, gate = entry("codex", "failed", finished=T1, error="x"), entry("gate", "open", question="q")
    assert state(tmp_path, a=done, b=failed, c=running, d=gate)["current"] == "c"
    assert state(tmp_path, a=gate, b=running)["current"] == "a"
    assert state(tmp_path, a=failed, b=done, c=failed)["current"] == "c"
    assert state(tmp_path, a=done, b=done)["current"] is None
    assert state(tmp_path)["current"] is None


def test_gate_carries_the_verbatim_section_or_an_empty_string(tmp_path):
    (tmp_path / "JANUS.md").write_text(
        "# Goal\nUpgrade the widget.\n\n## Gate: blocked#1/decision#1\nRetry or stop?\n    One of: retry, stop.\n\n"
        "    round 3 of 3\n\nanswer:\n\n## Progress\n- 2026-09-24T10:00:00 hi\n", encoding="utf-8")
    st = state(tmp_path, **{"plan#1": entry("codex", "done", finished=T1),
                            "blocked#1/decision#1": entry("decision", "open", question="Retry or stop?\nOne of: ..."),
                            "other#1/gate#1": entry("gate", "open", question="second")})
    assert st["gate"] == {"key": "blocked#1/decision#1", "kind": "decision", "question": "Retry or stop?\nOne of: ...",
                          "section": "## Gate: blocked#1/decision#1\nRetry or stop?\n    One of: retry, stop.\n\n"
                                     "    round 3 of 3\n\nanswer:"}
    assert st["goal"] == "Upgrade the widget." and st["progress"] == ["- 2026-09-24T10:00:00 hi"]
    (tmp_path / "JANUS.md").unlink()
    st = janus_ui.build_state(tmp_path, now=NOW)
    assert st["gate"]["section"] == "" and st["goal"] == "" and st["progress"] == [] and st["decisions"] == []
    assert state(tmp_path, **{"plan#1": entry("codex", "done", finished=T1)})["gate"] is None


# --- 10: progress and decisions -------------------------------------------------------

def test_progress_and_decisions_are_the_section_lines_verbatim(tmp_path):
    (tmp_path / "JANUS.md").write_text(
        "# Goal\nDo it.\n\n## Progress\n- 2026-09-24T10:00:00 plan#1: started\n  detail line\n\n"
        "## Decisions\n- 2026-09-24 gate#1: Merge it?\n  answer: yes\n", encoding="utf-8")
    st = janus_ui.build_state(tmp_path, now=NOW)
    assert st["progress"] == ["- 2026-09-24T10:00:00 plan#1: started", "  detail line", ""]
    assert st["decisions"] == ["- 2026-09-24 gate#1: Merge it?", "  answer: yes"]
    assert st["goal"] == "Do it."


# --- 11, 12: mermaid classes and counts, tree next labels ----------------------------

def test_mermaid_is_null_for_a_script_journal(tmp_path):
    st = state(tmp_path, **{"plan#1": entry("codex", "done", finished=T1)})
    assert st["mermaid"] is None and st["path"] == []


@pytest.mark.parametrize("steps, cls", [
    ({}, "running"),
    ({"b#2/plan#1": entry("codex", "running")}, "running"),
    ({"b#2/gate#1": entry("gate", "open", question="q")}, "open"),
    ({"b#2/plan#1": entry("codex", "failed", finished=T1, error="e")}, "failed"),
])
def test_mermaid_classes_follow_the_path_and_current(tmp_path, steps, cls):
    path = [visit("a", 1, "go"), visit("b", 1, ""), visit("a", 2, "go"), visit("b", 2)]
    write_journal(tmp_path, steps, graph=GRAPH, path=path)
    st = janus_ui.build_state(tmp_path, now=NOW)
    assert st["path"] == path
    assert st["mermaid"] == ("flowchart LR\n  a -- go (2) --> b\n  a -- stop --> END\n  b -- (1) --> a\n  END([END])\n"
                             f"  class a visited\n  class b {cls}\n" + CLASSDEFS)


def test_mermaid_after_the_flow_ended_marks_every_node_visited(tmp_path):
    write_journal(tmp_path, {"a#1/plan#1": entry("codex", "done", finished=T1)}, graph=GRAPH,
                  path=[visit("a", 1, "stop")])
    assert janus_ui.build_state(tmp_path, now=NOW)["mermaid"] == \
        ("flowchart LR\n  a -- go --> b\n  a -- stop (1) --> END\n  b --> a\n  END([END])\n  class a visited\n"
         + CLASSDEFS)


def test_tree_next_labels_come_from_the_finished_path_entries(tmp_path):
    write_journal(tmp_path, {"a#1/plan#1": entry("codex", "done", finished=T1),
                             "b#1/gate#1": entry("gate", "answered", finished=T1, answer="ok"),
                             "a#2/plan#1": entry("codex", "done", finished=T1),
                             "b#2/plan#1": entry("codex", "running"),
                             "loose": entry("step", "done", finished=T1)},
                  graph=GRAPH, path=[visit("a", 1, "go"), visit("b", 1, ""), visit("a", 2, "go"), visit("b", 2)])
    st = janus_ui.build_state(tmp_path, now=NOW)
    assert [(n["name"], n["next"]) for n in st["tree"]] == \
        [("a#1", "go"), ("b#1", ""), ("a#2", "go"), ("b#2", None), ("loose", None)]
    assert all(c["next"] is None for n in st["tree"] for c in n["children"])
    assert st["current"] == "b#2/plan#1"


def test_path_filters_to_entries_with_node_and_visit(tmp_path):
    write_journal(tmp_path, {"a#1/plan#1": entry("codex", "done", finished=T1)}, graph=GRAPH,
                  path=[{"finished": T1, "next": "go"}, "not-a-dict",
                        {"node": "a", "visit": 1, "started": T0, "finished": T1, "next": ""}])
    st = janus_ui.build_state(tmp_path, now=NOW)
    assert st["path"] == [{"node": "a", "visit": 1, "started": T0, "finished": T1, "next": ""}]
    assert st["mermaid"] == ("flowchart LR\n  a -- go --> b\n  a -- stop --> END\n  b --> a\n  END([END])\n"
                             "  class a visited\n" + CLASSDEFS)


# --- the server --------------------------------------------------------------------------

def test_server_serves_the_page_and_the_state_and_404s_the_rest(tmp_path):
    write_journal(tmp_path, {"plan#1": entry("codex", "done", finished=T1, result={"summary": "ok"})})
    server = janus_ui.make_server(tmp_path, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
        conn.request("GET", "/")
        r = conn.getresponse()
        body = r.read().decode("utf-8")
        assert (r.status, r.getheader("Content-Type")) == (200, "text/html; charset=utf-8")
        assert "<title>" in body
        conn.request("GET", "/state.json")
        r = conn.getresponse()
        st = json.loads(r.read().decode("utf-8"))
        assert (r.status, r.getheader("Content-Type"), r.getheader("Cache-Control")) == \
            (200, "application/json", "no-store")
        assert st["folder"] == tmp_path.name and [s["key"] for s in st["steps"]] == ["plan#1"]
        conn.request("GET", "/nope")
        r = conn.getresponse()
        r.read()
        assert r.status == 404
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_main_reports_a_port_in_use(tmp_path, monkeypatch, capsys):
    taken = janus_ui.make_server(tmp_path, 0)
    try:
        port = taken.server_address[1]
        monkeypatch.chdir(tmp_path)
        assert janus_ui.main(["--port", str(port)]) == 1
        assert capsys.readouterr().err == f"janus_ui: port {port} is in use; try --port {port + 1}\n"
    finally:
        taken.server_close()
