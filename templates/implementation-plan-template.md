---
schema: ultra-plan/v1
plan_id: YYYY-MM-DD-<feature-name>
status: Draft            # Draft|Approved|InProgress|Verification|Complete|Blocked
version: 1
runner_contract: true
defaults:
  retry_transient_max: 1            # explicit integer, never the word "bounded"
  step_timeout_s: 120               # per-step hang guardrail
  on_precondition_fail: stop-task-continue-independent
tasks:
  - id: T1
    depends_on: []                  # DAG edges — machine-parseable, must match Mermaid
    files: { create: [path/to/file1.ts], modify: [], test: [path/to/file1.test.ts] }
    idempotency_key: "T1:path/to/file1.ts"
    skip_if: "bun test path/to/file1.test.ts"   # exit 0 = already done → SKIPPED-IDEMPOTENT
    verify_exit: 0
    run:                             # the steps the runner executes; omit only for
      - cmd: "bun test path/to/file1.test.ts"  # work with no shell command (see below)
        expect_exit: 1               # RED: the failing test, before any implementation
        retry: 0
      - cmd: "bun test path/to/file1.test.ts"
        expect_exit: 0               # GREEN: passes, 0 failures
        retry: 1
  - id: T2
    depends_on: [T1]
    files: { create: [path/to/file2.ts], modify: [], test: [path/to/file2.test.ts] }
    idempotency_key: "T2:path/to/file2.ts"
    skip_if: "bun test path/to/file2.test.ts"
    verify_exit: 0
    run:
      - cmd: "bun test path/to/file2.test.ts"
        expect_exit: 1
        retry: 0
      - cmd: "bun test path/to/file2.test.ts"
        expect_exit: 0
        retry: 1
---

# [Feature Name] Implementation Plan

> The YAML frontmatter above is the single source of truth for routing, dependency order, retry, and idempotency. Prose and checklists below only explain and must never contradict it. Every `Task N` heading, its `tasks[].id`, and its Mermaid node id must be the same identifier; a mismatch is a pre-execution blocker. Commands stay tool-agnostic and directly runnable (no MCP/rtk required to execute this plan).
>
> **`run[]` is what the runner executes.** A task carrying `run[]` is machine-runnable: `bun scripts/ultra-plan-runner.mjs <plan.md> --execute` runs each `cmd` in order, compares the exit code to `expect_exit`, retries up to `retry` times, and reports `PASSED` / `FAILED-BLOCKING` / `FAILED-ISOLATED`. Without `run[]` the runner reports `NEEDS-AGENT` and the agent runs the prose steps itself, which is correct for work with no shell command (writing prose, choosing a layout, settling a design question) — but that task must still declare `skip_if`, or it is invisible to the runner and exempt from every gate.
>
> **A `skip_if` that only proves a string is present is not an idempotency proof.** `grep -q 'Marker' src/x.md` stays true after the string moves into a comment, and `plan-mark-done.mjs` will tick the task off it. Prefer a command that fails on behaviour: a test invocation, a build, a `git diff` query, or a state check. A `grep` that filters the output of a tool (`bun test x 2>&1 | grep -q ...`) is fine — the tool has to succeed first.

## 1. Intent & Scope
- **Goal:** [Concise description of target capability or fix]
- **Non-Goals:** [Explicit boundaries of what is out of scope]
- **Acceptance Criteria:**
  - [ ] AC-1: [Criterion 1 — observable, testable]
  - [ ] AC-2: [Criterion 2]
  - [ ] AC-3: [Criterion 3]

## 2. Visual Implementation Map — MANDATORY (approval gate blocker if missing)
> Every plan MUST include at least one valid Mermaid diagram. Minimum: a `flowchart` showing every task node, every `depends_on` edge, the approval gate, and the Verify → Completion tail. Add a second diagram (`sequenceDiagram` for interactions, `stateDiagram-v2` for lifecycle, `erDiagram` for data) when it clarifies the design. Node ids must be identical to `tasks[].id` in frontmatter and to the `Task <id>` headings in §4. Edge direction is `A --> B` meaning B depends on A. Every diagram MUST carry `accTitle` and `accDescr`. Validate with `bun scripts/validate-skill.mjs` (syntax + accessibility) and `bun scripts/ultra-plan-runner.mjs <plan.md>` (id and edge consistency, both directions) before requesting approval.
```mermaid
flowchart TD
    accTitle: Implementation plan visual map
    accDescr: Task T1 and task T2 form the dependency chain, followed by a human approval gate, integration verification, and completion sign-off.
    T1["T1: [Component A]"] --> T2["T2: [Component B]"]
    T2 --> Gate{{"Human Approval Gate"}}
    Gate --> Verify["Verify: Integration Verification"]
    Verify --> Finish["Completion & Sign-off"]
```
> Node ids (`T1`, `T2`, ...) must match `tasks[].id` in frontmatter and the task headings below. Every `depends_on` edge in frontmatter must appear as an arrow here, and every arrow between two task nodes must be declared in `depends_on`. The runner enforces both directions and rejects transitive-only reachability.

