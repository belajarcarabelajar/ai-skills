# Batch Manifest — 2026-09-26-plan-publish-to-obsidian

> Written before the first dispatch, per the mandatory BATCH MANIFEST rule. Every planned unit in the plan's §4 is covered here, every chunk has exactly one owner, and no two chunks write the same file.

## 0. Orchestration Amendment (deviation from the plan, deliberate)

The plan's per-task Step 5 says "Commit". **Subagents do not commit.** Thirteen concurrent `git add` / `git commit` calls in two repositories would race on `.git/index.lock` and produce lost commits — that is an orchestration defect, not a task detail. Committing moves to the parent, batched per repository after the diff audit gate passes.

Everything else in the plan's per-task step lists stands, including RED-before-GREEN.

## 1. Chunk Table

| Chunk | Single-purpose scope | Owner | Permitted target files (repo) | Expected output | Verification command |
|---|---|---|---|---|---|
| T1 | Registry + project config | Registry Builder | `plans.publish.json`, `scripts/plan-publish-registry.mjs`, `scripts/plan-publish-registry.test.mjs` (ai-skills) | Config file + loader module + passing tests | `bun test scripts/plan-publish-registry.test.mjs` |
| T2 | Frontmatter transform | Transform Engineer | `scripts/plan-publish-frontmatter.mjs`, `scripts/plan-publish-frontmatter.test.mjs` (ai-skills) | Pure merge module + passing tests | `bun test scripts/plan-publish-frontmatter.test.mjs` |
| T3 | CLI orchestrator | CLI Engineer | `scripts/plan-publish.mjs`, `scripts/plan-publish.test.mjs` (ai-skills) | Working CLI + passing tests | `bun test scripts/plan-publish.test.mjs` |
| T4 | Package scripts + README | Docs & Tooling | `package.json`, `README.md` (ai-skills) | 3 npm-style scripts + docs | `bun -e "const p=JSON.parse(await Bun.file('package.json').text());process.exit(p.scripts?.['plans:publish']&&p.scripts?.['plans:check']?0:1)"` |
| T5 | Master skill contract | Skill Author | `Super Ultra Code Plan Implementation.md` (ai-skills) | `## 📤 Plan Publishing` section + Mermaid | `bun -e "process.exit((await Bun.file('Super Ultra Code Plan Implementation.md').text()).includes('Plan Publishing')?0:1)"` |
| T6 | Validator guard | Guard Engineer | `scripts/validate-skill.mjs` (ai-skills) | Contract assertions that hard-fail | `bun scripts/validate-skill.mjs` |
| T7 | Trigger snippet | Snippet Editor | `snippets/orkestrasi-ngoding-plan.md` (ai-skills) | One publish mandate line | `bun -e "process.exit((await Bun.file('snippets/orkestrasi-ngoding-plan.md').text()).includes('plans:publish')?0:1)"` |
| T8 | Vault project indexes | Vault Structurer | `01 - Projects/Snipset/index.md`, `01 - Projects/ram-audit/index.md`, `01 - Projects/ai-skills/index.md` (vault) | 3 hub pages | `bun -e "const fs=require('node:fs');const v='/home/belajarcarabelajar/Dokumen/Obsidian Vault/01 - Projects/';process.exit(['Snipset','ram-audit','ai-skills'].every(n=>fs.existsSync(v+n+'/index.md'))?0:1)"` |
| T9 | Vault mirror contract test | Vault Test Engineer | `tests/test_plan_mirror.py` (vault) | unittest enforcing PARA props + no dangling wikilinks | `cd '/home/belajarcarabelajar/Dokumen/Obsidian Vault' && python3 -m unittest discover -s tests -p 'test_plan_mirror.py'` |
| T10 | Vault schema line | Vault Schema Editor | `AGENTS.md` (vault) | One Folder Contract bullet | `bun -e "process.exit((await Bun.file('/home/belajarcarabelajar/Dokumen/Obsidian Vault/AGENTS.md').text()).includes('plans/')?0:1)"` |
| T11 | Vault operating doc | Vault Docs | `90 - System/Plan-Publishing.md` (vault) | Operating page + hub link | `bun -e "process.exit((await Bun.file('/home/belajarcarabelajar/Dokumen/Obsidian Vault/90 - System/Plan-Publishing.md').text()).includes('plans:publish')?0:1)"` |
| T12 | End-to-end dogfood | Parent (inline, documented) | `01 - Projects/ai-skills/plans/*.md` (vault) | This plan mirrored into the vault | `bun scripts/plan-publish.mjs --check --all` |
| T13 | Snipset database push | Parent (inline, documented) | none (external DB) | Trigger snippet live in Snipset | `bun run snippets:check` |

- **Fan-out count:** 11 subagents for T1–T11, plus 2 parent-run integration chunks (T12, T13). The 10-subagent floor is met. T12 and T13 are integration gates over work that does not exist until the fan-out lands, so they cannot be delegated; the parent runs them inline and says so.
- **Chunk boundary check:** [x] every chunk has exactly one owner · [x] all 13 planned units covered · [x] no two chunks write the same file — T1–T7 split cleanly inside `ai-skills`, T8–T11 inside the vault, T4 is the only writer of `package.json`/`README.md`, T5 the only writer of the master file, T6 the only writer of the validator.
- **Re-dispatch rule:** a red chunk is re-chunked and re-dispatched alone. The batch is never restarted for one failure.

