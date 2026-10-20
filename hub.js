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
    context.subscriptions.push(this.changed, this.historyChanged, this.output);
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
  }

  catalogChildren(element) {
    const visible = core.catalogSkills(this.skills, this.filters, this.query);
    if (!element) return core.CATEGORIES.map(category => ({ kind: 'category', category,
      count: visible.filter(skill => core.categoryOf(skill) === category.id).length })).filter(group => group.count);
    if (element.kind === 'category') return visible.filter(skill => core.categoryOf(skill) === element.category.id).map(skill => ({ kind: 'skill', skill }));
    return [];
  }

  item(element) {
    if (element.kind === 'category') {
      const item = new vscode.TreeItem(element.category.label, this.query ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `category:${element.category.id}${this.query ? `:search:${this.query}` : ''}`;
      item.description = String(element.count);
      item.iconPath = new vscode.ThemeIcon(element.category.icon);
      item.contextValue = 'skillBentoCategory';
      item.tooltip = `${element.category.label}: ${element.count} skills`;
      return item;
    }
    if (element.kind === 'skill') {
      const skill = element.skill;
      const item = new vscode.TreeItem(skill.label);
      item.id = skill.name;
      item.description = `${skill.platform} / ${skill.role}${skill.invocable ? '' : ' / reference only'}`;
      item.tooltip = `${skill.name}\n${skill.description}\n${skill.file}`;
      item.iconPath = new vscode.ThemeIcon(!skill.invocable ? 'book' : skill.platform === 'all' ? 'tools' : 'device-mobile');
      item.contextValue = 'skillBentoSkill';
      item.command = { command: 'skillBento.run', title: 'Review Skill', arguments: [element] };
      return item;
    }
    const run = element.run;
    const item = new vscode.TreeItem(run.skill);
    item.id = run.id;
    item.description = `${STATUS[run.status][0]} | ${path.basename(run.repo)}`;
    item.tooltip = `${run.requirementUrl || 'Local run'}\n${run.repo}\n${run.updatedAt}\n${run.summary}`;
    item.iconPath = new vscode.ThemeIcon(STATUS[run.status][1]);
    item.contextValue = ['completed', 'failed', 'cancelled'].includes(run.status) ? 'skillBentoRunTerminal' : 'skillBentoRunActive';
    item.command = { command: 'skillBento.result', title: 'Run Details', arguments: [element] };
    return item;
  }

  async chooseFilters() {
    const role = await vscode.window.showQuickPick(['all', 'dev', 'tester'], { title: 'SkillBento: Role' });
    if (!role) return;
    const platform = await vscode.window.showQuickPick(['all', 'ios', 'android'], { title: 'SkillBento: Platform' });
    if (!platform) return;
    this.filters = { role, platform };
    await this.context.globalState.update('filters', this.filters);
    this.changed.fire();
  }

  async search() {
    const query = await vscode.window.showInputBox({ title: 'SkillBento: Search Skills', value: this.query,
      placeHolder: 'Skill name, description, iOS, Android...', prompt: 'Leave empty to show all matching skills' });
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
    const options = candidates.map(repo => `<option value="${escapeHtml(repo)}">${escapeHtml(path.basename(repo))} - ${escapeHtml(repo)}</option>`).join('');
    const hint = skill.hint ? `<p class="hint">Skill input hint: ${escapeHtml(skill.hint)}</p>` : '';
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'none';">
<title>Launch ${escapeHtml(skill.label)}</title>
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 760px; margin: 0 auto; padding: 24px; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
.description, .hint { color: var(--vscode-descriptionForeground); line-height: 1.5; }
.meta, .note { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; }
form { display: grid; gap: 18px; margin-top: 24px; }
label { display: grid; gap: 6px; font-weight: 600; }
label span { font-size: 12px; font-weight: 400; color: var(--vscode-descriptionForeground); }
input, select, textarea { box-sizing: border-box; width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); padding: 8px; font: inherit; }
textarea { resize: vertical; min-height: 120px; }
input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
button { border: 0; padding: 7px 14px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
#error { color: var(--vscode-errorForeground); min-height: 1.4em; }
</style></head><body>
<h1>${escapeHtml(skill.label)}</h1><p class="description">${escapeHtml(skill.description)}</p>
<p class="meta">Platform: ${escapeHtml(skill.platform)} | Role: ${escapeHtml(skill.role)}</p>${hint}
<p class="note">Submitting opens Copilot Chat with a prepared prompt. It does not confirm execution or bypass the skill's approval gates.</p>
<form id="launch-form">
<label for="repo">Target repository<select id="repo" required>${options}</select></label>
<label for="requirementUrl">Requirement URL <span>Optional; HTTP or HTTPS link to the request</span><input id="requirementUrl" type="url" pattern="https?://.*" placeholder="https://example.com/requirements/42"></label>
<label for="request">Request, input file, or diff <span>Optional; leave blank to follow the skill's default workflow</span><textarea id="request" placeholder="${escapeHtml(skill.hint || 'Add context for this run, if needed.')}"></textarea></label>
<p id="error" role="alert" aria-live="polite"></p>
<div class="actions"><button type="button" class="secondary" id="cancel">Cancel</button><button type="submit">Open Copilot Chat</button></div>
</form>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('launch-form').addEventListener('submit', event => {
  event.preventDefault();
  vscode.postMessage({ type: 'launch', repo: document.getElementById('repo').value, requirementUrl: document.getElementById('requirementUrl').value, request: document.getElementById('request').value });
});
document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
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
        const targetPlatforms = this.skills.filter(item => item.repo === message.repo).map(item => item.platform).filter(platform => platform !== 'all');
        if (skill.platform !== 'all' && targetPlatforms.length && !targetPlatforms.includes(skill.platform)) {
          await panel.webview.postMessage({ type: 'error', message: 'This skill does not match the target repository platform.' });
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
      const selected = await vscode.window.showQuickPick(unique.map(item => ({ label: item.label, description: item.name, detail: item.description, skill: item })), { title: 'SkillBento: Select a task', matchOnDescription: true, matchOnDetail: true });
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
      await this.context.globalState.update('runs', next);
      this.runs = next;
      this.historyChanged.fire();
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
    const selected = await vscode.window.showQuickPick(this.runs.map(run => ({ label: `${run.requirementUrl || 'Local'}: ${run.skill}`, description: `${STATUS[run.status][0]} | ${path.basename(run.repo)}`, run })), { title: 'SkillBento: Select a run' });
    return selected?.run;
  }

  async update(element) {
    const run = await this.chooseRun(element);
    if (!run) return;
    const selected = await vscode.window.showQuickPick(core.STATUSES.filter(status => status !== 'sent').map(status => ({ label: STATUS[status][0], status })), { title: 'SkillBento: Manual status update' });
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
    const events = (Array.isArray(run.events) ? run.events : []).map(event => `<li class="event"><strong>${escapeHtml(STATUS[event.status]?.[0] || event.status)}</strong><time>${escapeHtml(event.at)}</time><p>${escapeHtml(event.summary)}</p></li>`).join('');
    const artifacts = (Array.isArray(run.artifacts) ? run.artifacts : []).map(artifact => `<li><button type="button" class="link" data-action="open-artifact" data-path="${escapeHtml(artifact)}">${escapeHtml(artifact)}</button></li>`).join('');
    const cancelAction = terminal ? '' : '<button type="button" class="secondary" data-action="cancel">Mark as cancelled</button>';
    const deleteAction = terminal ? '<button type="button" class="danger" data-action="delete">Delete from history</button>' : '';
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>SkillBento Run Details</title>
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 900px; margin: 0 auto; padding: 24px; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
h2 { font-size: 14px; margin: 24px 0 8px; }
.muted, time { color: var(--vscode-descriptionForeground); font-size: 12px; }
.status { display: inline-block; margin: 10px 0 18px; padding: 4px 8px; border: 1px solid var(--vscode-widget-border); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.field, pre, .event { border: 1px solid var(--vscode-widget-border); padding: 12px; overflow-wrap: anywhere; }
.field strong { display: block; margin-bottom: 5px; }
pre { white-space: pre-wrap; font: inherit; line-height: 1.5; }
ol, ul { padding-left: 22px; }
.event { margin: 8px 0; list-style: none; }
.event p { white-space: pre-wrap; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
button { border: 0; padding: 7px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary, button.link { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.danger { color: var(--vscode-errorForeground); background: var(--vscode-button-secondaryBackground); }
button.link { padding: 0; text-align: left; text-decoration: underline; }
#error { color: var(--vscode-errorForeground); min-height: 1.4em; margin-top: 12px; }
</style></head><body>
<h1>${escapeHtml(run.requirementUrl || 'Local run')}: ${escapeHtml(run.skill)}</h1>
<div class="status">${escapeHtml(status)}</div>
<section class="grid">
  <div class="field"><strong>Repository</strong>${escapeHtml(run.repo)}</div>
  <div class="field"><strong>Requirement URL</strong>${escapeHtml(run.requirementUrl || 'Not supplied')}</div>
  <div class="field"><strong>Created</strong>${escapeHtml(run.createdAt)}</div>
  <div class="field"><strong>Last updated</strong>${escapeHtml(run.updatedAt)}</div>
  <div class="field"><strong>Run ID</strong>${escapeHtml(run.id)}</div>
</section>
<h2>Request</h2><pre>${escapeHtml(run.input || 'No additional request; the skill default workflow was selected.')}</pre>
<h2>Latest update</h2><pre>${escapeHtml(run.summary || 'No progress update has been reported.')}</pre>
<h2>Evidence and result files</h2>${artifacts ? `<ul>${artifacts}</ul>` : '<p class="muted">No result files attached.</p>'}
<h2>Status history</h2>${events ? `<ol>${events}</ol>` : '<p class="muted">No status changes have been reported.</p>'}
<p class="muted">Run status is manually reported; this view does not monitor Copilot Chat or external work.</p>
<div class="actions"><button type="button" data-action="copy">Copy original prompt</button>${cancelAction}${deleteAction}</div>
<p id="error" role="alert" aria-live="polite"></p>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
  vscode.postMessage({ type: button.dataset.action, path: button.dataset.path });
}));
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
    const root = await fs.realpath(run.repo);
    const file = await fs.realpath(path.resolve(run.repo, artifact));
    if (!core.isWithin(root, file) || !(await fs.stat(file)).isFile()) throw new Error('Artifact must be an existing file inside the repository');
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
  context.subscriptions.push(vscode.window.createTreeView('skillBento.history', { treeDataProvider: {
    onDidChangeTreeData: hub.historyChanged.event, getChildren: () => hub.runs.map(run => ({ kind: 'run', run })), getTreeItem: element => hub.item(element)
  } }));
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
  return hub;
}

module.exports = { activate, Hub };