const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const core = require('./core');

const STATUS = {
  sent: ['Sent to Chat / unconfirmed', 'mail'], running: ['Running', 'sync~spin'],
  pending_evidence: ['Blocked: evidence needed', 'warning'], needs_approval: ['Waiting for approval', 'person'],
  completed: ['Task completed', 'check'], failed: ['Failed', 'error'], cancelled: ['Cancelled', 'circle-slash']
};

const STATUS_COLORS = {
  sent: 'charts.purple',
  running: 'charts.blue',
  pending_evidence: 'charts.yellow',
  needs_approval: 'charts.orange',
  completed: 'testing.iconPassed',
  failed: 'testing.iconFailed',
  cancelled: 'testing.iconSkipped'
};

const CATEGORY_COLORS = {
  requirements: 'charts.blue',
  design: 'charts.purple',
  implementation: 'charts.blue',
  review: 'charts.yellow',
  testing: 'charts.green',
  workflow: 'charts.orange',
  tools: 'charts.foreground',
  reference: 'descriptionForeground',
  other: 'charts.yellow'
};

const SKILL_ICONS = {
  requirements: ['note', 'charts.blue'],
  design: ['layout', 'charts.purple'],
  implementation: ['code', 'charts.blue'],
  review: ['checklist', 'charts.yellow'],
  testing: ['beaker', 'charts.green'],
  workflow: ['git-pull-request', 'charts.orange'],
  tools: ['tools', 'charts.foreground'],
  reference: ['library', 'descriptionForeground'],
  other: ['zap', 'charts.yellow']
};

function createThemeColor(id) {
  try {
    return typeof vscode.ThemeColor === 'function' && id ? new vscode.ThemeColor(id) : undefined;
  } catch {
    return undefined;
  }
}

function createMarkdown(content) {
  try {
    if (typeof vscode.MarkdownString === 'function') {
      const md = new vscode.MarkdownString(content);
      md.isTrusted = true;
      md.supportThemeIcons = true;
      return md;
    }
  } catch {
    // fallback to plain string
  }
  return content;
}

