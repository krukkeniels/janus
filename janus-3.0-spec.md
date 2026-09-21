# Janus 3.0
## Minimal AI Development Orchestrator

**Status:** implementation specification, v0.2 (supersedes v0.1 after design review on 2026-09-21)
**Reference goal:** upgrade a multi-repository Angular application by one major version (x to x+1). The examples below use 15 to 16 for illustration only; nothing in Janus depends on a specific version.
**Intent:** preserve the control and resumability of Janus 2.1 without building a general-purpose agent framework.

### Changes from v0.1

| Topic | v0.1 | v0.2 | Reason |
|---|---|---|---|
| Goal | Angular 15 to 16 | Any x to x+1; `from`/`to` majors live in `JANUS.md` | The same runner serves every future major. |
| Workspace | `control/` checkout plus `repos/` folder, paths in front matter | The folder Janus runs from is the control repo; every git checkout inside it is a repo; no paths | One folder is one goal; nothing to configure by hand. |
| Discovery | Human writes repo config, Codex writes plan text | Codex writes the whole draft front matter and plan; human edits and approves | Janus does not decide anything about the repos. |
| Baseline | Runner obtains evidence "where feasible" | Plan states what baseline evidence matters; runner records what the plan asks for | Baseline scope is a judgment call, not a runner rule. |
| Codex sandbox | Codex sandbox flags, credential isolation in the runner | Full access inside an established sandbox that reaches only Bitbucket, the LLM, TeamCity and Nexus | The environment is the boundary; the runner detects ref mutations afterwards. |
| Tests | Unspecified | pytest; TeamCity and Bitbucket exercised by a per-test stdlib HTTP stub | Neither system is reachable from the development machine. |
| Reuse | Unspecified | Clean rewrite; Janus 2.x remains in Git history (`8bf3f0f`) as reference | Two files, small, no ported framework. |

## 1. Principle

**Codex performs development. Janus controls the workflow. Git retains the work. TeamCity supplies verification evidence. Humans approve plans, review code, and merge.**

The first version consists of exactly two Janus source files:

- `JANUS.md`: one human-readable goal, configuration, plan, approval record, progress, decisions, and handover.
- `janus.py`: one small Python executable to launch Codex, maintain checkpoints, use Git/Bitbucket/TeamCity, and stop at gates.

There is **no state machine framework, database, daemon, plugin architecture, provider interface, per-role JSON schema, separate plan YAML, persisted fake service, or custom telemetry service**. Python 3.9 or newer, standard library plus PyYAML. Existing Codex CLI, Git, Bitbucket Server and TeamCity do the actual work.

Janus decides nothing about the repositories. Which repositories take part, in what order, which branches, which TeamCity jobs, which local commands, how a prerelease is versioned, what counts as baseline: all of that is proposed by Codex during planning and approved by a human. The runner enforces gates, owns Git writes, ties evidence to exact commits, and resumes after a crash.

A new process must be able to reconstruct what to do from `JANUS.md`, repository heads, PRs and CI build results, without conversation memory.

## 2. Scope

**Included in v0.1 of the implementation**

- One major Angular upgrade per goal; multiple repositories in a human-approved order.
- Read-only discovery and baseline assessment by Codex; AI-drafted plan including the machine-readable configuration; explicit human plan approval.
- A goal branch and PR per changed repository.
- Sequential implementation tasks; fresh Codex process for each meaningful implementation, fix or review task.
- Local checks as named in the approved plan; TeamCity PR build feedback; bounded autonomous fix loop.
- Explicitly planned library prerelease and consumer bump steps, using existing TeamCity jobs and Nexus.
- Full E2E started via TeamCity API after implementation; review and re-verification of changed code.
- Final independent AI review, handover to existing human PR review and QA; humans merge.
- Git checkpoints and crash recovery; useful status/blocked summary.

**Not included**

