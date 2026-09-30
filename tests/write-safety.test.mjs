import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { defaultSchema, schemaMigratedName, normalizeSchemaModel, normalizeTagList, primarySeparator, portablePathKey, portableBasenameIssue, duplicateLocationGroups } from '../src/tagkey.ts';
import { hashedFrontmatterTags } from '../src/frontmatter-tags.ts';
import { planNoteChange, validatePlanSnapshot } from '../src/automation.ts';

// Execute the production orchestration methods with a small vault double.
// Extracting methods avoids mocking the unrelated UI imported by the plugin entry point.
const source = ts.createSourceFile('main.ts', fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const cls = source.statements.find(ts.isClassDeclaration);
const methods = ['previewSchemaChange', 'schemaPreviewIsCurrent', 'applySchemaChange', 'revertSeparatorRenames', 'applyChangeUnlocked', 'filenameConflict', 'performGuardedRename', 'schemaFilenameCollisions', 'cascadePreviewConflicts', 'separatorUndoPlan'];
const code = ts.transpileModule('class Probe {' + methods.map(name => {
 const method = cls.members.find(m => m.name?.getText(source) === name);
 assert.ok(method, name);
 return method.getText(source);
}).join('\n') + '}', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
class TFile {
 constructor(path) { this.path = path; this.extension = 'md'; this.parent = { path: '/' }; }
 get basename() { return this.path.replace(/\.md$/, ''); }
}
class TFolder { constructor(path, children = []) { this.path = path; this.children = children; } }
function fixture(names = ['Note']) {
 const files = names.map(name => new TFile(name + '.md'));
 const root = new TFolder('/', files);
 files.forEach(file => { file.parent = root; });
 const tags = new Map(files.map(f => [f, ['trel/P/01']]));
 const cached = new Map(files.map(f => [f, [...tags.get(f)]]));
 let gate = async () => true;
 class Progress {
  open() {} report() {} finish() {}
  async gate() { const result = await gate(); this.wasCancelled = !result; return result; }
 }
 const bindings = { TFile, TFolder, portablePathKey, portableBasenameIssue, duplicateLocationGroups, BulkProgressModal: Progress, t: x => x, cloneSchema: structuredClone, normalizeSchemaModel, normalizePath: x => x, Notice: class {}, hashedFrontmatterTags, schemaMigratedName, primarySeparator, validatePlanSnapshot, planNoteChange, normalizeTagList, sameStrings: (a,b) => JSON.stringify(a) === JSON.stringify(b), window: { setTimeout: fn => fn() }, console: { error() {} } };
 const Probe = new Function(...Object.keys(bindings), code + ';return Probe;')(...Object.values(bindings));
 const p = new Probe();
 const old = defaultSchema(); old.slots[0].syncMode = 'display-only';
 p.settings = { schema: old, filenameSyncEnabled: false };
 p.app = { vault: { getRoot: () => root, getMarkdownFiles: () => files.filter(f => f instanceof TFile), getAbstractFileByPath: path => files.find(f => f.path === path) }, metadataCache: { getFileCache: f => ({ frontmatter: { tags: cached.get(f) } }) }, fileManager: { processFrontMatter: async (f, fn) => { const fm = { tags: [...tags.get(f)] }; fn(fm); tags.set(f, fm.tags); } } };
 p.freshFrontmatterTags = async f => [...tags.get(f)];
 p.operations = { progress() {} }; p.saveSettings = async () => {}; p.rebuildTrees = () => {}; p.refreshNoNameManagedPaths = () => {};
 p.automationApplying = new Set(); p.noNameManagedPaths = new Set(); p.renaming = new Set();
 let outcome; const renames = [];
 p.runBulkOperation = async (label, total, fn) => { outcome = { status: 'completed', issues: [] }; await fn('test', outcome); };
 p.renameGuarded = async (f, path) => { renames.push([f.path, path]); f.path = path; return true; };
 const next = defaultSchema(); const rows = p.previewSchemaChange(next); const expected = structuredClone(old);
 return { p, files, root, tags, cached, next, rows, expected, renames, gate: fn => { gate = fn; }, outcome: () => outcome, apply: () => p.applySchemaChange(next, rows, expected) };
}

test('schema apply rejects changed disk tags even while metadata cache is stale', async () => {
 const f = fixture(); f.tags.set(f.files[0], ['trel/P/02']); await f.apply();
 assert.equal(f.renames.length, 0); assert.deepEqual(f.p.settings.schema, f.expected);
 assert.equal(f.outcome().status, 'rolled-back'); assert.match(f.outcome().issues[0].message, /schemaStale/);
});
test('schema preflight rejects a missing later note before renaming any note', async () => {
 const f = fixture(['One', 'Two']); f.files.pop(); await f.apply(); assert.equal(f.renames.length, 0);
});
test('schema apply rejects a changed naming schema, including an empty batch', async () => {
 for (const names of [['Note'], []]) { const f = fixture(names); f.p.settings.schema.separators = ['_']; await f.apply(); assert.equal(f.renames.length, 0); assert.deepEqual(f.p.settings.schema.separators, ['_']); assert.equal(f.outcome().status, 'rolled-back'); }
});
test('a later note changed during the batch rolls earlier renames back', async () => {
 const f = fixture(['One', 'Two']); let count = 0;
 f.gate(async () => { if (++count === 2) f.tags.set(f.files[1], ['trel/P/02']); return true; });
 await f.apply(); assert.equal(f.renames.length, 2); assert.deepEqual(f.files.map(x => x.path), ['One.md', 'Two.md']); assert.deepEqual(f.tags.get(f.files[1]), ['trel/P/02']); assert.deepEqual(f.p.settings.schema, f.expected);
});
test('an unchanged batch applies and records reversible names', async () => {
 const f = fixture(); await f.apply(); assert.equal(f.files[0].path, 'P01-Note.md'); assert.deepEqual(f.p.settings.schema, normalizeSchemaModel(f.next)); assert.equal(f.p.settings.lastSeparatorChange.renames.length, 1);
});
test('cancel after the first rename restores the original name and schema', async () => {
 const f = fixture(['One', 'Two']); let count = 0; f.gate(async () => ++count < 2); await f.apply(); assert.deepEqual(f.files.map(x => x.path), ['One.md', 'Two.md']); assert.deepEqual(f.p.settings.schema, f.expected);
});
for (const concurrent of [false, true]) {
 test(`automation rename failure ${concurrent ? 'preserves concurrent tags and reports incomplete recovery' : 'restores its own tag change'}`, async () => {
  const f = fixture(['P01-Note']); const file = f.files[0]; f.p.settings.schema = defaultSchema();
  const state = { path: file.path, basename: file.basename, extension: 'md', mtime: 1, allTags: ['#trel/P/01'], frontmatterTags: ['trel/P/01'] };
  f.p.noteState = () => ({ ok: true, value: state });
  const plan = planNoteChange(state, f.p.settings.schema, { path: state.path, tagChanges: [{ namespace: 'trel', tagPath: 'trel/P/02' }] }); assert.ok(plan.ok);
  f.p.renameGuarded = async () => { if (concurrent) f.tags.get(file).push('user/added'); return false; };
  const result = await f.p.applyChangeUnlocked(plan.value);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'rename-failed');
  assert.deepEqual(f.tags.get(file), concurrent ? ['trel/P/02', 'user/added'] : ['trel/P/01']);
  assert.equal(Boolean(result.error.details?.rollbackError), concurrent);
 });
}

test('a rejected preview preserves the previous undo journal', async () => {
 const f = fixture(); const previous = { renames: [{ path: 'Older.md', oldBasename: 'Old' }] };
 f.p.settings.lastSeparatorChange = structuredClone(previous);
 f.tags.set(f.files[0], ['trel/P/02']); await f.apply();
 assert.deepEqual(f.p.settings.lastSeparatorChange, previous);
});

test('automation blocks a differently cased destination before changing tags', async () => {
 const f = fixture(['P01-Note', 'p02-note']), file = f.files[0]; f.p.settings.schema = defaultSchema();
 const state = { path: file.path, basename: file.basename, extension: 'md', mtime: 1, allTags: ['#trel/P/01'], frontmatterTags: ['trel/P/01'] };
 f.p.noteState = () => ({ ok: true, value: state });
 const plan = planNoteChange(state, f.p.settings.schema, { path: state.path, tagChanges: [{ namespace: 'trel', tagPath: 'trel/P/02' }] }); assert.ok(plan.ok);
 const result = await f.p.applyChangeUnlocked(plan.value);
 assert.equal(result.error.code, 'target-exists'); assert.equal(f.renames.length, 0);
 assert.deepEqual(f.tags.get(file), ['trel/P/01']); assert.equal(file.path, 'P01-Note.md');
});

test('rename guard rejects Windows reserved superscript names and occupied files or folders', async () => {
 for (const target of ['COM¹.md', 'lpt².txt.md', 'NOTE.md', 'cafe\u0301.md', 'Folder.md']) {
  const f = fixture(['Source', 'Note', 'CAFÉ']); f.root.children.push(new TFolder('folder.md'));
  f.p.app.fileManager.renameFile = async () => { throw Error('must not write'); };
  const result = await f.p.performGuardedRename(f.files[0], target);
  assert.equal(result.status, target.includes('¹') || target.includes('²') ? 'not-portable' : 'collision', target);
  assert.equal(f.files[0].path, 'Source.md'); assert.equal(f.p.renaming.size, 0);
 }
});

test('rename guard allows own case-only rename through Obsidian and reports adapter failure', async () => {
 const f = fixture(['Note']); let calls = 0;
 f.p.app.fileManager.renameFile = async (file, path) => { calls++; file.path = path; };
 assert.equal((await f.p.performGuardedRename(f.files[0], 'NOTE.md')).status, 'renamed');
 assert.equal(calls, 1); assert.equal(f.files[0].path, 'NOTE.md'); assert.equal(f.p.renaming.size, 0);
 f.p.app.fileManager.renameFile = async () => { throw Error('adapter denied'); };
 assert.equal((await f.p.performGuardedRename(f.files[0], 'Other.md')).status, 'failed');
 assert.equal(f.files[0].path, 'NOTE.md'); assert.equal(f.p.renaming.size, 0);
});

test('collision checks keep equal names in separate folders independent', () => {
 const f = fixture(['Source']);
 const folder = new TFolder('Other', [new TFile('Other/NOTE.md')]); f.root.children.push(folder);
 assert.equal(f.p.filenameConflict('note.md', f.files[0]), null);
 assert.equal(f.p.filenameConflict('Other/note.md', f.files[0]), folder.children[0]);
});

test('schema and branch previews block two planned names differing only in case', () => {
 const f = fixture(['One', 'Two']);
 assert.deepEqual(f.p.schemaFilenameCollisions([{ path: 'One.md', newName: 'Note' }, { path: 'Two.md', newName: 'note' }]), [{ targetPath: 'Note.md', notePaths: ['One.md', 'Two.md'] }]);
 f.p.settings.filenameSyncEnabled = true;
 f.p.projectedPathForTagChange = file => file.path === 'One.md' ? 'Note.md' : 'note.md';
 assert.deepEqual(f.p.cascadePreviewConflicts(f.files.map(file => ({ path: file.path, beforeTags: ['trel/P/01'], afterTags: ['trel/P/02'] }))), ['note.md']);
});

test('undo preflight blocks case-only duplicate targets and newly occupied names', () => {
 const f = fixture(['One', 'Two']), schema = f.p.settings.schema;
 const rec = { oldSchema: schema, newSchema: schema, renames: [{ path: 'One.md', oldBasename: 'Note' }, { path: 'Two.md', oldBasename: 'note' }] };
 assert.equal(f.p.separatorUndoPlan(rec), null);
 f.root.children.push(new TFolder('NOTE.md'));
 assert.equal(f.p.separatorUndoPlan({ ...rec, renames: rec.renames.slice(0, 1) }), null);
});

test('a collision arriving after a valid preview is caught at the final rename guard', async () => {
 const f = fixture(['Source']), rows = [{ path: 'Source.md', newName: 'Note' }];
 assert.deepEqual(f.p.schemaFilenameCollisions(rows), []);
 f.root.children.push(new TFile('note.md'));
 f.p.app.fileManager.renameFile = async () => { throw Error('must not write'); };
 assert.equal((await f.p.performGuardedRename(f.files[0], 'Note.md')).status, 'collision');
 assert.equal(f.files[0].path, 'Source.md');
});
