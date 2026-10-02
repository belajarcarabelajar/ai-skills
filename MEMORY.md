# MEMORY.md — Distilled Rules

> Domain knowledge handbook. Durable `WHEN → DO → NOT` rules distilled from the Step 6 Learning
> Harvest (`templates/session-learning-ledger-template.md`), organized under `Task Group:` headers.
> Each rule passed both the Minimum-Signal NO-OP gate and the 30-Day Horizon test before landing here.
> Moving task state and transient errors do NOT belong here — they expire with the session.

---

## Task Group: ai-skills repo (super-ultra-code-plan skill maintenance)

| # | Rule (`WHEN <situation> → DO <action>, NOT <anti-pattern>`) | Origin session |
|---|---|---|
| L1 | WHEN invoking a shell command → DO use the tool named exactly `bash`, NOT `shell` (there is no `shell` tool in this harness; calling it wastes a turn) | session that added the learning ledger |
| L2 | WHEN adding a new `templates/*.md` to this repo → DO register it in BOTH `requiredTemplates` and `mermaidRequiredTemplates` in `scripts/validate-skill.mjs` and embed a strict ` ```mermaid ` fence, NOT just drop the file (the validator fails the build otherwise) | session that added the learning ledger |
| L3 | WHEN a planning/artifact template needs a Mermaid block → DO use a bare ` ```mermaid ` fence on its own line with `accTitle` + `accDescr`, NOT ` ```mermaid {config} ` (the renderer and validator only match the strict fence) | session that added the learning ledger |