- Automatic PR merge, production deployment or post-merge release orchestration.
- Multiple Angular majors in one goal; arbitrary agent task graphs; parallel writers to one repository.
- Automatic plan approval, automatic acceptance of new baseline failures, automatic architectural decisions.
- Automatic PR-comment polling and response. A human writes review feedback into `JANUS.md` and runs Janus again.
- A generalized dependency/verification-group scheduler. Coupled repositories are described explicitly in the approved plan.
- Generic CI/SCM adapters, persisted fake services, analytics dashboard or model experiments.
- Sandboxing of the Codex process by Janus. The machine Janus runs on is already a sandbox.

## 3. Files and workspace

The folder Janus is started from **is** the goal. It is a small Git repository (the control repo) whose tracked content is Janus's own files. Every subdirectory that contains a `.git` is a product repository.

```text
angular-16-upgrade/          # control repo checkout; one folder = one goal
  janus.py                   # tracked
  JANUS.md                   # tracked
  .gitignore                 # tracked; contains "*/" so nested clones are invisible
  ui-kit/                    # product Git clone, ignored by the control repo
  shell/
  orders-remote/
  .janus.lock                # ephemeral, ignored
  .janus-interrupted.patch   # optional, ignored
```

Starting a goal on any machine: clone the control repo, clone the product repositories into it, write the `# Goal` paragraph in `JANUS.md`, run `python janus.py plan`. Nothing else is configured by hand. Repository names in `JANUS.md` are folder names.

Never commit product source or credentials into the control repo. The runner stores progress in `JANUS.md` and commits it to the control repo after meaningful transitions, then pushes. If a shared control remote is unavailable, a local control repo is acceptable for a proof of concept, but cross-machine resume then requires pushing it somewhere accessible.

The lock file and interrupted-run patch are runtime safeguards, not authoritative documents.

## 4. The JANUS.md contract

`JANUS.md` has a YAML front matter containing the **small machine-readable part** and ordinary Markdown containing rationale, risks, acceptance criteria, progress and decisions. Do not duplicate the task list in a second plan file.

Before `plan` runs, the file needs only a `# Goal` section. Codex writes the rest of the draft. Minimal example after planning (illustrative identifiers, not production values):

```markdown
---
id: angular-15-to-16
status: awaiting_plan_approval
angular:
  from: 15
  to: 16
approval:
  plan_hash: null
  approved_by: null
  approved_at: null
repos:
  - name: ui-kit
    base: main
    branch: ai/angular-15-to-16
    pr_build: Fe_UiKit_Build
    checks: ["npm ci", "npm run lint", "npm test -- --watch=false"]
  - name: shell
    base: main
    branch: ai/angular-15-to-16
    pr_build: Fe_Shell_Build
    checks: ["npm ci", "npm run build", "npm test -- --watch=false"]
  - name: orders-remote
    base: develop
    branch: ai/angular-15-to-16
    pr_build: Fe_Orders_Build
    checks: ["npm ci", "npm run build", "npm test -- --watch=false"]
e2e:
  build_type: Fe_E2E_Full
  branch_parameters:
    shell: env.SHELL_BRANCH
    orders-remote: env.ORDERS_BRANCH
tasks:
  - id: 1
    repo: ui-kit
    objective: Upgrade and publish a prerelease through TeamCity
    status: pending
  - id: 2
    repo: shell
    objective: Upgrade using the ui-kit prerelease recorded by task 1
    status: pending
  - id: 3
    repo: orders-remote
    objective: Upgrade and verify with shell
    status: pending
current_task: null
last_verified: {}       # repo -> {commit, teamcity_build, status}
prs: {}                 # repo -> URL
attempts: 0
in_flight: null
---

# Goal
Upgrade Angular 15 to 16 across the repositories in this folder; preserve existing behaviour.

## Approved-plan content
Repository order, dependencies, coupled changes, prerelease strategy
and versioning, baseline evidence and known pre-existing failures,
test strategy, acceptance criteria and non-goals. Draft until approved.

## Rules
Never change scope or architecture without human direction.
Never weaken/skip tests to obtain a green build.
Never merge, publish a production release or deploy.

## Review feedback
Empty until a human pastes PR review or QA comments here and runs Janus again.

## Progress and handover
Current state, completed tasks, blockers and exact next action.

## Decisions
Human approvals, exceptions and replanning decisions.
```

