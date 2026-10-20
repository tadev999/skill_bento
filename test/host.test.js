const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function host() {
  const commands = new Map();
  const tools = new Map();
  const views = new Map();
  const detailProviders = new Map();
  const treeViews = new Map();
  const launchPanels = [];
  const state = new Map();
  const picks = [];
  const inputs = [];
  const sent = [];
  const statusEntries = [];
  const messages = [];
  const warnings = [];
  const answers = [];
  const disposable = () => ({ dispose() {} });
  const vscode = {
    ViewColumn: { Active: -1 },
    StatusBarAlignment: { Left: 1 },
    TreeItemCollapsibleState: { Collapsed: 1, Expanded: 2 },
    EventEmitter: class {
      listeners = new Set();
      event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
      fire() { this.listeners.forEach(listener => listener()); }
      dispose() { this.listeners.clear(); }
    },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class {},
    Uri: { file: file => ({ fsPath: file, scheme: 'file' }) },
    LanguageModelToolResult: class { constructor(content) { this.content = content; } },
    LanguageModelTextPart: class { constructor(value) { this.value = value; } },
    commands: {
      registerCommand: (name, action) => { commands.set(name, action); return disposable(); },
      executeCommand: async (name, ...args) => {
        sent.push([name, ...args]);
        return commands.get(name)?.(...args);
      }
    },
    env: { clipboard: { writeText: async text => { sent.push(['clipboard', text]); } } },
    lm: { registerTool: (name, tool) => { tools.set(name, tool); return disposable(); } },
    window: {
      createStatusBarItem: () => {
        const item = { show() { this.visible = true; }, dispose() {} };
        statusEntries.push(item);
        return item;
      },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createTreeView: (name, options) => {
        views.set(name, options.treeDataProvider);
        const listeners = new Set();
        const treeView = { onDidChangeSelection: listener => { listeners.add(listener); return disposable(); }, select: selection => listeners.forEach(listener => listener({ selection })), dispose() {} };
        treeViews.set(name, treeView);
        return treeView;
      },
      createWebviewPanel: (viewType, title, column, options) => {
        const receiveListeners = new Set();
        const disposeListeners = new Set();
        const panel = { viewType, title, column, options, messages: [], webview: {
          html: '', onDidReceiveMessage: listener => { receiveListeners.add(listener); return disposable(); },
          postMessage: async message => { panel.messages.push(message); }
        },
        onDidDispose: listener => { disposeListeners.add(listener); return disposable(); },
        receive: message => Promise.all([...receiveListeners].map(listener => listener(message))),
        dispose: () => disposeListeners.forEach(listener => listener()) };
        launchPanels.push(panel);
        return panel;
      },
      registerWebviewViewProvider: (name, provider) => { detailProviders.set(name, provider); return disposable(); },
      showQuickPick: async items => { const pick = picks.shift(); return typeof pick === 'number' ? items[pick] : pick; },
      showInputBox: async () => inputs.shift(),
      showInformationMessage: async (...args) => { messages.push(args); return answers.shift(); },
      showWarningMessage: async (...args) => { warnings.push(args); return answers.shift(); }, showErrorMessage() {}
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: path.resolve(__dirname, '../../..'), scheme: 'file' } }],
      getConfiguration: () => ({ get: () => [] }),
      onDidChangeWorkspaceFolders: disposable, onDidChangeConfiguration: disposable,
      createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable })
    }
  };
  const filename = path.resolve(__dirname, '../hub.js');
  const localRequire = createRequire(filename);
  const sandbox = { require: name => name === 'vscode' ? vscode : localRequire(name), module: { exports: {} }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const context = { subscriptions: [], globalState: { get: (key, fallback) => state.get(key) || fallback, update: async (key, value) => { state.set(key, value); } } };
  const activate = async context => {
    const hub = await sandbox.module.exports.activate(context);
    const core = require('../core');
    const repo = vscode.workspace.workspaceFolders[0].uri.fsPath;
    hub.skills = ['test-item-generation', 'test-item-review', 'ios-coding', 'android-coding', 'requirements-analysis', 'design-review', 'code-review', 'orchestrator', 'environment-setup'].map(name => ({
      ...core.parseSkill(`---\nname: ${name}\ndescription: Run ${name} workflow\n---\n`, name), repo, file: path.join(repo, '.agents', 'skills', name, 'SKILL.md')
    }));
    hub.repos = [repo];
    hub.changed.fire();
    return hub;
  };
  return { ...sandbox.module.exports, activate, context, commands, tools, views, detailProviders, treeViews, launchPanels, picks, inputs, sent, statusEntries, messages, warnings, answers, vscode };
}

