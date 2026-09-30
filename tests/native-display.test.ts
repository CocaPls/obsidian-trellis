import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { normalizeDisplaySettings } from "../src/display-settings.ts";

const bundle = await build({
	stdin: { contents: 'export { NativeDisplay } from "./src/native-display.ts"; export { TFile } from "obsidian";', resolveDir: process.cwd() },
	bundle: true, write: false, format: "esm", platform: "node",
	plugins: [{ name: "obsidian-test", setup(b) {
		b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
		b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: `
export class Component { registerEvent() {} }
export class TFile { constructor(path) { this.path=path; this.basename=path.split('/').pop().replace(/\\.md$/,''); this.extension='md'; } }
export function debounce(fn) { fn.cancel=()=>{}; return fn; }
export function sortSearchResults(rows) { rows.sort((a,b)=>b.match.score-a.match.score); }
export function prepareFuzzySearch(q) { return text=>text.toLowerCase().includes(q.toLowerCase())?{score:0,matches:[]}:null; }
` }));
	} }],
});
const { NativeDisplay, TFile } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

class Element {
	styleValues = new Map<string, string>();
	style = {
		getPropertyValue: (key: string) => this.styleValues.get(key) ?? "",
		getPropertyPriority: () => "",
		setProperty: (key: string, value: string) => this.styleValues.set(key, value),
		removeProperty: (key: string) => this.styleValues.delete(key),
	};
	ownerDocument = { defaultView: { getComputedStyle: () => ({ fontSize: "32px" }) } };
	dataset: Record<string, string> = {};
	attrs = new Map<string, string>();
	classes = new Set<string>();
	classList = { contains: (v: string) => this.classes.has(v), add: (v: string) => this.classes.add(v), remove: (v: string) => this.classes.delete(v) };
	textContent = "Note";
	isConnected = true;
	getAttribute(k: string) { return this.attrs.get(k) ?? null; }
	setAttribute(k: string, v: string) { this.attrs.set(k, v); }
	removeAttribute(k: string) { this.attrs.delete(k); }
	closest() { return null; }
}

test("display settings opt in per surface and reject truthy malformed settings", () => {
	const first = normalizeDisplaySettings(undefined);
	const second = normalizeDisplaySettings({ explorer: true, tabs: "true", titles: 1, switcher: true });
	assert.ok(Object.values(first).every(v => v === false));
	assert.equal(second.explorer, true);
	assert.equal(second.switcher, true);
	assert.equal(second.tabs, false);
	assert.equal(second.titles, false);
	second.search = true;
	assert.equal(first.search, false);
});

test("decoration preserves editable filename and restores prior attributes on unload", () => {
	const file = new TFile("One/Note.md");
	const el = new Element();
	el.setAttribute("title", "Existing tooltip");
	const controller = new NativeDisplay({}, () => normalizeDisplaySettings({ titles: true }), () => "P18-Note");
	controller.decorate(el, file);
	assert.equal(el.textContent, "Note");
	assert.equal(el.style.getPropertyValue("--trellis-native-font-size"), "32px");
	assert.equal(el.dataset.trellisDisplay, "P18-Note");
	assert.equal(el.getAttribute("aria-label"), "P18-Note — One/Note.md");
	controller.onunload();
	assert.equal(el.dataset.trellisDisplay, undefined);
	assert.equal(el.getAttribute("title"), "Existing tooltip");
	assert.equal(el.style.getPropertyValue("--trellis-native-font-size"), "");
	assert.equal(el.getAttribute("aria-label"), null);
	assert.equal(el.textContent, "Note");
});

test("search decoration accepts maps from another realm without changing result text", () => {
	const file = new TFile("One/Note.md");
	const el = new Element();
	const entries = [[file, { el: { querySelector: () => el } }]];
	const foreignMap = { entries: () => entries.values(), [Symbol.iterator]: () => entries.values() };
	const controller = new NativeDisplay({}, () => normalizeDisplaySettings({ search: true }), () => "P18-Note");
	controller.search({ resultDomLookup: foreignMap }, new Set());
	assert.equal(el.dataset.trellisDisplay, "P18-Note");
	assert.equal(el.textContent, "Note");
});