**Ownership.** Codex proposes the front matter configuration (`angular`, `repos`, `e2e`, `tasks`) and the plan text during `plan`. The runner owns `status`, `approval`, task statuses, `current_task`, `last_verified`, `prs`, `attempts`, `in_flight` and the Progress section. Codex never edits `JANUS.md` after approval; the runner updates it from Codex's structured summary and from verified external results. During implementation Codex works only in its assigned product checkout.

**Plan integrity.** `janus approve` computes a hash of the Goal section, `angular`, `repos`, `e2e`, the task ids/repos/objectives in order, and the Approved-plan content section; records the human's explicit approval; and checkpoints it. Runtime fields are excluded from the hash. `janus run` stops if approved content has changed. Replanning requires a new explicit approval. Local approval is a workflow control, not a cryptographic identity guarantee; repository permissions provide the real authorization boundary.

## 5. CLI: only four commands

```bash
python janus.py plan         # discovery + baseline + draft plan; then stop
python janus.py approve      # interactive human approval of displayed plan
python janus.py run          # advance until next human gate, block or completion
python janus.py status       # concise state, PR/build links, next action
```

`run` can be invoked again after a crash, long CI wait or human review. No `init`, `doctor`, `telemetry`, `escalation`, `review sync` or subcommand hierarchy is necessary. Environment variables supply TeamCity and Bitbucket URLs and tokens; never put secrets in `JANUS.md`, CLI arguments, agent prompts or stored logs.

## 6. Workflow

```text
Human writes # Goal in JANUS.md
    |
plan: Codex discovers every repo in the folder, checks baseline as it sees fit,
      drafts front matter config + plan text; runner commits the draft
    |
HUMAN GATE: edit the draft, approve plan and explicit baseline exceptions
    |
For each approved task, in order:
    start/resume fresh Codex in assigned repo
    -> approved local checks -> diff guardrails -> runner commits + pushes
    -> ensure PR -> find TeamCity build for exact commit
    -> GREEN: checkpoint, next task
    -> RED: bounded new Codex fix -> recheck -> push -> retry
    -> BLOCKED: checkpoint and ask human for direction
    |
Full E2E via TeamCity API
    -> fail: bounded diagnosis/fix/reverify or human direction
    |
Independent fresh Codex review
    -> findings: fix -> affected CI + E2E -> re-review
    |
HUMAN GATE: PR review and QA; paste feedback into JANUS.md and rerun as needed
    |
HUMAN GATE: merge and handle release through existing process
    |
Done
```

### Planning and baseline

`plan` starts one fresh Codex process with the workspace folder as its working directory and the Goal text. Codex reads every repository, determines the from/to majors, dependency order, coupling, base branches, the existing TeamCity build configurations and local check commands, a prerelease and versioning strategy for shared libraries, and the baseline evidence it considers relevant, including known pre-existing failures. It returns the proposed front matter configuration and plan text in its structured output. Nothing is changed in product source during planning.

The runner writes the draft into `JANUS.md`, verifies any TeamCity evidence the plan cites where it can (latest build status for the named build configurations on the named base branches), marks what it could not verify as unverified, commits the draft and stops. What to check as baseline is the plan's decision, not the runner's.

The human reviews and edits the exact draft and explicitly invokes `approve`. Approved baseline exceptions identify the failing build/test and reason; no new exceptions may be silently created during execution.

### Implementation and TeamCity loop

At each task the runner:

1. Checks the approved-plan hash, lock, branch heads and a clean/recognized working tree. Reconciles the recorded state against remote Git and TeamCity before doing anything irreversible.
2. Checks out or creates the approved goal branch. Does not overwrite commits or force push.
3. Records every branch head in the repository, then starts a fresh Codex process in the repo with goal, current task, approved constraints, dependency context (for example the prerelease version recorded by an earlier task), relevant earlier failure summary and exact next action.
4. Runs the approved local checks for that repo. Compares branch heads with step 3 and stops if Codex moved any ref. Inspects changed paths and rejects obvious test skips/deletions, forbidden CI changes and out-of-scope changes; qualitative test weakening is deferred to independent AI and human review.
5. Commits and pushes product changes, then records the commit SHA. Ensures a draft/open Bitbucket PR exists for the changed repo.
6. Finds the PR build corresponding to that **exact commit SHA**. If no automatic build appears within the configured appearance timeout, triggers the approved TeamCity build explicitly. Never regards an older green build as proof for a new commit.
7. On red, gives a fresh Codex process a **bounded, redacted** failure summary and retries at most **3 code-fix attempts per task**. CI infrastructure/start failures do not count as code-fix attempts and are retried once.
8. On green, records build ID, verified SHA, Codex's summary and any values later tasks depend on (such as a published prerelease version), then checkpoints to the control repo.