function escapeMarkdown(text) {
  return String(text || '').replace(/([\\`*_#[\]()])/g, '\\$1');
}

/** @param {string} value */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return character;
    }
  });
}

class Hub {
  constructor(context) {
    this.context = context;
    this.skills = [];
    this.repos = [];
    this.runs = context.globalState.get('runs', []);
    this.filters = context.globalState.get('filters', { role: 'all', platform: 'all' });
    this.query = '';
    this.changed = new vscode.EventEmitter();
    this.historyChanged = new vscode.EventEmitter();
    this.queue = Promise.resolve();
    this.output = vscode.window.createOutputChannel('SkillBento');
    this.statusBarItem = null;
    this.historyView = null;
    context.subscriptions.push(this.changed, this.historyChanged, this.output);
  }

  updateStatusSummary() {
    const activeRuns = this.runs.filter(r => !['completed', 'failed', 'cancelled'].includes(r.status));
    const runningCount = this.runs.filter(r => r.status === 'running').length;
    const waitingCount = this.runs.filter(r => ['pending_evidence', 'needs_approval'].includes(r.status)).length;
    if (this.statusBarItem) {
      if (runningCount > 0) {
        this.statusBarItem.text = `$(sync~spin) SkillBento: ${runningCount} running`;
      } else if (waitingCount > 0) {
        this.statusBarItem.text = `$(bell) SkillBento: ${waitingCount} waiting`;
      } else {
        this.statusBarItem.text = '$(tools) SkillBento';
      }
      this.statusBarItem.tooltip = 'SkillBento: Open Skills & Runs Hub';
    }
    if (this.historyView) {
      this.historyView.badge = activeRuns.length > 0
        ? { value: activeRuns.length, tooltip: `${activeRuns.length} active run${activeRuns.length > 1 ? 's' : ''}` }
        : undefined;
      const total = this.runs.length;
      if (total === 0) {
        this.historyView.description = undefined;
      } else if (activeRuns.length > 0) {
        this.historyView.description = `${activeRuns.length} active / ${total} total`;
      } else {
        this.historyView.description = `${total} ${total === 1 ? 'run' : 'runs'}`;
      }
    }
  }

  async refresh() {
    const roots = new Set();
    const repos = new Set();
    for (const folder of vscode.workspace.workspaceFolders || []) {
      if (folder.uri.scheme !== 'file') continue;
      repos.add(folder.uri.fsPath);
      let entries;
      try { entries = await fs.readdir(folder.uri.fsPath, { withFileTypes: true }); }
      catch (error) { this.output.appendLine(`${folder.uri.fsPath}: ${error.message}`); continue; }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'build', 'dist'].includes(entry.name)) repos.add(path.join(folder.uri.fsPath, entry.name));
      }
    }
    for (const repo of repos) {
      roots.add(path.join(repo, '.agents', 'skills'));
      roots.add(path.join(repo, '.github', 'skills'));
    }
    for (const root of vscode.workspace.getConfiguration('skillBento').get('skillRoots', [])) {
      if (path.isAbsolute(root)) roots.add(root);
      else this.output.appendLine(`Skipped non-absolute skill root: ${root}`);
    }
    const skills = [];
    const discovered = new Set();
    for (const root of roots) {
      let entries;
      try { entries = await fs.readdir(root, { withFileTypes: true }); }
      catch (error) {
        if (error.code !== 'ENOENT') this.output.appendLine(`${root}: ${error.message}`);
        continue;
      }
      const repo = path.dirname(path.dirname(root));
      discovered.add(repo);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'shared') continue;
        const file = path.join(root, entry.name, 'SKILL.md');
        try {
          const skill = core.parseSkill(await fs.readFile(file, 'utf8'), entry.name);
          if (!skills.some(other => other.name === skill.name && other.repo === repo)) skills.push({ ...skill, file, repo });
        } catch (error) { this.output.appendLine(`${file}: ${error.message}`); }
      }
    }
    this.skills = skills.sort((left, right) => left.name.localeCompare(right.name));
    this.repos = [...discovered];
    this.changed.fire();
    this.historyChanged.fire();
    this.updateStatusSummary();
  }

  catalogChildren(element) {
    const visible = core.catalogSkills(this.skills, this.filters, this.query);
    if (!element) return core.CATEGORIES.map(category => ({ kind: 'category', category,
      count: visible.filter(skill => core.categoryOf(skill) === category.id).length })).filter(group => group.count);
    if (element.kind === 'category') return visible.filter(skill => core.categoryOf(skill) === element.category.id).map(skill => ({ kind: 'skill', skill }));
    return [];
  }

  historyChildren(element) {
    if (!element) return this.runs.map(run => ({ kind: 'run', run }));
    if (element.kind === 'run') {
      const run = element.run;
      const children = [];
      if (run.summary) {
        children.push({ kind: 'run-summary', run });
      }
      if (run.artifacts && Array.isArray(run.artifacts) && run.artifacts.length > 0) {
        for (const artifact of run.artifacts) {
          children.push({ kind: 'run-artifact', run, artifact });
        }
      }
      if (run.requirementUrl) {
        children.push({ kind: 'run-requirement', run });
      }
      return children;
    }
    return [];
  }

  item(element) {
    if (element.kind === 'category') {
      const item = new vscode.TreeItem(element.category.label, this.query ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `category:${element.category.id}${this.query ? `:search:${this.query}` : ''}`;
      item.description = `${element.count} ${element.count === 1 ? 'skill' : 'skills'}`;
      item.iconPath = new vscode.ThemeIcon(element.category.icon, createThemeColor(CATEGORY_COLORS[element.category.id]));
      item.contextValue = 'skillBentoCategory';
      item.tooltip = createMarkdown(
        `### $(${element.category.icon}) **${element.category.label}**\n\n` +
        `**${element.count}** skill${element.count > 1 ? 's' : ''} available in the active workspace.\n\n` +
        `_Click to ${this.query ? 'collapse' : 'expand'} category skills._`
      );
      return item;
    }
    if (element.kind === 'skill') {
      const skill = element.skill;
      const item = new vscode.TreeItem(skill.label);
      item.id = skill.name;
      const badges = [];
      if (!skill.invocable) {
        badges.push('Reference');
      } else {
        if (skill.role && skill.role !== 'all') {
          badges.push(skill.role);
        } else {
          badges.push('Invocable');
        }
        if (skill.hint) badges.push('hint');
      }
      item.description = badges.join(' • ');

      const categoryId = core.categoryOf(skill);
      if (!skill.invocable) {
        item.iconPath = new vscode.ThemeIcon('book', createThemeColor('descriptionForeground'));
      } else {
        const iconConfig = SKILL_ICONS[categoryId] || ['play-circle', 'charts.blue'];
        item.iconPath = new vscode.ThemeIcon(iconConfig[0], createThemeColor(iconConfig[1]));
      }

      const tipLines = [
        `### $(${!skill.invocable ? 'book' : 'sparkle'}) **${skill.label}**`,
        '',
        skill.description || '_No description provided._',
        '',
        '---',
        `- **Category:** \`${categoryId}\``,
        `- **Type:** ${skill.invocable ? '⚡ Invocable Workflow' : '📖 Reference Guide (Read Only)'}`,
        skill.hint ? `- **Input Hint:** _${skill.hint}_` : '',
        skill.repo ? `- **Repository:** \`${path.basename(skill.repo)}\`` : '',
        `- **Source:** \`${skill.file}\``,
        '',
        '---',
        skill.invocable
          ? `[$(play) **Run Skill**](command:skillBento.run) &nbsp;&nbsp;|&nbsp;&nbsp; [$(file-code) Open Definition](command:skillBento.details)`
          : `[$(file-code) Open SKILL.md](command:skillBento.details)`
      ];
      item.tooltip = createMarkdown(tipLines.filter(Boolean).join('\n'));
      item.contextValue = 'skillBentoSkill';
      item.command = { command: 'skillBento.run', title: 'Review Skill', arguments: [element] };
      return item;
    }
    if (element.kind === 'run') {
      const run = element.run;
      const hasChildren = Boolean(run.summary) || (run.artifacts && run.artifacts.length > 0) || Boolean(run.requirementUrl);
      const item = new vscode.TreeItem(run.skill, hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = run.id;
      item.description = `${STATUS[run.status][0]} • ${path.basename(run.repo)}`;
      item.iconPath = new vscode.ThemeIcon(STATUS[run.status][1], createThemeColor(STATUS_COLORS[run.status]));
      item.contextValue = ['completed', 'failed', 'cancelled'].includes(run.status) ? 'skillBentoRunTerminal' : 'skillBentoRunActive';
      item.command = { command: 'skillBento.result', title: 'Run Details', arguments: [element] };

      const tipLines = [
        `### $(${STATUS[run.status][1]}) **${run.skill}** &nbsp; \`${STATUS[run.status][0]}\``,
        '',
        `> **Latest Update:**`,
        `> ${escapeMarkdown(run.summary || 'No progress update reported.')}`,
        '',
        '---',
        `- **Repository:** \`${run.repo}\``,
        run.requirementUrl ? `- **Requirement:** [${run.requirementUrl}](${run.requirementUrl})` : '',
        `- **Run ID:** \`${run.id}\``,
        `- **Last Updated:** ${escapeHtml(run.updatedAt)}`,
        run.artifacts && run.artifacts.length
          ? `- **Artifacts (${run.artifacts.length}):**\n` + run.artifacts.map(a => `  - \`${a}\``).join('\n')
          : `- **Artifacts:** _None reported_`,
        '',
        '---',
        `[$(output) View Details & Results](command:skillBento.result) &nbsp;&nbsp;|&nbsp;&nbsp; [$(copy) Copy Prompt](command:skillBento.copy)`
      ];
      item.tooltip = createMarkdown(tipLines.filter(Boolean).join('\n'));
      return item;
    }
    if (element.kind === 'run-summary') {
      const summaryText = element.run.summary ? element.run.summary.replace(/[\r\n]+/g, ' ') : 'No update';
      const label = summaryText.length > 45 ? summaryText.slice(0, 45) + '…' : summaryText;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.description = 'Latest update';
      item.iconPath = new vscode.ThemeIcon('comment-discussion', createThemeColor('charts.blue'));
      item.tooltip = createMarkdown(`**Latest Progress Update:**\n\n> ${escapeMarkdown(element.run.summary)}`);
      item.command = { command: 'skillBento.result', title: 'Run Details', arguments: [{ kind: 'run', run: element.run }] };
      item.contextValue = 'skillBentoRunSummary';
      return item;
    }
    if (element.kind === 'run-artifact') {
      const item = new vscode.TreeItem(path.basename(element.artifact), vscode.TreeItemCollapsibleState.None);
      const dir = path.dirname(element.artifact);
      item.description = dir !== '.' ? dir : 'artifact';
      item.iconPath = new vscode.ThemeIcon('file-code', createThemeColor('charts.green'));
      item.tooltip = `Artifact: ${element.artifact}\nClick to open file in editor`;
      item.command = {
        command: 'vscode.open',
        title: 'Open Artifact',
        arguments: [vscode.Uri.file(path.resolve(element.run.repo, element.artifact))]
      };
      item.contextValue = 'skillBentoArtifact';
      return item;
    }
    if (element.kind === 'run-requirement') {
      const item = new vscode.TreeItem('Requirement', vscode.TreeItemCollapsibleState.None);
      item.description = element.run.requirementUrl;
      item.iconPath = new vscode.ThemeIcon('link-external', createThemeColor('charts.purple'));
      item.tooltip = `Requirement URL: ${element.run.requirementUrl}\nClick to open in browser`;
      item.command = {
        command: 'vscode.open',
        title: 'Open Requirement',
        arguments: [vscode.Uri.parse ? vscode.Uri.parse(element.run.requirementUrl) : vscode.Uri.file(element.run.requirementUrl)]
      };
      item.contextValue = 'skillBentoRequirement';
      return item;
    }
    return new vscode.TreeItem('');
  }

  async chooseFilters() {
    const roles = ['all', ...new Set(this.skills.map(item => item.role).filter(role => role && role !== 'all'))];
    const role = await vscode.window.showQuickPick(roles.length > 1 ? roles : ['all', 'dev', 'tester'], { title: 'SkillBento: Role' });
    if (!role) return;
    const platforms = ['all', ...new Set(this.skills.map(item => item.platform).filter(platform => platform && platform !== 'all'))];
    const platform = await vscode.window.showQuickPick(platforms.length > 1 ? platforms : ['all', 'ios', 'android'], { title: 'SkillBento: Platform' });
    if (!platform) return;
    this.filters = { role, platform };
    await this.context.globalState.update('filters', this.filters);
    this.changed.fire();
  }

  async search() {
    const query = await vscode.window.showInputBox({ title: 'SkillBento: Search Skills', value: this.query,
      placeHolder: 'Skill name, description, role, category...', prompt: 'Leave empty to show all matching skills' });
    if (query === undefined) return;
    this.query = query.trim();
    this.changed.fire();
  }

  async resetFilters() {
    this.query = '';
    this.filters = { role: 'all', platform: 'all' };
    await this.context.globalState.update('filters', this.filters);
    this.changed.fire();
  }
  /** @param {{ label: string, description: string, hint: string, platform: string, role: string }} skill @param {string[]} candidates @param {string} nonce */
  launchFormHtml(skill, candidates, nonce) {
    const options = candidates.map(repo => `<option value="${escapeHtml(repo)}">${escapeHtml(path.basename(repo))} &mdash; ${escapeHtml(repo)}</option>`).join('');
    const hint = skill.hint ? `<div class="bento-hint"><span class="hint-icon">&#9432;</span><span>Skill input hint: ${escapeHtml(skill.hint)}</span></div>` : '';
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src https://fonts.gstatic.com; style-src 'nonce-${nonce}' https://fonts.googleapis.com; script-src 'nonce-${nonce}'; form-action 'none';">
<title>Launch ${escapeHtml(skill.label)}</title>
<style nonce="${nonce}">
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

:root {
  --bento-radius: 12px;
  --bento-card-bg: var(--vscode-sideBar-background, rgba(127, 127, 127, 0.05));
  --bento-border: var(--vscode-widget-border, rgba(255, 255, 255, 0.1));
}
body {
  font-family: 'Inter', var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif);
  color: var(--vscode-foreground);
  line-height: 1.68;
  letter-spacing: -0.011em;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  background: radial-gradient(circle at 10% 0%, rgba(55, 148, 255, 0.07) 0%, transparent 45%),
              radial-gradient(circle at 90% 100%, rgba(139, 92, 246, 0.05) 0%, transparent 45%),
              var(--vscode-editor-background);
  min-height: 100vh;
  margin: 0;
  padding: 36px 28px;
  box-sizing: border-box;
}
.bento-container { max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px; }
.bento-hero {
  background: var(--bento-card-bg);
  border: 1px solid var(--bento-border);
  border-radius: var(--bento-radius);
  padding: 26px 30px;
  position: relative;
  overflow: hidden;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(10px);
}
.bento-hero::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, #38bdf8, #818cf8, #c084fc);
}
.brand-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--vscode-textLink-foreground, #38bdf8);
  margin-bottom: 12px;
}
h1 {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 14px;
  line-height: 1.35;
  letter-spacing: -0.025em;
  color: var(--vscode-editor-foreground);
}
.description {
  color: var(--vscode-descriptionForeground);
  line-height: 1.75;
  font-size: 14.5px;
  letter-spacing: -0.006em;
  margin: 0 0 20px;
}
.tags-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 20px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  background: rgba(127, 127, 127, 0.1);
  border: 1px solid var(--bento-border);
  color: var(--vscode-foreground);
}
.badge-accent { background: rgba(56, 189, 248, 0.12); border-color: rgba(56, 189, 248, 0.3); color: var(--vscode-textLink-foreground, #38bdf8); }
.meta { color: var(--vscode-descriptionForeground); font-size: 12.5px; line-height: 1.7; margin: 8px 0; }
form { display: grid; gap: 20px; }
.bento-card {
  background: var(--bento-card-bg);
  border: 1px solid var(--bento-border);
  border-radius: var(--bento-radius);
  padding: 20px 24px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.bento-card:focus-within {
  border-color: var(--vscode-focusBorder);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.16);
}
label {
  display: grid;
  gap: 10px;
  font-weight: 600;
  font-size: 13.5px;
  line-height: 1.5;
  letter-spacing: -0.01em;
  color: var(--vscode-foreground);
}
label span {
  font-size: 12.5px;
  font-weight: 400;
  line-height: 1.6;
  color: var(--vscode-descriptionForeground);
  margin-top: 1px;
}
input, select, textarea {
  box-sizing: border-box;
  width: 100%;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--bento-border));
  border-radius: 8px;
  padding: 11px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.6;
  letter-spacing: -0.005em;
  transition: all 0.2s ease;
}
textarea {
  resize: vertical;
  min-height: 130px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', var(--vscode-editor-font-family, monospace);
  font-size: 13px;
  line-height: 1.72;
  letter-spacing: 0;
}
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2); }
.bento-hint {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--vscode-descriptionForeground);
  margin-top: 10px;
  padding: 8px 12px;
  background: rgba(127, 127, 127, 0.06);
  border-radius: 6px;
}
.hint-icon { font-size: 14px; color: var(--vscode-textLink-foreground, #38bdf8); }
.actions { display: flex; justify-content: flex-end; align-items: center; gap: 14px; margin-top: 10px; }
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  padding: 11px 22px;
  border-radius: 8px;
  color: var(--vscode-button-foreground);
  background: linear-gradient(135deg, var(--vscode-button-background), #2563eb);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.45;
  letter-spacing: -0.01em;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
  transition: all 0.2s ease;
}
button:hover {
  background: var(--vscode-button-hoverBackground, #1d4ed8);
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
}
button:active { transform: translateY(0); }
button.secondary {
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground, rgba(127, 127, 127, 0.15));
  box-shadow: none;
}
button.secondary:hover {
  background: var(--vscode-button-secondaryHoverBackground, rgba(127, 127, 127, 0.25));
  color: var(--vscode-foreground);
}
#error { color: var(--vscode-errorForeground); min-height: 1.4em; font-size: 13px; line-height: 1.6; margin: 6px 0 0; }
</style></head><body>
<div class="bento-container">
<section class="bento-hero">
  <div class="brand-badge">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 7 10-4 2 3-10 4Z"/><path d="M3 12h18l-1.4 7.4a2 2 0 0 1-2 1.6H6.4a2 2 0 0 1-2-1.6Z"/></svg>
    SkillBento Launcher
  </div>
  <h1>${escapeHtml(skill.label)}</h1>
  <p class="description">${escapeHtml(skill.description)}</p>
  <div class="tags-row">
    <span class="badge badge-accent">Platform: ${escapeHtml(skill.platform)}</span>
    <span class="badge">Role: ${escapeHtml(skill.role)}</span>
    ${skill.category ? `<span class="badge">Category: ${escapeHtml(skill.category)}</span>` : ''}
    <span class="badge">${skill.invocable ? 'Executable' : 'Reference only'}</span>
  </div>
  <p class="meta" style="display:none;">Platform: ${escapeHtml(skill.platform)} | Role: ${escapeHtml(skill.role)}</p>
</section>

<form id="launch-form">
  <div class="bento-card">
    <label for="repo">Target repository
      <span>Select which workspace or repository this skill will analyze or modify</span>
      <select id="repo" required>${options}</select>
    </label>
  </div>

  <div class="bento-card">
    <label for="requirementUrl">Requirement URL <span>Optional; HTTP or HTTPS link to the request</span>
      <input id="requirementUrl" type="url" pattern="https?://.*" placeholder="https://example.com/requirements/42">
    </label>
  </div>

  <div class="bento-card">
    <label for="request">Request, input file, or diff <span>Optional; leave blank to follow the skill's default workflow</span>
      <textarea id="request" placeholder="${escapeHtml(skill.hint || 'Add specific requirements, issue details, or files for this run...')}" rows="4"></textarea>
    </label>
    ${hint}
  </div>

  <p id="error" role="alert" aria-live="polite"></p>

  <div class="actions">
    <button type="button" class="secondary" id="cancel">Cancel</button>
    <button type="submit">Open Copilot Chat</button>
  </div>
</form>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('launch-form').addEventListener('submit', event => {
  event.preventDefault();
  vscode.postMessage({ type: 'launch', repo: document.getElementById('repo').value, requirementUrl: document.getElementById('requirementUrl').value, request: document.getElementById('request').value });
});
document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
window.addEventListener('keydown', event => { if (event.key === 'Escape') vscode.postMessage({ type: 'cancel' }); });
window.addEventListener('message', event => { if (event.data.type === 'error') document.getElementById('error').textContent = event.data.message; });
</script></body></html>`;
  }

  /** @param {{ name: string, label: string, description: string, hint: string, platform: string }} skill @param {string[]} candidates */
  async showLaunchForm(skill, candidates) {
    const nonce = randomBytes(16).toString('base64');
    const panel = vscode.window.createWebviewPanel('skillBento.launch', `Launch ${skill.label}`, vscode.ViewColumn.Active, { enableScripts: true });
    panel.webview.html = this.launchFormHtml(skill, candidates, nonce);
    return new Promise(resolve => {
      let settled = false;
      /** @param {{ skill: object, repo: string, requirementUrl: string, request: string } | undefined} value */
      const finish = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      panel.onDidDispose(() => finish(undefined));
      panel.webview.onDidReceiveMessage(async message => {
        if (message?.type === 'cancel') {
          panel.dispose();
          return;
        }
        if (message?.type !== 'launch') return;
        if (typeof message.repo !== 'string' || !candidates.includes(message.repo)) {
          await panel.webview.postMessage({ type: 'error', message: 'Select a repository from the list.' });
          return;
        }
        let requirementUrl;
        try { requirementUrl = core.validateRequirementUrl(message.requirementUrl === undefined ? '' : message.requirementUrl); }
        catch (error) {
          await panel.webview.postMessage({ type: 'error', message: error.message });
          return;
        }
        const selectedSkill = this.skills.find(item => item.name === skill.name && item.repo === message.repo) || skill;
        finish({ skill: selectedSkill, repo: message.repo,
          requirementUrl,
          request: typeof message.request === 'string' ? message.request.trim() : '' });
        panel.dispose();
      });
    });
  }

  updateCatalogSummary() {
    const count = core.catalogSkills(this.skills, this.filters, this.query).length;
    this.catalogView.description = `${count} ${count === 1 ? 'skill' : 'skills'}`;
    const active = [this.filters.role !== 'all' && `Role: ${this.filters.role}`,
      this.filters.platform !== 'all' && `Platform: ${this.filters.platform}`, this.query && `Search: "${this.query}"`].filter(Boolean);
    this.catalogView.message = [active.join(' | '), !count && 'No matching skills. Clear filters or search again.'].filter(Boolean).join('\n') || undefined;
  }

  async launch(element) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before launching skills');
    if (!this.skills.length) await this.refresh();
    let skill = element?.skill;
    if (!skill) {
      const unique = [...new Map(this.skills.filter(item => core.matches(item, this.filters) && item.invocable).map(item => [item.name, item])).values()];
      const selected = await vscode.window.showQuickPick(unique.map(item => {
        const cat = core.categoryOf(item);
        const iconName = SKILL_ICONS[cat]?.[0] || 'zap';
        return {
          label: `$(${iconName}) ${item.label}`,
          description: `${cat} • ${item.name}`,
          detail: item.description,
          skill: item
        };
      }), { title: 'SkillBento: Select a skill to launch', matchOnDescription: true, matchOnDetail: true });
      skill = selected?.skill;
    }
    if (!skill) return;
    if (!skill.invocable) {
      return vscode.commands.executeCommand('skillBento.details', { skill });
    }
    const candidates = [...new Set([...this.repos, ...(vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file' && !this.repos.some(repo => core.isWithin(folder.uri.fsPath, repo))).map(folder => folder.uri.fsPath)])];
    if (!candidates.length) throw new Error('No local repository is available as a target');
    const form = await this.showLaunchForm(skill, candidates);
    if (!form) return;
    const run = core.createRun(form.skill, form.repo, form.requirementUrl, form.request);
    await this.mutate(runs => [run, ...runs]);
    const prompt = core.buildPrompt(run);
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
      vscode.window.showInformationMessage('Copilot opened. Check Agent mode and send if needed. Execution is not yet confirmed.');
    } catch (error) {
      await vscode.env.clipboard.writeText(prompt);
      await this.change(run.id, { status: 'pending_evidence', summary: `Could not open Copilot: ${error.message}. Prompt copied; paste into Agent Chat manually.` }, 'launcher');
      vscode.window.showWarningMessage('Could not open Copilot. Prompt copied; paste it into Copilot Chat in Agent mode.');
    }
  }

  mutate(callback) {
    const operation = this.queue.then(async () => {
      const next = callback(this.runs);
      const capped = Array.isArray(next) ? next.slice(0, 100) : next;
      await this.context.globalState.update('runs', capped);
      this.runs = capped;
      this.historyChanged.fire();
      this.updateStatusSummary();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async change(id, change, source) {
    if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted');
    return this.mutate(runs => {
      if (!runs.some(run => run.id === id)) throw new Error('Unknown runId');
      return runs.map(run => run.id === id ? core.updateRun(run, change, source) : run);
    });
  }

  async chooseRun(element) {
    if (element?.run) return this.runs.find(run => run.id === element.run.id);
    const selected = await vscode.window.showQuickPick(this.runs.map(run => ({
      label: `$(${STATUS[run.status]?.[1] || 'circle-outline'}) ${run.requirementUrl || 'Local'}: ${run.skill}`,
      description: `${STATUS[run.status][0]} • ${path.basename(run.repo)}`,
      detail: run.summary,
      run
    })), { title: 'SkillBento: Select a run' });
    return selected?.run;
  }

  async update(element) {
    const run = await this.chooseRun(element);
    if (!run) return;
    const selected = await vscode.window.showQuickPick(core.STATUSES.filter(status => status !== 'sent').map(status => ({
      label: `$(${STATUS[status][1]}) ${STATUS[status][0]}`,
      description: status,
      status
    })), { title: 'SkillBento: Manual status update' });
    if (!selected) return;
    const summary = await vscode.window.showInputBox({ title: 'SkillBento: Actual result / evidence / reason', value: run.summary, validateInput: value => value.trim() ? undefined : 'A factual note is required' });
    if (summary === undefined) return;
    const artifact = await vscode.window.showInputBox({ title: 'SkillBento: Result file relative to repository (optional)', placeHolder: 'docs/test/integration/result.html' });
    if (artifact === undefined) return;
    const artifacts = artifact.trim() ? [...new Set([...run.artifacts, artifact.trim()])] : run.artifacts;
    for (const file of artifacts) await this.safeArtifact(run, file);
    await this.change(run.id, { status: selected.status, summary, artifacts }, 'manual');
  }

  runDetailsHtml(run, nonce) {
    const terminal = ['completed', 'failed', 'cancelled'].includes(run.status);
    const status = STATUS[run.status]?.[0] || run.status;
    const events = (Array.isArray(run.events) ? run.events : []).map(event => `<li class="event"><div class="event-header"><strong>${escapeHtml(STATUS[event.status]?.[0] || event.status)}</strong><time>${escapeHtml(event.at)}</time></div><p>${escapeHtml(event.summary)}</p></li>`).join('');
    const artifacts = (Array.isArray(run.artifacts) ? run.artifacts : []).map(artifact => `<li class="artifact-item"><button type="button" class="link artifact-btn" data-action="open-artifact" data-path="${escapeHtml(artifact)}"><span class="doc-icon">&#128196;</span>${escapeHtml(artifact)}</button></li>`).join('');
    const cancelAction = terminal ? '' : '<button type="button" class="secondary" data-action="cancel">Mark as cancelled</button>';
    const deleteAction = terminal ? '<button type="button" class="danger" data-action="delete">Delete from history</button>' : '';
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src https://fonts.gstatic.com; style-src 'nonce-${nonce}' https://fonts.googleapis.com; script-src 'nonce-${nonce}';">
<title>SkillBento Run Details</title>
<style nonce="${nonce}">
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

:root {
  --bento-radius: 12px;
  --bento-card-bg: var(--vscode-sideBar-background, rgba(127, 127, 127, 0.05));
  --bento-border: var(--vscode-widget-border, rgba(255, 255, 255, 0.1));
}
body {
  font-family: 'Inter', var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif);
  color: var(--vscode-foreground);
  line-height: 1.68;
  letter-spacing: -0.011em;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  background: radial-gradient(circle at 10% 0%, rgba(55, 148, 255, 0.06) 0%, transparent 45%),
              radial-gradient(circle at 90% 100%, rgba(139, 92, 246, 0.04) 0%, transparent 45%),
              var(--vscode-editor-background);
  min-height: 100vh;
  margin: 0;
  padding: 36px 28px;
  box-sizing: border-box;
}
.bento-container { max-width: 920px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px; }
.bento-header-card {
  background: var(--bento-card-bg);
  border: 1px solid var(--bento-border);
  border-radius: var(--bento-radius);
  padding: 26px 30px;
  position: relative;
  overflow: hidden;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(10px);
}
.bento-header-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, #38bdf8, #818cf8, #c084fc);
}
.brand-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--vscode-textLink-foreground, #38bdf8);
  margin-bottom: 12px;
}
h1 {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 14px;
  line-height: 1.35;
  letter-spacing: -0.025em;
  color: var(--vscode-editor-foreground);
}
h2 {
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  line-height: 1.5;
  color: var(--vscode-descriptionForeground);
  margin: 0 0 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin: 6px 0 0;
  padding: 6px 16px;
  border-radius: 20px;
  font-family: 'Inter', sans-serif;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.4;
  border: 1px solid var(--vscode-widget-border);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
}
@keyframes pulse {
  0% { transform: scale(0.95); opacity: 0.8; }
  50% { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(0.95); opacity: 0.8; }
}
.status-running { color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); background: rgba(56, 189, 248, 0.12); }
.status-running::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: #38bdf8; animation: pulse 1.5s infinite; }
.status-completed { color: #4ade80; border-color: rgba(74, 222, 128, 0.4); background: rgba(74, 222, 128, 0.12); }
.status-completed::before { content: '&#10003;'; font-size: 11px; }
.status-failed { color: #f87171; border-color: rgba(248, 113, 113, 0.4); background: rgba(248, 113, 113, 0.12); }
.status-failed::before { content: '&#10007;'; font-size: 11px; }
.status-pending_evidence, .status-needs_approval { color: #facc15; border-color: rgba(250, 204, 21, 0.4); background: rgba(250, 204, 21, 0.12); }
.status-pending_evidence::before, .status-needs_approval::before { content: '&#9888;'; font-size: 11px; }
.status-cancelled { color: var(--vscode-descriptionForeground); border-color: var(--vscode-widget-border); background: rgba(127, 127, 127, 0.08); }

.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 16px; }
.field {
  background: var(--bento-card-bg);
  border: 1px solid var(--bento-border);
  border-radius: var(--bento-radius);
  padding: 16px 20px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.06);
}
.field strong {
  display: block;
  margin-bottom: 8px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  line-height: 1.4;
  color: var(--vscode-descriptionForeground);
  font-weight: 600;
}
.bento-section {
  background: var(--bento-card-bg);
  border: 1px solid var(--bento-border);
  border-radius: var(--bento-radius);
  padding: 24px 28px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);
}
pre {
  white-space: pre-wrap;
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', var(--vscode-editor-font-family, monospace);
  line-height: 1.75;
  font-size: 13px;
  letter-spacing: 0;
  margin: 0;
  padding: 16px 18px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--bento-border);
  border-radius: 8px;
}
pre.highlight {
  border-left: 3px solid #38bdf8;
  background: rgba(56, 189, 248, 0.03);
}
.muted, time { color: var(--vscode-descriptionForeground); font-size: 12.5px; line-height: 1.65; }
ol, ul { padding-left: 0; margin: 0; list-style: none; }
.artifact-list { display: flex; flex-direction: column; gap: 10px; }
.artifact-item { list-style: none; }
.artifact-btn {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--bento-border);
  border-radius: 6px;
  color: var(--vscode-textLink-foreground, #38bdf8);
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12.5px;
  line-height: 1.5;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.2s ease;
}
.artifact-btn:hover {
  background: rgba(56, 189, 248, 0.1);
  border-color: #38bdf8;
  transform: translateX(2px);
}
.event {
  margin: 12px 0;
  list-style: none;
  padding: 14px 18px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--bento-border);
  border-radius: 8px;
  border-left: 3px solid #818cf8;
}
.event-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.event strong { font-size: 13.5px; line-height: 1.5; color: var(--vscode-foreground); }
.event time { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; line-height: 1.4; }
.event p { white-space: pre-wrap; margin: 6px 0 0; font-size: 13px; line-height: 1.7; color: var(--vscode-descriptionForeground); }

