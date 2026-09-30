# Batch Manifest — 2026-09-30-jev-dedupe-corpus-spike

> Written before the first dispatch, per the mandatory BATCH MANIFEST rule.

## 0. Orchestration Amendment (deviation from the plan, deliberate)

The plan's per-task lists end in "Commit". **Subagents do not commit.** Committing moves to the parent, batched after the diff audit.

**A stronger deviation than the sibling plan needed.** The plan predicts `corpus not viable`: T1's balance check is expected to exit 1 because the minority class is empty, and T2 is then `HALTED-UPSTREAM`. Delegating work whose expected outcome is a refusal spends a subagent to watch a script exit non-zero. T1 is therefore **parent-run inline** — it is a count, it is the plan's RED phase, and its output is the finding. T2 is dispatched only if T1 exits 0, which on the 2026-09-30 measurement it will not. T3 is parent-run inline: it is a report, and it runs in every branch including both failure ones.

This is stated rather than disguised. The skill's subagent-first default yields to "work that is a hypothesis test with a predicted negative outcome", because the value is in the measurement being recorded correctly, not in the work being parallelised.

## 1. Chunk Table

| Chunk | Scope | Owner | Permitted target files (ai-skills) | Expected output | Verification command |
|---|---|---|---|---|---|
| T1 | Harvest alternative pairs, refuse a degenerate class | Parent (inline, documented) | `scripts/spike-alt-corpus.mjs` (new), `scripts/spike-alt-corpus.test.mjs` (new), `spike-out/alt-corpus.json` (new, only when non-degenerate) | Exits 1 with `E_PRECOND_IMBALANCE`, printing the class counts | `bun test scripts/spike-alt-corpus.test.mjs` |
| T2 | Two-class probe on the pairs | Conditional — dispatched only if T1 exits 0 | `scripts/spike-alt-probe.mjs`, `scripts/spike-alt-probe.test.mjs`, `spike-out/alt-*.json` | Not reached on 2026-09-30 | `bun test scripts/spike-alt-probe.test.mjs` |
| T3 | Report the verdict | Parent (inline, documented) | `docs/code-plan/spikes/2026-09-30-jev-dedupe-corpus-spike-report.md` (new) | One of the three verdicts, fixed by plan §5 | `bun test scripts/` |

- **Fan-out count:** **0 subagents on the predicted path.** Justified in §0 above, on the record rather than as an afterthought. On the branch where the corpus exists, T2 is dispatched and T3 re-runs.
- **Chunk boundary check:** [x] every chunk has exactly one owner · [x] all 3 planned units covered · [x] no two chunks write the same file.
- **Re-dispatch rule:** a red chunk is re-chunked and re-dispatched alone. The batch is never restarted for one failure.

## 2. Dispatch Waves (bounded by the plan's own machine-checked DAG)

| Wave | Chunks | Gate to enter | Expected state |
|---|---|---|---|
| 1 | T1 | none | exits 1 — this is the plan's RED |
| 2 | T2 | needs T1 to have exited **0** | will not be entered |
| 3 | T3 | needs T1 either way | runs in both branches |

## 3. Invariants Every Subagent Receives

1. Runtime is **Bun**. Never `npm`, `npx`, `yarn`, `pnpm`, or bare `node <file>`.
2. Do **not** run `git add`, `git commit`, or `git push`. The parent commits.
3. Do **not** use `sed -i` or `>` output redirection. Use the `edit` and `write` tools.
4. Stay inside the permitted target file list. Touching anything else is a failed chunk.
5. TDD is mandatory: the failing run is captured before the implementation exists.
6. **The API key is never written anywhere.** It exists only as an inline environment variable on the single command that needs it, and only if T2 is reached. Never into a file, a cassette, a log line, or a commit. The cassette already has a credential-pattern scan; run it and do not assume it.
7. **No synthetic pair counts as evidence.** A paraphrase or restatement of an existing alternative is marked `synthetic: true`, counted separately, and excluded from scoring. If excluding them leaves an empty minority class, the corpus is refused. A corpus padded to look balanced is the exact failure that killed version 1 of the parent spike.
8. **The verdict is fixed by plan §5 before T1 runs** and is not edited afterwards. `corpus not viable` is a success.