# Batch Manifest — 2026-09-30-skipif-unknown-class

> Written before the first dispatch, per the mandatory BATCH MANIFEST rule. Every planned unit is covered, every chunk has exactly one owner, and no two chunks write the same file.

## 0. Orchestration Amendment (deviation from the plan, deliberate)

The plan's per-task Step lists end in "Commit". **Subagents do not commit.** Chunks touching `scripts/ultra-plan-runner.mjs` are strictly sequential (T2 → T4 → T5), so an index-lock race is unlikely — but committing still moves to the parent, batched after the diff audit, so the gate is one decision rather than seven. Everything else stands, including RED-before-GREEN.

## 1. Chunk Table

| Chunk | Scope | Owner | Permitted target files (ai-skills) | Expected output | Verification command |
|---|---|---|---|---|---|
| T1 | Freeze the spike's classifier snapshot | Spike Freezer | `scripts/spike-skipif-classifier.mjs` (new), `scripts/spike-skipif-classifier.test.mjs` (new), `scripts/spike-skipif-corpus.mjs`, `scripts/spike-skipif-probe.mjs`, `scripts/spike-skipif-corpus.test.mjs`, `scripts/spike-skipif-probe.test.mjs` | Snapshot module + all spike imports repointed, 296+ tests green | `bun test scripts/` |
| T2 | `classifySkipIf` gains sentinel + unknown | Classifier | `scripts/ultra-plan-runner.mjs`, `scripts/ultra-plan-runner.test.mjs` | 5 named classes, fallthrough deleted | `bun test scripts/ultra-plan-runner.test.mjs` |
| T3 | Registry audit CLI | Auditor | `scripts/skipif-registry-audit.mjs` (new), `scripts/skipif-registry-audit.test.mjs` (new) | Audit reproducing plan §2 counts | `bun test scripts/skipif-registry-audit.test.mjs` |
| T4 | `validatePlan` warns on unknown | Validator | `scripts/ultra-plan-runner.mjs`, `scripts/ultra-plan-runner.test.mjs` | WARN per unknown, no new error | `bun test scripts/ultra-plan-runner.test.mjs` |
| T5 | grep-family probes are loose | Classifier | `scripts/ultra-plan-runner.mjs`, `scripts/ultra-plan-runner.test.mjs` | 30 rows flip to loose, regression-locked | `bun test scripts/ultra-plan-runner.test.mjs` |
| T6 | Prose, snippet, report, F5 row | Docs | `Super Ultra Code Plan Implementation.md`, `snippets/orkestrasi-ngoding-plan.md`, `docs/code-plan/spikes/2026-09-30-jev-decision-gate-spike-report.md`, `docs/code-plan/plans/2026-09-30-jev-decision-gate-spike.md` | 4 classes documented; spike numbers untouched | `bun scripts/check-runner-contract.mjs` |
| T7 | Full gate | Parent (inline, documented) | none | `bun run ci` green, tree clean | `bun run ci` |

- **Fan-out count:** the 10-subagent floor is **not** met, and the plan's own DAG explains why. T2, T4, T5 are three edits to the same two files with a strict serial dependency — dispatching them in parallel would be three writers on one file, which the parent diff audit exists to prevent. T1 and T3 are the only independent units. This is a small, tightly-coupled change to one function; the skill's own size rule treats it as bounded work, and the parent's inline role on T1/T2/T4/T5 is stated rather than disguised.
- **Chunk boundary check:** [x] every chunk has exactly one owner · [x] all 7 planned units covered · [x] no two concurrent chunks write the same file — T2/T4/T5 share `ultra-plan-runner.mjs` and are therefore serial, not parallel; T1 and T3 touch disjoint files; T6 is the only writer of the master file, the snippet, the spike report, and the F5 row.
- **Re-dispatch rule:** a red chunk is re-chunked and re-dispatched alone. The batch is never restarted for one failure.

## 2. Dispatch Waves (bounded by the plan's own machine-checked DAG)

| Wave | Chunks | Gate to enter | State |
|---|---|---|---|
| 1 | T1 | none — the freeze must land before the classifier moves | queued |
| 2 | T2 | needs T1 | queued |
| 3 | T3 | needs T2 | queued |
| 4 | T4 | needs T2 | queued |
| 5 | T5 | needs T3 + T4 | queued |
| 6 | T6 | needs T5 | queued |
| 7 | T7 | needs T6 | queued |

## 3. Invariants Every Subagent Receives

1. Runtime is **Bun**. Never `npm`, `npx`, `yarn`, `pnpm`, or bare `node <file>`.
2. Do **not** run `git add`, `git commit`, or `git push`. The parent commits.
3. Do **not** use `sed -i` or `>` output redirection. Use the `edit` and `write` tools, and `cmd 2>&1 | tail -n N` for command output.
4. Stay inside the permitted target file list. Touching anything else is a failed chunk.
5. TDD is mandatory: the failing test run is captured in the report **before** the implementation exists, and it must fail for the reason the GREEN step fixes.
6. **The measured numbers in plan §2 are the acceptance target, not a suggestion.** If a task's work does not reproduce them, stop and report; do not adjust the plan to fit the code.
7. **`unknown` warns, never errors.** 14 tasks in 7 plans stay runnable.
8. **The spike's 0.995 / ECE 0.011 / $0.004129 are never edited.** Append a dated amendment; never rewrite a measured number.