test('clicking a skill opens its in-editor form directly with purpose and optional requirementUrl and request', async () => {
  const manifest = require('../package.json');
  assert.equal(manifest.contributes.views.skillBento.some(view => view.id === 'skillBento.details'), false);
  const mock = host();
  const hub = await mock.activate(mock.context);
  assert.ok(hub.skills.length > 5);
  assert.ok(mock.views.has('skillBento.history'));
  const skill = hub.skills.find(item => item.name === 'test-item-generation');
  assert.equal(mock.detailProviders.size, 0);
  const item = hub.item({ kind: 'skill', skill });
  assert.equal(item.command.command, 'skillBento.run');
  const launchPromise = mock.commands.get(item.command.command)(...item.command.arguments);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mock.messages.length, 0);
  assert.equal(hub.runs.length, 0);
  assert.equal(mock.launchPanels.length, 1);
  assert.equal(mock.sent.some(([command]) => command === 'workbench.action.chat.open'), false);
  const panel = mock.launchPanels[0];
  assert.ok(panel);
  assert.equal(panel.options.enableScripts, true);
  assert.ok(panel.webview.html.includes(skill.description));
  assert.ok(panel.webview.html.includes(`Platform: ${skill.platform} | Role: ${skill.role}`));
  assert.match(panel.webview.html, /does not confirm execution or bypass the skill's approval gates/);
  assert.match(panel.webview.html, /Target repository/);
  assert.match(panel.webview.html, /Requirement URL <span>Optional/);
  assert.match(panel.webview.html, /Request, input file, or diff <span>Optional/);
  assert.doesNotMatch(panel.webview.html, /id="request"[^>]*required/);
  await panel.receive({ type: 'launch', repo: skill.repo, requirementUrl: 'not-a-url', request: '' });
  assert.equal(hub.runs.length, 0);
  assert.match(panel.messages.at(-1).message, /valid HTTP or HTTPS/);
  await panel.receive({ type: 'launch', repo: skill.repo, requirementUrl: ' https://example.com/requirements/42 ', request: '' });
  await launchPromise;
  assert.equal(hub.runs.length, 1);
  assert.equal(hub.runs[0].status, 'sent');
  assert.equal(hub.runs[0].requirementUrl, 'https://example.com/requirements/42');
  assert.equal(hub.runs[0].input, '');
  const openedChat = mock.sent.find(([command]) => command === 'workbench.action.chat.open');
  assert.ok(openedChat[1].query.includes('https://example.com/requirements/42'));
  assert.match(openedChat[1].query, /follow the selected skill's default workflow/);
  const tool = mock.tools.get('skillBento_updateRun');
  await tool.invoke({ input: { runId: hub.runs[0].id, status: 'pending_evidence', summary: 'Need device matrix' } });
  assert.equal(hub.runs[0].status, 'pending_evidence');
  assert.equal(mock.context.globalState.get('runs')[0].events[0].source, 'copilot-tool');
  await assert.rejects(tool.invoke({ input: { runId: 'missing', status: 'completed', summary: 'Done' } }), /Unknown/);
  await assert.rejects(tool.invoke({ input: { runId: hub.runs[0].id, status: 'completed', summary: 'Done', artifacts: ['../secret'] } }), /outside/);
  mock.vscode.workspace.isTrusted = false;
  await assert.rejects(hub.launch({ skill }), /Trust/);
  mock.context.subscriptions.forEach(item => item.dispose());
});

test('Run Skill picker opens the selected skill form directly without a confirmation dialog', async () => {
  const mock = host();
  const hub = await mock.activate(mock.context);
  mock.picks.push(0);
  const launchPromise = mock.commands.get('skillBento.run')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mock.messages.length, 0);
  assert.equal(mock.picks.length, 0);
  assert.equal(hub.runs.length, 0);
  assert.equal(mock.launchPanels.length, 1);
  mock.launchPanels[0].receive({ type: 'launch', repo: hub.skills.find(skill => skill.invocable).repo, requirementUrl: '', request: '' });
  await launchPromise;
  assert.equal(hub.runs.length, 1);
  mock.context.subscriptions.forEach(item => item.dispose());
});

