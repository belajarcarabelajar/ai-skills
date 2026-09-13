# AI Skills: Ultimate All-in-One AI Coding Agent Pipeline

Comprehensive, production-grade, all-in-one skill pipeline for AI coding agents. Designed to guide agents through the entire software engineering lifecycle: **Idea → Design → Plan → Human Approval Gate → TDD → Systematic Debugging → Subagent Orchestration → Verification → Finishing**.

Maintains a **Single Source of Truth** (`Super Ultra Code Plan Implementation.md`) so the agent never loses contextual invariants, safety constraints, or human-approval gates during execution.

---

## Execution Lifecycle

```mermaid
flowchart TD
    Start["User Request / Intent"] --> Classify{"Task Classification"}
    
    Classify -->|Spike| PathSpike["Exploratory Spike & Hypothesis Testing"]
    Classify -->|Bounded| PathBounded["Bounded Direct Fix (< 2 Files)"]
    Classify -->|Architectural| PathArch["Architectural Design & Brainstorming"]
    
    PathSpike --> DesignReport["Spike Report & Recommendations"]
    PathArch --> WritePlan["Visual Implementation Plan (Writing Plans)"]
    PathBounded --> WritePlan
    DesignReport --> WritePlan
    
    WritePlan --> HardGate{{"🛑 HARD HUMAN APPROVAL GATE"}}
    
    HardGate -->|Revisions Requested| WritePlan
    HardGate -->|Approved| ExecRoute{"Execution Strategy"}
    
    ExecRoute -->|New Feature / Refactor| TDD["4️⃣ Test-Driven Development (RED → GREEN → REFACTOR)"]
    ExecRoute -->|Bug Isolation| Debug["4.1 🐞 Systematic Debugging (4-Phase RCA Loop)"]
    ExecRoute -->|Parallel Workstreams| Subagents["🤖 Subagent Orchestration & Isolated Workspaces"]
    
    TDD --> VerifyGate
    Debug --> VerifyGate
    Subagents --> VerifyGate
    
    VerifyGate["5️⃣ Verification Before Completion (Evidence Gate)"] --> GitHygiene["Finishing & Git Hygiene Protocol"]
    GitHygiene --> Done["✅ Task Completed & Verified"]
```

---

## Repository Structure

```
ai-skills/
├── README.md                                    # Documentation & architecture flow
├── LICENSE                                      # MIT License
├── Super Ultra Code Plan Implementation.md      # SINGLE SOURCE OF TRUTH (Master Skill)
├── install.sh                                   # 1-command installer for all harnesses
├── .github/
│   └── workflows/
│       └── ci.yml                               # CI validation workflow
├── scripts/
│   ├── sync.sh                                  # Bidirectional sync (~/.config/ai <-> repo)
│   └── validate-skill.mjs                       # Frontmatter, link & token validation
├── templates/                                   # Companion templates
│   ├── implementation-plan-template.md          # Visual work breakdown & task mapping
│   ├── spike-report-template.md                 # Timeboxed exploratory spike & hypotheses
│   ├── systematic-debugging-log-template.md     # 4-phase RCA & bug reproduction log
│   └── verification-checklist-template.md       # Multi-layer proof & sign-off checklist
└── skills/
    └── super-ultra-code-plan/
        └── SKILL.md -> ../../Super Ultra Code Plan Implementation.md  # Harness discovery symlink
```

---

## Quick Start & Installation

Install and configure symlinks across all installed agent harnesses with one command:

```bash
git clone https://github.com/belajarcarabelajar/ai-skills.git
cd ai-skills
./install.sh
```

### Supported Harnesses & Target Paths

| Harness / Ecosystem | Config / Skill Location | Auto-Discovery Support |
|---|---|---|
| **Google Antigravity CLI** (`agy`) | `~/.gemini/antigravity-cli/builtin/skills/super-ultra-code-plan/` | Supported |
| **Universal Agents** | `~/.agents/skills/super-ultra-code-plan/` | Supported |
| **Claude Code** | `~/.claude/skills/super-ultra-code-plan/` | Supported |
| **Personal Config Mirror** | `~/.config/ai/Super Ultra Code Plan Implementation.md` | Supported |

---

## Companion Templates

Agents can instantly scaffold structured artifacts using the ready-to-use templates in `templates/`:

- **[`implementation-plan-template.md`](templates/implementation-plan-template.md)**: Visual Mermaid map, task breakdown, failing tests (RED), implementation (GREEN), and verification matrix.
- **[`spike-report-template.md`](templates/spike-report-template.md)**: Hypothesis testing, epistemic unknowns exploration, and architectural trade-off evaluations.
- **[`systematic-debugging-log-template.md`](templates/systematic-debugging-log-template.md)**: 4-phase debugging (deterministic repro test, root cause analysis, smallest safe fix, regression proof).
- **[`verification-checklist-template.md`](templates/verification-checklist-template.md)**: Pre-completion evidence gate (test logs, zero warnings, build pass, git hygiene).

---

## Validation & Quality Checks

Run the automated validation suite locally:

```bash
node scripts/validate-skill.mjs
```

Verifies:
- YAML frontmatter syntax (`name`, `description`, `triggers`).
- Master file integrity and estimated token budget (~22k tokens).
- Symlink validity in `skills/super-ultra-code-plan/SKILL.md`.
- Presence of all required templates and executable scripts.

---

## License

[MIT License](LICENSE) — Copyright (c) 2026 belajarcarabelajar
