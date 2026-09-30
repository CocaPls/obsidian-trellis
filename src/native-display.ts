import { Component, TFile, debounce, prepareFuzzySearch, sortSearchResults, type App, type WorkspaceLeaf } from "obsidian";
import type { DisplaySettings } from "./display-settings";

// Obsidian has no public filename-label provider. Keep optional view internals
// in this adapter, feature-detect them, and never change a TFile or editor text.
interface SearchDom {
	resultDomLookup?: Map<TFile, { el?: HTMLElement }>;
}
interface NativeView {
	file?: TFile;
	fileItems?: Record<string, { el?: HTMLElement }>;
	dom?: SearchDom;
	backlink?: { backlinkDom?: SearchDom; unlinkedDom?: SearchDom };
	backlinks?: { backlinkDom?: SearchDom; unlinkedDom?: SearchDom };
}
interface SwitcherItem {
	type: string;
	file?: TFile;
	match?: ReturnType<ReturnType<typeof prepareFuzzySearch>>;
	downranked?: boolean;
}
interface SwitcherModal {
	shouldShowMarkdown?: boolean;
	getSuggestions(query: string): SwitcherItem[];
	renderSuggestion(item: SwitcherItem, el: HTMLElement): void;
}
interface SwitcherPlugin {
	QuickSwitcherModal?: { prototype: SwitcherModal };
}
interface InternalApp {
	internalPlugins?: { plugins?: Record<string, { enabled?: boolean; instance?: SwitcherPlugin }> };
}
interface Decoration { title: string | null; aria: string | null; label: string; path: string; note?: HTMLElement; font: string; fontPriority: string }

export class NativeDisplay extends Component {
	private readonly decorated = new Map<HTMLElement, Decoration>();
	private readonly observers = new Map<Document, MutationObserver>();
	private switcherCleanup: (() => void) | null = null;
	private switcherPrototype: SwitcherModal | null = null;
	private disposed = false;
	readonly schedule = debounce(() => this.refresh(), 50, true);

	constructor(
		private readonly app: App,
		private readonly settings: () => DisplaySettings,
		private readonly name: (path: string) => string,
	) { super(); }

	onload() {
		this.registerEvent(this.app.workspace.on("layout-change", this.schedule));
		this.registerEvent(this.app.workspace.on("file-open", this.schedule));
		this.registerEvent(this.app.workspace.on("css-change", () => {
			for (const el of this.decorated.keys()) this.measureFont(el);
			this.schedule();
		}));
		this.registerEvent(this.app.metadataCache.on("changed", this.schedule));
		this.registerEvent(this.app.vault.on("rename", this.schedule));
		this.registerEvent(this.app.vault.on("delete", this.schedule));
		this.refresh();
	}

	onunload() {
		this.disposed = true;
		this.schedule.cancel();
		for (const observer of this.observers.values()) observer.disconnect();
		this.observers.clear();
		this.switcherCleanup?.();
		for (const el of this.decorated.keys()) this.clear(el);
	}

	private clear(el: HTMLElement) {
		const old = this.decorated.get(el);
		if (!old) return;
		if (el.dataset.trellisDisplay === old.label) {
			delete el.dataset.trellisDisplay;
			el.classList.remove("trellis-native-name");
			for (const [key, value] of [["title", old.title], ["aria-label", old.aria]]) {
				if (value === null) el.removeAttribute(key!);
				else el.setAttribute(key!, value);
			}
		}
		if (old.font) el.style.setProperty("--trellis-native-font-size", old.font, old.fontPriority);
		else el.style.removeProperty("--trellis-native-font-size");
		old.note?.remove();
		this.decorated.delete(el);
	}

	private measureFont(el: HTMLElement) {
		const decorated = el.classList.contains("trellis-native-name");
		el.classList.remove("trellis-native-name");
		const fontSize = el.ownerDocument.defaultView?.getComputedStyle(el).fontSize;
		if (fontSize) el.style.setProperty("--trellis-native-font-size", fontSize);
		if (decorated) el.classList.add("trellis-native-name");
	}

