#!/usr/bin/env python3
"""Janus UI: a live view of one goal folder in the browser (design 2026-09-24 section 4).
``python janus_ui.py [--port N]`` from the goal folder serves http://127.0.0.1:8765 on loopback only. It reads
``journal.yaml`` and ``JANUS.md`` on every poll and never writes, never runs the flow, never commits."""
from __future__ import annotations

import argparse
import datetime as dt
import errno
import json
import sys
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from janus import find_section, to_mermaid

JOURNAL_FILE = "journal.yaml"
GOAL_FILE = "JANUS.md"
SUMMARY_WIDTH = 160
CODEX_KINDS = ("codex", "ai_gate")
TOKEN_KEYS = ("input", "cached", "output", "total")


# --- state -----------------------------------------------------------------

def read_journal(root: Path) -> Tuple[Dict[str, Any], Optional[str], Optional[str]]:
    """(journal, updated, error): the mapping, its mtime as ISO seconds, one error line. A missing file gives
    ({}, None, None); a corrupt one ({}, None, "journal.yaml ...") so the rest reads as for a missing journal."""
    path = root / JOURNAL_FILE
    if not path.exists():
        return {}, None, None
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        return {}, None, f"{JOURNAL_FILE} is not valid YAML: {' '.join(str(exc).split())}"
    if not isinstance(loaded, dict):
        return {}, None, f"{JOURNAL_FILE} is not a mapping"
    return loaded, dt.datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"), None


def parse_time(value: Any) -> Optional[dt.datetime]:
    """An engine timestamp (ISO seconds, a string or already a datetime when YAML resolved it), else None."""
    if isinstance(value, dt.datetime):
        return value
    try:
        return dt.datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


def seconds(entry: Dict[str, Any], now: dt.datetime) -> Optional[int]:
    """Whole seconds from ``started`` to ``finished``, or to ``now`` while running or open; None when unparsable."""
    started = parse_time(entry.get("started"))
    finished = now if entry.get("status") in ("running", "open") else parse_time(entry.get("finished"))
    return None if started is None or finished is None else int((finished - started).total_seconds())


def summary(entry: Dict[str, Any]) -> str:
    """One line of at most 160 characters: the result's summary or text, the answer, the error or the question."""
    status, result = entry.get("status"), entry.get("result")
    if status == "done":
        text = next((result[k] for k in ("summary", "text") if isinstance(result, dict)
                     and isinstance(result.get(k), str)), "")
    else:
        field = {"answered": "answer", "failed": "error", "open": "question"}.get(status)
        text = entry.get(field) if field else ""
    line = str(text).splitlines()[0] if text else ""
    return line if len(line) <= SUMMARY_WIDTH else line[:SUMMARY_WIDTH - 3] + "..."


def step_item(key: str, entry: Dict[str, Any], now: dt.datetime) -> Dict[str, Any]:
    usage = entry.get("usage")
    return {"key": key, "kind": entry.get("kind"), "status": entry.get("status"), "attempt": entry.get("attempt"),
            "session": entry.get("session"), "usage": usage if isinstance(usage, dict) else None,
            "started": entry.get("started"), "finished": entry.get("finished"), "seconds": seconds(entry, now),
            "summary": summary(entry), "detail": yaml.safe_dump(entry, sort_keys=False, allow_unicode=True)}


def section_lines(lines: List[str], heading: str) -> List[str]:
    span = find_section(lines, heading)
    return [] if span is None else lines[span[0] + 1:span[1]]


