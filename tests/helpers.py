"""Shared helpers for Janus tests: journal reading, prompt writing and a tiny git wrapper."""
import subprocess

import yaml


def read_journal(root):
    return yaml.safe_load((root / "journal.yaml").read_text(encoding="utf-8"))


def write_prompt(root, stem, body, output=None):
    """Write prompts/<stem>.md with an optional ``output`` front matter mapping."""
    text = body
    if output is not None:
        text = "---\n" + yaml.safe_dump({"output": output}, sort_keys=False) + "---\n" + body
    (root / "prompts").mkdir(exist_ok=True)
    (root / "prompts" / f"{stem}.md").write_text(text, encoding="utf-8")


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True).stdout.strip()


def init_repo(path):
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.name", "Test User")
    git(path, "config", "user.email", "test@example.com")
    git(path, "config", "commit.gpgsign", "false")


def commit_all(path, message):
    git(path, "add", "-A")
    git(path, "commit", "-q", "-m", message)
    return git(path, "rev-parse", "HEAD")


def make_bare(path):
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(path)], check=True)
    return path