## 3. Global Constraints
- Non-negotiable constraints, safety rules, and platform compatibility requirements.
- Dependency constraints (e.g. no new external runtime packages unless approved).
- Performance and memory limits.

## 4. Work Breakdown & Task Checklist

### Task T1: [Component Name]
- **Interfaces:**
  - Consumes: [exact signatures from earlier tasks, or `none`]
  - Produces: [exact names/types consumed by later tasks]
- **Preconditions (assert FIRST; fail-fast, never improvise a substitute):**
  - [ ] Dependency: `<cmd> --version` exits 0 (else abort: `E_PRECOND_DEP`)
  - [ ] Input contract: <VAR> defined and satisfies <constraint> (else abort: `E_PRECOND_INPUT`)
  - On failure: STOP this task, do NOT guess a substitute, record to §6 Error Ledger, continue only tasks independent of T1.
- **Idempotency Check (BEFORE Step 1):**
  - [ ] Skip when `skip_if` (frontmatter) exits 0 → mark `SKIPPED-IDEMPOTENT`. A checked box alone never justifies a skip.
- [ ] **Step 1 — Failing Test (RED):** cmd: `bun test path/to/file1.test.ts` | expect: exit non-zero for the right reason | retry: 0
- [ ] **Step 2 — Implementation (GREEN):** minimal code to pass the test
- [ ] **Step 3 — Verify:** cmd: `bun test path/to/file1.test.ts` | expect: exit 0, 0 failures | retry: 1 (transient only) | on_fail: mark FAILED, write §6, halt only downstream (`depends_on` includes T1), keep independent tasks running
- [ ] **Step 4 — Commit:** `git add <files> && git commit -m "feat: ..."`

> Steps 1 and 3 are the same commands as T1's `run[]` in the frontmatter. The frontmatter is the copy the runner executes; this checklist is the copy a human reads. When they disagree, the frontmatter wins and the checklist is the defect.

### Task T2: [Component Name]
- **Interfaces:**
  - Consumes: [outputs of T1]
  - Produces: [exact names/types]
- **Preconditions (assert FIRST; fail-fast):**
  - [ ] Upstream: artifact from T1 exists at `path/to/file1.ts` (else abort: `E_PRECOND_UPSTREAM`)
  - On failure: STOP, record to §6, continue only tasks independent of T2.
- **Idempotency Check (BEFORE Step 1):**
  - [ ] Skip when `skip_if` exits 0 → `SKIPPED-IDEMPOTENT`.
- [ ] **Step 1 — Failing Test (RED):** cmd: `bun test path/to/file2.test.ts` | expect: exit non-zero | retry: 0
- [ ] **Step 2 — Implementation (GREEN):** minimal code to pass
- [ ] **Step 3 — Verify:** cmd: `bun test path/to/file2.test.ts` | expect: exit 0, 0 failures | retry: 1 (transient only) | on_fail: mark FAILED, write §6, halt downstream, keep independent running
- [ ] **Step 4 — Commit:** `git add <files> && git commit -m "feat: ..."`

## 5. Verification Matrix Before Completion
| Check | Command | Exit Code | Fresh Evidence | Status |
|---|---|---|---|---|
| Unit Tests | `bun test` | 0 | 0 failures | Pending |
| Type Check | `bun run typecheck` | 0 | 0 errors | Pending |
| Lint Check | `bun run lint` | 0 | 0 warnings | Pending |
| Build Check | `bun run build` | 0 | Build succeeded | Pending |

## 6. Error Ledger (aggregated at end; independent tasks not halted)
| Task | Step | Classification | Exit | Root cause | Retry used | Fallback | Status |
|---|---|---|---|---|---|---|---|
| [T?] | [n] | [environment] | [1] | [cause] | [0/1] | [none] | `FAILED-ISOLATED` |

- Classification: `code` | `test` | `contract` | `environment` | `infrastructure` | `pre-existing`.
- Status: `FAILED-ISOLATED` | `FAILED-BLOCKING` | `RESOLVED` | `DEFERRED`.

## 7. Human Approval Gate
- [ ] Partner / Human approval received for this plan before implementation begins.

## 8. Session-Close Debt Sweep & Follow-Up Backlog
> Runs when every task above is `Done 100%`. Filled with `templates/follow-up-injection-template.md`.

| # | Follow-up (outcome + path + finish line) | Class | `defer: <ceiling>, <upgrade-trigger>` | Status |
|---|---|---|---|---|
| F1 | | `NOW` / `LATER` | | `OPEN` / `DONE` / `DEFERRED` |

- [ ] 3-5 ranked follow-ups injected as one multi-select question (checkboxes) after the final recap.
- [ ] Every selected follow-up executed through the full pipeline with fresh evidence.
- [ ] Declined and out-of-cap items written here so no debt leaves the session unrecorded.

