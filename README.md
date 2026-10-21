# 🍱 SkillBento

**Find a skill. Launch with context. Track the run.**

*A local-first VS Code extension that brings centralized skill discovery, guarded context injection, and real-time lifecycle tracking to AI coding agents.*

---

## 💥 The Problem: The Chaos of AI Agent Skills

As software teams adopt AI coding agents (such as GitHub Copilot in Agent mode), they encode specialized workflows, coding rules, and testing standards into **Skills** (defined via `SKILL.md` files).

However, without a dedicated management layer, working with agent skills quickly degenerates into friction and cognitive overload:

```
Before SkillBento:
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  Skills Lost in │  ==>  │ Manual Prompting│  ==>  │ "Black Box" Run │
│  Multiple Repos │       │ & Context Drift │       │ & Fake "Done"s  │
└─────────────────┘       └─────────────────┘       └─────────────────┘
 • Digging in folders      • Missing repo boundaries • Lost in chat history
 • Forgetting syntax       • No ticket/Jira linkage  • No artifact tracking
 • Guessing capabilities   • Hallucinated changes    • Untracked blockers
```

### 1. The "Skill Sprawl" Nightmare
Skills live buried inside nested folders across repositories (`.agents/skills/`, `.github/skills/`, submodules, monorepos). Developers constantly switch contexts, hunting through markdown files just to remember what skills exist, which roles they serve (Developer vs. Tester), or where their documentation lives.

### 2. Context Drift & Wrong-Repo Disasters
Invoking a skill manually requires crafting a chat prompt from scratch. When developers forget to explicitly scope target repository boundaries or omit strict constraints, AI agents frequently hallucinate edits across unintended workspace folders or violate project structures.

### 3. The "Prompting Tax" & Repetitive Setup
Launching a task properly requires: finding the exact skill path, attaching issue/Jira requirement URLs, including specific instructions, and setting verification criteria. Doing this manually for every task is tedious and error-prone.

### 4. The "Black-Box" Execution Trap
Once a prompt is sent to chat, it disappears into a scrolling conversation feed. If you work on other tasks or run multi-agent workflows, there is zero visibility into:
- Did the agent actually start working?
- Is it waiting for human approval or missing evidence?
- Which files and artifacts were generated?

### 5. The "Hallucinated Done" Illusion
LLMs are prone to enthusiastically claiming *"Task completed!"* right after creating a half-finished file, without running tests, verifying acceptance criteria, or collecting real evidence.

---

## ✨ The Solution: How SkillBento Solves It

SkillBento transforms how developers interact with agent skills by introducing a structured, local-first control center directly in VS Code's Activity Bar.

```
With SkillBento:
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ Centralized Bento│ ===> │ Guarded Launch   │ ===> │ Real-Time Run    │
│ Catalog          │      │ Form with Scope  │      │ Tracker & Tools  │
└──────────────────┘      └──────────────────┘      └──────────────────┘
 • Auto-discovered skills  • Selected target repo    • Live status updates
 • Filter by role/category • Validated ticket URL    • Artifact audit trail
 • 1-click spec preview    • Pre-engineered prompt   • Copilot Tool integration
```

### 🍱 1. Centralized Bento Catalog
- **Automatic Discovery:** Automatically scans `.agents/skills` and `.github/skills` across your open workspace folders and child repositories, plus any custom directories defined in `skillBento.skillRoots`.
- **Intelligent Organization:** Categorizes skills into clean Bento boxes (*Requirements, Design, Implementation, Review, Testing, Workflow, Tools, Reference*).
- **Fast Search & Role Filters:** Instantly filter by role (`dev`, `tester`, `all`) or fuzzy search by name and description.
- **Instant Previews:** Review a skill's purpose and inputs with one click before running it.

### 🎯 2. Guarded Launch Form (Context & Boundary Enforcement)
- **Target Repository Sandboxing:** Explicitly select the target repository. SkillBento injects strict boundary constraints into the prompt, preventing cross-repo modifications.
- **Requirement Verification:** Attach a validated Requirement URL (Jira, GitHub issue, PR) and optional custom requests or diffs.
- **Airtight Engineered Prompts:** Automatically compiles a standardized prompt containing the exact skill path, repository boundary, requirement link, unique `runId`, and verification rules.

### ⚡ 3. Live Run Tracker & Language Model Tool
- **Native Copilot Agent Tool (`#skillBentoUpdateRun`):** Agents can report real-time status transitions (`running`, `pending_evidence`, `needs_approval`, `completed`, `failed`, `cancelled`) along with progress summaries directly to your VS Code UI.
- **Dynamic Status Bar Monitoring:** At-a-glance status indicators in your VS Code status bar show active runs (`$(sync~spin) SkillBento: 1 running`) or pending checkpoints (`$(bell) SkillBento: 1 waiting`).
- **Interactive Run Inspector:** View full run histories, inspect event logs, copy original prompts, and manually update status whenever needed.

