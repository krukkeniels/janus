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
    """Write journal.yaml atomically at every status change of ``key``."""
    write_atomic(ROOT / JOURNAL_FILE, yaml.safe_dump(JOURNAL, sort_keys=False, allow_unicode=True))


# --- JANUS.md --------------------------------------------------------------

def read_goal_file() -> List[str]:
    path = ROOT / GOAL_FILE
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []


def write_goal_file(lines: List[str]) -> None:
    write_atomic(ROOT / GOAL_FILE, "\n".join(lines).rstrip("\n") + "\n")


def find_section(lines: List[str], heading: str) -> Optional[Tuple[int, int]]:
    """Line range [start, end) of the section with exactly this heading line; ### and deeper belong to it."""
    for i, line in enumerate(lines):
        if line.rstrip() == heading:
            j = i + 1
            while j < len(lines) and not re.match(r"#{1,2} ", lines[j]):
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
