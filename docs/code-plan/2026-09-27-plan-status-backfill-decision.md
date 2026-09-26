---
schema: ultra-plan/v1
plan_id: 2026-09-27-plan-status-backfill-decision
status: Complete
version: 1
created: 2026-09-27
---

# Decision Record — the Explicitly-`Draft` Plans

## What this is

Task T6 of [[plan]] — the decision on the plans that declare `status: Draft` in
their own frontmatter, as opposed to the much larger group whose mirror reads
`Draft` only because the publisher fell back to it.

Measured 2026-09-27 by `bun scripts/plan-lifecycle-audit.mjs`:

| Group | Count | Nature |
|---|---|---|
| Untracked — no frontmatter at all | 227 | `status: Draft` is a **publisher default**, not a claim. Left untouched. |
| Tracked, frontmatter but no `status:` | 0 | — |
| Tracked and explicitly `Draft` | **10** | A real claim. This record decides them. |

The 227 are excluded deliberately. Their `Draft` says nothing about the work, so
any status assigned to them would be invented rather than measured. That is a
separate piece of work, and it is not this one.

## The evidence, and why it was not enough

Every one of the 8 Snipset plans below has a commit touching its plan file whose
subject is an implementation commit — `fix(...)` or `feat(...)`. That looks like
evidence of completion and is not. A commit that touches a plan file records that
the file changed; it does not record that every acceptance criterion in the plan
was met. Two of them have partially ticked checklists (3 of 32 and 5 of 36),
which proves work started and proves nothing about whether it finished.

| Plan | Ticked / total steps | Last commit touching the plan file |
|---|---|---|
| `2026-09-21-bundled-cli-delivery-plan` | 3 / 32 | `fix(desktop): bundle CLI in Windows installer` |
| `2026-09-21-mouse-operator` | 5 / 36 | `docs: record mouse operator plan, design` |
| `2026-09-20-mobile-overlap-text-audit` | 0 / 39 | `fix(website): guard navbar CTA nowrap` |
| `2026-09-21-website-telegram-monitoring` | 0 / 54 | `style(website): format monitoring plan` |
| `2026-09-26-linux-webkitgtk-empty-voice-catalog` | 0 / 29 | `fix(speech): keep the voice profile selected` |
| `2026-09-26-linux-youtube-player-error-pomodoro` | 0 / 36 | `fix(pomodoro): map every youtube error code` |
| `2026-09-26-speech-engine-branch-and-linux-ggml-baseline` | 0 / 28 | `fix(speech): audition the local engine` |
| `2026-09-26-youtube-native-audio-linux` | 0 / 46 | `feat(pomodoro): play YouTube audio natively` |

## Decision

Put to the user as one question, on 2026-09-27, with the evidence above.

| # | Plan | Decision | Reason |
|---|---|---|---|
| 1 | `2026-09-21-bundled-cli-delivery-plan` | **leave `Draft`** | inconclusive — needs a human read of the plan against its acceptance criteria |
| 2 | `2026-09-21-mouse-operator` | **leave `Draft`** | inconclusive — same |
| 3 | `2026-09-20-mobile-overlap-text-audit` | **leave `Draft`** | inconclusive — same |
| 4 | `2026-09-21-website-telegram-monitoring` | **leave `Draft`** | inconclusive — same |
| 5 | `2026-09-26-linux-webkitgtk-empty-voice-catalog` | **leave `Draft`** | inconclusive — same |
| 6 | `2026-09-26-linux-youtube-player-error-pomodoro` | **leave `Draft`** | inconclusive — same |
| 7 | `2026-09-26-speech-engine-branch-and-linux-ggml-baseline` | **leave `Draft`** | inconclusive — same |
| 8 | `2026-09-26-youtube-native-audio-linux` | **leave `Draft`** | inconclusive — same |
| 9 | `2026-09-27-plan-finish-sync-to-obsidian` | **`Complete`** | the work is finished and independently verifiable: commits `e15b27b`, `3c28ae3`, `e0063f7`, `e280208`; gate proven to exit 3 on a stale mirror and 0 after republishing; `bun run ci` green |
| 10 | `2026-09-27-post-execution-vault-sync` | **leave `Draft`** | this is the plan doing the work; it is closed only once its own tasks are |

So: **one** status changed, and it changed because the evidence for that one is
strong. The eight inconclusive plans are recorded as inconclusive rather than
rounded to a status. That is the whole point of this record — a backfill that
guessed would have produced eight false claims and looked finished.

## What this record deliberately does not do

- It does not mark any Snipset plan `Complete`. A user decision, not a script's.
- It does not add frontmatter to the 227 untracked plans.
- It does not touch the checklists of any plan. Ticking belongs to
  `plan-mark-done`, applied from a runner log.

## Re-measure before trusting these numbers

The counts in this record were true on 2026-09-27 and will drift, because every
plan published at `Draft` joins that row — including this one, and including the
two plans published on the day this work started. Run:

```bash
bun scripts/plan-lifecycle-audit.mjs
```

It always exits 0 and asserts no expected count, precisely so that a drifting
number is reported rather than enforced.
