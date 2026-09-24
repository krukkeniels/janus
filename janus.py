#!/usr/bin/env python3
"""Janus 4.0: a small durable flow engine for Codex. One file, standard library plus PyYAML.
A flow imports the primitives with ``from janus import ...``; see janus-4.0-spec.md sections 4 to 9."""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import os
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
import traceback
import types
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import yaml

# --- constants, errors and engine state ------------------------------------

GOAL_FILE = "JANUS.md"
JOURNAL_FILE = "journal.yaml"
FLOW_FILE = "flow.py"
PREAMBLE_FILE = "prompts/_preamble.md"


class JanusError(Exception):
    """Engine and flow errors that stop the run."""


class Exhausted(Exception):
    """Raised by ralph after max_iter iterations without success; .last is the final result."""
    def __init__(self, last: Any) -> None:
        super().__init__("ralph exhausted")
        self.last = last


END = object()  # sentinel for node(next=END) and {"label": END}: the flow ends there
Node = Tuple[str, Callable[[Any], Any], Dict[str, Optional[str]]]  # (name, fn, edges); an END target is None

# Engine state for one run; begin() resets all of it.
ROOT = Path(".")
JOURNAL: Dict[str, Any] = {"flow": FLOW_FILE, "started": None, "steps": {}}
CONTEXT: Dict[str, Any] = {}
COUNTERS: Dict[str, int] = {}
LIVE: set = set()
CURRENT: Optional[str] = None
REPLAYING = False  # True while the last step came from the journal; log() then skips Progress
NODES: Dict[str, Node] = {}  # node flows register here in definition order; the first one is the start
NODE: Optional[str] = None  # "<node>#<visit>" while the runner is inside a node; every key gets it as a prefix
DRY = False  # set by `graph`: loading flow.py must register nodes only, so claim() refuses to run a step
DRY_MESSAGE = "flow.py runs steps at load time; only node flows have a graph"


