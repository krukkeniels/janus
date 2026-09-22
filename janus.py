#!/usr/bin/env python3
"""Janus 4.0: a small durable flow engine for Codex. One file, standard library plus PyYAML.
A flow imports the primitives with ``from janus import ...``; see janus-4.0-spec.md sections 4 to 9."""
from __future__ import annotations

import argparse
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


# Engine state for one run; begin() resets all of it.
ROOT = Path(".")
JOURNAL: Dict[str, Any] = {"flow": FLOW_FILE, "started": None, "steps": {}}
CONTEXT: Dict[str, Any] = {}
COUNTERS: Dict[str, int] = {}
LIVE: set = set()
CURRENT: Optional[str] = None
REPLAYING = False  # True while the last step came from the journal; log() then skips Progress


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
    global ROOT, JOURNAL, CONTEXT, COUNTERS, LIVE, CURRENT, REPLAYING
    ROOT = Path(root)
    path, fresh = ROOT / JOURNAL_FILE, {"flow": FLOW_FILE, "started": now(), "steps": {}}
    JOURNAL = yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else fresh
    JOURNAL.setdefault("steps", {})
    CONTEXT, COUNTERS, LIVE, CURRENT = {}, {}, set(), None
    REPLAYING = bool(JOURNAL["steps"])


def save_journal(key: str, status: str) -> None:
    """Write journal.yaml atomically at every status change of ``key``, then commit (section 5, Git)."""
    write_atomic(ROOT / JOURNAL_FILE, yaml.safe_dump(JOURNAL, sort_keys=False, allow_unicode=True))
    git_commit(f"janus: {key} {status}")


# --- JANUS.md --------------------------------------------------------------

def read_goal_file() -> List[str]:
    path = ROOT / GOAL_FILE
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []


def write_goal_file(lines: List[str]) -> None:
    write_atomic(ROOT / GOAL_FILE, "\n".join(lines).rstrip("\n") + "\n")


def is_reserved_heading(line: str) -> bool:
    """True for a heading line the engine itself writes; free text (a question, an answer, a note)
    may contain a '#'-prefixed line without ending the section it lives in (finding 1)."""
    line = line.rstrip()
    return line in ("# Goal", "## Progress", "## Decisions") or line.startswith("## Gate: ")


def find_section(lines: List[str], heading: str) -> Optional[Tuple[int, int]]:
    """Line range [start, end) of the section with exactly this heading line; only another heading
    the engine itself writes ends it, so free text within the section may contain '#' lines."""
    for i, line in enumerate(lines):
        if line.rstrip() == heading:
            j = i + 1
            while j < len(lines) and not is_reserved_heading(lines[j]):
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
    """Explicit key, or ``<stem>#<n>`` counting calls with that prompt stem in this run."""
    if key is not None:
        return key
    stem = Path(prompt).stem
    COUNTERS[stem] = COUNTERS.get(stem, 0) + 1
    return f"{stem}#{COUNTERS[stem]}"


def claim(key: str) -> None:
    global CURRENT
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
        return entry["result"]
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
    entry.update(status="done", finished=now(), result=result)
    save_journal(key, "done")
    return result


def step(key: str, fn: Callable[[], Any]) -> Any:
    return run_step(key, "step", lambda attempt: fn())


# --- codex -----------------------------------------------------------------

def run_codex(cwd: Path, prompt: str, schema: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """One fresh ``codex exec`` (spec section 7). Returns the parsed final message."""
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
    """(Re)write the gate section at the end of JANUS.md with an empty ``answer:`` line.
    Only the question's first line sits at column 0 (matching the spec's example); continuation
    lines are indented so a '## x'-shaped question line can never be mistaken for a heading."""
    remove_section(f"## Gate: {key}")
    lines = read_goal_file()
    qlines = question.splitlines() or [""]
    section = [f"## Gate: {key}", qlines[0]] + ["    " + line for line in qlines[1:]] + [""]
    if show is not None:
        section += ["    " + line for line in as_text(show).splitlines()] + [""]
    section += ([note, ""] if note else []) + ["answer:", ""]
    write_goal_file(lines + ([""] if lines and lines[-1].strip() else []) + section)


def read_answer(key: str) -> str:
    """Text after ``answer:`` up to the end of the gate section; empty when there is none.
    Line 0 of the body is always the question's own first line (never the engine's marker, which
    is always preceded by a blank line), so a question starting with 'answer:' cannot be mistaken
    for it (finding 1, Task 7 deferred minor)."""
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


# --- git -------------------------------------------------------------------

def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(ROOT), capture_output=True, text=True)


def git_commit(message: str) -> None:
    """Commit JANUS.md and journal.yaml and push if there is an upstream. Failures warn only."""
    if not (ROOT / ".git").exists():
        return
    existing = [f for f in (GOAL_FILE, JOURNAL_FILE) if (ROOT / f).exists()]
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

def cmd_run() -> int:
    begin(Path.cwd())
    if not (ROOT / FLOW_FILE).exists():
        print(f"janus: {FLOW_FILE} not found in {ROOT}", file=sys.stderr)
        return 1
    # flow.py says `from janus import ...`; that must resolve to this module, not to a second copy of the file.
    sys.modules.setdefault("janus", sys.modules[__name__])
    sys.path.insert(0, str(ROOT))  # so flow.py can import helper modules from the goal folder
    try:
        runpy.run_path(str(ROOT / FLOW_FILE), run_name="flow")
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    except Exhausted as exc:
        traceback.print_exc()
        log(f"{CURRENT}: ralph exhausted; last result:\n{as_text(exc.last)}")
        return 1
    except Exception as exc:
        traceback.print_exc()
        log(f"{CURRENT or 'flow'}: {type(exc).__name__}: {exc}")
        return 1
    print("flow ended")
    return 0


def cmd_status() -> int:
    begin(Path.cwd())
    if not (ROOT / JOURNAL_FILE).exists():
        print("no journal; nothing has run yet\nnext: python janus.py run")
        return 0
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
    begin(Path.cwd())
    path = ROOT / JOURNAL_FILE
    if path.exists():
        archive = ROOT / "journals" / (dt.datetime.now().strftime("%Y%m%dT%H%M%S") + ".yaml")
        archive.parent.mkdir(exist_ok=True)
        shutil.move(str(path), str(archive))
        print(f"archived {JOURNAL_FILE} to {archive.relative_to(ROOT)}")
    gates = [line.rstrip() for line in read_goal_file() if line.startswith("## Gate: ")]
    for heading in gates:
        remove_section(heading)
    print(f"removed {len(gates)} open gate(s) from {GOAL_FILE}")
    return 0


COMMANDS = {"run": cmd_run, "status": cmd_status, "reset": cmd_reset}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="janus.py", description="Janus 4.0: a small durable flow engine for Codex")
    parser.add_argument("command", choices=sorted(COMMANDS))
    return COMMANDS[parser.parse_args(argv).command]()


if __name__ == "__main__":
    sys.exit(main())
