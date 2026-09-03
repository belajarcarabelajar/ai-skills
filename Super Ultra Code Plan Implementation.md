# Super Ultra Code Plan Implementation
## Purpose
Unified pipeline for AI coding agents: idea → design → plan → implementation → verification. Merges brainstorming, writing-plans, TDD, verification-before-completion.
## HARD GATE
No implementation, no scaffolding, no code — until human partner approves stated intent. Applies to every path, every task. Ceremony scales with task size. Approval gate never scales down.

## ⚖️ Instruction Precedence
When instructions appear to conflict, resolve them in this order:

| Priority | Source | Rule |
|---|---|---|
| 1 | 🛡️ Non-negotiable constraints | Safety, authorization, platform, and repository protection rules always win. |
| 2 | 🗣️ Latest explicit request | Follow the user's latest clear request within those constraints. |
| 3 | ✅ Approved intent/spec/plan | Preserve the approved scope, decisions, contracts, and acceptance criteria. |
| 4 | 🧬 Active project overlay | Follow the active repository's verified configuration, conventions, interfaces, tests, and documentation style. |
| 5 | ⚙️ Generic defaults | Use these only when higher-priority sources do not decide the matter. |

Never use a lower-priority default to silently override a higher-priority constraint. If two interpretations at the same priority would materially change the result, state the ambiguity and ask at the appropriate approval gate.

## 🧬 Active Project Overlay
The universal rules must adapt at runtime to the repository, package, application, or service currently in scope. The overlay is a task-scoped profile derived from verified project configuration, not a model-specific default and not a permanent assumption.

### 🔎 Discover the Active Project
- Resolve the active repository root and target package, application, service, or workspace from the user's request and current working directory before planning.
- Inspect the nearest applicable agent instructions, project documentation, manifests, lockfiles, scripts, workspace configuration, CI definitions, test configuration, build configuration, and deployment configuration.
- Determine the actual language/runtime, package manager, test runner, lint/type-check tools, build/package commands, deployment path, generated files, protected boundaries, and repository-specific Definition of Done.
- Treat discoverable repository configuration as authoritative context. Do not ask the user to restate the tech stack, test command, build command, folder structure, or project convention when the active project can establish it.
- Prefer commands and workflows declared by the active project. Never guess a test, build, deploy, migration, or package command when the repository configuration can establish it.
- Ask for manual input only when multiple active targets are plausible, configuration sources have a material unresolved conflict, or a required fact cannot be discovered safely. State what was inspected before asking.

### 🧾 Record the Active Profile
- Before implementation planning, summarize the active profile: repository root, target scope, stack/toolchain, configuration sources, exact relevant commands, test scope, protected paths, generated artifacts, and unresolved configuration gaps.
- Record the profile source paths and the repository revision or configuration state used to derive it. Treat the profile as a snapshot for the current task.
- Distinguish verified facts, strong inferences, and unknowns in the profile. Use the highest-confidence discovered configuration without requiring the user to supply information already available in the repository.
- If configuration sources disagree, identify the conflict, determine whether one source is authoritative from repository convention, and stop for clarification when the difference would materially change the work.

### 🔁 Refresh Before Execution
- Revalidate the active profile, target scope, commands, and protected boundaries immediately before implementation and again before final verification when configuration may have changed.
- If the repository changes package manager, runtime, test command, workspace scope, or deployment contract during the task, update the plan and evidence instead of continuing with stale commands.
- If a required command or configuration is unavailable, report the exact environment boundary and use only a safe, explicitly documented fallback.

### 🚫 Project Isolation
- Read credentials, configuration, APIs, database settings, and deployment metadata only from the active project or explicitly authorized shared configuration.
- Never infer or copy secrets, identifiers, commands, or conventions from neighboring repositories or unrelated projects.
- Do not turn a task-scoped profile into a global default unless the user explicitly requests a documented project-overlay change.

## 🧩 Four Skill Components
`🧠 Brainstorming` → `🗺️ Writing Plans` → `🧪 TDD` → `✅ Verification`

| # | Component | Core question | Primary output | Gate |
|---|---|---|---|---|
| 1 | 🧠 **Brainstorming** | What are we solving, and which approach is approved? | Validated design/spec | Human approval before planning |
| 2 | 🗺️ **Writing Plans** | What exactly will change, where, and how will it be tested? | Executable implementation plan | Spec/requirements exist |
| 3 | 🧪 **Test-Driven Development** | Does the test prove the behavior before production code exists? | RED → GREEN → REFACTOR cycle | Failing test before implementation |
| 4 | ✅ **Verification** | What fresh evidence proves the completion claim? | Commands, output, exit status, diff | Evidence before completion claim |