def now() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def write_atomic(path: Path, text: str) -> None:
    """Write through a temporary file in the same directory, then rename over the target."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, str(path))


def begin(root: Path) -> None:
    """Reset the engine for one run rooted at ``root`` and load its journal, or start a fresh one."""
    global ROOT, JOURNAL, CONTEXT, COUNTERS, LIVE, CURRENT, REPLAYING, NODES, NODE, DRY
    ROOT = Path(root)
    path, fresh = ROOT / JOURNAL_FILE, {"flow": FLOW_FILE, "started": now(), "steps": {}}
    JOURNAL = fresh
    if path.exists():
        try:
            loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            raise JanusError(f"{JOURNAL_FILE} is not a valid journal: {exc}")
        if not isinstance(loaded, dict):
            raise JanusError(f"{JOURNAL_FILE} is not a valid journal: "
                              + ("empty" if loaded is None else "not a mapping"))
        JOURNAL = loaded
    JOURNAL.setdefault("steps", {})
    CONTEXT, COUNTERS, LIVE, CURRENT, NODES, NODE, DRY = {}, {}, set(), None, {}, None, False
    REPLAYING = bool(JOURNAL["steps"])


def write_journal() -> None:
    write_atomic(ROOT / JOURNAL_FILE, yaml.safe_dump(JOURNAL, sort_keys=False, allow_unicode=True))


def save_journal(key: str, status: str) -> None:
    """Write journal.yaml atomically at every status change of ``key``, then commit (section 5, Git)."""
    write_journal()
    git_commit(f"janus: {key} {status}")


# --- JANUS.md --------------------------------------------------------------

def read_goal_file() -> List[str]:
    path = ROOT / GOAL_FILE
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []


def write_goal_file(lines: List[str]) -> None:
    write_atomic(ROOT / GOAL_FILE, "\n".join(lines).rstrip("\n") + "\n")


RESERVED_HEADING = re.compile(r"\A(?:# Goal|## Progress|## Decisions)\Z|\A## Gate: ")
HEADING = re.compile(r"#{1,2} ")


def find_section(lines: List[str], heading: str) -> Optional[Tuple[int, int]]:
    """Line range [start, end) of the section with exactly this heading line. Every section ends at
    any '#'/'##' heading, as a human's own subsections would expect -- except '## Gate: ', which ends
    only at a heading the engine writes (# Goal, ## Progress, ## Decisions, another ## Gate: ) or at
    a blank line before any heading, so an indented question or answer keeps a '#' line, while a
    human's own section after the gate (past a blank line) is left alone."""
    loose = heading.startswith("## Gate: ")

    def ends_at(j: int) -> bool:
        if not loose:
            return bool(HEADING.match(lines[j]))
        if RESERVED_HEADING.match(lines[j].rstrip()):
            return True
        return lines[j].rstrip() == "" and j + 1 < len(lines) and bool(HEADING.match(lines[j + 1]))

    for i, line in enumerate(lines):
        if line.rstrip() == heading:
            j = i + 1
            while j < len(lines) and not ends_at(j):
                j += 1
            return i, j
    return None


def remove_section(heading: str) -> None:
    lines = read_goal_file()
    span = find_section(lines, heading)
    if span is not None:
        del lines[span[0]:span[1]]
        write_goal_file(lines)


def append_to_section(heading: str, new_lines: List[str]) -> None:
    """Append lines at the end of a section, creating the section at the end of the file if needed."""
    lines = read_goal_file()
    span = find_section(lines, heading)
    if span is None:
        lines += ([""] if lines and lines[-1].strip() else []) + [heading]
        span = (len(lines) - 1, len(lines))
    end = span[1]
    while end > span[0] + 1 and not lines[end - 1].strip():  # keep the blank line before the next heading
        end -= 1
    lines[end:end] = new_lines
    write_goal_file(lines)


def goal() -> str:
    lines = read_goal_file()
    span = find_section(lines, "# Goal")
    if span is None:
        raise JanusError(f"{GOAL_FILE} has no '# Goal' section")
    return "\n".join(lines[span[0] + 1:span[1]]).strip()


def log(text: str) -> None:
    print(text)
    lines = text.splitlines() or [""]
    if not REPLAYING:  # a replayed run repeats the print, not the Progress line
        append_to_section("## Progress", [f"- {now()} {lines[0]}"] + [f"  {line}" for line in lines[1:]])


# --- rendering -------------------------------------------------------------

PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}")


def lookup(path: str, variables: Dict[str, Any]) -> Any:
    """Dotted access into dicts and lists by index; a missing or None value is undefined."""
    value: Any = variables
    for part in path.split("."):
        if isinstance(value, dict) and value.get(part) is not None:
            value = value[part]
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        else:
            raise JanusError(f"undefined placeholder {{{{{path}}}}}")
    return value


def as_text(value: Any) -> str:
    """Strings as they are; everything else as YAML without the trailing document marker."""
    if isinstance(value, str):
        return value
    text = yaml.safe_dump(value, sort_keys=False, allow_unicode=True).rstrip("\n")
    return text[:-4] if text.endswith("\n...") else text


def render(text: str, variables: Dict[str, Any]) -> str:
    return PLACEHOLDER.sub(lambda m: as_text(lookup(m.group(1), variables)), text)


def load_prompt(path: str) -> Tuple[Optional[Dict[str, Any]], str]:
    """The front matter ``output`` mapping (None if absent) and the body of a prompt file."""
    text = (ROOT / path).read_text(encoding="utf-8")
    m = re.match(r"---\n(.*?)\n---\n?(.*)", text, re.S)
    return ((yaml.safe_load(m.group(1)) or {}).get("output"), m.group(2)) if m else (None, text)


# --- output schema ---------------------------------------------------------

def field_schema(decl: Any) -> Dict[str, Any]:
    """JSON schema for one ``output`` field declaration (spec section 4, Output schema)."""
    scalars = {"str": "string", "int": "integer", "float": "number", "bool": "boolean"}
    if isinstance(decl, str) and decl in scalars:
        return {"type": scalars[decl]}
    if isinstance(decl, str) and re.fullmatch(r"list\[\w+\]", decl):
        return {"type": "array", "items": field_schema(decl[5:-1])}
    if isinstance(decl, list) and len(decl) == 1:
        return {"type": "array", "items": field_schema(decl[0])}
    if isinstance(decl, dict) and list(decl) == ["one_of"]:
        if isinstance(decl["one_of"], list) and decl["one_of"] and all(isinstance(o, str) for o in decl["one_of"]):
            return {"type": "string", "enum": list(decl["one_of"])}
    elif isinstance(decl, dict) and decl:
        return build_schema(decl)
    raise JanusError(f"invalid output declaration: {decl!r}")