.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 14px; align-items: center; }
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  padding: 11px 22px;
  border-radius: 8px;
  color: var(--vscode-button-foreground);
  background: linear-gradient(135deg, var(--vscode-button-background), #2563eb);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.45;
  letter-spacing: -0.01em;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
  transition: all 0.2s ease;
}
button:hover {
  background: var(--vscode-button-hoverBackground, #1d4ed8);
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
}
button:active { transform: translateY(0); }
button.secondary {
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground, rgba(127, 127, 127, 0.15));
  box-shadow: none;
}
button.secondary:hover {
  background: var(--vscode-button-secondaryHoverBackground, rgba(127, 127, 127, 0.25));
  color: var(--vscode-foreground);
}
button.danger {
  color: #f87171;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.3);
  box-shadow: none;
}
button.danger:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}
#error { color: var(--vscode-errorForeground); min-height: 1.4em; margin-top: 10px; font-size: 13px; line-height: 1.6; }
</style></head><body>
<div class="bento-container">
<section class="bento-header-card">
  <div class="brand-badge">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 7 10-4 2 3-10 4Z"/><path d="M3 12h18l-1.4 7.4a2 2 0 0 1-2 1.6H6.4a2 2 0 0 1-2-1.6Z"/></svg>
    SkillBento Run Hub
  </div>
  <h1>${escapeHtml(run.requirementUrl || 'Local run')}: ${escapeHtml(run.skill)}</h1>
  <div class="status status-${escapeHtml(run.status)}">${escapeHtml(status)}</div>