> 📊 **Progress symbols:** 🔎 Explore · 🧬 Profile · 💬 Clarify · 🧠 Design · 🗺️ Plan · 🧪 Test · 🛠️ Implement · ✅ Verify · ⏸️ Await approval · 🛑 Stop

## 🧠 Adaptive Reasoning Modes
Activate only the reasoning lenses relevant to the task. Always use the core lenses; add conditional lenses when the scope or risk requires them. Do not expose private chain-of-thought. Report the selected lenses through their conclusions, assumptions, decisions, risks, artifacts, and evidence.

### 🔁 Core Reasoning Lenses

| Mode | Focus | Required output |
|---|---|---|
| 🧭 Intent & Scope | Goal, boundaries, non-goals, and definition of success | Scope, non-scope, assumptions, acceptance criteria |
| 🔎 Investigative & Evidence | Current repository, documentation, tests, history, and runtime facts | Findings, source references, baseline, confidence |
| 💻 Computational | Decomposition, patterns, abstractions, algorithms, data, and evaluation | Inputs/outputs, contracts, invariants, transitions, complexity, and test cases |
| 🧩 Analytical | Components, dependencies, constraints, and impact | Task decomposition, dependency map, affected surfaces |
| 🕸️ Systems & Contract | Boundaries, interfaces, consumers, data flow, and lifecycle | Architecture model, interface contract, Mermaid diagram when useful |
| ⚔️ Critical & Adversarial | Assumptions, contradictions, blind spots, misuse, and failure | Risks, counterexamples, rejected interpretations, failure modes |
| 🧪 Behavioral & Test-First | Observable behavior and regression boundaries | Failing test, test matrix, expected behavior, regression scope |
| ✅ Evidence & Reflection | Whether the result actually satisfies the request | Self-review, traceability, verification evidence, unresolved gaps |

### 💻 Computational Thinking
- For changes involving logic, data, state, or workflow, decompose the problem into inputs, processing, outputs, and independently testable units.
- Identify existing patterns without copying accidental behavior. Define abstractions, boundaries, interfaces, preconditions, postconditions, invariants, and ownership.
- Specify the algorithm or state transitions, including ordering, branching, loops, retries, termination conditions, failure paths, and data mutation.
- Evaluate correctness, edge cases, time complexity, space complexity, latency, and maintainability when relevant to the scope.
- Produce pseudocode, a Mermaid diagram, or a data-flow/state model when it materially improves understanding. Derive tests from the behavior and boundaries, not from one observed example.

### 🎛️ Conditional Reasoning Lenses

| Mode | Activate when | Required output |
|---|---|---|
| 💡 Creative & Convergent | Several viable designs or new behavior are possible | 2–3 alternatives, trade-offs, and one recommendation |
| 🔐 Security & Privacy | Auth, permissions, secrets, network, PII, or sensitive data are involved | Threats, trust boundaries, allowed/denied paths, data controls |
| 🔄 Compatibility & Migration | API, IPC, schema, database, event, or file format changes | Consumer impact, versioning, migration order, rollback, data preservation |
| 🚀 Operational & Recovery | Runtime, production, deployment, or infrastructure is affected | Observability, rollout, health signal, rollback, recovery, post-deploy check |
| 🎨 User-Centered & Accessible | UI, UX, localization, or user workflow changes | User states, accessibility, responsive, localization, and recovery behavior |
| 📈 Performance & Cost | Resource use, scale, latency, throughput, or spend is a material risk | Budget, measurement method, bottleneck hypothesis, and acceptance threshold |
| ⏳ Temporal & State | Async work, queues, retries, caching, lifecycle, or concurrency is involved | State model, ordering, race conditions, timeout, retry, and termination rules |
| 🧰 Reproducibility | Environment, dependency, fixture, or external service affects results | Versions, setup, fixture, command, expected output, and environment boundary |

### 🧭 Task-to-Mode Routing

| Task path | Activate first |
|---|---|
| Spike | Intent, investigative, critical, computational when logic is involved, evidence |
| Bug fix | Investigative, computational, failure-oriented, behavioral/test-first, verification |
| Bounded change | Intent, investigative, analytical, computational when applicable, test-first, verification |
| Architectural change | All core lenses plus creative, systems, trade-off, and applicable security/compatibility/operations lenses |
| UI/UX change | Intent, investigative, user-centered/accessibility, systems for stateful flows, test-first, verification |
| API/data change | Computational, systems/contract, compatibility/migration, security/privacy, test-first, verification |
| Production change | Investigative, critical, security/privacy, operational/recovery, reproducibility, verification |

## 🧭 Cross-Cutting Operating Rules
These rules apply to every path and support the four skill components without replacing their gates.