If a task cannot be individually green because of an approved coupled change, the **plan must explicitly name the temporary red and the joint verification point**. The runner may proceed to that point but must not present the intermediate result as green. Unexpected red stops at the retry limit. Do not silently weaken tests or broaden scope to make the run pass.

A shared-library prerelease may be published to Nexus by an existing TeamCity job when the approved task calls for it. How the version is chosen is part of the approved plan. That is not permission to publish a production release.

### E2E, AI review, human gates

Full E2E is a deliberate TeamCity API trigger after all required PR builds are green or an explicitly approved coupled verification point has been reached. Pass each participating repository's exact goal branch; use base branches only where the approved plan says so. E2E evidence is valid only for the recorded repository head SHAs. Any later change to a participating branch invalidates it.

After green E2E, start an **independent fresh Codex review** of the combined change. Fix material findings, rerun affected CI and E2E, then review again, with a maximum of 2 review/fix cycles before human direction. Produce a concise QA handover with PR links, changed behaviour, tests run, known limitations and unresolved risks.

Janus stops for human PR review and QA. A human pastes review comments into the Review feedback section of `JANUS.md` and invokes `run` to start another bounded fix/verify/review pass; the runner moves consumed feedback into Decisions. Janus must **never** interpret silence, a green build or an AI review as human approval. Human operators merge PRs in the approved dependency order and run the existing release process. Completion is recorded only after checking actual merged PRs and release handover; a failed or unobserved release remains an explicit follow-up rather than falsely "done".

## 7. Human intervention

Stop and preserve a handover when:

- The plan has not been explicitly approved or its approved content has changed.
- The task needs a new architectural decision, repository, dependency order or scope.
- Three code-fix attempts or two final review cycles have been exhausted.
- An unexpected baseline failure or a non-recoverable infrastructure failure appears.
- A Git branch has unexpected remote changes, an unrecognized dirty tree, a ref moved by the agent, or an unresolved merge conflict.
- A required TeamCity or Bitbucket capability is unavailable.
- Human PR review, QA or merge is required.

The handover states **what passed, what failed, the exact build/commit/PR links, what was attempted, and the next human decision**. The human edits the draft plan and re-approves if scope/order changes, or fixes an environmental issue and invokes `run` again. No automatic rewriting of an approved plan.

## 8. Crash recovery and checkpoints

- Before launching Codex or a CI wait, checkpoint `in_flight` with task, repo, starting SHA and intended operation.
- On restart, compare `JANUS.md`, local and remote branch heads, PR state and TeamCity builds. An already-pushed commit or completed build must not be duplicated merely because Janus crashed before updating Markdown.
- If an agent was interrupted with a recognized uncommitted diff, preserve it as `.janus-interrupted.patch` and resume with a fresh agent instructed to inspect the diff. Do not silently discard changes. If ownership of the dirty tree is unclear, stop for a human.
- Always tie green evidence to exact commit SHA(s). Checkpoint at least after a push, a CI outcome, a completed task and entry into a human gate.
- Only one runner process may operate on a goal at a time; use a local process lock. Do not force-push, reset unknown work or auto-resolve unexpected remote branch divergence.
- After a checkpoint, push the control repo. If the control push fails, stop before moving to the next task.

A new machine can resume by cloning the control repo and the product repositories into it and running `python janus.py run`, provided credentials and access are configured.

## 9. Security and control boundaries

**Prompt instructions are not security boundaries.** Janus runs inside an established sandbox that can reach only Bitbucket, the LLM endpoint, TeamCity and Nexus. That environment, not Janus, isolates the agent. Within it the enforceable controls are:

