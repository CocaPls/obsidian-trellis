import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function methodClass(path, className, names, bindings = {}) {
 const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
 const cls = source.statements.find(s => ts.isClassDeclaration(s) && s.name.text === className);
 const methods = names.map(name => cls.members.find(m => m.name?.getText(source) === name).getText(source));
 const code = ts.transpileModule('class Probe {' + methods.join('\n') + '}', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
 return new Function(...Object.keys(bindings), code + ';return Probe;')(...Object.values(bindings));
}

test('unload flushes queued settings and cancels all visual/save debounces', async () => {
 const calls = [];
 const Probe = methodClass('../src/main.ts', 'TrellisPlugin', ['registerLiveSyncCleanup', 'saveSettings'], { window: { clearTimeout: id => calls.push(id) } });
 const p = new Probe(); let cleanup;
 p.register = fn => { cleanup = fn; };
 p.settings = { color: 'pending' }; p.saveData = async value => calls.push(value.color);
 for (const key of ['scheduleSettingsSave', 'scheduleUndoPathSave', 'scheduleTreeRefresh', 'schedulePropertyTagDecoration']) p[key] = { cancel: () => calls.push(key) };
 p.liveSyncTimer = 42; p.pendingLiveSyncPaths = new Set(['Note.md']);
 p.registerLiveSyncCleanup(); cleanup();
 assert.equal(p.disposed, true); assert.equal(p.liveSyncTimer, null); assert.equal(p.pendingLiveSyncPaths.size, 0);
 assert.deepEqual(calls, ['pending', 'scheduleSettingsSave', 'scheduleUndoPathSave', 'scheduleTreeRefresh', 'schedulePropertyTagDecoration', 42]);
 // Resolving a settings write after unload must not schedule another DOM update.
 await p.saveSettings(); assert.equal(calls.at(-1), 'pending');
});

test('startup keeps deferred leaves asleep while repairing only stale loaded leaves', async () => {
 class TrellisTreeView {}
 const Probe = methodClass('../src/main.ts', 'TrellisPlugin', ['rehydrateStaleTreeViews'], { TrellisTreeView, TRELLIS_TREE_VIEW: 'trellis-tree' });
 const deferred = { isDeferred: true, view: {} }, stale = { isDeferred: false, view: {} }, valid = { isDeferred: false, view: new TrellisTreeView() };
 const p = new Probe(), repaired = [];
 p.app = { workspace: { getLeavesOfType: () => [deferred, stale, valid] } };
 p.rehydrateTreeLeaf = async leaf => repaired.push(leaf);
 await p.rehydrateStaleTreeViews(); assert.deepEqual(repaired, [stale]);
});

test('closing bootstrap selection removes mouseup from its original document', () => {
 const Probe = methodClass('../src/modals.ts', 'BootstrapSelectModal', ['onClose'], { activeDocument: { removeEventListener() { throw Error('wrong document'); } } });
 const p = new Probe(), removed = [];
 p.onMouseUp = () => {}; p.mouseDocument = { removeEventListener: (...args) => removed.push(args) }; p.contentEl = { empty() {} };
 p.onClose(); assert.deepEqual(removed, [['mouseup', p.onMouseUp]]); assert.equal(p.mouseDocument, null);
 p.onClose(); assert.equal(removed.length, 1);
});