test('reference skills open their definition directly without creating a run', async () => {
  const mock = host();
  const hub = await mock.activate(mock.context);
  const skill = { ...hub.skills[0], invocable: false };
  const item = hub.item({ kind: 'skill', skill });
  await mock.commands.get(item.command.command)(...item.command.arguments);
  assert.equal(mock.messages.length, 0);
  assert.equal(mock.sent.some(([command]) => command === 'workbench.action.chat.open'), false);
  assert.ok(mock.sent.some(([command, uri]) => command === 'vscode.open' && uri.fsPath === skill.file));
  assert.equal(hub.runs.length, 0);
  mock.context.subscriptions.forEach(item => item.dispose());
});

test('queued status writes preserve concurrent updates and survive reactivation', async () => {
  const mock = host();
  const hub = await mock.activate(mock.context);
  const skill = hub.skills[0];
  const core = require('../core');
  const run = core.createRun(skill, skill.repo, '', 'Test');
  await hub.mutate(() => [run]);
  await Promise.all([
    hub.change(run.id, { status: 'running', summary: 'Started' }, 'copilot-tool'),
    hub.change(run.id, { status: 'needs_approval', summary: 'Await approval' }, 'manual')
  ]);
  assert.equal(hub.runs[0].events.length, 2);
  assert.equal(hub.runs[0].status, 'needs_approval');
  const restored = new mock.Hub(mock.context);
  assert.equal(restored.runs[0].id, run.id);
  mock.context.subscriptions.forEach(item => item.dispose());
});

test('clicking a run opens readable details and lets the user mark it cancelled', async () => {
  const mock = host();
  const hub = await mock.activate(mock.context);
  const core = require('../core');
  const run = core.createRun({ name: 'test-item-generation', file: '/skills/SKILL.md' }, '/repo', 'https://example.com/requirements/1', 'Generate cases');
  const blocked = core.updateRun(run, { status: 'pending_evidence', summary: 'Waiting for the linked specification.', artifacts: ['docs/evidence.md'] }, 'copilot-tool');
  await hub.mutate(() => [blocked]);
  const element = { kind: 'run', run: blocked };
  const item = hub.item(element);
  assert.equal(item.contextValue, 'skillBentoRunActive');
  assert.match(item.description, /Blocked: evidence needed/);
  await mock.commands.get(item.command.command)(...item.command.arguments);
  const panel = mock.launchPanels.at(-1);
  assert.ok(panel);
  assert.equal(panel.viewType, 'skillBento.runDetails');
  for (const text of ['https://example.com/requirements/1', 'test-item-generation', '/repo', 'Generate cases', 'Waiting for the linked specification.', 'docs/evidence.md', 'Status history', 'Mark as cancelled']) {
    assert.ok(panel.webview.html.includes(text), `missing run detail: ${text}`);
  }
  await panel.receive({ type: 'cancel' });
  assert.equal(hub.runs[0].status, 'cancelled');
  assert.match(panel.webview.html, /Cancelled/);
  assert.match(panel.webview.html, /external work are not stopped/);
  assert.equal(hub.item({ kind: 'run', run: hub.runs[0] }).contextValue, 'skillBentoRunTerminal');
  mock.context.subscriptions.forEach(item => item.dispose());
});

