const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core');

test('parses YAML, block descriptions and role/platform', () => {
  const skill = core.parseSkill('---\nname: ios-test-execution\ndescription: >\n  Run tests:\n  on iOS.\n---\nBody', 'ios-test-execution');
  assert.equal(skill.platform, 'ios');
  assert.equal(skill.role, 'tester');
  assert.match(skill.description, /Run tests: on iOS/);
  assert.equal(core.matches(skill, { platform: 'android', role: 'tester' }), false);
  assert.equal(core.matches(skill, { platform: 'ios', role: 'all' }), true);

  const custom = core.parseSkill('---\nname: my-tool\ndescription: Custom skill\nplatform: android\nrole: dev\ncategory: tools\n---\n', 'my-tool');
  assert.equal(custom.platform, 'android');
  assert.equal(custom.role, 'dev');
  assert.equal(core.categoryOf(custom), 'tools');
});

test('rejects invalid metadata and preserves non-user-invocable skills', () => {
  assert.throws(() => core.parseSkill('No metadata', 'a'));
  assert.throws(() => core.parseSkill('---\nname: wrong\ndescription: Test\n---\n', 'a'));
  assert.equal(core.parseSkill('---\nname: helper\ndescription: Test\nuser-invocable: false\n---\n', 'helper').invocable, false);
});

test('runs begin unconfirmed and prompts preserve evidence and approvals', () => {
  const run = core.createRun({ name: 'test-item-generation', file: '/skills/SKILL.md' }, '/repo', 'https://example.com/requirements/1', 'Create tests');
  assert.equal(run.status, 'sent');
  const prompt = core.buildPrompt(run);
  for (const text of [run.id, '/skills/SKILL.md', 'https://example.com/requirements/1', '#skillbentoUpdateRun']) assert.ok(prompt.includes(text));
  assert.doesNotMatch(prompt, /Target repository: \/repo/);
  assert.doesNotMatch(prompt, /approval gates|tests passed|DoD/);
  assert.throws(() => core.updateRun(run, { status: 'completed', summary: '' }, 'manual'));
  const next = core.updateRun(run, { status: 'pending_evidence', summary: 'requirements service not accessible' }, 'copilot-tool');
  assert.equal(run.status, 'sent');
  assert.equal(next.events[0].source, 'copilot-tool');
  assert.equal(next.status, 'pending_evidence');
});

test('runs keep repository metadata out of the skill prompt', () => {
  const skill = { name: 'test-item-generation', file: '/skills/SKILL.md' };
  const run = core.createRun(skill, '/project/code', '', 'Update the service');
  const prompt = core.buildPrompt(run);
  assert.equal(run.repo, '/project/code');
  assert.equal(Object.hasOwn(run, 'folders'), false);
  assert.doesNotMatch(prompt, /Target repository|Project folders|Work folder|Reference folder/);
  assert.equal(core.isWithinRepo(run, 'docs/result.md'), true);
  assert.equal(core.isWithinRepo(run, '../outside/result.md'), false);
  assert.throws(() => core.updateRun(run, { status: 'completed', summary: 'Done', artifacts: ['../outside/result.md'] }, 'manual'), /inside the run repository/);
});

test('prompts directly request skill execution without extra workflow rules', () => {
  const run = core.createRun({ name: 'test-item-generation', file: '/skills/SKILL.md' }, '/project/code', '', 'Generate test cases');
  const prompt = core.buildPrompt(run);
  assert.match(prompt, /Execute the test-item-generation skill/);
  assert.match(prompt, /Read its full definition at \/skills\/SKILL\.md/);
  assert.match(prompt, /User request:\nGenerate test cases/);
  assert.doesNotMatch(prompt, /Treat the selected skill as authoritative|do not add, omit|stop and ask the user/);
  assert.doesNotMatch(prompt, /For test-case generation/);
});

test('requirement URLs are optional, web-only and cannot include credentials', () => {
  assert.equal(core.validateRequirementUrl(''), '');
  assert.equal(core.validateRequirementUrl(' https://example.com/request/1 '), 'https://example.com/request/1');
  for (const value of ['TASK-1', 'javascript:alert(1)', 'file:///tmp/input', 'https://user:secret@example.com']) {
    assert.throws(() => core.validateRequirementUrl(value));
  }
});

test('an empty optional request uses the skill default workflow', () => {
  const run = core.createRun({ name: 'test-item-generation', file: '/skills/SKILL.md' }, '/repo', '', '');
  const prompt = core.buildPrompt(run);
  assert.match(prompt, /No additional request was supplied; follow the selected skill's default workflow\./);
  assert.doesNotMatch(prompt, /User request:\nundefined/);
});

test('artifact paths cannot escape repository', () => {
  for (const file of ['../secret', '/elsewhere/file', '/repo', '..']) assert.equal(core.isWithin('/repo', file), false);
  assert.equal(core.isWithin('/repo', 'docs/result.html'), true);
  const run = core.createRun({ name: 'test', file: '/skill' }, '/repo', '', 'test');
  assert.throws(() => core.updateRun(run, { status: 'completed', summary: 'Done', artifacts: ['../secret'] }, 'manual'));
});