	private decorate(el: HTMLElement | null | undefined, file: TFile, seen?: Set<HTMLElement>) {
		if (!el || file.extension !== "md") return;
		const label = this.name(file.path);
		if (!label || label === file.basename) return;
		seen?.add(el);
		if (!this.decorated.has(el)) {
			this.decorated.set(el, { title: el.getAttribute("title"), aria: el.getAttribute("aria-label"), label, path: file.path, font: el.style.getPropertyValue("--trellis-native-font-size"), fontPriority: el.style.getPropertyPriority("--trellis-native-font-size") });
			// Resolve relative theme sizes before the original text is hidden.
			this.measureFont(el);
		}
		const saved = this.decorated.get(el)!;
		saved.label = label;
		saved.path = file.path;
		el.dataset.trellisDisplay = label;
		el.classList.add("trellis-native-name");
		el.setAttribute("title", `${label} — ${file.path}`);
		el.setAttribute("aria-label", `${label} — ${file.path}`);
	}

	private search(dom: SearchDom | undefined, seen: Set<HTMLElement>) {
		if (!dom?.resultDomLookup || typeof dom.resultDomLookup.entries !== "function") return;
		for (const [file, row] of dom.resultDomLookup) {
			if (file instanceof TFile) this.decorate(row.el?.querySelector<HTMLElement>(".search-result-file-title .tree-item-inner"), file, seen);
		}
	}