def build_schema(output: Any) -> Dict[str, Any]:
    if not isinstance(output, dict) or not output:
        raise JanusError(f"invalid output declaration: {output!r}")
    return {"type": "object", "properties": {name: field_schema(decl) for name, decl in output.items()},
            "required": list(output), "additionalProperties": False}


def validate(value: Any, schema: Dict[str, Any], where: str = "$") -> Optional[str]:
    """The first mismatch between value and a build_schema() schema, or None."""
    kind = schema["type"]
    if kind == "object":
        if not isinstance(value, dict):
            return f"{where}: expected object"
        if sorted(value) != sorted(schema["required"]):
            return f"{where}: expected exactly the keys {schema['required']}, got {sorted(value)}"
        items = [(value[k], sub, f"{where}.{k}") for k, sub in schema["properties"].items()]
    elif kind == "array":
        if not isinstance(value, list):
            return f"{where}: expected array"
        items = [(item, schema["items"], f"{where}[{i}]") for i, item in enumerate(value)]
    else:
        is_bool = isinstance(value, bool)
        ok = {"string": isinstance(value, str), "boolean": is_bool, "integer": isinstance(value, int) and not is_bool,
              "number": isinstance(value, (int, float)) and not is_bool}[kind]
        if not ok or ("enum" in schema and value not in schema["enum"]):
            return f"{where}: expected {kind}" + (f" in {schema['enum']}" if "enum" in schema else "")
        return None
    return next((p for p in (validate(*item) for item in items) if p), None)

# --- steps and keys --------------------------------------------------------

def make_key(prompt: str, key: Optional[str]) -> str:
    """Explicit key, or ``<stem>#<n>`` counting calls with that prompt stem in this run (in this node visit,
    inside a node flow); inside a node the key is prefixed with ``<node>#<visit>/``."""
    if key is None:
        stem = Path(prompt).stem
        COUNTERS[stem] = COUNTERS.get(stem, 0) + 1
        key = f"{stem}#{COUNTERS[stem]}"
    return key if NODE is None else f"{NODE}/{key}"


def claim(key: str) -> None:
    global CURRENT
    if DRY:
        raise JanusError(DRY_MESSAGE)
    if key in LIVE:
        raise JanusError(f"duplicate step key in one run: {key}")
    LIVE.add(key)
    CURRENT = key


def run_step(key: str, kind: str, execute: Callable[[int], Any]) -> Any:
    """Replay ``key`` from the journal or execute it, journaling every status change (spec section 5)."""
    global REPLAYING
    claim(key)
    entry = JOURNAL["steps"].get(key)
    REPLAYING = entry is not None and entry.get("status") == "done"
    if REPLAYING:
        return copy.deepcopy(entry["result"])  # a flow must never be able to rewrite journal history
    attempt = 1 if entry is None else int(entry.get("attempt", 0)) + 1
    entry = JOURNAL["steps"][key] = {"kind": kind, "status": "running", "attempt": attempt, "started": now()}
    save_journal(key, "running")
    try:
        result = execute(attempt)
        yaml.safe_dump(result)  # a result that is not YAML-serialisable fails the step here
    except Exception as exc:
        error = str(exc) if isinstance(exc, JanusError) else f"{type(exc).__name__}: {exc}"
        entry.update(status="failed", finished=now(), error=error)
        save_journal(key, "failed")
        raise
    entry.update(status="done", finished=now(), result=copy.deepcopy(result))
    save_journal(key, "done")
    return copy.deepcopy(result)


def step(key: str, fn: Callable[[], Any]) -> Any:
    return run_step(make_key(key, key), "step", lambda attempt: fn())


# --- codex -----------------------------------------------------------------

