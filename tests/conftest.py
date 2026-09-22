import json
import os
import types

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


FAKE_CODEX = '''#!/usr/bin/env python3
"""Fake `codex` for tests: records the call, then plays the next scripted step.
A step is {"output": <dict>} or {"text": <str>} for the final message, plus optional
"stderr" (printed to stderr), "shell" (commands run in the -C directory) and "exit" (default 0).
The last step repeats for extra calls."""
import json, os, subprocess, sys

argv = sys.argv[1:]


def opt(flag):
    return argv[argv.index(flag) + 1] if flag in argv else None


cwd = opt("-C") or os.getcwd()
out_path = opt("--output-last-message")
schema = json.load(open(opt("--output-schema"))) if opt("--output-schema") else None
prompt = sys.stdin.read() if argv and argv[-1] == "-" else (argv[-1] if argv else "")
calls_path = os.environ["FAKE_CODEX_CALLS"]
steps = json.load(open(os.environ["FAKE_CODEX_SCRIPT"]))
done = sum(1 for _ in open(calls_path)) if os.path.exists(calls_path) else 0
step = steps[min(done, len(steps) - 1)]
with open(calls_path, "a") as f:
    f.write(json.dumps({"argv": argv, "cwd": cwd, "prompt": prompt, "schema": schema}) + "\\n")
for command in step.get("shell", []):
    subprocess.run(command, shell=True, cwd=cwd, check=True)
if step.get("stderr"):
    sys.stderr.write(step["stderr"] + "\\n")
if out_path and "output" in step:
    with open(out_path, "w") as f:
        json.dump(step["output"], f)
elif out_path and "text" in step:
    with open(out_path, "w") as f:
        f.write(step["text"])
sys.exit(step.get("exit", 0))
'''


@pytest.fixture
def fake_codex(tmp_path, monkeypatch):
    """Puts a scripted `codex` first on PATH. Tests never reach the real Codex."""
    bin_dir = tmp_path / "fake-bin"
    bin_dir.mkdir()
    exe = bin_dir / "codex"
    exe.write_text(FAKE_CODEX, encoding="utf-8")
    exe.chmod(0o755)
    script_path = tmp_path / "codex-script.json"
    calls_path = tmp_path / "codex-calls.jsonl"
    script_path.write_text("[{}]", encoding="utf-8")
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("FAKE_CODEX_SCRIPT", str(script_path))
    monkeypatch.setenv("FAKE_CODEX_CALLS", str(calls_path))

    def script(steps):
        script_path.write_text(json.dumps(steps), encoding="utf-8")

    def calls():
        if not calls_path.exists():
            return []
        return [json.loads(line) for line in calls_path.read_text(encoding="utf-8").splitlines()]

    return types.SimpleNamespace(script=script, calls=calls)