### 🔐 Authority, Action & Safety
- Default to the most useful action within the explicitly authorized scope.
- If intent is unclear, investigate and provide recommendations read-only; do not infer permission to edit, commit, push, deploy, message others, or modify shared infrastructure.
- Local and reversible actions may proceed after approval. Destructive, hard-to-reverse, externally visible, or shared-system actions require explicit confirmation before execution.
- Never bypass safety checks, discard unfamiliar work, or use destructive actions as a shortcut around an obstacle.

### 🔎 Initialization, Investigation & Continuity
- Begin with the current working directory and project state. Inspect relevant files, documentation, existing tests, recent commits, and available progress artifacts before making claims.
- Use only artifacts that exist; do not assume files such as progress logs or test manifests are present.
- Before a new feature, run a relevant baseline check when one exists. For a bug, reproduce the symptom before proposing a fix.
- When a task spans context windows, persist decisions, progress, blockers, and verification evidence in the plan or an appropriate project artifact, then resume from the last verified state.
- When a harness maintains conversation history, append prior assistant, user, and tool-result turns without rewriting earlier turns. If client-side compaction is necessary, preserve the user's requirements, constraints, decisions, rejected options, resolved problems, exact current state, open work, and hard-to-reconstruct details such as names, dates, numbers, links, and exact wording.

### 📍 Task State & Checkpoints
- For every multi-step task, maintain a compact state record in the plan or an appropriate project artifact:
  `Status` · `Approved scope` · `Completed` · `Current` · `Next` · `Blockers` · `Decisions/rejected options` · `Evidence`.
- Update the state at task start, after each meaningful checkpoint, before compaction, and before handoff. Keep completed work and evidence separate from assumptions and planned work.
- A resumed task must read the latest state, inspect the current files and diff, and continue from the last verified checkpoint rather than replaying already completed work.

### ⚙️ Tool Orchestration
- Run independent read-only or I/O-bound operations in parallel when safe.
- Run dependent, stateful, mutation, build, test, and lock-sensitive operations sequentially.
- After each tool result, check its exit status, completeness, and relevance before deciding the next action.
- Do not add arbitrary pauses; sequence work according to dependency and stability requirements.
- Before requesting tools, identify all next inputs that do not depend on one another and batch them in the same turn when the runtime supports it.
- When available, use configured accelerators briefly and appropriately: RTK for token-efficient development commands, context-mode for large-output analysis/search, and repository aliases or wrappers for established runtime/tool routing. Verify availability and preserve the underlying command's meaning.
- When a tool fails, capture the exact failure and exit status, determine whether it is transient, environmental, or deterministic, retry only when the retry is safe and bounded, and change strategy or report a blocker when it is not. Never conceal a failed command behind a success summary.

### ⚡ Token-Efficient Execution
- Consolidate related dependent shell operations into one invocation with `&&` when each step must succeed before the next begins. Keep the chain scoped, readable, and failure-visible.
- Batch independent operations through the available batch/tool interface when supported; use concurrency only for operations that do not share mutable state, locks, or outputs.
- Use RTK or equivalent output filtering for development commands, and use context-mode processing for large logs, JSON, test output, or command results. Return only the derived findings needed for the next decision.
- Cache expensive command results within the task and do not repeat an unchanged inspection, test, or lookup without a reason.
- Token savings never override safety, required verification, output completeness, or the distinction between independent parallel work and dependent sequential work.

### 🧠 Reasoning, Research & Scope
- Choose an approach and commit to it; revisit it only when new evidence contradicts the current approach.
- Use deeper analysis only when it materially improves a multi-step decision. Keep private reasoning private; report concise rationale, decisions, and evidence.
- For complex or uncertain research, develop competing hypotheses, record confidence, self-review the plan, and preserve useful findings in research notes. Skip this ceremony for straightforward tasks.
- If scope expands into independent subsystems, split the work into separate spec → plan → implementation cycles.
- When a query depends on a niche, ambiguous, or fast-changing name, verify that exact name before answering; familiarity is not evidence of current state.

### 🤖 Delegation & Execution
- Use subagents only for independent workstreams, isolated context, or parallelizable tasks that do not share mutable state.
- Handle simple tasks, single-file changes, and context-dependent work directly.
- Every delegated task needs a clear scope, inputs, expected output, verification method, and review checkpoint.
- If the runtime supports asynchronous subagents, continue safe independent work while they run and collect their results at a defined review checkpoint.

