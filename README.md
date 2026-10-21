# SkillBento

**Find a skill. Launch with context. Track the run.**

Skills are scattered across repositories. Finding the right one, choosing its target project, and tracking progress creates unnecessary context switching.

SkillBento brings skill discovery and run history into VS Code.

- Browse by category; search by name or description.
- Review a skill before launch; choose the target repository.
- Add a requirement URL and optional request, file, or diff.
- Track reported status, evidence, and results in **Runs**.

## Get started

Requires VS Code Desktop 1.100+, a trusted workspace, and GitHub Copilot with Agent mode.

1. From the extension directory, build and install the VSIX:

   ```sh
   npm ci
   npm run package
   code --install-extension ./skillbento-0.2.1.vsix
   ```
2. Reload VS Code and open a repository containing skills, or its parent directory.
3. Open **SkillBento** from the Activity Bar and select a skill.
4. Review its purpose, select the target repository, and add a requirement URL or request if needed.
5. Select **Open Copilot Chat**. Choose **Agent** and send the prompt if it is only prefilled.
6. Track updates in **Runs**.

A run starts only after submitting the launch form. Reference-only skills open their definitions instead.

## Run statuses

- **Sent to Chat / unconfirmed:** execution is not confirmed.
- **Running:** work was reported as started; this is not live monitoring.
- **Blocked: evidence needed** or **Waiting for approval:** an input or human checkpoint is pending.
- **Task completed:** completion was reported; tests or approval are not implied.
- **Failed / Cancelled:** a terminal status was reported or set.

Cancelling updates local history; it does not stop Copilot or external work. Deleting a terminal run does not delete its evidence files or chat.

## Skill metadata format

Skills define their behavior via YAML frontmatter in `SKILL.md`. In addition to name and description, you can explicitly configure target platform, role, category, and whether the skill is user-invocable:

```yaml
---
name: my-analysis-skill
description: Analyze requirements and generate test specifications
platform: all        # 'all', 'web', 'backend', 'cloud', 'ios', 'android', or any project type
role: dev            # 'dev' | 'tester' | 'all' or any role (inferred from name if omitted)
category: review     # 'requirements' | 'design' | 'implementation' | 'review' | 'testing' | 'workflow' | 'tools'
user-invocable: true # set to false for reference-only skills
argument-hint: Optional specification path or issue link
---
```

## Add skill sources

SkillBento discovers `.agents/skills/<name>/SKILL.md` and `.github/skills/<name>/SKILL.md` in workspace folders and their immediate child directories. To add another source, set `skillBento.skillRoots` to an absolute path:

```json
{
  "skillBento.skillRoots": ["/absolute/path/to/project/.agents/skills"]
}
```

Then run **SkillBento: Refresh Skills**. Filters affect discovery, not access. The status bar dynamically reflects active runs (`$(sync~spin) SkillBento: N running` or `$(bell) SkillBento: N waiting`).

## Privacy

Run history, prompts, requirement URLs, evidence, and paths are stored in local VS Code state and are not synced through Settings Sync. The extension sends no telemetry and does not modify project files. Copilot processes submitted prompts under its own service policies. Do not enter secrets.

SkillBento preserves each skill's approval gates. Sending a prompt or creating an artifact does not prove the task is complete.

## Development

```sh
npm ci
npm test
npm run test:integration
npm run package
```

Tests cover lint, unit/host behavior, and a separate VS Code Extension Host. Copilot sign-in and live prompt submission require manual verification.