- Codex runs with full access to the workspace. Only the runner performs product Git commit/push and calls TeamCity/Bitbucket write APIs. The runner records all branch heads before each Codex run and stops if any ref moved afterwards.
- Do not provide Bitbucket admin or TeamCity release tokens to the sandbox at all. Bitbucket branch restrictions and mandatory human review protect merge. Production release/deploy permissions remain outside Janus.
- CI provides independent test evidence. Simple deterministic diff checks run before every runner commit; independent AI and humans inspect semantic changes.
- Secrets are supplied through the runner's environment. Redact credentials and sensitive query parameters from the CI excerpts given to Codex or committed to the control repo. Never place secrets in prompts.
- Do not claim that a scripted path check proves tests were not weakened; this requires review as well.

## 10. Implementation guidance

Implement `janus.py` as a straightforward procedural script with small functions, not framework classes:

```text
load_goal / save_checkpoint / verify_plan_approval
discover_repos / run_codex / record_heads / check_heads_unchanged
run_checks / diff_guardrails / git_commit_push / ensure_pr
find_or_trigger_build / wait_and_summarize_build
trigger_full_e2e / run_review / show_status
```

Use `subprocess` for Codex and Git, `urllib.request` for the existing TeamCity and Bitbucket Server REST endpoints, `hashlib` for plan integrity, and `fcntl` for single-run protection. `PyYAML` parses and rewrites the front matter; preserve the Markdown body byte for byte and keep progress readable. Handle HTTP pagination/timeouts narrowly where those APIs actually require it. Do not introduce abstractions before there are two real implementations needing one.

Codex is invoked as `codex exec` with the user's existing Codex configuration and one small shared JSON output schema: summary, files touched, values for later tasks, blockers, proposed next action. During `plan` the same schema carries the proposed front matter configuration and plan text.

**Tests.** pytest, in a `tests/` folder next to `janus.py`. Git behaviour is tested against temporary repositories with a local bare remote. TeamCity and Bitbucket are tested against a small `http.server` stub started per test that serves canned responses for exactly the endpoints Janus calls. Codex is tested by substituting a fake `codex` executable on `PATH` that returns scripted JSON. No persisted fakes, no provider interfaces.

**Slices.** Start with **one repository and the local checks loop**, tried here on a throwaway Angular app with a local bare remote; then add Bitbucket/TeamCity against the stub; then a second repo with an explicit coupled verification point; then E2E and prerelease steps. The same script and file format must survive all four slices.

Janus 2.x remains in this repository's history (last commit `8bf3f0f`) as a reference for edge cases in policy checks, redaction and the Codex adapter. Nothing is ported.

## 11. Acceptance criteria

1. A human writes only a Goal paragraph, runs `plan` in a folder of repositories, edits the draft and explicitly `approve`s it.
2. `run` cannot execute a changed or unapproved plan.
3. Codex implements one approved task; Janus commits/pushes, opens a PR and verifies the exact SHA in TeamCity.
4. A red build starts fresh bounded fix attempts; green records evidence and advances; exhausted retries stop with useful handover.
5. A simulated process crash after push and during CI wait resumes without duplicated commits or false green status.
6. Two repositories run in the approved order; an explicit coupled verification point does not masquerade as a green individual build.
7. Full E2E runs through TeamCity API with correct branch parameters and is invalidated by subsequent changes.
8. A fresh AI review and existing human PR review/QA occur before human merge. Janus never auto-merges or triggers a production release.
9. An agent cannot modify Janus approval/state; unexpected Git ref mutations are detected and stop the run.
10. The tracked Janus artifact for one goal remains `JANUS.md`; the implementation remains one small `janus.py` plus its tests, without a framework of additional state or provider files.
11. The same runner and file format work for a different Angular major without code changes.

## 12. Deliberate trade-off

Janus 3.0 is a **small controlled runner, not a mathematically complete workflow engine**. It handles the common path, reliable resume and explicit handoffs. Unusual integration, environment or release situations go to a human rather than becoming more engine features. Add complexity only after a real goal demonstrates that this smaller design cannot safely handle it.
