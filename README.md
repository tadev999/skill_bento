# 🍱 Skill Bento

> **Find a skill. Launch with context. Track the run.**  
> Local-first skill catalog & execution tracker for AI coding agents in VS Code.

---

### The Pain (Before)

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│ Skills Lost in  │  ───> │ Manual Prompting│  ───> │ "Black Box" Run │
│ Multiple Repos  │       │ & Context Drift │       │ & Fake "Done"s  │
└─────────────────┘       └─────────────────┘       └─────────────────┘
 • Buried in subfolders    • Omitted repo bounds     • Lost in chat scrollback
 • Forgetting syntax       • Missing ticket links    • Untracked blockers
 • Hard to discover        • Cross-repo edits        • No verified artifacts
```

### The Fix (With SkillBento)

```
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ Centralized Hub  │ ───> │ Guarded Launch   │ ───> │ Real-Time Run    │
│ & Bento Catalog  │      │ Form with Scope  │      │ Tracker & Tools  │
└──────────────────┘      └──────────────────┘      └──────────────────┘
 • Auto-scanned skills     • Sandboxed target repo   • Live status in statusbar
 • Filter by role/category • Validated Jira/PR URL   • Copilot tool integration
 • 1-click spec preview    • Pre-engineered prompt   • Clickable artifact trail
```

---

### Quick Start

*Requires VS Code Desktop 1.100+ and GitHub Copilot with Agent mode.*

```sh
# Build and install extension
npm ci && npm run package
code --install-extension ./skillbento-0.2.3.vsix
```

1. Open **SkillBento** from the Activity Bar.
2. Select a skill → click **Run**.
3. Choose the **Target Repository**, add an optional **Requirement URL**, and click **Open Copilot Chat**.
4. Track live progress, blockers, and artifacts in **Runs**.

---

### Skill Spec (`SKILL.md`)

Define skills using standard YAML frontmatter:

```yaml
---
name: api-test-generator
description: Generate integration tests and mocks for REST endpoints
category: testing    # requirements | design | implementation | review | testing | workflow | tools
role: tester         # dev | tester | all
platform: all        # all | web | backend | ios | android
user-invocable: true # set to false for reference-only docs
argument-hint: OpenAPI spec path or ticket URL
---
```

---

### Configuration

Add external or centralized skill directories via `.vscode/settings.json`:

```json
{
  "skillBento.skillRoots": ["/path/to/shared/.agents/skills"]
}
```

---

### Run Lifecycle & Agent Tool

`sent` ➔ `running` ➔ `pending_evidence` | `needs_approval` ➔ `completed` | `failed` | `cancelled`

- **Language Model Tool:** Agents update status and report output files natively using `#skillBentoUpdateRun`:
  ```json
  {
    "runId": "uuid-from-launch-prompt",
    "status": "completed",
    "summary": "Generated test suite with 100% pass rate",
    "artifacts": ["test/api.test.js"]
  }
  ```
- **Local & Private:** History and artifacts persist strictly in local VS Code state. Zero telemetry.

---

### Development

```sh
npm test                 # Lint + unit/host tests
npm run test:integration # Extension host tests
npm run package          # Build VSIX
```

---

### License

MIT