	refresh() {
		if (this.disposed) return;
		const settings = this.settings();
		const enabled = Object.values(settings).some(Boolean);
		const seen = new Set<HTMLElement>();
		const documents = new Set<Document>();
		const leaves = new Set<WorkspaceLeaf>();
		this.app.workspace.iterateAllLeaves(leaf => { leaves.add(leaf); });
		// Inactive sidebar tabs may be omitted by iterateAllLeaves.
		for (const type of ["markdown", "file-explorer", "search", "backlink"]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) leaves.add(leaf);
		}
		for (const leaf of leaves) {
			const container = leaf.view.containerEl;
			if (enabled) documents.add(container.ownerDocument);
			const view = leaf.view as unknown as NativeView;
			if (settings.explorer && leaf.view.getViewType() === "file-explorer" && view.fileItems) {
				for (const [path, item] of Object.entries(view.fileItems)) {
					const file = this.app.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) this.decorate(item.el?.querySelector<HTMLElement>(".nav-file-title-content"), file, seen);
				}
			}
			if (view.file instanceof TFile && leaf.view.getViewType() === "markdown") {
				if (settings.tabs) {
					const tab = (leaf as WorkspaceLeaf & { tabHeaderEl?: HTMLElement }).tabHeaderEl;
					this.decorate(tab?.querySelector<HTMLElement>(".workspace-tab-header-inner-title"), view.file, seen);
				}
				if (settings.titles) {
					for (const el of Array.from(container.querySelectorAll<HTMLElement>(".view-header-title, .inline-title"))) this.decorate(el, view.file, seen);
				}
			}
			if (settings.search && leaf.view.getViewType() === "search") this.search(view.dom, seen);
			if (settings.backlinks) {
				for (const backlinks of [view.backlink, view.backlinks]) {
					this.search(backlinks?.backlinkDom, seen);
					this.search(backlinks?.unlinkedDom, seen);
				}
			}
		}
		for (const el of this.decorated.keys()) {
			// Quick switcher rows are owned by its renderer until the prompt closes.
			if (settings.switcher && el.isConnected && el.closest(".prompt")) {
				const file = this.app.vault.getAbstractFileByPath(this.decorated.get(el)!.path);
				if (file instanceof TFile && this.name(file.path) !== file.basename) {
					this.decorate(el, file);
					continue;
				}
			}
			if (!seen.has(el)) this.clear(el);
		}
		for (const [doc, observer] of this.observers) {
			if (!documents.has(doc)) { observer.disconnect(); this.observers.delete(doc); }
		}
		for (const doc of documents) {
			if (this.observers.has(doc)) continue;
			const observer = new MutationObserver(this.schedule);
			observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
			this.observers.set(doc, observer);
		}
		this.installSwitcher();
	}

	private installSwitcher() {
		const plugin = (this.app as unknown as InternalApp).internalPlugins?.plugins?.switcher;
		const proto = plugin?.instance?.QuickSwitcherModal?.prototype;
		if (!this.settings().switcher || !proto || typeof proto.getSuggestions !== "function" || typeof proto.renderSuggestion !== "function") {
			this.switcherCleanup?.(); this.switcherCleanup = null; this.switcherPrototype = null;
			return;
		}
		if (proto === this.switcherPrototype) return;
		this.switcherCleanup?.();
		// Preserve the native receiver when invoking these methods below.
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the native modal receiver via call().
		const originalGet = proto.getSuggestions;
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the native modal receiver via call().
		const originalRender = proto.renderSuggestion;
		const ownGet = Object.getOwnPropertyDescriptor(proto, "getSuggestions");
		const ownRender = Object.getOwnPropertyDescriptor(proto, "renderSuggestion");
		// The wrappers have the native modal as `this`, not this component.
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- Wrappers retain their own native modal receiver.
		const owner = this;
		function get(this: SwitcherModal, query: string): SwitcherItem[] {
			const rows = [...originalGet.call(this, query)];
			if (owner.disposed || !owner.settings().switcher || !query.trim() || this.shouldShowMarkdown === false) return rows;
			const match = prepareFuzzySearch(query.trim());
			const additions: { file: TFile; match: NonNullable<SwitcherItem["match"]> }[] = [];
			const existing = new Set(rows.filter(row => row.type === "file").map(row => row.file?.path));
			for (const file of owner.app.vault.getMarkdownFiles()) {
				if (existing.has(file.path) || (owner.app.metadataCache as typeof owner.app.metadataCache & { isUserIgnored?: (path: string) => boolean }).isUserIgnored?.(file.path)) continue;
				const label = owner.name(file.path);
				const result = label !== file.basename ? match(label) : null;
				if (result) additions.push({ file, match: result });
			}
			sortSearchResults(additions);
			// Native renderers index matches into the physical name, so do not
			// pass display-name character offsets to them.
			rows.push(...additions.map(({ file }) => ({ type: "file", file, match: null })));
			const queryName = query.trim().toLocaleLowerCase();
			const exact = (row: SwitcherItem) => row.type === "file" && row.file &&
				!row.downranked && owner.name(row.file.path).toLocaleLowerCase() === queryName;
			// Preserve the native ordering (including aliases) after exact display matches.
			return [...rows.filter(exact), ...rows.filter(row => !exact(row))];
		}
		function render(this: SwitcherModal, row: SwitcherItem, el: HTMLElement) {
			originalRender.call(this, row, el);
			if (owner.disposed || !owner.settings().switcher || row?.type !== "file" || !row.file) return;
			const title = el.querySelector<HTMLElement>(".suggestion-title");
			owner.decorate(title, row.file);
			const saved = title && owner.decorated.get(title);
			if (saved) {
				saved.note?.remove();
				saved.note = el.querySelector(".suggestion-content")?.createDiv({ cls: "suggestion-note", text: row.file.path });
			}
		}
		proto.getSuggestions = get;
		proto.renderSuggestion = render;
		this.switcherPrototype = proto;
		this.switcherCleanup = () => {
			if (proto.getSuggestions === get) {
				if (ownGet) Object.defineProperty(proto, "getSuggestions", ownGet);
				else Reflect.deleteProperty(proto, "getSuggestions");
			}
			if (proto.renderSuggestion === render) {
				if (ownRender) Object.defineProperty(proto, "renderSuggestion", ownRender);
				else Reflect.deleteProperty(proto, "renderSuggestion");
			}
		};
	}
}
