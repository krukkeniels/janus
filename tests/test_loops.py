"""Spec section 14 return loops under replay (coverage item 12 of section 9): a `while` flow whose
gate answer sends it back to an earlier stage, run across several `janus.main(["run"])` invocations."""
import janus
from helpers import read_journal

# The return-loop shape of spec section 14, with step() and human_gate() so no Codex is needed.
# The round counter is recomputed by the flow from the replayed answers, never read from the journal.
RETURN_LOOP = """\
from janus import step, human_gate

findings = ""
rnd = 0
while True:
    rnd += 1
    k = f"r{rnd}"
    work = step(f"{k}/work", lambda: f"round {rnd} built with findings: {findings!r}")
    answer = human_gate("Approve, or write your findings.", key=f"{k}/review", show=work)
    if answer.strip().lower() != "approved":
        findings = answer
        continue
    break
step("finish", lambda: f"finished in round {rnd}")
"""


def run(root, monkeypatch):
    monkeypatch.chdir(root)
    return janus.main(["run"])


def answer(root, text):
    path = root / "JANUS.md"
    path.write_text(path.read_text(encoding="utf-8").replace("\nanswer:\n", f"\nanswer: {text}\n"), encoding="utf-8")


def test_a_return_loop_executes_only_the_new_round_and_resumes_at_a_gate_inside_it(root, monkeypatch):
    (root / "flow.py").write_text(RETURN_LOOP, encoding="utf-8")

    # Round 1: the work step runs, the gate opens, the run exits 2.
    assert run(root, monkeypatch) == 2
    steps = read_journal(root)["steps"]
    assert list(steps) == ["r1/work", "r1/review"]
    assert steps["r1/work"]["result"] == "round 1 built with findings: ''"
    assert steps["r1/review"]["status"] == "open"
    round_one = dict(steps["r1/work"])

    # The gate says no: round 1 replays, round 2 executes with the answer as findings, and its gate opens.
    answer(root, "the title is wrong")
    assert run(root, monkeypatch) == 2
    steps = read_journal(root)["steps"]
    assert list(steps) == ["r1/work", "r1/review", "r2/work", "r2/review"]
    assert steps["r1/work"] == round_one  # round 1 was replayed, not re-executed: same result, same timestamps
    assert steps["r1/review"]["answer"] == "the title is wrong"
    assert steps["r2/work"]["result"] == "round 2 built with findings: 'the title is wrong'"
    assert steps["r2/review"]["status"] == "open"
    assert "## Gate: r2/review" in (root / "JANUS.md").read_text(encoding="utf-8")

    # A run with the gate still unanswered resumes in round 2: exit 2 again, no round 3 key.
    assert run(root, monkeypatch) == 2
    assert list(read_journal(root)["steps"]) == ["r1/work", "r1/review", "r2/work", "r2/review"]

    # The gate inside round 2 says yes: the loop breaks in round 2 and the flow ends.
    answer(root, "approved")
    assert run(root, monkeypatch) == 0
    steps = read_journal(root)["steps"]
    assert list(steps) == ["r1/work", "r1/review", "r2/work", "r2/review", "finish"]
    assert steps["finish"]["result"] == "finished in round 2"
    assert "r3/work" not in steps

    # The finished loop replays without executing anything: the journal is unchanged, byte for byte.
    before = (root / "journal.yaml").read_text(encoding="utf-8")
    assert run(root, monkeypatch) == 0
    assert (root / "journal.yaml").read_text(encoding="utf-8") == before