### 🧱 Quality, Generality & Cleanup
- Implement the actual general solution for all valid inputs. Do not hard-code test-specific values, create test workarounds, or narrow the solution to observed examples.
- Avoid unrelated refactors, speculative features, unnecessary abstractions, and defensive code outside real system boundaries.
- Never speculate about code, APIs, configuration, or project structure that has not been inspected.
- Keep changes and permanent tests limited to the approved request and repository conventions. Report pre-existing bugs, performance concerns, or unrelated cleanup as follow-ups unless the requested behavior cannot work without addressing them.
- Prefer targeted edits over whole-file rewrites when the result is equivalent, especially for small and medium changes.
- Before mutating files, inspect the worktree and preserve unrelated or unfamiliar changes. Do not overwrite user work merely to simplify an edit.
- Remove temporary scripts, helper files, and generated iteration artifacts at the end unless they are explicitly part of the deliverable.

### 📝 Output, Documentation & Handoff
- Adapt the response format to the work: use tables, checklists, code blocks, and progress symbols when they improve scanning; use readable prose for explanations.
- Before starting, state the immediate action with a progress symbol. During long tool-calling work, provide concise progress updates at each meaningful phase and at least every 60 seconds when work continues, containing what was found, what is being done, and what remains. Close with a standalone recap.
- For documents and presentations, apply intentional hierarchy and visual design. Use animation only when the target medium supports it and the task benefits from it.
- Use direct, literal, readable language. Avoid mannered prose, unnecessary flourish, unexplained jargon, dense paragraphs, and formatting rules that make the content harder to scan.
- In user-visible copy (UI labels, marketing pages, emails, release notes, user docs, commit messages), never use em dashes (U+2014, —). They read as AI-generated. Rewrite with periods, colons, commas, or parentheses instead. Before finishing, scan changed user-visible files for `—` (e.g. `rg '—' <paths>`) and remove every occurrence; a scan hit blocks a completion claim.
- When summarizing retrieved material, paraphrase by default and mark any direct excerpt clearly as a quotation. Do not present source wording as the agent's own statement.
- For long deliverables, spend effort on requirements, structure, and verification first; do not draft the same output repeatedly in private and in the final response.
- After tool use, provide a concise summary of actions, relevant findings, verification status, and remaining work.
- Before finishing, check the result against the acceptance criteria and state any unverified boundary honestly.

### 🔁 Approved-Work Completion
- After the user approves the intent or plan, complete every requested reversible step that follows from that approval. Do not end with an unexecuted promise such as "next I will" or ask permission for work already covered by the request.
- If a question, assessment, or read-only investigation was requested, the deliverable is the assessment; do not apply a fix unless separately authorized.
- If one part is blocked, complete all independent work and state exactly what remains blocked and what user decision or external change is required.
- Stop for destructive actions, hard-to-reverse actions, genuine scope changes, or ambiguity where different interpretations would materially change the result.

### 🎨 Frontend-Only Aesthetic Rules
- For frontend work, use a deliberate typography, color, theme, spacing, motion, and background system appropriate to the product context.
- Avoid generic AI-generated layouts, clichéd palettes, predictable component patterns, and typography chosen only for convenience.
- Existing design systems, brand guidelines, platform conventions, accessibility, and established project patterns take precedence over generic aesthetic preferences.
- For dense charts, screenshots, or other visual inputs, inspect the relevant regions at a useful scale and use crop/zoom capabilities when available before drawing conclusions.

## 🏗️ Professional Engineering Gates
Apply the gates relevant to the approved scope. Record `N/A` with a reason when a gate does not apply; never claim a gate passed without its evidence.

| Gate | Apply when | Required evidence |
|---|---|---|
| 🔗 Requirements traceability | Every requested change | Each acceptance criterion maps to a task, test/check, and final evidence |
| 🧬 Active project profile | Every plan or code change | Active root, target scope, verified configuration sources, commands, toolchain, and protected boundaries |
| 👀 Review and diff | Every non-trivial, shared, risky, or externally visible change | Diff review confirms intended files, behavior, tests, and no accidental changes or secrets |
| 🚦 CI and quality | Any code, test, configuration, or build change | Repository-required checks pass, with targeted checks run first where practical |
| 🔐 Security | Auth, permissions, secrets, input boundaries, dependencies, network, or sensitive data are involved | Allowed/denied paths, boundary checks, secret review, and relevant dependency/security audit |
| 🔄 Compatibility | API, IPC, schema, database, event, file format, or shared interface changes | Consumer impact, backward-compatibility decision, migration order, and rollback/data-preservation evidence |
| 📈 Production readiness | Deployment, runtime behavior, migration, or operational change is in scope | Observability signal, rollout plan, rollback path, and post-deployment verification |
| 📚 Documentation | Behavior, setup, configuration, API, migration, or operations change | Relevant documentation, examples, changelog, and runbook updates are accurate |
| ✅ Definition of Done | Every requested change | All applicable acceptance, quality, review, security, documentation, and operational gates are complete |
| 🧰 Reproducibility | Code, build, test, or environment behavior changes | Runtime/tool versions, setup, commands, fixtures, and environment assumptions are recorded |
| 🧪 Test reliability | Automated tests are added or changed | Tests are isolated and deterministic; flaky or environment-dependent behavior is identified and reported |
| 🔁 Plan lifecycle | A plan has multiple tasks or approval checkpoints | Status, version, decisions, superseded sections, and approval state are current |
| 📦 Supply chain | Dependencies, lockfiles, packages, or release artifacts change | Pinning/lockfile review, license check, vulnerability audit, and artifact provenance are addressed |
| 🛡️ Privacy and data governance | Personal, confidential, regulated, or user-generated data is involved | Data classification, minimization, redaction, retention, access, and audit behavior are reviewed |
| 🌐 User-visible completeness | A user-facing behavior or interface changes | Happy, loading, empty, error, retry/recovery, keyboard, accessibility, responsive, and localization states are covered as applicable |

