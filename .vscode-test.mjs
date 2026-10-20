import { defineConfig } from '@vscode/test-cli';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const userData = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'skillbento-'));
const workspaceFolder = path.join(userData, 'workspace');
for (const name of ['requirements-analysis', 'design-review', 'ios-coding', 'android-coding', 'test-item-generation', 'test-item-review', 'orchestrator', 'environment-setup']) {
	const directory = path.join(workspaceFolder, '.agents', 'skills', name);
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Run ${name} workflow\n---\n`);
}
process.on('exit', () => fs.rmSync(userData, { recursive: true, force: true }));

export default defineConfig({
	files: 'test/extension.test.js',
	workspaceFolder,
	launchArgs: [`--user-data-dir=${userData}`],
});
