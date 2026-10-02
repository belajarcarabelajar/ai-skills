# Vault Index Extraction Contract — Semantic Layer

> This is the contract every subagent in the vault indexing fan-out is held to. It is not a code-editing contract: a subagent here **reads notes and emits JSON**. It writes no source file, runs no test suite, and touches no git state. The only artifact is one chunk file.
>
> Read `scripts/lib/chunk-schema.mjs` before you start. It is the machine-checkable version of everything below, and `validateChunk()` is what decides whether your output counts. Prose that disagrees with the validator loses.

## 1. Delegation Metadata

- **Task ID:** T8 / batch `<NNN>`
- **Subagent Role:** Note Reader — concept and rationale extraction
- **Parent Goal:** `docs/code-plan/plans/2026-10-02-subagent-driven-vault-index.md`
- **Delegation Mode:** `isolated-files` — your chunk file is yours alone
- **Working directory:** `/home/belajarcarabelajar/ai-skills`
- **Vault root:** `/home/belajarcarabelajar/Dokumen/Obsidian Vault`

### 1a. Git Boundary

You do not touch git state. Never `git commit`, `git add`, `git checkout`, `git push`, or `gh`. The deliverable is your chunk file on disk, not a commit. If you believe a file outside your scope needs changing, name it in your report and let the parent decide.

### 1b. What you produce

One file: `vault-index/semantic/chunk-<NNN>.json`

Nothing else. No prose wrapper around the JSON, no markdown fences, no commentary inside the file. A chunk that does not parse as JSON is a failed batch, and re-running you costs the parent a dispatch.

## 2. Scope — the one rule that matters

**Every node you emit names a `source_file`, and that path is a real file in your assigned batch.**

This is not a style preference. The vault's existing graph carries **1,299 nodes whose `source_file` is null or empty** — 1,269 null and 30 blank, of which 1,185 nonetheless carry edges. They are ghost nodes: an extractor emitted a concept without recording which note it came from. They cannot be re-verified against disk, `graphify explain` cannot link them to a file, and they fail the project's own chunk validator. Nobody knows which note they came from, so nobody can ever check or delete them.

You are the layer most likely to reproduce that failure, because you are the layer inventing `concept` and `rationale` nodes rather than reading them off a heading. **If you cannot name the file a concept came from, do not emit the concept.**

The validator enforces this and will reject your chunk. Writing it correctly the first time is cheaper.

## 3. What to emit

The structural layer (task T7, already built, deterministic) has already emitted, for every note:

- one `document` node per file
- `contains` edges from each file to its headings
- `references` edges for every wikilink

**Do not re-emit any of that.** Duplicates are tolerated by the merger but they inflate the graph and waste review.

You emit only the layer that needs judgment:

| Node `file_type` | What it is | Typical count |
|---|---|---|
| `concept` | A named idea the note is actually about — a technique, a decision, a system, a term of art | 0–4 per note |
| `rationale` | A stated reason for a choice, in the note's own words | 0–2 per note |

| Relation | Direction | Meaning |
|---|---|---|
| `conceptually_related_to` | concept → concept | two ideas a reader would want side by side |
| `rationale_for` | rationale → concept | this is *why* that was chosen |

Use only relations from the validator's vocabulary. `contains` and `references` belong to T7.

## 4. Node shape

Every node needs, at minimum:

```json
{
  "id": "concept--<slug>",
  "label": "Leiden community detection",
  "file_type": "concept",
  "source_file": "01 - Projects/foo/plans/2026-09-30-some-plan.md",
  "source_location": "L142",
  "norm_label": "leiden community detection"
}
```

- `id` — a stable slug. Same concept in two notes gets the **same** id, so the merger unions them instead of duplicating. Slug the normalised label, not the note path; a per-note id would make every concept a singleton and reproduce the fragmentation this project exists to fix.
- `source_file` — repo-relative, from your batch list, verbatim. Never absolute, never `..`.
- `source_location` — `L<n>`, the line the concept is discussed on. This is what makes `graphify explain` clickable.