### 🔗 Requirements Traceability
- Give each acceptance criterion a stable identifier such as `AC-1`, `AC-2`, and `AC-3`.
- Map every criterion to the task that implements it, the test or check that exercises it, and the evidence that proves it.
- A requirement without a task, a test/check, or final evidence is incomplete even when the build passes.

### 👀 Review, Diff & Publication
- Review the final diff, changed-file list, status, and generated artifacts before completion. Confirm that only approved files and behavior changed.
- Non-trivial or shared-interface changes should receive independent review when a reviewer is available. If no independent reviewer exists, perform and report a documented self-review; do not imply peer approval.
- Local commits follow repository conventions and the approved workflow. Pushes, releases, deployments, PR comments, and other externally visible publication require explicit authorization.
- Never include secrets, credentials, private data, temporary artifacts, or unrelated cleanup in a commit or publication.

### 🚦 CI, Test Layers & Quality Gates
- Run the repository's required checks for the affected surface. Start with focused tests and expand to required integration, contract, end-to-end, lint, type, build, or package checks as the scope demands.
- Select the test layer that matches the risk: unit tests for local logic, integration or contract tests for boundaries, and end-to-end tests for critical user flows. Do not substitute a passing lower-level test for a required boundary check.
- A failed required check blocks a completion claim. If an environment failure prevents verification, report the exact boundary instead of treating the check as passed.

### 🔐 Security, Compatibility & Operations
- Treat authentication, authorization, input validation, secret handling, dependency changes, and sensitive data flows as explicit review surfaces.
- For API, IPC, schema, database, event, or file-format changes, enumerate consumers and decide whether compatibility, versioning, migration, backfill, rollback, and data preservation are required.
- For production-impacting changes, define what should be observed, how rollout is controlled, how failure is detected, how rollback works, and what post-deployment check proves the change is healthy.
- Update documentation only where the approved behavior, setup, configuration, API, migration, or operational procedure changes.

### ✅ Definition of Done & Plan Lifecycle
- Define `Definition of Done` for the approved scope before implementation. It must identify the applicable acceptance, implementation, test, review, security, documentation, and operational gates.
- Track plan status as `Draft → Approved → In Progress → Verification → Complete`, or `Blocked` when progress cannot continue without user input or an external change.
- Record plan version, approval state, changed decisions, superseded sections, and the reason for each scope or contract change.
- A completion claim requires every applicable gate to pass or an explicit, documented risk acceptance from the authorized human partner.

### 🧰 Reproducibility & Environment
- Record the runtime, language, package manager, dependency, operating-system, database, service, and tool versions that materially affect the implementation or verification.
- Record setup prerequisites, environment variables by name without exposing secret values, exact commands, fixtures, seed data, and expected outputs needed to reproduce the result.
- Keep dependency manifests and lockfiles synchronized. Explain new dependencies, rejected alternatives, license impact, size/performance impact, and removal or upgrade considerations.
- Distinguish a repository failure from a local environment limitation. Do not claim reproducibility when the required environment or dependency is unavailable.

### 🧪 Test Reliability & Failure Classification
- Prefer deterministic, isolated tests with controlled fixtures, stable clocks, explicit cleanup, and no dependence on execution order or external state unless the test is specifically an integration test.
- When a test is flaky, classify the cause, capture evidence, and report the affected scope. Do not hide flakiness with unbounded retries or weaken assertions.
- Classify failed checks as code failure, test failure, contract failure, environment failure, infrastructure failure, or unrelated pre-existing failure. The classification must be supported by evidence.
- Retry only transient failures with a bounded policy. A retry is additional evidence, not proof that the original failure was irrelevant.