test("quick switcher finds duplicate display names by distinct paths and restores inherited methods", () => {
	const files = [new TFile("One/Note.md"), new TFile("Two/Note.md"), new TFile("Ignored/Note.md")];
	const base = { getSuggestions() { return []; }, renderSuggestion() {} };
	const proto = Object.create(base);
	const settings = normalizeDisplaySettings({ switcher: true });
	const app = {
		internalPlugins: { plugins: { switcher: { instance: { QuickSwitcherModal: { prototype: proto } } } } },
		vault: { getMarkdownFiles: () => files },
		metadataCache: { isUserIgnored: (path: string) => path.startsWith("Ignored/") },
	};
	const controller = new NativeDisplay(app, () => settings, () => "P18-Note");
	controller.installSwitcher();
	assert.deepEqual(proto.getSuggestions("P18").map((r: { file: { path: string } }) => r.file.path), ["One/Note.md", "Two/Note.md"]);
	proto.shouldShowMarkdown = false;
	assert.deepEqual(proto.getSuggestions("P18"), []);
	controller.onunload();
	assert.equal(Object.prototype.hasOwnProperty.call(proto, "getSuggestions"), false);
	assert.equal(proto.getSuggestions, base.getSuggestions);
	assert.equal(proto.renderSuggestion, base.renderSuggestion);
});


test("refresh includes inactive native sidebar leaves and removes disabled decorations", () => {
	const file = new TFile("One/Note.md");
	const el = new Element();
	const doc = {};
	const leaf = { view: {
		containerEl: { ownerDocument: doc }, getViewType: () => "search",
		dom: { resultDomLookup: new Map([[file, { el: { querySelector: () => el } }]]) },
	} };
	const settings = normalizeDisplaySettings({ search: true });
	const app = { workspace: { iterateAllLeaves() {}, getLeavesOfType: (type: string) => type === "search" ? [leaf] : [] } };
	const controller = new NativeDisplay(app, () => settings, () => "P18-Note");
	controller.observers.set(doc, { disconnect() {} });
	controller.refresh();
	assert.equal(el.dataset.trellisDisplay, "P18-Note");
	settings.search = false;
	controller.refresh();
	assert.equal(el.dataset.trellisDisplay, undefined);
	assert.equal(el.textContent, "Note");
	controller.onunload();
});


test("theme font remeasurement keeps the display name and restores native styling", () => {
	const el = new Element();
	el.style.setProperty("--trellis-native-font-size", "18px");
	const controller = new NativeDisplay({}, () => normalizeDisplaySettings({ titles: true }), () => "P18-Note");
	controller.decorate(el, new TFile("Note.md"));
	el.ownerDocument.defaultView.getComputedStyle = () => ({ fontSize: "40px" });
	controller.measureFont(el);
	assert.equal(el.style.getPropertyValue("--trellis-native-font-size"), "40px");
	assert.equal(el.dataset.trellisDisplay, "P18-Note");
	assert.equal(el.classList.contains("trellis-native-name"), true);
	controller.onunload();
	assert.equal(el.style.getPropertyValue("--trellis-native-font-size"), "18px");
});


test("exact display matches precede native fuzzy results without mutating native arrays", () => {
	const nativeFile = new TFile("P18-Note-extra.md");
	const exactFile = new TFile("Physical.md");
	const nativeRows = [{ type: "file", file: nativeFile, match: null }];
	const proto = { getSuggestions(_query: string) { return nativeRows; }, renderSuggestion() {} };
	const settings = normalizeDisplaySettings({ switcher: true });
	const controller = new NativeDisplay({
		internalPlugins: { plugins: { switcher: { instance: { QuickSwitcherModal: { prototype: proto } } } } },
		vault: { getMarkdownFiles: () => [nativeFile, exactFile] }, metadataCache: {},
	}, () => settings, (path: string) => path === exactFile.path ? "P18-Note" : nativeFile.basename);
	controller.installSwitcher();
	assert.deepEqual(proto.getSuggestions("p18-note").map((r: { file: { path: string } }) => r.file.path), [exactFile.path, nativeFile.path]);
	assert.equal(nativeRows.length, 1);
	controller.onunload();
});

test("unloading preserves a later plugin wrapper and makes the retained Trellis wrapper inert", () => {
	const nativeFile = new TFile("Note.md");
	const extra = new TFile("Other.md");
	const proto = { getSuggestions(_query: string) { return [{ type: "file", file: nativeFile }]; }, renderSuggestion() {} };
	const controller = new NativeDisplay({
		internalPlugins: { plugins: { switcher: { instance: { QuickSwitcherModal: { prototype: proto } } } } },
		vault: { getMarkdownFiles: () => [nativeFile, extra] }, metadataCache: {},
	}, () => normalizeDisplaySettings({ switcher: true }), () => "Found");
	controller.installSwitcher();
	const wrapped = proto.getSuggestions;
	const later = function(query: string) { return wrapped.call(proto, query); };
	proto.getSuggestions = later;
	assert.equal(proto.getSuggestions("Found").length, 2);
	controller.onunload();
	assert.equal(proto.getSuggestions, later);
	assert.deepEqual(proto.getSuggestions("Found").map(row => row.file.path), [nativeFile.path]);
});
