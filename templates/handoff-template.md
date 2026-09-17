# Session Handoff Document

> Fill this out at the END of every session before context runs out.
> Resume the next session by reading this file FIRST before doing anything else.

---

## Identity

- **Task / Goal:** [One sentence — what is this task trying to achieve?]
- **Plan file:** [Path to implementation plan, e.g. `docs/plans/feat-rate-limit.md`]
- **Repo / branch:** [e.g. `~/projects/myapp` on branch `feat/rate-limit`]
- **Skill active:** `super-ultra-code-plan`
- **Handoff written at:** [ISO timestamp, e.g. 2026-09-18T03:00:00+07:00]

---

## Last Verified State

*What was confirmed working at the end of this session — with evidence.*

| Item | Command run | Exit code | Evidence |
|---|---|---|---|
| [e.g. Unit tests] | `rtk bun test src/api/rate-limit.test.ts` | 0 | 5 passed, 0 failed |
| [e.g. Type check] | `bun run typecheck` | 0 | 0 errors |

---

## Completed Steps

- [x] [Step 1 description — what was done and confirmed]
- [x] [Step 2 description]

## Current Position

- **Currently on:** Task N — [Name of the task in progress]
- **Status:** [ACTIVE / PAUSED / BLOCKED]
- **Partial work in progress:** [Describe any half-done state — files open, changes not yet committed, etc.]

## Next Immediate Action

> Exactly what to do in the first 60 seconds of the next session.

```
[Paste the exact command or action to resume, e.g.:
  cd ~/projects/myapp
  git status
  bun test src/api/rate-limit.test.ts
]
```

---

## Open Decisions

*Questions or ambiguities that need resolution before proceeding.*

- [ ] [Decision 1: e.g. "Should rate limit apply per IP or per API key? User hasn't specified."]
- [ ] [Decision 2]

## Blockers

- [Blocker 1: describe what is stuck and what external action unblocks it]
- None (if none)

---

## Key Decisions Made

*Choices made during this session — include rejected alternatives so they don't get re-litigated.*

| Decision | Choice made | Rejected alternatives | Reason |
|---|---|---|---|
| [e.g. Storage for rate limit state] | In-memory Map | Redis, DB | "No persistence needed for MVP scope" |

---

## Files Modified This Session

```
[git diff --stat output or manual list]
M  src/api/rate-limit.ts
A  src/api/rate-limit.test.ts
```

## Git State

- **Last commit:** [hash + message, or "uncommitted — see partial work above"]
- **Working tree clean:** [ ] Yes / [ ] No — [describe any dirty state]

---

## Resume Checklist (for next session)

- [ ] Read this handoff document fully
- [ ] Run `git status` to confirm working tree state
- [ ] Re-read the active plan file
- [ ] Confirm last verified state still holds (re-run key test command above)
- [ ] Continue from "Next Immediate Action" above