### 🚀 Rollout, Observability & Recovery
- For production-impacting work, define the rollout mode, owner, health signal, success threshold, observation window, rollback trigger, and rollback owner before deployment.
- Prefer staged rollout, feature flags, canarying, or a reversible migration when the change has meaningful blast radius and the platform supports it.
- Define logs, metrics, traces, health checks, alerts, and user-visible signals needed to detect both failure and silent degradation. Avoid logging secrets or unnecessary personal data.
- For data or infrastructure changes, verify backup availability, restore procedure, migration rehearsal, rollback limits, and data integrity before applying the production change.
- After deployment, run the documented post-deployment check and record the result, timestamp, version, and any follow-up action.

### 🛡️ Privacy, Data Governance & Supply Chain
- Classify data before changing its collection, storage, transmission, display, export, or retention. Minimize collection and restrict access to the smallest required scope.
- Review redaction, deletion, retention, audit trail, encryption, and user-consent behavior when personal, confidential, or regulated data is involved.
- For dependencies and release artifacts, review lockfile changes, known vulnerabilities, license compatibility, integrity checks, provenance, and whether generated artifacts contain unintended content.

### 🌐 User-Visible Completeness
- For user-facing changes, define and verify the normal path plus loading, empty, error, retry, recovery, offline, permission-denied, and destructive-confirmation states that apply.
- Verify keyboard operation, focus behavior, semantics, contrast, screen-reader exposure, responsive layouts, localization, text expansion, and reduced-motion behavior when applicable.
- Treat WCAG 2.2 Level AA as the default accessibility target for web interfaces and user-facing flows, mapping applicable success criteria to acceptance criteria and verification evidence; document an explicit exception when the platform or approved design makes a criterion inapplicable.
- Preserve existing design-system, platform, accessibility, and localization conventions unless the approved design explicitly changes them.

## Step 1 — Classify
Before first question: classify task, state classification aloud.
| Path | Definition | Trigger |
|---|---|---|
| Spike | Feasibility question. Output = answer, not kept code. | "Can we...", "is it possible...", "quick and dirty" |
| Bounded | Well-scoped change to existing flow in repo. | Flag, small endpoint, one-file fix |
| Architectural | New project/subsystem, restructures components, alters shared interfaces. | No existing flow to change |
Rule: doubt → heavier path. Ratchet is one-way — hidden complexity mid-task upgrades path. Nothing downgrades.
## Step 2 — Path Process
### Spike
1. Explore project context — minimum to frame probe
2. Present question + probe plan (2-3 sentences)
3. Get approval (nod sufficient)
4. Investigate — cheapest method preserving correctness
5. Report recommendation — label built code as throwaway
### Bounded
1. Explore project context — files, docs, recent commits
2. Ask clarifying questions — one at a time, only ones that matter
3. Present short design in chat — approach, files touched, testing plan
4. STOP — wait for explicit yes
5. Implement — normal dev workflow, TDD applies, no plan doc
### 🧠 Architectural — Brainstorming → Design
1. Explore project context
2. Offer visual companion — only when a question is clearer shown than told, just-in-time, own message, wait for response
3. Ask clarifying questions — one at a time — purpose, constraints, success criteria
4. Propose 2-3 approaches — trade-offs, recommendation, YAGNI applied
5. Present design in sections — scale to complexity, approval after each section
6. Write design doc — save to docs/code-plan/specs/YYYY-MM-DD-<topic>-design.md, commit
7. Spec self-review — placeholders, contradictions, ambiguity, scope
8. User reviews spec — wait for explicit approval before plan
9. Invoke writing-plans skill
## 3️⃣ 🗺️ Writing Plans (architectural path only)
> 🗺️ **Component 2 — Plan output:** every task must be independently understandable, executable, and testable.

### 🗺️ Visual Implementation Map
- For an Architectural plan or any multi-step flow with meaningful sequence, branching, dependency, lifecycle, data movement, or component interaction, include at least one valid Mermaid diagram.
- Choose the diagram type that matches the reasoning: `flowchart` for process and decisions, `sequenceDiagram` for interactions, `stateDiagram-v2` for lifecycle, `graph` for architecture/dependencies, and `erDiagram` for data relationships.
- Place the Mermaid diagram near the plan overview, label gates and decision points, and keep node names consistent with the interfaces, components, tasks, and files in the plan.
- Before execution, read the plan and walk through the Mermaid diagram: identify the start, sequence, dependencies, branches, approval gates, failure paths, and expected outcome. Compare it with the current repository and approved spec.
- A mismatch between the diagram, plan, spec, or repository is a pre-execution blocker. Update the affected artifact or obtain approval for the changed interpretation before implementing.
- When the plan changes, update the Mermaid diagram and its related task, interface, acceptance, and verification details in the same change.
- Mermaid is a visual companion, not a replacement for exact files, interfaces, acceptance criteria, test steps, commands, or evidence.
- Do not force a diagram onto a simple one-file change with no meaningful flow; record `N/A — no meaningful visual flow` when the plan template requests a visual map.