</section>

<section class="grid">
  <div class="field"><strong>Repository</strong>${escapeHtml(run.repo)}</div>
  <div class="field"><strong>Requirement URL</strong>${escapeHtml(run.requirementUrl || 'Not supplied')}</div>
  <div class="field"><strong>Created</strong>${escapeHtml(run.createdAt)}</div>
  <div class="field"><strong>Last updated</strong>${escapeHtml(run.updatedAt)}</div>
  <div class="field"><strong>Run ID</strong>${escapeHtml(run.id)}</div>
</section>

<section class="bento-section">
  <h2>Request</h2>
  <pre>${escapeHtml(run.input || 'No additional request; the skill default workflow was selected.')}</pre>
</section>

<section class="bento-section">
  <h2>Latest update</h2>
  <pre class="highlight">${escapeHtml(run.summary || 'No progress update has been reported.')}</pre>
</section>

<section class="bento-section">
  <h2>Evidence and result files</h2>
  ${artifacts ? `<ul class="artifact-list">${artifacts}</ul>` : '<p class="muted">No result files attached.</p>'}
</section>

<section class="bento-section">
  <h2>Status history</h2>
  ${events ? `<ol>${events}</ol>` : '<p class="muted">No status changes have been reported.</p>'}
</section>

<p class="muted">Run status is manually reported; this view does not monitor Copilot Chat or external work.</p>

