const assert = require('assert');
const vscode = require('vscode');

suite('SkillBento in Extension Host', () => {
	test('activates, discovers the catalog, registers commands and the progress tool', async () => {
		const extension = vscode.extensions.getExtension('skillbento-local.skillbento');
		assert.ok(extension);
		const hub = await extension.activate();
		const container = extension.packageJSON.contributes.viewsContainers.activitybar.find(item => item.id === 'skillBento');
		assert.ok(container, 'Dedicated SkillBento Activity Bar container must exist');
		assert.ok(extension.packageJSON.contributes.views.skillBento.some(view => view.id === 'skillBento.catalog'));
		assert.ok(!extension.packageJSON.contributes.views.skillBento.some(view => view.id === 'skillBento.details'), 'Skill Details panel must be removed');
		await vscode.commands.executeCommand('skillBento.open');
		await vscode.commands.executeCommand('skillBento.refresh');
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
		assert.ok(leaves.every(element => hub.item(element).command.command === 'skillBento.run'));
		assert.equal(new Set(leaves.map(element => element.skill.name)).size, leaves.length);
		hub.query = 'ios-coding';
		hub.changed.fire();
		assert.match(hub.catalogView.message, /ios-coding/);
		assert.equal(hub.item(hub.catalogChildren()[0]).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
		await vscode.commands.executeCommand('skillBento.resetFilters');
		assert.equal(hub.catalogView.message, undefined);
		assert.ok(vscode.lm.tools.some(tool => tool.name === 'skillBento_updateRun'));
		const commands = await vscode.commands.getCommands();
		assert.ok(commands.includes('skillBento.run'));
		assert.ok(commands.includes('skillBento.search'));
	});
});