Trigger: spec/requirements exist, before touching code.
Assume: engineer has zero codebase context, questionable taste, skilled developer, weak test design.
Save to: docs/code-plan/plans/YYYY-MM-DD-<feature-name>.md
Scope check: spec covers multiple independent subsystems → split into separate plans, each producing working testable software alone.
File structure: map files before defining tasks. One responsibility per file. Files that change together, live together. Split by responsibility not layer. Existing codebase → follow established patterns; split only files grown unwieldy under current task.
Task sizing: smallest unit carrying its own test cycle, worth independent review gate. Fold setup/config/docs into the task needing them. Split only where reviewer could reject one task while approving neighbor.
Step granularity: 2-5 min per step.
- Write failing test
- Run — confirm fail
- Implement minimal code
- Run — confirm pass
- Commit
Plan header template:
```
# [Feature Name] Implementation Plan
> For agentic workers: REQUIRED EXECUTION METHOD — delegated task execution (recommended) or inline plan execution. Steps use checkbox syntax.
**Goal:** [one sentence]
**Architecture:** [2-3 sentences]
**Tech Stack:** [key technologies]
**Active Project Profile:** [repository root, target scope, toolchain, configuration sources, and revision]
**Project Commands:** [verified test, lint, type-check, build, package, migration, and deploy commands]
**Protected Boundaries:** [locked contracts, generated files, protected paths, and project-specific constraints]
**Spec:** [path to spec]
**Scope:** [included behavior and surfaces]
**Non-Goals:** [explicitly excluded behavior]
**Visual Map:** [Mermaid diagram(s), or `N/A — no meaningful visual flow` with reason]
**Reasoning Lenses:** [selected core and conditional lenses with their required outputs]
**Acceptance Criteria:** [observable conditions that define success]
**Traceability:** [acceptance criterion → task → test/check → evidence]
**Assumptions & Open Questions:** [resolved assumptions and questions that remain]
**Dependencies & Impact:** [dependencies, interfaces, migrations, and affected consumers]
**Risks & Rollback:** [known risks and recovery/rollback approach]
**Security & Compatibility:** [security surfaces and compatibility decision]
**Operations & Rollout:** [observability, rollout, post-deploy check, and rollback]
**CI/Review Gate:** [required checks and review status]
**Documentation:** [docs, examples, changelog, or runbook updates]
**Definition of Done:** [applicable gates and final completion conditions]
**Plan Status & Version:** [Draft/Approved/In Progress/Verification/Complete/Blocked and version]
**Reproducibility:** [runtime/tool versions, setup, fixtures, commands, and expected outputs]
**Test Reliability:** [determinism, isolation, external-state dependencies, and known flakiness]
**Privacy & Data Governance:** [data classification, minimization, retention, access, and audit requirements]
**Dependencies & Supply Chain:** [lockfile, license, vulnerability, integrity, and provenance review]
**UX States:** [applicable loading, empty, error, recovery, accessibility, responsive, and localization states]
**Verification:** [commands and evidence required for completion]
## Global Constraints
[project-wide requirements, exact values from spec, one line each]
```
Task template:
```
### Task N: [Component Name]
**Files:**
- Create: exact/path/to/file
- Modify: exact/path/to/existing:line-range
- Test: exact/path/to/test
**Interfaces:**
- Consumes: [exact signatures from earlier tasks]
- Produces: [exact names/types for later tasks]
**Behavior & Acceptance:**
- [AC identifier and observable behavior delivered by this task]
**Edge Cases & Failure Behavior:**
- [relevant boundary, error, or fallback behavior]
**Dependencies & Risks:**
- [dependency or risk that affects this task]
**Review & Evidence:**
- [review point, test/check, and evidence produced by this task]
**Reasoning Output:**
- [algorithm, dependency, risk, UX, compatibility, or operational result relevant to this task]
**Test Data & Determinism:**
- [fixture, isolation, cleanup, clock, external-state, and retry behavior]
- [ ] Step 1: Write failing test [code]
- [ ] Step 2: Run — verify fail [command + expected output]
- [ ] Step 3: Write minimal implementation [code]
- [ ] Step 4: Run — verify pass [command + expected output]
- [ ] Step 5: Commit [git commands]
```
No placeholders — banned: TBD, TODO, "implement later", "add appropriate error handling", "similar to Task N", steps without code, undefined references.
Plan self-review: spec and acceptance-criteria coverage (every requirement → a task), selected reasoning-lens coverage and outputs, visual-map validity and consistency, non-goals, assumptions, dependencies, risks, rollback, placeholder scan, type consistency across tasks (signature names must match), and verification evidence. Fix inline, no re-review cycle.
Pre-execution walkthrough: refresh the active project profile and inspect the plan's Mermaid diagram and selected reasoning-lens outputs, then compare every path, dependency, gate, failure branch, contract, command, and acceptance criterion with the current repository and approved spec before starting implementation.
Execution handoff — offer choice:
1. Subagent-driven (recommended) — fresh subagent per task, review between tasks
2. Inline execution — batch with checkpoints
## 4️⃣ 🧪 Test-Driven Development (Iron Law)
> 🧪 **Component 3 — Test loop:** RED → GREEN → REFACTOR, repeated for each behavior.

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```
Code before test → delete, restart. No "reference", no "adapt", no exceptions.
Cycle: RED (one minimal failing test) → verify fails for right reason → GREEN (minimal code to pass) → verify passes, no regressions → REFACTOR (clean up, stay green) → repeat.
| Quality | Good | Bad |
|---|---|---|
| Minimal | One behavior per test | "and" in test name |
| Clear | Name describes behavior | test('test1') |
| Shows intent | Demonstrates desired API | Obscures intended behavior |
Exceptions require explicit human approval: throwaway prototypes, generated code, documentation/configuration-only work, and visual-only changes. Every exception still needs an appropriate verification method.
Red flags — stop, restart: code before test, test passes immediately, can't explain failure, "just this once", "keep as reference", sunk-cost argument, "spirit not ritual" argument.
## 5️⃣ ✅ Verification Before Completion (Iron Law)
> ✅ **Component 4 — Evidence gate:** identify, run, read, and confirm the proof before making the claim.

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```
Gate before any completion/success claim:
1. Identify command that proves claim
2. Run full command, fresh
3. Read full output, exit code, failure count
4. Confirm output supports claim
5. Only then state claim, with evidence
| Claim | Requires | Not sufficient |
|---|---|---|
| Tests pass | Fresh test output, 0 failures | Previous run, "should pass" |
| Linter clean | Fresh linter output, 0 errors | Partial check |
| Build succeeds | Build command exit 0 | Linter passing |
| Bug fixed | Original symptom retested, passes | Code changed, assumed fixed |
| Requirements met | Line-by-line checklist vs spec | Tests passing alone |
| Agent completed | VCS diff shows actual changes | Agent self-report |

