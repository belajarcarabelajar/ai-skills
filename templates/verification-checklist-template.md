# Verification Checklist Before Completion

## 1. Scope & Acceptance Criteria Sign-Off
- [ ] Stated intent from approved plan is 100% satisfied.
- [ ] No unrequested features, speculative code, or out-of-scope refactoring added.
- [ ] All requested acceptance criteria verified.

## 2. Working Tree & Git Hygiene
- [ ] `git status` inspected: clean state, only expected files modified or staged.
- [ ] All temporary scratch files, debug logs, and repro scripts deleted.
- [ ] No hardcoded tokens, secrets, or API keys present in git diff.
- [ ] Commit message conforms to Conventional Commits format (`feat:`, `fix:`, `docs:`, etc.).

## 2b. Evidence Gate Flow

```mermaid
flowchart LR
    Claim(["Completion\nclaim ready?"]) --> RunCmd["Run verification\ncommand fresh"]
    RunCmd --> Inspect["Inspect exit code\n+ full log output"]
    Inspect --> Pass{"Exit 0 &\n0 failures?"}
    Pass -->|"Yes"| ExtractEvidence["Extract structured\nevidence snippet"]
    Pass -->|"No"| Fix["Fix code/test\nand re-run"]
    Fix --> RunCmd
    ExtractEvidence --> AllGates{"All required\ngates checked?"}
    AllGates -->|"No"| NextGate["Run next\nverification gate"]
    NextGate --> RunCmd
    AllGates -->|"Yes"| Sign(["✅ Sign off\nwith evidence"])
```

## 3. Fresh Evidence Table
| Verification Gate | Exact Command | Exit Code | Verified Evidence / Summary | Verdict |
|---|---|---|---|---|
| Unit Tests | `[command]` | 0 | [e.g. 15 passed, 0 failed] | ✅ PASSED |
| Integration Tests | `[command]` | 0 | [e.g. 4 passed, 0 failed] | ✅ PASSED |
| Type Check | `[command]` | 0 | 0 errors found | ✅ PASSED |
| Linter | `[command]` | 0 | 0 lint warnings / errors | ✅ PASSED |
| Production Build | `[command]` | 0 | Build completed successfully | ✅ PASSED |
| Manual / UI Walk | `[command/url]` | 0 | Verified functional end-to-end | ✅ PASSED |

## 4. Final Completion Verdict
- **Timestamp:** [ISO Timestamp]
- **Commit / State:** [Git commit hash or branch]
- **Evidence Verified By:** [Agent / Auditor]
- **Status:** APPROVED FOR COMPLETION / READY FOR PR