test('only terminal runs can be deleted and confirmation removes history but not artifacts', async () => {
  const mock = host();
  const hub = await mock.activate(mock.context);
  const core = require('../core');
  const active = core.createRun({ name: 'test-item-generation', file: '/skills/SKILL.md' }, '/repo', 'https://example.com/requirements/2', 'Generate cases');
  await hub.mutate(() => [active]);
  await assert.rejects(hub.deleteRun(active.id), /Mark this run as cancelled/);
  const cancelled = core.updateRun(active, { status: 'cancelled', summary: 'Cancelled by user.' }, 'manual');
  await hub.mutate(() => [cancelled]);
  mock.answers.push('Delete');
  const item = hub.item({ kind: 'run', run: cancelled });
  assert.equal(item.contextValue, 'skillBentoRunTerminal');
  await mock.commands.get(item.command.command)(...item.command.arguments);
  const panel = mock.launchPanels.at(-1);
  assert.ok(panel.webview.html.includes('Delete from history'));
  await panel.receive({ type: 'delete' });
  assert.equal(hub.runs.length, 0);
  assert.match(mock.warnings[0][0], /Result files and Copilot Chat will not be deleted/);
  mock.context.subscriptions.forEach(item => item.dispose());
});

test('visible status-bar button opens the dedicated sidebar without running a skill', async () => {
  const mock = host();
  const hub = await mock.activate(mock.context);
  assert.equal(mock.statusEntries[0].visible, true);
  assert.equal(mock.statusEntries[0].command, 'skillBento.open');
  await mock.commands.get('skillBento.open')();
  assert.equal(mock.sent[0][0], 'workbench.view.extension.skillBento');
  assert.equal(hub.runs.length, 0);
  mock.context.subscriptions.forEach(item => item.dispose());
});

test('catalog groups each discovered skill once, counts children and supports search and filters', async () => {
  const mock = host();
  const hub = await mock.activate(mock.context);
  const groups = hub.catalogChildren();
  assert.ok(groups.length > 4);
  const leaves = groups.flatMap(group => {
    const children = hub.catalogChildren(group);
    assert.equal(group.count, children.length);
    assert.equal(hub.item(group).collapsibleState, 1);
    assert.equal(hub.item(group).command, undefined);
    return children;
  });
  assert.equal(leaves.length, new Set(hub.skills.map(skill => skill.name)).size);
  assert.equal(new Set(leaves.map(element => element.skill.name)).size, leaves.length);
  const core = require('../core');
  assert.equal(core.categoryOf(hub.skills.find(skill => skill.name === 'ios-coding')), 'implementation');
  assert.equal(core.categoryOf(hub.skills.find(skill => skill.name === 'test-item-review')), 'testing');
  assert.ok(core.catalogSkills(hub.skills, hub.filters, 'IOS CODING').some(skill => skill.name === 'ios-coding'));
  mock.inputs.push('IOS-CODING');
  await mock.commands.get('skillBento.search')();
  const found = hub.catalogChildren();
  assert.equal(found.length, 1);
  assert.equal(hub.item(found[0]).collapsibleState, 2);
  assert.equal(hub.catalogChildren(found[0])[0].skill.name, 'ios-coding');
  assert.match(hub.catalogView.message, /IOS-CODING/);
  assert.equal(hub.catalogView.description, '1 skill');
  mock.inputs.push(undefined);
  await hub.search();
  assert.equal(hub.query, 'IOS-CODING');
  hub.filters = { role: 'dev', platform: 'android' };
  assert.equal(hub.catalogChildren().length, 0);
  hub.updateCatalogSummary();
  assert.match(hub.catalogView.message, /No matching skills/);
  await mock.commands.get('skillBento.resetFilters')();
  assert.equal(hub.query, '');
  assert.equal(hub.filters.platform, 'all');
  assert.equal(hub.catalogChildren().length, groups.length);
  assert.equal(hub.catalogView.message, undefined);
  assert.equal(hub.runs.length, 0);
  mock.context.subscriptions.forEach(item => item.dispose());
});