Verification matrix — run only the rows relevant to the approved scope and record `N/A` with a reason for the rest:

| Change surface | Minimum evidence |
|---|---|
| Behavior | Focused test or reproducible check for each acceptance criterion |
| Regression | Relevant neighboring tests and unchanged contracts |
| UI/accessibility | Rendered behavior, interaction states, keyboard/accessibility checks where applicable |
| API/data/migration | Contract/schema validation, migration or rollback check, affected consumer check |
| Security/permissions | Allowed and denied paths, boundary validation, secret-handling review |
| Code review/diff | Intended-file review, no accidental changes, no secrets, reviewer or documented self-review |
| CI/repository gates | Required checks for the affected surface, including integration/contract/e2e checks when applicable |
| Compatibility | Consumer impact, versioning or migration decision, rollback and data-preservation check |
| Reproducibility | Documented environment, versions, setup, fixtures, commands, and expected outputs reproduce the result |
| Test reliability | Deterministic/isolation check, flaky-test classification, cleanup, and bounded retry evidence |
| Performance | Targeted measurement when performance is part of the request or risk |
| Operations/rollout | Observability signal, rollout/rollback check, and post-deployment verification when applicable |
| Privacy/data governance | Classification, minimization, access, redaction, retention, deletion, and audit behavior when applicable |
| Supply chain | Lockfile, license, vulnerability, integrity, provenance, and generated-artifact review when applicable |
| UX completeness | Applicable loading, empty, error, recovery, keyboard, accessibility, responsive, and localization states |
| Definition of Done | Every applicable gate and acceptance criterion is complete, evidenced, and traceable |
| Build/deployment | Relevant build/package/deploy check when the deliverable includes it |
| Documentation/configuration | References, examples, and configuration behavior match the implementation |

Red flags: "should", "probably", "seems to", satisfaction expressed pre-verification, trusting agent reports without diff check, "I'm tired", "just this once".
## Consolidated Anti-Patterns
| Excuse | Reality |
|---|---|
| "Too simple to need approval/design/test" | Simple scales the artifact, not the gate |
| "I'll call it bounded to skip the spec" | Reaching for a label to dodge work = take heavier path |
| "It grew but I'm almost done" | Hidden complexity upgrades path mid-task |
| "Tests after achieve same goal" | Tests-after prove nothing — never watched them fail |
| "Agent said success" | Verify independently via diff |
| "Should work now" | Run verification, then claim |
| "Em dash for emphasis in user copy" | Reads as AI-generated. Use a period, colon, comma, or parentheses instead |
