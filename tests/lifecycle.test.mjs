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

test('closing bootstrap selection removes pointer listeners from its original document', () => {
 const Probe = methodClass('../src/modals.ts', 'BootstrapSelectModal', ['onClose'], { activeDocument: { removeEventListener() { throw Error('wrong document'); } } });
 const p = new Probe(), removed = [];
 p.onPointerEnd = () => {}; p.pointerDocument = { removeEventListener: (...args) => removed.push(args) }; p.contentEl = { empty() {} };
 p.onClose(); assert.deepEqual(removed, [['pointerup', p.onPointerEnd], ['pointercancel', p.onPointerEnd]]); assert.equal(p.pointerDocument, null);
 p.onClose(); assert.equal(removed.length, 2);
});

function selectionFixture() {
 class TFile { constructor(path) { this.path = path; this.basename = path; } }
 class TFolder {}
 const Probe = methodClass('../src/modals.ts', 'BootstrapSelectModal', ['renderNode', 'applyDrag', 'selectRange'], { TFile, TFolder, t: x => x });
 const doc = { activeElement: null };
 class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; }
  createEl(tag) { const el = new Element(tag); this.children.push(el); return el; }
  createSpan() { return this.createEl('span'); }
  setCssProps() {}
  addEventListener(name, fn) { this.handlers[name] = fn; }
  focus() { doc.activeElement = this; }
  fire(name, values = {}) { let prevented = false; this.handlers[name]?.({ preventDefault: () => { prevented = true; }, ...values }); return prevented; }
 }
 const p = new Probe(), root = new Element('div');
 p.selected = new Set(); p.cbByPath = new Map(); p.visibleFiles = []; p.contentEl = { ownerDocument: doc };
 p.fileVisible = () => true; p.isTagged = () => false;
 p.renderTree = () => { root.children = []; p.visibleFiles = []; p.cbByPath.clear(); for (const path of ['One.md', 'Two.md', 'Three.md']) p.renderNode(root, new TFile(path), 0); };
 p.renderTree();
 return { p, root, doc, row: index => root.children[index], checkbox: index => root.children[index].children.find(el => el.tag === 'input') };
}

test('touch and pen leave scrolling alone and native checkbox changes select or clear a note', () => {
 const f = selectionFixture();
 for (const pointerType of ['touch', 'pen']) {
  assert.equal(f.row(0).tag, 'label');
  assert.equal(f.row(0).fire('pointerdown', { pointerType, button: 0 }), false);
  assert.equal(f.p.selected.size, 0);
  const cb = f.checkbox(0); cb.checked = true; cb.fire('change');
  assert.deepEqual([...f.p.selected], ['One.md']);
  const next = f.checkbox(0); next.checked = false; next.fire('change');
  assert.equal(f.p.selected.size, 0);
 }
});

test('native keyboard selection retains focus after the tree refresh', () => {
 const f = selectionFixture(), cb = f.checkbox(0); cb.focus(); cb.checked = true; cb.fire('change');
 assert.equal(f.doc.activeElement, f.checkbox(0)); assert.notEqual(f.doc.activeElement, cb);
 assert.deepEqual([...f.p.selected], ['One.md']);
});

test('mouse painting selects and clears rows once, while Shift selects the visible range', () => {
 const f = selectionFixture();
 assert.equal(f.row(0).fire('pointerdown', { pointerType: 'mouse', button: 0 }), true);
 f.row(1).fire('pointerenter', { pointerType: 'mouse' });
 f.row(2).fire('pointerenter', { pointerType: 'touch' });
 assert.deepEqual([...f.p.selected], ['One.md', 'Two.md']);
 assert.equal(f.row(0).fire('click'), true);
 f.p.dragging = false; f.p.renderTree();
 f.row(0).fire('pointerdown', { pointerType: 'mouse', button: 0 });
 f.row(1).fire('pointerenter', { pointerType: 'mouse' });
 assert.equal(f.p.selected.size, 0);
 f.p.dragging = false; f.p.renderTree();
 f.row(2).fire('pointerdown', { pointerType: 'mouse', button: 0, shiftKey: true });
 assert.deepEqual([...f.p.selected], ['One.md', 'Two.md', 'Three.md']);
});
