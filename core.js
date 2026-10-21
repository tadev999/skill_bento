const path = require('node:path');
const { randomUUID } = require('node:crypto');
const YAML = require('yaml');

const STATUSES = ['sent', 'running', 'pending_evidence', 'needs_approval', 'completed', 'failed', 'cancelled'];

function parseSkill(text, folderName) {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('Missing YAML frontmatter');
  const meta = YAML.parse(match[1]);
  if (!meta || typeof meta.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) || meta.name !== folderName) throw new Error('Skill name must match its directory');
  if (typeof meta.description !== 'string' || !meta.description.trim()) throw new Error('Missing skill description');
  const platform = (typeof meta.platform === 'string' && meta.platform.trim())
    ? meta.platform.trim().toLowerCase()
    : (/android/.test(meta.name) ? 'android' : /ios|apple|swift/.test(meta.name) ? 'ios' : 'all');
  const role = (typeof meta.role === 'string' && meta.role.trim())
    ? meta.role.trim().toLowerCase()
    : (/test|maestro/.test(meta.name) ? 'tester' : /coding|swiftui|code-review|bug-analysis|design-|merge|mr-ops|upstream|apple/.test(meta.name) ? 'dev' : 'all');
  const category = (typeof meta.category === 'string' && meta.category.trim())
    ? meta.category.trim().toLowerCase()
    : undefined;
  return { name: meta.name, label: meta.name.replaceAll('-', ' '),
    description: meta.description, platform, role, category,
    invocable: meta['user-invocable'] !== false,
    hint: typeof meta['argument-hint'] === 'string' ? meta['argument-hint'] : '' };
}

const CATEGORIES = [
  { id: 'requirements', label: 'Requirements & Specifications', icon: 'note' },
  { id: 'design', label: 'Design', icon: 'layout' },
  { id: 'implementation', label: 'Implementation', icon: 'code' },
  { id: 'review', label: 'Code Review & Bug Analysis', icon: 'checklist' },
  { id: 'testing', label: 'Testing & Results', icon: 'beaker' },
  { id: 'workflow', label: 'Workflow & Reporting', icon: 'git-pull-request' },
  { id: 'tools', label: 'Tools & Environment', icon: 'tools' },
  { id: 'reference', label: 'Reference Library', icon: 'library' },
  { id: 'other', label: 'Other Skills', icon: 'extensions' }
];

function categoryOf(skill) {
  if (!skill.invocable) return 'reference';
  if (skill.category && CATEGORIES.some(item => item.id === skill.category)) return skill.category;
  if (/requirements|spec-qa|pbi/.test(skill.name)) return 'requirements';
  if (/design-|figma|layout-to/.test(skill.name)) return 'design';
  if (/test|maestro/.test(skill.name)) return 'testing';
  if (/review|bug-analysis/.test(skill.name)) return 'review';
  if (/coding|swiftui|stubserver/.test(skill.name)) return 'implementation';
  if (/orchestrator|consistency|result-reporting|mr-ops/.test(skill.name)) return 'workflow';
  if (/upstream|vpn|setup|apple-xcode/.test(skill.name)) return 'tools';
  return 'other';
}

function catalogSkills(skills, filters, query = '') {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = skills.filter(skill => matches(skill, filters) && terms.every(term =>
    `${skill.name} ${skill.label} ${skill.description} ${skill.platform} ${skill.role}`.toLowerCase().includes(term)));
  return [...new Map(visible.map(skill => [skill.name, skill])).values()];
}

function matches(skill, filters) {
  return (filters.role === 'all' || skill.role === 'all' || skill.role === filters.role)
    && (filters.platform === 'all' || skill.platform === 'all' || skill.platform === filters.platform);
}

function validateRequirementUrl(value) {
  if (typeof value !== 'string') throw new Error('Requirement URL must be a string');
  const trimmed = value.trim();
  if (!trimmed) return '';
  let url;
  try { url = new URL(trimmed); }
  catch { throw new Error('Enter a valid HTTP or HTTPS requirement URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter an HTTP or HTTPS requirement URL without credentials');
  return trimmed;
}

function createRun(skill, repo, requirementUrl, input) {
  const now = new Date().toISOString();
  return { id: randomUUID(), skill: skill.name, skillPath: skill.file, repo, requirementUrl: validateRequirementUrl(requirementUrl), input,
    status: 'sent', summary: 'Prepared for Copilot; execution not confirmed.', artifacts: [],
    createdAt: now, updatedAt: now, events: [] };
}

function updateRun(run, change, source) {
  if (!STATUSES.includes(change.status) || change.status === 'sent') throw new Error('Invalid run status');
  if (typeof change.summary !== 'string' || !change.summary.trim()) throw new Error('A progress/evidence summary is required');
  if (change.summary.length > 12000) throw new Error('Summary exceeds 12000 characters');
  const artifacts = change.artifacts === undefined ? run.artifacts : change.artifacts;
  if (!Array.isArray(artifacts) || artifacts.some(item => typeof item !== 'string' || !isWithin(run.repo, item))) throw new Error('Artifacts must be files inside the run repository');
  const now = new Date().toISOString();
  return { ...run, status: change.status, summary: change.summary.trim(), artifacts,
    updatedAt: now, events: [...run.events, { at: now, status: change.status, summary: change.summary.trim(), source }].slice(-100) };
}

function isWithin(root, file) {
  const relative = path.relative(root, path.resolve(root, file));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function buildPrompt(run) {
  return [
    `Use the skill ${run.skill}. Read the full skill file at ${run.skillPath} and its required references.`,
    `Target repository: ${run.repo}. Work only in this repository unless explicitly authorized.`,
    run.requirementUrl ? `Requirement URL: ${run.requirementUrl}` : '',
    run.input ? `User request:\n${run.input}` : "No additional request was supplied; follow the selected skill's default workflow.",
    `Local SkillBento runId: ${run.id}.`,
    'If available, use #skillBentoUpdateRun (registered tool skillBento_updateRun) with this exact runId to report running, pending_evidence, needs_approval, completed, failed, or cancelled.',
    'If the status tool is unavailable, report that in chat; the user can update the run manually. Do not create status files as a substitute.',
    'Include a factual summary and repository-relative existing artifact paths. Completed means this requested task finished, NOT that tests passed, DoD was met, or approval was granted.',
    'Preserve skill approval gates. Never infer success from sending the prompt or creating an artifact. Stop and report missing evidence when required.'
  ].filter(Boolean).join('\n\n');
}

module.exports = { STATUSES, CATEGORIES, categoryOf, catalogSkills, parseSkill, matches, createRun, updateRun, isWithin, buildPrompt, validateRequirementUrl };