def run_codex(cwd: Path, prompt: str, schema: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """One fresh ``codex exec`` (spec section 7). Returns the parsed final message."""
    if not cwd.is_dir():  # fail before Popen instead of surfacing as an opaque codex exit (finding 11)
        raise JanusError(f"cwd not found: {cwd}")
    with tempfile.TemporaryDirectory(prefix="janus-") as tmp:
        last = Path(tmp) / "last.json"
        argv = ["codex", "exec", "-C", str(cwd), "--dangerously-bypass-approvals-and-sandbox"]
        if schema is not None:
            (Path(tmp) / "schema.json").write_text(json.dumps(schema, indent=2), encoding="utf-8")
            argv += ["--output-schema", str(Path(tmp) / "schema.json")]
        argv += ["--output-last-message", str(last), "-"]
        (Path(tmp) / "prompt.md").write_text(prompt, encoding="utf-8")
        with open(Path(tmp) / "prompt.md", encoding="utf-8") as stdin:
            proc = subprocess.Popen(argv, stdin=stdin, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        lines: List[str] = []
        for line in proc.stderr:  # Codex writes its transcript to stderr: show it live, keep the tail
            sys.stderr.write(line)
            lines.append(line.rstrip("\n"))
        tail = "\n".join(lines[-20:])
        if proc.wait() != 0:
            raise JanusError(f"codex exec exited with {proc.returncode}: {tail}")
        message = last.read_text(encoding="utf-8") if last.exists() else ""
        if not message.strip():
            raise JanusError(f"codex exec ended without a final message: {tail}")
    if schema is None:
        return {"text": message.strip()}
    try:
        data = json.loads(message)
    except ValueError as exc:
        raise JanusError(f"codex final message is not JSON ({exc}): {tail}")
    problem = validate(data, schema)
    if problem:
        raise JanusError(f"codex final message does not match the output schema ({problem}): {tail}")
    return data


def run_prompt(prompt: str, cwd: str, attempt: int, variables: Dict[str, Any], previous: Optional[Any] = None,
               extra_output: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Render with reserved values < context() < call arguments, preamble first; build the schema; run Codex.
    Rendering and schema errors are raised before Codex starts."""
    output, body = load_prompt(prompt)
    merged: Dict[str, Any] = {"goal": goal(), "attempt": attempt}
    if previous is not None:
        merged["previous"] = previous
    merged.update(CONTEXT)
    merged.update(variables)
    text = render(body, merged)
    preamble = ROOT / PREAMBLE_FILE
    if preamble.exists():
        text = render(preamble.read_text(encoding="utf-8"), merged).rstrip("\n") + "\n\n" + text
    if extra_output:
        output = dict(output or {}, **extra_output)
    return run_codex(ROOT / cwd, text, None if output is None else build_schema(output))


def codex(prompt: str, key: Optional[str] = None, cwd: str = ".", **vars: Any) -> Dict[str, Any]:
    return run_step(make_key(prompt, key), "codex", lambda attempt: run_prompt(prompt, cwd, attempt, vars))


# --- context, ralph and ai_gate --------------------------------------------

def context(**vars: Any) -> None:
    CONTEXT.update(vars)


def ralph(prompt: str, until: Callable[[Dict[str, Any]], bool], max_iter: int, key: Optional[str] = None,
          cwd: str = ".", **vars: Any) -> Dict[str, Any]:
    """codex() repeated until ``until(result)``; iterations are keyed <key>/<n> and see {{previous}}."""
    global CURRENT
    key = make_key(prompt, key)
    previous: Any = ""
    last: Any = None
    for n in range(1, max_iter + 1):
        last = run_step(f"{key}/{n}", "codex",
                        lambda attempt, prev=previous: run_prompt(prompt, cwd, attempt, vars, previous=prev))
        if until(last):
            return last
        previous = last
    CURRENT = key
    raise Exhausted(last)


def ai_gate(prompt: str, key: Optional[str] = None, cwd: str = ".", **vars: Any) -> bool:
    result = run_step(make_key(prompt, key), "ai_gate", lambda attempt: run_prompt(
        prompt, cwd, attempt, vars, extra_output={"passed": "bool", "reasons": "list[str]"}))
    return bool(result["passed"])


# --- gates -----------------------------------------------------------------

def write_gate(key: str, question: str, show: Any, note: Optional[str] = None) -> None:
    """(Re)write the gate section with an empty ``answer:`` line. Only the question's first line
    sits at column 0 (as the spec's example shows); continuation lines are indented. A human note
    after the gate, past a blank line, is left alone (find_section's rule); text right after
    ``answer:`` with no blank line is answer text however it starts."""
    remove_section(f"## Gate: {key}")
    lines = read_goal_file()
    qlines = question.splitlines() or [""]
    section = [f"## Gate: {key}", qlines[0]] + ["    " + line for line in qlines[1:]] + [""]
    if show is not None:
        section += ["    " + line for line in as_text(show).splitlines()] + [""]
    section += ([note, ""] if note else []) + ["answer:", ""]
    write_goal_file(lines + ([""] if lines and lines[-1].strip() else []) + section)


def read_answer(key: str) -> str:
    """Text after ``answer:`` up to the end of the gate section; empty when there is none. Line 0
    is always the question's own first line, never the engine's marker, so a question starting
    with 'answer:' is not mistaken for it. Known limitation, not fixed: an answer that itself
    contains a literal reserved heading line such as '## Decisions' at column 0 still truncates
    there."""
    lines = read_goal_file()
    span = find_section(lines, f"## Gate: {key}")
    body = [] if span is None else lines[span[0] + 1:span[1]]
    for i, line in enumerate(body):
        if i > 0 and line.startswith("answer:"):
            return "\n".join([line[len("answer:"):]] + body[i + 1:]).strip()
    return ""


def gate(question: str, key: str, show: Any, options: Optional[List[str]]) -> str:
    global REPLAYING
    claim(key)
    entry = JOURNAL["steps"].get(key)
    REPLAYING = entry is not None and entry.get("status") == "answered"
    if REPLAYING:
        return entry["answer"]
    if entry is None:
        entry = JOURNAL["steps"][key] = {"kind": "gate" if options is None else "decision", "status": "open",
                                         "question": question, "started": now()}
    answer = read_answer(key)
    rejected = bool(answer) and options is not None and answer not in options
    if answer and not rejected:
        entry.update(status="answered", answer=answer, finished=now())
        remove_section(f"## Gate: {key}")
        append_to_section("## Decisions", [f"- {dt.date.today().isoformat()} {key}: {question}"]
                          + [("  answer: " if i == 0 else "  ") + line for i, line in enumerate(answer.splitlines())])
        save_journal(key, "answered")
        return answer
    write_gate(key, question, show, f'Note: "{answer}" is not one of: {", ".join(options)}.' if rejected else None)
    save_journal(key, "open")
    print(f"gate open: {key}. Answer it in {GOAL_FILE} and run again.")
    raise SystemExit(2)


def human_gate(question: str, key: Optional[str] = None, show: Any = None) -> str:
    return gate(question, make_key("gate", key), show, None)


def decision(question: str, options: List[str], key: Optional[str] = None, show: Any = None) -> str:
    return gate(question, make_key("decision", key), show, list(options))


# --- nodes -----------------------------------------------------------------

def node(next: Any) -> Callable[[Callable[[Any], Any]], Callable[[Any], Any]]:
    """Register the decorated function as a node named after it. ``next`` is a node name (one edge,
    the function returns None), END, or {label: name or END} (the function returns a label)."""
    if next is END or isinstance(next, str):
        edges: Dict[str, Optional[str]] = {"": None if next is END else next}
    elif (isinstance(next, dict) and next and all(isinstance(k, str) for k in next)
          and all(v is END or isinstance(v, str) for v in next.values())):
        edges = {k: (None if v is END else v) for k, v in next.items()}
    else:
        raise JanusError(f"node next must be a name, END or a non-empty dict of label -> name or END: {next!r}")

    def register(fn: Callable[[Any], Any]) -> Callable[[Any], Any]:
        if fn.__name__ in NODES:
            raise JanusError(f"duplicate node name: {fn.__name__}")
        NODES[fn.__name__] = (fn.__name__, fn, edges)
        return fn
    return register


def graph() -> Dict[str, Any]:
    """The flow's map in registration order: {"start": name, "nodes": [{"name", "next": {label: target|None}}]}."""
    return {"start": next(iter(NODES), None), "nodes": [{"name": n, "next": dict(e)} for n, _, e in NODES.values()]}


def validate_nodes() -> None:
    for name, _, edges in NODES.values():
        for target in edges.values():
            if target is not None and target not in NODES:
                raise JanusError(f"node {name} goes to {target!r}, which is not a node")


def check_label(name: str, edges: Dict[str, Optional[str]], returned: Any) -> str:
    """The edge label a node's return value selects (design 2.4): "" for a single edge, else the label."""
    if list(edges) == [""]:
        if returned is not None:
            raise JanusError(f"node {name} declares one edge but returned {returned!r}")
        return ""
    if isinstance(returned, str) and returned in edges:
        return returned
    raise JanusError(f"node {name} returned {returned!r}; declared: {', '.join(edges)}")


CLASS_STYLES = {"visited": "fill:#1b5e20,stroke:#66bb6a", "running": "fill:#0d47a1,stroke:#42a5f5",
                "open": "fill:#e65100,stroke:#ffb74d", "failed": "fill:#b71c1c,stroke:#ef5350"}


def to_mermaid(graph: Dict[str, Any], classes: Optional[Dict[str, str]] = None,
               counts: Optional[Dict[Tuple[str, str], int]] = None) -> str:
    """A graph() mapping as a mermaid flowchart (design 2.5); ``classes`` adds class lines, ``counts`` (n)."""
    lines, ends = ["flowchart LR"], False
    for n in graph["nodes"]:
        for label, target in n["next"].items():
            count = (counts or {}).get((n["name"], label))
            text = " ".join(p for p in (label, f"({count})" if count is not None else "") if p)
            lines.append(f"  {n['name']} {f'-- {text} -->' if text else '-->'} {'END' if target is None else target}")
            ends = ends or target is None
    lines += ["  END([END])"] if ends else []
    if classes:
        lines += [f"  class {name} {cls}" for name, cls in classes.items()]
        lines += [f"  classDef {cls} {style}" for cls, style in CLASS_STYLES.items()]
    return "\n".join(lines)


def run_nodes() -> None:
    """Walk the graph from the start node, recording each visit in JOURNAL["path"] (design 2.3). A finished
    entry is checked against the replayed visit, not re-recorded; an unfinished one is resumed in place."""
    global NODE, COUNTERS
    validate_nodes()
    JOURNAL["graph"] = graph()
    path: List[Dict[str, Any]] = JOURNAL.setdefault("path", [])
    s, visits, name, index = types.SimpleNamespace(), {}, graph()["start"], 0
    while name is not None:
        visit = visits[name] = visits.get(name, 0) + 1
        entry = path[index] if index < len(path) else None
        if entry is not None and entry["node"] != name:  # finished or interrupted, either way the flow changed
            raise JanusError(f"flow changed: visit {index + 1} was {entry['node']}, now {name}")
        if entry is None:
            entry = {"node": name, "visit": visit, "started": now()}
            path.append(entry)
        NODE, COUNTERS = f"{name}#{visit}", {}
        _, fn, edges = NODES[name]
        label = check_label(name, edges, fn(s))
        if entry.get("finished"):
            if entry["next"] != label:
                raise JanusError(f"flow changed: {NODE} went to {entry['next']!r} before, now {label!r}")
        else:
            entry.update(finished=now(), next=label)
        name, index = edges[label], index + 1
    NODE = None


# --- git -------------------------------------------------------------------

def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(ROOT), capture_output=True, text=True)


def git_commit(message: str) -> None:
    """Commit JANUS.md and journal.yaml and push if there is an upstream. Failures warn only."""
    if not (ROOT / ".git").exists():
        return
    existing = [f for f in (GOAL_FILE, JOURNAL_FILE) if (ROOT / f).exists()]
    if not existing:
        return  # nothing of ours to add; never fall back to a whole-index commit (NB4)
    git("add", "--", *existing)
    if git("diff", "--cached", "--quiet", "--", *existing).returncode == 0:
        return  # nothing staged for JANUS.md/journal.yaml; leave any other staged file alone
    commit = git("commit", "-q", "-m", message, "--", *existing)
    if commit.returncode != 0:
        print(f"janus: warning: git commit failed: {commit.stderr.strip()}", file=sys.stderr)
    elif git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").returncode == 0:
        push = git("push", "-q")
        if push.returncode != 0:
            print(f"janus: warning: git push failed: {push.stderr.strip()}", file=sys.stderr)

# --- CLI -------------------------------------------------------------------

def load_flow() -> None:
    """Execute flow.py top to bottom: a script flow runs its steps here; a node flow registers its nodes."""
    sys.modules.setdefault("janus", sys.modules[__name__])  # `from janus import ...` must resolve to this module
    sys.path.insert(0, str(ROOT))  # so flow.py can import helper modules from the goal folder
    runpy.run_path(str(ROOT / FLOW_FILE), run_name="flow")


def cmd_run() -> int:
    global REPLAYING
    begin(Path.cwd())
    if not (ROOT / FLOW_FILE).exists():
        print(f"janus: {FLOW_FILE} not found in {ROOT}", file=sys.stderr)
        return 1
    try:
        load_flow()
        if NODES:  # a node flow: the file only registered its nodes; the runner walks them
            run_nodes()
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    except Exhausted as exc:
        traceback.print_exc()
        REPLAYING = False  # spec section 6: the Progress line is written even after a replayed step
        log(f"{CURRENT}: ralph exhausted; last result:\n{as_text(exc.last)}")
        return 1
    except Exception as exc:
        traceback.print_exc()
        REPLAYING = False
        log(f"{CURRENT or 'flow'}: {type(exc).__name__}: {exc}")
        return 1
    finally:  # the path's last entry and a log() after the last status change are not saved yet
        if (ROOT / JOURNAL_FILE).exists() or JOURNAL.get("path"):  # a script flow that ran no step leaves none
            write_journal()
        git_commit("janus: run ended")
    print("flow ended")
    return 0


def cmd_graph() -> int:
    global DRY
    begin(Path.cwd())
    if not (ROOT / FLOW_FILE).exists():
        print(f"janus: {FLOW_FILE} not found in {ROOT}", file=sys.stderr)
        return 1
    DRY = True
    load_flow()
    if not NODES:
        raise JanusError(DRY_MESSAGE)
    validate_nodes()
    print(to_mermaid(graph()))
    return 0


def cmd_status() -> int:
    begin(Path.cwd())
    if not (ROOT / JOURNAL_FILE).exists():
        print("no journal; nothing has run yet\nnext: python janus.py run")
        return 0
    if JOURNAL.get("path"):
        last = JOURNAL["path"][-1]
        print(f"at: {last['node']}#{last['visit']} (visit {last['visit']} of {last['node']})")
    steps: Dict[str, Any] = JOURNAL["steps"]
    gates = [k for k, e in steps.items() if e.get("status") == "open"]
    unfinished = [k for k, e in steps.items() if e.get("status") in ("running", "failed")]
    print(f"open gate: {gates[0]}\n  {steps[gates[0]].get('question', '')}" if gates else "no open gate")
    print("last steps:")
    for k in list(steps)[-5:]:
        print(f"  {k}: {steps[k].get('kind')} {steps[k].get('status')} (attempt {steps[k].get('attempt', '-')})")
    if gates:
        print(f"next: answer '{gates[0]}' in {GOAL_FILE}, then python janus.py run")
    else:
        print("next: python janus.py run" + (f" (re-executes {unfinished[0]})" if unfinished else ""))
    return 0


def cmd_reset() -> int:
    global ROOT
    ROOT = Path.cwd()  # archive before begin(): a corrupt journal.yaml must not block reset (NB2)
    path = ROOT / JOURNAL_FILE
    if path.exists():
        archive = ROOT / "journals" / (dt.datetime.now().strftime("%Y%m%dT%H%M%S") + ".yaml")
        archive.parent.mkdir(exist_ok=True)
        shutil.move(str(path), str(archive))
        print(f"archived {JOURNAL_FILE} to {archive.relative_to(ROOT)}")
    begin(ROOT)  # journal.yaml is gone now (or never existed), so this always succeeds
    gates = [line.rstrip() for line in read_goal_file() if line.startswith("## Gate: ")]
    for heading in gates:
        remove_section(heading)
    print(f"removed {len(gates)} open gate(s) from {GOAL_FILE}")
    return 0


STARTER_FLOW = '''\
from janus import END, human_gate, log, node, ralph

@node(next="approve")
def draft(s):
    s.result = ralph("prompts/draft.md", until=lambda r: r["done"], max_iter=3,
                     findings=getattr(s, "findings", ""))

@node(next={"yes": "finish", "no": "draft"})
def approve(s):
    answer = human_gate("Is this done? Answer yes, or write what to change.", show=s.result["summary"])
    if answer.strip().lower() == "yes":
        return "yes"
    s.findings = answer
    return "no"

@node(next=END)
def finish(s):
    log("done: " + s.result["summary"])
'''

STARTER_PREAMBLE = '''\
{{goal}}

Rules: report blockers instead of guessing; never echo secrets (tokens, passwords, keys); commit your own
work and report the commit.
'''

STARTER_DRAFT = '''\
---
output:
  done: bool
  summary: str
  blockers: list[str]
---
Do the work the goal describes, in the current folder.

Your earlier attempt (empty on the first attempt):
{{previous}}

What the human asked to change (empty on the first draft):
{{findings}}

When the work is complete answer done: true with a summary of what you did and where; otherwise answer
done: false, say in summary how far you got and list in blockers what stops you.
'''

STARTER_FILES = {"JANUS.md": "# Goal\nDescribe what Codex must achieve; every prompt sees this text as {{goal}}.\n",
                 "flow.py": STARTER_FLOW, "prompts/_preamble.md": STARTER_PREAMBLE,
                 "prompts/draft.md": STARTER_DRAFT, ".gitignore": "*/\n!prompts/\n!journals/\n"}

INIT_STEPS = """\
next, in this folder:
  1. edit JANUS.md: describe the goal under # Goal
  2. edit prompts/draft.md, or add prompts; each declares its output fields in front matter
  3. edit flow.py: one function per node, next= says where it goes
  4. python janus.py graph    # print the map
  5. python janus.py run      # run it; answer gates in JANUS.md and run again
  6. python janus_ui.py       # watch it in the browser"""


def cmd_init(folder: Optional[str]) -> int:
    """Create a goal folder with a copy of this engine and the starter node flow (design 2.7)."""
    if not folder:
        raise JanusError("init needs a folder: python janus.py init <folder>")
    target = Path(folder)
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise JanusError(f"{target} exists and is not an empty folder")
    (target / "prompts").mkdir(parents=True, exist_ok=True)
    here = Path(__file__).resolve()
    shutil.copy(str(here), str(target / "janus.py"))
    if (here.parent / "janus_ui.py").exists():
        shutil.copy(str(here.parent / "janus_ui.py"), str(target / "janus_ui.py"))
    for name, text in STARTER_FILES.items():
        (target / name).write_text(text, encoding="utf-8")
    print(f"created {target}\n{INIT_STEPS}")
    return 0


COMMANDS = {"run": cmd_run, "status": cmd_status, "reset": cmd_reset, "graph": cmd_graph, "init": cmd_init}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="janus.py", description="Janus 4.0: a small durable flow engine for Codex")
    parser.add_argument("command", choices=sorted(COMMANDS))
    parser.add_argument("folder", nargs="?", help="init: the goal folder to create")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:  # argparse's usual exit 2 collides with "2 = a gate is open" (finding 7)
        return 0 if exc.code in (0, None) else 1
    try:
        return cmd_init(args.folder) if args.command == "init" else COMMANDS[args.command]()
    except JanusError as exc:  # e.g. begin() found a corrupt journal.yaml (finding 6)
        print(f"janus: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