### 📂 4. Artifact Audit Trail & Truthful Completion
- **Direct File Tracking:** Agents register generated files (specs, code, test reports, diagrams) as relative artifacts, clickable directly from the Run Details panel.
- **Strict Quality Gates:** "Task completed" explicitly means the requested task finished—not that tests passed or changes were approved. SkillBento preserves human-in-the-loop approval gates.

### 🔒 5. 100% Local-First & Zero Telemetry
- All run history, prompts, and metadata are stored exclusively in local VS Code state.
- Zero external network requests, zero telemetry, no cloud dependencies.

---

## 🚀 Quick Start

### Prerequisites
- **VS Code Desktop** `1.100+`
- A trusted workspace
- **GitHub Copilot** with Agent mode enabled

### Installation

1. Clone or open the SkillBento repository, then package and install:
   ```sh
   npm ci
   npm run package
   code --install-extension ./skillbento-0.2.3.vsix
   ```

2. Reload VS Code and open your project workspace containing skills (e.g. `.agents/skills/` or `.github/skills/`).

3. Click the **SkillBento icon** in the Activity Bar:
   - Select any skill from the **Skills** catalog.
   - Review its description and click **Run**.
   - Choose the **Target Repository**, optionally enter a **Requirement URL** and additional instructions.
   - Click **Open Copilot Chat** (Agent mode will open with your pre-engineered prompt ready to go).
   - Track progress, evidence, and artifacts under **Runs**.

---

## 📊 Run Lifecycle & Statuses

SkillBento tracks each execution with clear, unambiguous states:

| Status | Icon | Meaning |
|---|:---:|---|
| **Sent to Chat / unconfirmed** | ✉️ | Prompt generated and sent; execution has not been acknowledged yet. |
| **Running** | 🔄 | Agent confirmed work started with active progress reported. |
| **Blocked: evidence needed** | ⚠️ | Agent is blocked and requires specific input or evidence to proceed. |
| **Waiting for approval** | 👤 | Human checkpoint reached; awaiting manual code or design approval. |
| **Task completed** | ✅ | Requested task completed and artifacts reported (does not imply tests passed or PR merged). |
| **Failed** | ❌ | Execution failed or terminated with errors. |
| **Cancelled** | 🚫 | Manually marked as cancelled by the user. |

---

## 🛠️ Skill Specification (`SKILL.md`)

SkillBento parses standard `SKILL.md` files with YAML frontmatter. You can enrich your skills with metadata for filtering and organization:

```yaml
---
name: api-test-generator
description: Generate comprehensive integration tests and mocks for REST endpoints
platform: all        # 'all', 'web', 'backend', 'cloud', 'ios', 'android', etc.
role: tester         # 'dev' | 'tester' | 'all' (inferred if omitted)
category: testing    # 'requirements' | 'design' | 'implementation' | 'review' | 'testing' | 'workflow' | 'tools'
user-invocable: true # Set to false for reference-only library skills
argument-hint: Endpoint path or OpenAPI spec file
---

# API Test Generator

Detailed workflow instructions for the AI agent...
```

---

## ⚙️ Configuration

### Adding Custom Skill Directories
By default, SkillBento searches workspace folders and immediate child repositories. To discover skills located in external paths or central repositories:

```json
{
  "skillBento.skillRoots": [
    "/Users/username/Projects/shared-ai-skills/.agents/skills"
  ]
}
```

After modifying settings, execute **SkillBento: Refresh Skills** from the command palette.

---

## 🤖 Language Model Tool Integration

SkillBento contributes the `skillBento_updateRun` language model tool (referenced as `#skillBentoUpdateRun` in Copilot Chat). When prompted by SkillBento, Copilot can call this tool natively to report progress:

```json
{
  "runId": "uuid-v4-from-launch-prompt",
  "status": "running | pending_evidence | needs_approval | completed | failed | cancelled",
  "summary": "Detailed factual progress summary",
  "artifacts": ["src/api/service.test.ts", "coverage/summary.json"]
}
```

If Copilot does not have tool execution enabled, users can also update statuses manually via the Run Details webview.

---

## 🛡️ Privacy & Security

- **Strictly Local:** Run history, prompts, requirement URLs, and artifact paths remain inside VS Code's internal storage (`globalState`).
- **No Telemetry:** SkillBento transmits zero analytics or telemetry data.
- **Approval Preserving:** Prompts explicitly forbid agents from bypassing approval gates or declaring unwarranted success.

---

## 🧪 Development & Testing

```sh
# Install dependencies
npm ci

# Run linter and core unit tests
npm test

# Run VS Code extension host integration tests
npm run test:integration

# Package VSIX
npm run package
```

---

## 📄 License

MIT © [TADEV](https://github.com/tadev999)
