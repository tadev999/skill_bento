const assert = require('assert');
const vscode = require('vscode');

suite('SkillBento in Extension Host', () => {
	test('activates, discovers the catalog, registers commands and the progress tool', async () => {
		const extension = vscode.extensions.getExtension('skillbento-local.skill-bento');
		assert.ok(extension);
		const hub = await extension.activate();
		const container = extension.packageJSON.contributes.viewsContainers.activitybar.find(item => item.id === 'skillbento');
		assert.ok(container, 'Dedicated SkillBento Activity Bar container must exist');
		assert.ok(extension.packageJSON.contributes.views.skillbento.some(view => view.id === 'skillbento.catalog'));
		assert.ok(!extension.packageJSON.contributes.views.skillbento.some(view => view.id === 'skillbento.details'), 'Skill Details panel must be removed');
		await vscode.commands.executeCommand('skillbento.open');
		await vscode.commands.executeCommand('skillbento.refresh');
		assert.ok(hub.skills.length > 0);
		const groups = hub.catalogChildren();
		assert.ok(groups.length > 4 && groups.length < 10);
		const leaves = groups.flatMap(group => {
			assert.equal(hub.item(group).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
			const children = hub.catalogChildren(group);
			assert.equal(children.length, group.count);
			return children;
		});
		assert.ok(leaves.length >= 8);
		assert.ok(leaves.every(element => hub.item(element).command.command === 'skillbento.run'));
		assert.equal(new Set(leaves.map(element => element.skill.name)).size, leaves.length);
		hub.query = 'ios-coding';
		hub.changed.fire();
		assert.match(hub.catalogView.message, /ios-coding/);
		assert.equal(hub.item(hub.catalogChildren()[0]).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
		await vscode.commands.executeCommand('skillbento.resetFilters');
		assert.equal(hub.catalogView.message, undefined);
		assert.ok(vscode.lm.tools.some(tool => tool.name === 'skillbento_updateRun'));
		const commands = await vscode.commands.getCommands();
		assert.ok(commands.includes('skillbento.run'));
		assert.ok(commands.includes('skillbento.search'));
	});
});