| T14 | Vault hub wiring | Hub Editor | `90 - System/index.md` (vault) | 4 inbound wikilinks | `bun -e "…index.md includes '01 - Projects/ai-skills/index'…"` |

**Added after the parent diff audit of wave 1.** T8 reported that its three index pages have outbound links only, so the vault's "every active page must be reachable from an index or hub" rule is not actually satisfied — the linter would stay green while the vault breaks its own contract. T11 originally owned the hub link, which would have put two chunks on `90 - System/index.md`; that overlap was removed from T11 and T14 now owns the hub alone.

- **Fan-out count:** 12 subagents for T1–T11 and T14, plus 2 parent-run integration chunks (T12, T13). The 10-subagent floor is met. T12 and T13 are integration gates over work that does not exist until the fan-out lands, so they cannot be delegated; the parent runs them inline and says so.
- **Chunk boundary check:** [x] every chunk has exactly one owner · [x] all 14 planned units covered · [x] no two chunks write the same file — T1–T7 split cleanly inside `ai-skills`, T8–T11 and T14 inside the vault, T4 is the only writer of `package.json`/`README.md`, T5 the only writer of the master file, T6 the only writer of the validator, T14 the only writer of `90 - System/index.md`.
- **Re-dispatch rule:** a red chunk is re-chunked and re-dispatched alone. The batch is never restarted for one failure. T2 was re-dispatched alone once, for a two-constant defect.

## 2. Dispatch Waves (bounded by the plan's own machine-checked DAG)

The plan's `depends_on` graph is enforced by `ultra-plan-runner.mjs`, so waves are data dependencies, not scheduling taste. Within a wave, chunks write disjoint files and run concurrently.

| Wave | Chunks | Gate to enter | State |
|---|---|---|---|
| 1 | T1, T2, T8 | none — three independent foundations | done, audited |
| 2 | T3, T10, T2-fix | T3 needs T1+T2; T10 needs T8 | done, audited |
| 3 | T4, T5, T9, T11 | all need T3 | T3 dispatched, rest queued |
| 4 | T6, T7 | need T5's text to exist in order to guard it | queued |
| 5 | T14, T13 | T14 needs T8+T11; T13 needs T7 | queued |
| 6 | T12 | needs everything; runs the full `bun run ci` gate | queued |

## 3. Invariants Every Subagent Receives

1. Runtime is **Bun**. Never `npm`, `npx`, `yarn`, `pnpm`, or bare `node <file>`.
2. Do **not** run `git add`, `git commit`, or `git push`. The parent commits.
3. Do **not** use `sed -i` or `>` output redirection. A command-rewriting proxy (`rtk`, via an opencode plugin hook) rewrites both into an invalid `--encoding` invocation, and the command fails before it runs. Use the `edit` and `write` tools, and `cmd 2>&1 | tail -n N` for command output.
4. Stay inside the permitted target file list. Touching anything else is a failed chunk.
5. TDD is mandatory: a failing test run captured before the implementation exists.
6. No new dependencies. `bun install` is not part of any chunk.
7. Report the actual exit code of the verification command. Never report a success you did not observe.

## 4. Parent Diff Audit Gate (runs after each wave)

- [x] Wave 1: `git status` in both repos shows only permitted files. T1 14/0, T2 30/0, T8 lint 2757→2760 files with `broken_links` pinned at 1987.
- [x] Wave 1 finding: T1's `enumeratePlans` globbing `*.md` is **correct**, not a defect. Only 40 of 268 real plans carry `schema: ultra-plan/v1`; 228 have no frontmatter. Filtering on the schema would have silently skipped 85% of the corpus. The one false positive was the parent's own manifest file, which was sitting in `plans/` — moved to `docs/code-plan/`.
- [x] Wave 1 finding: the plan's `type: project` / `para: projects` were wrong. Measured across 2757 vault files, `projects` and `type: project` occur zero times. Corrected to `type: note` / `para: project`; T2 re-dispatched alone.
- [x] Wave 2: T2-fix 33/0, full suite 83/0 exit 0. T10 diff is exactly 1 insertion and 0 deletions in `AGENTS.md`; vault suite 41 tests OK exit 0.
- [ ] Wave 3 onward

## 5. Progress Log

| Wave | State | Evidence |
|---|---|---|
| 1 | done | T1 14/0, T2 30/0, T8 vault lint 2760 files / 1987 broken (unchanged) / 41 vault tests OK |
| 2 | done | T2-fix 33/0 and suite 83/0; T10 `+1 -0` in AGENTS.md, vault suite 41 OK. T3 dispatched. |
| 3 | in flight | T3 dispatched; T4, T5, T9, T11 queued behind it |
| 4 | pending | — |
| 5 | pending | — |
| 6 | pending | — |