<div class="actions">
  <button type="button" data-action="copy">Copy original prompt</button>
  ${cancelAction}
  ${deleteAction}
</div>

<p id="error" role="alert" aria-live="polite"></p>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.action === 'copy') {
    const originalText = button.textContent;
    button.textContent = 'Copied to clipboard!';
    setTimeout(() => { button.textContent = originalText; }, 2000);
  }
  vscode.postMessage({ type: button.dataset.action, path: button.dataset.path });
}));
window.addEventListener('keydown', event => { if (event.key === 'Escape') vscode.postMessage({ type: 'cancel' }); });
window.addEventListener('message', event => { if (event.data.type === 'error') document.getElementById('error').textContent = event.data.message; });
</script></body></html>`;
  }

  async cancelRun(id) {
    const run = this.runs.find(item => item.id === id);
    if (!run) throw new Error('Unknown runId');
    if (['completed', 'failed', 'cancelled'].includes(run.status)) throw new Error('This run is already in a terminal status');
    await this.change(id, { status: 'cancelled', summary: 'Marked as cancelled in Runs. Copilot Chat and external work are not stopped.' }, 'manual');
    return this.runs.find(item => item.id === id);
  }

  async deleteRun(id) {
    const run = this.runs.find(item => item.id === id);
    if (!run) throw new Error('Unknown runId');
    if (!['completed', 'failed', 'cancelled'].includes(run.status)) throw new Error('Mark this run as cancelled before deleting it from history');
    const answer = await vscode.window.showWarningMessage(`Delete ${run.requirementUrl || 'local'}: ${run.skill} from local SkillBento history? Result files and Copilot Chat will not be deleted.`, { modal: true }, 'Delete');
    if (answer !== 'Delete') return false;
    await this.mutate(runs => runs.filter(item => item.id !== id));
    return true;
  }

  async result(element) {
    const run = await this.chooseRun(element);
    if (!run) return;
    const nonce = randomBytes(16).toString('base64');
    const panel = vscode.window.createWebviewPanel('skillBento.runDetails', `Run: ${run.requirementUrl || run.skill}`, vscode.ViewColumn.Active, { enableScripts: true });
    panel.webview.html = this.runDetailsHtml(run, nonce);
    panel.webview.onDidReceiveMessage(async message => {
      try {
        if (message?.type === 'copy') await vscode.env.clipboard.writeText(core.buildPrompt(run));
        else if (message?.type === 'cancel') {
          const updated = await this.cancelRun(run.id);
          panel.webview.html = this.runDetailsHtml(updated, nonce);
        } else if (message?.type === 'delete' && await this.deleteRun(run.id)) panel.dispose();
        else if (message?.type === 'open-artifact' && typeof message.path === 'string') {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(await this.safeArtifact(run, message.path)));
        }
      } catch (error) { await panel.webview.postMessage({ type: 'error', message: error.message }); }
    });
  }

  async safeArtifact(run, artifact) {
    if (!core.isWithin(run.repo, artifact) || path.isAbsolute(artifact)) throw new Error('Artifact is outside the repository or not relative');
    let root, file;
    try {
      root = await fs.realpath(run.repo);
      file = await fs.realpath(path.resolve(run.repo, artifact));
    } catch {
      throw new Error('Artifact must be an existing file inside the repository');
    }
    if (!core.isWithin(root, file)) throw new Error('Artifact must be an existing file inside the repository');
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error('Artifact must be an existing file inside the repository');
    } catch {
      throw new Error('Artifact must be an existing file inside the repository');
    }
    return file;
  }
}

async function activate(context) {
  const hub = new Hub(context);
  const register = (name, action) => context.subscriptions.push(vscode.commands.registerCommand(`skillBento.${name}`, async (...args) => {
    try { return await action(...args); }
    catch (error) { hub.output.appendLine(error.stack || error.message); vscode.window.showErrorMessage(`SkillBento: ${error.message}`); }
  }));
  register('open', () => vscode.commands.executeCommand('workbench.view.extension.skillBento'));
  const entry = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  entry.text = '$(tools) SkillBento';
  entry.tooltip = 'Open SkillBento';
  entry.command = 'skillBento.open';
  entry.show();
  context.subscriptions.push(entry);
  hub.statusBarItem = entry;
  register('refresh', () => hub.refresh());
  register('filters', () => hub.chooseFilters());
  register('search', () => hub.search());
  register('resetFilters', () => hub.resetFilters());
  register('run', element => hub.launch(element));
  register('update', element => hub.update(element));
  register('result', element => hub.result(element));
  register('cancelRun', async element => {
    const run = await hub.chooseRun(element);
    if (run) return hub.cancelRun(run.id);
  });
  register('deleteRun', async element => {
    const run = await hub.chooseRun(element);
    if (run) return hub.deleteRun(run.id);
  });
  register('details', element => element?.skill && vscode.commands.executeCommand('vscode.open', vscode.Uri.file(element.skill.file)));
  register('copy', async element => {
    const run = await hub.chooseRun(element);
    if (run) await vscode.env.clipboard.writeText(core.buildPrompt(run));
  });
  register('clear', async () => {
    const answer = await vscode.window.showWarningMessage('Clear local SkillBento history? Result files will not be deleted.', { modal: true }, 'Clear');
    if (answer === 'Clear') await hub.mutate(() => []);
  });
  hub.catalogView = vscode.window.createTreeView('skillBento.catalog', { showCollapseAll: true, treeDataProvider: {
    onDidChangeTreeData: hub.changed.event, getChildren: element => hub.catalogChildren(element), getTreeItem: element => hub.item(element)
  } });
  context.subscriptions.push(hub.catalogView, hub.changed.event(() => hub.updateCatalogSummary()));
  hub.historyView = vscode.window.createTreeView('skillBento.history', { treeDataProvider: {
    onDidChangeTreeData: hub.historyChanged.event, getChildren: element => hub.historyChildren(element), getTreeItem: element => hub.item(element)
  } });
  context.subscriptions.push(hub.historyView);
  context.subscriptions.push(vscode.lm.registerTool('skillBento_updateRun', {
    prepareInvocation: options => ({ invocationMessage: `SkillBento ${options.input.runId}: ${options.input.status}` }),
    invoke: async options => {
      const input = options.input;
      const run = hub.runs.find(item => item.id === input.runId);
      if (!run) throw new Error('Unknown runId');
      for (const artifact of input.artifacts || []) await hub.safeArtifact(run, artifact);
      await hub.change(input.runId, input, 'copilot-tool');
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Updated ${input.runId}: ${input.status}. No test-pass or approval inferred.`)]);
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => hub.refresh().catch(error => hub.output.appendLine(error.message))));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('skillBento')) hub.refresh().catch(error => hub.output.appendLine(error.message));
  }));
  const watcher = vscode.workspace.createFileSystemWatcher('**/{.agents,.github}/skills/**/SKILL.md');
  let timer;
  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => hub.refresh().catch(error => hub.output.appendLine(error.message)), 300); };
  context.subscriptions.push(watcher, watcher.onDidCreate(refresh), watcher.onDidChange(refresh), watcher.onDidDelete(refresh), { dispose: () => clearTimeout(timer) });
  await hub.refresh();
  hub.updateCatalogSummary();
  hub.updateStatusSummary();
  return hub;
}

module.exports = { activate, Hub };