## 5. Judgement calls

These are the decisions that make this layer worth a model, and the ones a parser cannot make.

- **A concept is something the note is about, not something it mentions.** "Cloudflare" appearing in a list of tools is not a concept node for that note. A note whose entire subject is a decision to move DNS to Cloudflare has one.
- **Zero is a valid answer.** Most notes in this vault are plans, logs, or transcripts, and many have no distinct concept worth a node. A batch that returns nothing is a correct batch, not a failed one. Do not pad to hit a quota.
- **`rationale` requires an actual stated reason.** "Chose X" is not a rationale. "Chose X because Y broke under Z load" is. If the note records a choice without a reason, emit the concept and skip the rationale.
- **Do not invent.** If the note does not say it, it is not in the graph. A concept you inferred from general knowledge rather than read here is a hallucination with a file path attached, which is worse than a missing node.
- **Transcripts are not plans.** Roughly half the corpus is `05 - Conversations/`, raw session logs. A discarded approach discussed in a transcript is worth a concept node; a tool invocation is not.

## 5a. Id reuse — check before you invent

Node ids are the graph's primary keys. Two chunks emitting different nodes
under one id silently unions two claims; two chunks emitting the same claim
under different ids silently fragments it. Both are invisible at merge, and
both are worse than either alternative being obviously wrong.

Node ids carry a `concept--` / `rationale--` prefix, so searching a bare slug
misses. Use the script — it matches on substring and prints which chunk
emitted each id:

```bash
cd /home/belajarcarabelajar/ai-skills
bun scripts/vault-index-ids.mjs tgrep          # by subject or slug fragment
bun scripts/vault-index-ids.mjs                # list every id
bun scripts/vault-index-ids.mjs --owner=concept--exact-id
```

Run it once per candidate slug, plus one for the note's main subject. A hit
means **read that chunk's node** before deciding — the label text alone will
not tell you whether it is the same claim.

Then the rule:

- **Reuse an id when another chunk emitted the SAME claim.** Same fact, same
  mechanism, same finding — even if worded differently and from a different
  session. Union them.
- **Do not reuse on adjacency.** Two notes touching the same subsystem make
  different claims. Adjacent is not the same.
- **A narrower claim gets its own id.** If an existing node is the general case
  and yours is the specific one, emit a new id. A later reader looking for the
  specific claim should find it, not have to settle for the general one.
- **When you reuse, keep your own `rationale` if the note states its own
  reason.** Do not import the other chunk's. Attributing a reason the note
  never gave is the same error as inventing a node.
- **Verify by reading the cited line**, not by matching slug text. Two slugs can
  look identical and mean different things.

If you cannot read the existing ids, say so in your report. Do not quietly
emit batch-local generics and let the merge discover the collisions.

## 6. Verification — run this yourself before reporting

From `/home/belajarcarabelajar/ai-skills`:

```bash
bun -e "
import { validateChunk } from './scripts/lib/chunk-schema.mjs';
import { readFileSync } from 'node:fs';
const c = JSON.parse(readFileSync('vault-index/semantic/chunk-<NNN>.json','utf8'));
const r = validateChunk(c);
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);
"
```

Exit 0 means your chunk counts. A non-zero exit means the parent discards it and re-dispatches you, which is the most expensive outcome available to you. Run it.

## 7. Report back

State, plainly and without restating the contract:

- the batch id and how many files you read
- node and edge counts by `file_type` and `relation`
- any file you could not attribute a concept to, and why
- anything in your batch that looked like it needed a judgement the contract does not cover

Do not claim success without having run the verification in §6 and seen exit 0.

## 8. Parent Diff Audit Gate

The parent does not take your word. It re-runs §6 itself, re-reads your chunk, and checks that every `source_file` is in your assigned batch. A chunk that reports success and fails the parent's re-run is re-dispatched alone, never by restarting the batch.
