"""Shared helpers for Janus tests: journal reading and prompt writing."""
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