def build_tree(steps: List[Dict[str, Any]], path: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keys split on '/': a journal key's node carries its status and seconds, a group rolls its children up
    (running if any is running or open, else failed if any failed, else done) and sums their seconds; a top-level
    node named after a finished path visit gets that visit's label as ``next``."""
    roots: List[Dict[str, Any]] = []
    nodes: Dict[str, Dict[str, Any]] = {}
    for item in steps:
        siblings, prefix = roots, ""
        for part in item["key"].split("/"):
            prefix = f"{prefix}/{part}" if prefix else part
            if prefix not in nodes:
                nodes[prefix] = {"name": part, "key": prefix, "status": None, "seconds": None, "next": None,
                                 "children": []}
                siblings.append(nodes[prefix])
            siblings = nodes[prefix]["children"]
        nodes[item["key"]].update(status=item["status"], seconds=item["seconds"])

    def roll(node: Dict[str, Any]) -> None:
        for child in node["children"]:
            roll(child)
        if node["status"] is None and node["children"]:
            statuses = [c["status"] for c in node["children"]]
            node["status"] = ("running" if any(s in ("running", "open") for s in statuses)
                              else "failed" if "failed" in statuses else "done")
            timed = [c["seconds"] for c in node["children"] if c["seconds"] is not None]
            node["seconds"] = sum(timed) if timed else None

    labels = {f"{e['node']}#{e['visit']}": e.get("next") for e in path if e.get("finished")}
    for root in roots:
        roll(root)
        root["next"] = labels.get(root["key"])
    return roots


def gate_of(steps: List[Dict[str, Any]], raw: Dict[str, Any], lines: List[str]) -> Optional[Dict[str, Any]]:
    """The first open entry with its verbatim ``## Gate: <key>`` section of JANUS.md (heading included)."""
    for s in steps:
        if s["status"] == "open":
            span = find_section(lines, f"## Gate: {s['key']}")
            return {"key": s["key"], "kind": s["kind"], "question": raw[s["key"]].get("question"),
                    "section": "\n".join(lines[span[0]:span[1]]) if span else ""}
    return None


def mermaid_of(graph: Any, path: List[Dict[str, Any]], current: Optional[Dict[str, Any]]) -> Optional[str]:
    """The map with every finished visit's node ``visited``, the unfinished last visit's node after ``current``'s
    status (``running`` without a current step), and ``(n)`` counts on the edges the finished visits took."""
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
        return None
    finished = [e for e in path if e.get("finished")]
    classes = {e["node"]: "visited" for e in finished}
    if path and not path[-1].get("finished"):
        status = current["status"] if current else "running"
        classes[path[-1]["node"]] = status if status in ("running", "open", "failed") else "running"
    return to_mermaid(graph, classes, dict(Counter((e["node"], e.get("next", "")) for e in finished)))


def build_state(root: Path, now: Any = None) -> Dict[str, Any]:
    """The page's state from journal.yaml and JANUS.md (design 4.2); ``now`` (ISO string or datetime) for tests."""
    root, clock = Path(root), parse_time(now) or dt.datetime.now()
    journal, updated, error = read_journal(root)
    raw = journal.get("steps") if isinstance(journal.get("steps"), dict) else {}
    steps = [step_item(str(k), e, clock) for k, e in raw.items() if isinstance(e, dict)]
    raw_path = journal.get("path")
    path = ([e for e in raw_path if isinstance(e, dict) and "node" in e and "visit" in e]
            if isinstance(raw_path, list) else [])
    live = [s for s in steps if s["status"] in ("running", "open")]
    failed = [s for s in steps if s["status"] == "failed"]
    current = live[0] if live else failed[-1] if failed else None
    goal_path = root / GOAL_FILE
    lines = goal_path.read_text(encoding="utf-8").splitlines() if goal_path.exists() else []
    used = [s["usage"] for s in steps if s["usage"]]
    tokens = {k: sum(u.get(k, 0) for u in used) for k in TOKEN_KEYS}
    tokens["sessions"] = len(used)
    totals = {"steps": len(steps), **{st: sum(1 for s in steps if s["status"] == st)
                                      for st in ("done", "failed", "running", "open", "answered")},
              "codex_seconds": sum(s["seconds"] or 0 for s in steps if s["kind"] in CODEX_KINDS), "tokens": tokens}
    return {"folder": root.resolve().name, "flow": journal.get("flow", "flow.py"), "started": journal.get("started"),
            "updated": updated, "error": error, "goal": "\n".join(section_lines(lines, "# Goal")).strip(),
            "steps": steps, "tree": build_tree(steps, path), "current": current["key"] if current else None,
            "gate": gate_of(steps, raw, lines), "path": path,
            "mermaid": mermaid_of(journal.get("graph"), path, current),
            "progress": section_lines(lines, "## Progress"), "decisions": section_lines(lines, "## Decisions"),
            "totals": totals}


# --- server ----------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    root = Path(".")  # make_server sets it on a subclass

    def do_GET(self) -> None:
        route = self.path.split("?")[0]
        if route == "/":
            self.reply(200, "text/html; charset=utf-8", PAGE.encode("utf-8"))
        elif route == "/state.json":
            try:
                body = json.dumps(build_state(self.root), default=str).encode("utf-8")
            except Exception as exc:  # the page keeps its last state and reddens the dot with this text
                self.reply(500, "text/plain; charset=utf-8", f"{type(exc).__name__}: {exc}".encode("utf-8"))
                return
            self.reply(200, "application/json", body)
        else:
            self.reply(404, "text/plain; charset=utf-8", b"not found\n")

    def reply(self, code: int, content_type: str, body: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - the base class names it so
        pass


def make_server(root: Path, port: int) -> ThreadingHTTPServer:
    """A loopback server for ``root``; port 0 picks a free one (``server.server_address[1]`` tells which)."""
    handler = type("JanusHandler", (Handler,), {"root": Path(root)})
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="janus_ui.py", description="Janus UI: a live view of this goal folder")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    try:
        server = make_server(Path.cwd(), args.port)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise
        print(f"janus_ui: port {args.port} is in use; try --port {args.port + 1}", file=sys.stderr)
        return 1
    print(f"janus_ui: {Path.cwd().resolve().name} at http://127.0.0.1:{args.port} (Ctrl-C stops)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


# --- page ------------------------------------------------------------------

PAGE = r"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Janus</title></head><body>Janus</body></html>
"""

if __name__ == "__main__":
    sys.exit(main())
