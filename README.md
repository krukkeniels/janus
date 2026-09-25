# Janus

A small durable flow engine for Codex. You write the goal, the prompts and the flow. Janus starts a
fresh `codex exec` process for each step, records every step in a journal, stops when a human has to
answer something and picks up where it left off.

All of it is one file, `janus.py`.

## Get started

You need Python 3.9 or newer, PyYAML (`pip install pyyaml`) and the `codex` CLI on your PATH.

```bash
python janus.py init ~/work/my-goal
cd ~/work/my-goal
```

This creates a goal folder with a starter flow: Codex drafts the work, you approve it or say what to
change, and it goes round again until you approve.

1. Describe the goal under `# Goal` in `JANUS.md`.
2. Change `prompts/draft.md` and `flow.py` if you need to.
3. Run `python janus.py run`.

When the run stops at a question, write your answer after `answer:` in `JANUS.md` and run again.
Steps that already finished are read back from `journal.yaml` and don't run again.

## Commands

| Command | What it does |
|---|---|
| `python janus.py run` | Run the flow until it ends or needs an answer |
| `python janus.py status` | Show where the run is and what to do next |
| `python janus.py graph` | Print the flow as a Mermaid diagram |
| `python janus.py reset` | Archive the journal and start over |
| `python janus_ui.py` | Watch the run in the browser |

## More

- `examples/angular-upgrade/`: a full example flow
- `skills/janus-flow/`: a Codex skill that helps you write flows
- `janus-4.0-spec.md`: the full specification
- Tests: `uv run pytest`
