# Subagent Task Contract: [Subagent Role / Task Name]

> Use this template to define an isolated workstream before delegating to a child or sibling subagent.
> Enforces explicit boundaries, strict non-overlapping file scopes, and parent verification gates.

## 1. Delegation Metadata
- **Task ID:** [e.g. task-auth-service-01]
- **Subagent Role:** [e.g. Database Migrator / Component Refactorer]
- **Parent Goal:** [Link to active plan and parent milestone]
- **Delegation Mode:** `share` | `branch` | `isolated-files`

## 1b. Task Chunking & Fan-Out Plan (written before dispatch)
The parent chunks the work into the smallest independently verifiable units, then assigns one unit per subagent. Target 10+ narrow subagents when the task supports it.

| Chunk ID | Single-purpose scope | Owner subagent | Permitted target files | Expected output | Verification command |
|---|---|---|---|---|---|
| C1 | [one behavior / one file] | [role] | `path` | [artifact] | `cmd` |
| C2 | [...] | [...] | `path` | [...] | `cmd` |
| CN | [...] | [...] | `path` | [...] | `cmd` |

- **Fan-out count:** [N] subagents (below the 10 floor? state the reason: atomic task, no subagent tool in this runtime, or inseparable shared state)
- **Chunk boundary check:** [ ] every chunk has exactly one owner, [ ] every planned unit is covered, [ ] no two chunks write the same file
- **Re-dispatch rule:** a red chunk is re-chunked and re-dispatched alone, never by restarting the whole batch

```mermaid
flowchart LR
    Plan["Approved task"] --> Chunk["Chunk into smallest\nverifiable units"]
    Chunk --> Fan["Dispatch N narrow subagents\ndisjoint targets"]
    Fan --> Gather["Gather all reports\nat review checkpoint"]
    Gather --> Synth["Synthesize: dedupe,\nresolve, verify"]
    Synth --> Audit["Parent diff audit gate"]
    Audit -->|"Green"| Merge["Merged result"]
    Audit -->|"Red"| Redo["Re-chunk that scope\nand re-dispatch"]
    Redo --> Fan
```

## 2. Delegation & Audit Lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor Parent as Parent Agent
    participant Sub as Subagent
    participant Repo as Repository Files
    participant Test as Test Runner

    Parent->>Sub: Issue Task Contract (Scope, Targets, Tests)
    Sub->>Repo: Apply scoped modifications
    Sub->>Test: Run isolated module tests
    Test-->>Sub: Tests pass (Exit 0)
    Sub-->>Parent: Report completion + diff summary
    Note over Parent: Parent Diff Audit Gate (Never trust blindly)
    Parent->>Repo: Inspect git diff against allowed target files
    Parent->>Test: Run parent regression test suite
    Parent->>Parent: Verify exit 0 & integrate into plan state
```

## 3. Strict Scope & File Boundaries
- **Permitted Target Files:**
  - `path/to/specific/file.ts`
  - `path/to/specific/file.test.ts`
- **Strictly Prohibited Files:**
  - Any files outside the permitted list above
  - Shared lockfiles, environment configuration, or deployment scripts

## 4. Input Preconditions & Invariants
- [Precondition 1: e.g. Base interfaces already committed on branch]
- [Invariant 1: e.g. Do not change existing public function signatures]

## 5. Required Implementation & Tests
- **Target Behavior:** [Describe the exact capability or fix to implement]
- **Failing Test (RED):**
  - Command: `[command]`
  - Expected Error: [Expected failure message prior to implementation]
- **Passing Verification (GREEN):**
  - Command: `[command]`
  - Expected Output: Exit 0, 0 failures

## 6. Gather & Synthesize Checkpoint (parent side)
- [ ] All subagent reports collected at the review checkpoint; none skipped, none pasted raw as the result.
- [ ] Duplicate and restated findings removed.
- [ ] Conflicting claims between overlapping reports resolved from the evidence, not by picking the newest report.
- [ ] Each subagent's success claim re-verified by the parent (diff, log, exit status).
- [ ] Only new findings, blockers, and evidence merged into the parent task state.

## 7. Parent Diff Audit Gate Checklist
- [ ] Subagent modified ONLY the permitted target files.
- [ ] No extraneous refactoring or whitespace reformatting in adjacent lines.
- [ ] No hardcoded secrets, temporary scratch files, or mock outputs left behind.
- [ ] Targeted tests executed fresh by parent and exited 0.
- [ ] Output integrated into parent task state log.
