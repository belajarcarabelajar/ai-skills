# Pull Request: [Imperative title, matching the codebase's language]

> One PR per **session**, never one per subagent. Twenty subagents inside one
> session produce one PR. Twenty sessions produce twenty PRs.
>
> The branch and worktree are **derived, not chosen**:
> `bun scripts/pr-registry.mjs claim --plan <plan-id> --session <slug>` prints
> both. Copy them from that output. A hand-written branch name is how two panes
> end up pushing to the same ref.

## 1. Delivery Metadata

| Field | Value |
|---|---|
| Session slot | `[session slug from pr-registry claim]` |
| Plan | `[docs/code-plan/plans/YYYY-MM-DD-<name>.md]` |
| Base branch | `main` |
| Head branch | `ai/<plan-id>/<session-slug>` |
| Worktree | `[path printed by pr-registry claim]` |
| Type of change | feature / bug fix / breaking / refactor / docs / test / chore |
| Reviewer | `[who, or "none requested"]` |

## 2. What This Changes

[One paragraph. What is different after this merges. Not a list of files: the
file list is already in the diff, and repeating it makes the reviewer read it
twice.]

**Non-goals:** [what this deliberately does not do, so a reviewer does not
audit for something that was never claimed]

## 3. Acceptance Criteria

| ID | Criterion | Task | Check | Evidence |
|---|---|---|---|---|
| AC-1 | [observable condition] | T1 | `[command]` | exit 0, [n] passed |

A row with no evidence is not done. "Tests pass" is not evidence; the command
and its exit code are.

## 4. Local Verification Evidence

> These runs happened **in the session that produced the change**, on the
> machine holding the working tree. No hosted runner was asked to verify
> anything, and no commit was pushed in order to make someone else's CI run.

| Gate | Command | Exit | Result |
|---|---|---|---|
| Focused tests | `[bun test path/to/file.test.ts]` | 0 | [n passed, 0 failed] |
| Lint | `[bun run lint]` | 0 | 0 errors, 0 warnings |
| Type check | `[bun run typecheck]` | 0 | 0 errors |
| Build | `[bun run build]` | 0 | completed |

Pre-existing warnings outside the changed surface are reported in section 7,
not carried as part of this PR.

## 5. Independent Review

- [ ] A reviewer that did not produce the work read the diff, or a documented
      self-review exists and says so. The work never grades itself silently.
- [ ] The parent diff audit ran: `git diff` inspected, targeted tests re-run in
      the parent, every subagent success claim re-verified rather than trusted.
- [ ] Every finding that met the 8-point qualification filter is either fixed in
      this PR or listed in section 7. A finding is never closed verbally.

**Reviewer verdict:** `correct` | `not correct`. [One to three sentences of
justification, plus the conditions that would change it]

## 6. Risk, Rollout, Rollback

| Concern | Answer |
|---|---|
| Blast radius | [which surfaces can break if this is wrong] |
| Rollout | [default / flag / staged; state it when not the default] |
| Health signal | [what proves this is healthy in use, not just in tests] |
| Rollback | [the exact revert, and who can run it] |
| Compatibility | [consumers affected, versioning or migration decision] |

`N/A` with a reason is a valid answer. A blank cell is not.

## 7. Pre-Existing Issues and Deferred Debt

Observed while working, deliberately not fixed here. Each is a debt item, so
each carries a ceiling and a trigger.

- `[path:line]` [issue]. `defer: <ceiling>, <upgrade-trigger>`

## 8. Checklist

- [ ] Branch and worktree came from `pr-registry claim`, not from memory.
- [ ] Nothing was committed directly to the base branch.
- [ ] Title is imperative and the body is in the codebase's language, not the
      language the request arrived in.
- [ ] No em dash in this body, the commit messages, or any user-visible string
      in the diff.
- [ ] No secrets, tokens, `.env` content, or unrelated cleanup in the diff.
- [ ] Every acceptance criterion maps to a check and to evidence.
- [ ] PR body written to a file and posted with `--body-file`, never `--body`.
- [ ] Registered in the registry: `bun scripts/pr-registry.mjs pr <session> --number <N>`.

```mermaid
flowchart TD
    accTitle: Session delivery into a pull request
    accDescr: A session claims a derived branch and worktree, subagents write only inside that worktree, the parent runs local verification and the diff audit, the pull request is opened from a body file, and the number is recorded in the registry so the merge order stays computable.
    Start(["Session approved"]) --> Claim["pr-registry claim<br/>branch + worktree derived"]
    Claim --> Worktree["git worktree add<br/>from origin/main"]
    Worktree --> Fan["Subagents write<br/>inside the worktree only"]
    Fan --> Verify["Local verification<br/>zero-tolerance clean pass"]
    Verify --> Audit{"Parent diff audit"}
    Audit -->|"Red"| Fix["Re-chunk and re-dispatch<br/>only the failing scope"]
    Fix --> Verify
    Audit -->|"Green"| Body["Write PR body to a file<br/>follow the PR template"]
    Body --> Push["Commit and push<br/>the session branch"]
    Push --> Open["gh pr create --body-file<br/>never --body"]
    Open --> Record["pr-registry pr<br/>record the number"]
    Record --> Sweep(["Step 6 debt sweep<br/>then the batch merge stage"])
```
