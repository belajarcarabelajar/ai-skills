---
schema: ultra-plan/v1
plan_id: 2026-09-27-plan-status-backfill-decision
status: Complete
version: 1
created: 2026-09-27
---

# Decision Record — the Explicitly-`Draft` Plans

> **CLOSED 2026-09-27.** All eight were read against their own acceptance
> criteria with evidence gathered from the repositories. The table below is the
> original T6 decision; the outcome is in §2 at the end. `Draft` went from 8 to 0
> across the tracked plans.

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


## 2. Outcome — all eight assessed, 2026-09-27

Each plan was read in full and every acceptance criterion was checked against
files, tests and git history. Plan prose and progress logs were treated as
claims. Where a criterion needed a real Windows host, a real `yt-dlp` run, or a
live Linux WebKitGTK session, it is recorded as unverified rather than assumed.

| Plan | Was | Now | Why |
|---|---|---|---|
| `2026-09-26-linux-webkitgtk-empty-voice-catalog` | `Draft` | **`Complete`** | All six ACs met and re-verified fresh: 84 voice tests, 158 accessibility tests, `tsc --noEmit`, eslint, prettier, production build — all exit 0. Two independent assessments agreed. |
| `2026-09-26-linux-youtube-player-error-pomodoro` | `Draft` | **`Verification`** | **This one was marked `Complete` first, and that was wrong.** 114 tests pass, but commit `f1c0fb020` added `requiresYoutubeWebview()` afterwards, so on Linux the IFrame path where AC-3's `console.warn(event.data)` lives is never entered. The mapped message survives at `:211` and `:272`; the diagnostic logging does not, and that logging is the plan's purpose. |
| `2026-09-21-bundled-cli-delivery-plan` | `Draft` | `Verification` | AC-1/2/3 all need a Windows host; no `.nsi` exists in the repo. AC-4 met. |
| `2026-09-21-mouse-operator` | `Draft` | `Verification` | The plan's own rule: "Missing native verification keeps final status in Verification or Blocked, never Complete." A later debugging plan found two real defects in the code this one shipped. |
| `2026-09-20-mobile-overlap-text-audit` | `Draft` | `Verification` | AC-4's RCA artifact was never committed — `docs/code-plan/logs/` does not exist — yet the progress log ticks it. |
| `2026-09-21-website-telegram-monitoring` | `Draft` | `Verification` | AC-7 is self-declared BLOCKED pending an owner-supplied non-Cloudflare host. AC-10 is operator prose. |
| `2026-09-26-speech-engine-branch-and-linux-ggml-baseline` | `Draft` | `Verification` | AC-2 has no test at all; AC-6 is unmeetable as written against a recorded `2 failed` contract baseline; the ggml fix is unproven on real hardware. |
| `2026-09-26-youtube-native-audio-linux` | `Draft` | **`Blocked`** | The work was reverted three commits later: `c9dbef41e refactor(pomodoro): drop the yt-dlp resolve path, it never produced a stream`. `Draft` would have read as in-progress, which is the one thing it is not. |

### The lesson, recorded because it nearly went the other way twice

**A green suite proves the code does what the test says. It does not prove the
plan's goal is met.** The youtube-player plan passed 114 tests and was still not
complete, because a later commit moved the code path off the platform the plan
was written for. Reading the acceptance criteria against the repository, not
against the test file, is what caught it — and it took two disagreeing
assessments plus a direct look at `pomodoroMusicPlayer.ts:712` to settle.

The second near-miss was in this record's own §3, where the first draft blamed
`vault_lint --strict` on 1986 broken links. That number came from the linter's
printed summary; the cause was in a gate condition one line away. A plausible
number next to a failing command is not a cause.

### Still outstanding, and not fixed by any status change

- `docs/troubleshooting/youtube-linux-audio.md` still instructs operators to
  install `yt-dlp` for a code path the application no longer calls.
- FU6 on that plan: "confirm the reporter's real error integer; if it is `5` and
  not `153`, this design does not apply". If it is 5, the premise was wrong.
- 227 untracked plans remain in the publisher's fallback bucket, untouched by
  design.
