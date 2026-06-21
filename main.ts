import {
	Plugin,
	TFile,
	getAllTags,
	Notice,
	Modal,
	Setting,
	PluginSettingTab,
	App,
	AbstractInputSuggest,
	debounce,
} from "obsidian";
import {
	TrellisConfig,
	NoteTreeNode,
	tagToTrekey,
	pickTrekey,
	syncedBasename,
	renameTagPath,
	normalizeTagList,
	expandTagPrefixes,
	filterTagSuggestions,
	buildNoteTree,
	sortNoteTree,
	nextChildSegment,
} from "./trekey";
import { TrellisTreeView, TRELLIS_TREE_VIEW } from "./tree-view";

type SortKey = "trekey" | "mtime" | "ctime";

/**
 * TRELLIS — tag-driven trekey sync.
 *
 * When a note's location tag (e.g. #trel/…) changes, rewrite the filename
 * trekey slot to match, via the link-safe rename API. One direction only: the
 * tag is the source of truth. A cascade command renames a whole tag subtree.
 * Behaviour is driven by settings (namespace / separator / key position).
 * Deferred: multi-key, title-key upward sync, bootstrap, drift warnings.
 */

/** Full plugin settings = conversion config + UI flags. */
interface TrellisSettings extends TrellisConfig {
	treeViewEnabled: boolean;
	sortKey: SortKey;
	sortAsc: boolean;
}

const DEFAULT_SETTINGS: TrellisSettings = {
	namespace: "trel",
	separator: "-",
	keyPosition: "prefix",
	treeViewEnabled: true,
	sortKey: "trekey",
	sortAsc: true,
};

export default class TrellisPlugin extends Plugin {
	settings: TrellisSettings = { ...DEFAULT_SETTINGS };

	/** Ribbon button for the tree view, kept so we can show/hide it on toggle. */
	private ribbonEl: HTMLElement | null = null;

	/** Infinite-loop guard: paths we are currently renaming, to ignore the
	 *  metadata/vault events our own rename triggers. */
	private renaming = new Set<string>();

	/** Cached note tree; null = stale, rebuilt on next sortedNoteTree(). */
	private treeCache: NoteTreeNode[] | null = null;

	/** Debounced tree refresh: data changes fire often (typing, cascade), so we
	 *  invalidate the cache and re-render at most once per 200ms. */
	private readonly scheduleTreeRefresh = debounce(
		() => {
			this.treeCache = null;
			this.refreshTreeViews();
		},
		200,
		true
	);

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new TrellisSettingTab(this.app, this));

		// Sidebar tree view: reads the location-tag hierarchy and renders it as a
		// collapsible tree (the read-side counterpart to the rename engine).
		this.registerView(
			TRELLIS_TREE_VIEW,
			(leaf) =>
				new TrellisTreeView(
					leaf,
					() => this.sortedNoteTree(),
					() => this.settings.sortAsc,
					() => void this.toggleSortDir(),
					(parentTagPath) => this.newChildNote(parentTagPath)
				)
		);
		this.ribbonEl = this.addRibbonIcon("list-tree", "TRELLIS tree", () =>
			void this.activateTreeView()
		);
		this.addCommand({
			id: "open-tree-view",
			name: "Open tree view",
			callback: () => {
				if (this.settings.treeViewEnabled) void this.activateTreeView();
				else new Notice("TRELLIS: tree view is off (enable it in settings)");
			},
		});
		this.applyTreeViewState();

		// metadataCache 'changed' fires after a file's tags/frontmatter are
		// parsed — the right moment to read the location tag.
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					void this.syncFile(file);
				}
				this.scheduleTreeRefresh();
			})
		);

		// A manual filename change ('rename') is NOT a tag change — the tag stays
		// the source of truth. If the user edited the trekey slot so it disagrees
		// with the tag, restore it; a title-only edit keeps the trekey and passes
		// through untouched. The rename guard stops our own renames from looping.
		this.registerEvent(
			this.app.vault.on("rename", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					void this.syncFile(file);
				}
				this.scheduleTreeRefresh();
			})
		);

		// Keep the tree in sync when files appear/disappear.
		this.registerEvent(this.app.vault.on("create", () => this.scheduleTreeRefresh()));
		this.registerEvent(this.app.vault.on("delete", () => this.scheduleTreeRefresh()));

		// Cascade: rename a location tag (and everything under it) across the
		// vault. The tag edits then drive each file's rename through syncFile.
		this.addCommand({
			id: "cascade-rename-tag",
			name: "Rename location tag (cascade)",
			callback: () => {
				new CascadeRenameModal(this.app, (from, to) =>
					void this.cascadeRename(from, to)
				).open();
			},
		});

		// Right-click a note → cascade-rename its location tag (From prefilled).
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				const from = this.locationTagOf(file);
				if (from === null) return;
				menu.addItem((item) =>
					item
						.setTitle("Rename location tag (cascade)")
						.setIcon("tags")
						.onClick(() =>
							new CascadeRenameModal(
								this.app,
								(f, t) => void this.cascadeRename(f, t),
								from
							).open()
						)
				);
			})
		);

		console.log("TRELLIS loaded (tag → filename trekey + cascade rename)");
	}

	onunload() {
		console.log("TRELLIS unloaded");
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Sync one file's location tag into its filename trekey (one direction). */
	private async syncFile(file: TFile) {
		if (this.renaming.has(file.path)) return; // guard: our own rename echo

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return;
		const tags = getAllTags(cache) ?? [];
		const trekey = pickTrekey(tags, this.settings);
		if (trekey === null) return; // no location tag → never touch the file

		const newBasename = syncedBasename(file.basename, trekey, this.settings);
		if (newBasename === null) return; // already in sync

		const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
		const newPath = `${dir}${newBasename}.${file.extension}`;

		this.renaming.add(file.path);
		this.renaming.add(newPath);
		try {
			// renameFile = same path as a manual rename → wikilinks auto-update.
			await this.app.fileManager.renameFile(file, newPath);
			new Notice(`TRELLIS: ${file.basename} → ${newBasename}`);
		} catch (e) {
			console.error("TRELLIS rename failed", e);
			new Notice(`TRELLIS: rename failed for ${file.basename}`);
		} finally {
			this.renaming.delete(file.path);
			// Release the new path after the follow-up events settle.
			window.setTimeout(() => this.renaming.delete(newPath), 200);
		}
	}

	/** Collect every note's location tag into the sidebar note-tree, sorted.
	 *  Cached; data/sort changes invalidate via scheduleTreeRefresh/rebuildTrees. */
	private sortedNoteTree(): NoteTreeNode[] {
		if (this.treeCache) return this.treeCache;
		const entries: { tagPath: string; notePath: string }[] = [];
		const ns = this.settings.namespace;
		const prefix = `#${ns}/`;
		const exact = `#${ns}`;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const tag = (getAllTags(cache) ?? []).find(
				(t) => t.startsWith(prefix) || t === exact
			);
			if (!tag) continue;
			entries.push({ tagPath: tag.replace(/^#/, ""), notePath: file.path });
		}
		this.treeCache = sortNoteTree(buildNoteTree(entries), this.noteComparator());
		return this.treeCache;
	}

	/** Invalidate the cache and re-render immediately (sort/namespace change). */
	rebuildTrees() {
		this.treeCache = null;
		this.refreshTreeViews();
	}

	/** Comparator from the current sort key + direction. trekey = name order;
	 *  mtime/ctime read file stats. */
	private noteComparator(): (a: NoteTreeNode, b: NoteTreeNode) => number {
		const { sortKey, sortAsc } = this.settings;
		const dir = sortAsc ? 1 : -1;
		return (a, b) => {
			let r: number;
			if (sortKey === "trekey") {
				r = this.treeBasename(a.notePath).localeCompare(
					this.treeBasename(b.notePath)
				);
			} else {
				r = this.fileTime(a.notePath, sortKey) - this.fileTime(b.notePath, sortKey);
			}
			return r * dir;
		};
	}

	private fileTime(path: string, key: "mtime" | "ctime"): number {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) return key === "ctime" ? f.stat.ctime : f.stat.mtime;
		return 0;
	}

	private treeBasename(path: string): string {
		return (path.split("/").pop() ?? path).replace(/\.md$/, "");
	}

	/** Flip ascending/descending and persist; rebuild open trees. */
	async toggleSortDir() {
		this.settings.sortAsc = !this.settings.sortAsc;
		await this.saveSettings();
		this.rebuildTrees();
	}

	/** Open the new-child-note modal under a parent tag path. */
	private newChildNote(parentTagPath: string) {
		const suggested = nextChildSegment(this.childSegmentsOf(parentTagPath));
		new NewChildNoteModal(this.app, parentTagPath, suggested, (segment, title) =>
			void this.createChildNote(parentTagPath, segment, title)
		).open();
	}

	/** Direct-child segments already in use under a parent tag path. */
	private childSegmentsOf(parentTagPath: string): string[] {
		const segs: string[] = [];
		const ns = this.settings.namespace;
		const prefix = `#${ns}/`;
		const exact = `#${ns}`;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const tag = (getAllTags(cache) ?? []).find(
				(t) => t.startsWith(prefix) || t === exact
			);
			if (!tag) continue;
			const path = tag.replace(/^#/, "");
			if (path.startsWith(parentTagPath + "/")) {
				const rest = path.slice(parentTagPath.length + 1);
				if (!rest.includes("/")) segs.push(rest); // direct child only
			}
		}
		return segs;
	}

	/** Create a new note as a child of parentTagPath with the given segment. */
	private async createChildNote(
		parentTagPath: string,
		segment: string,
		title: string
	) {
		const tagPath = `${parentTagPath}/${segment}`;
		const trekey = tagToTrekey(`#${tagPath}`, this.settings);
		if (!trekey) {
			new Notice("TRELLIS: could not derive trekey (check namespace)");
			return;
		}
		const safeTitle = title.trim().replace(/[\\/:*?"<>|]/g, "");
		const sep = this.settings.separator;
		let base: string;
		if (!safeTitle) base = trekey;
		else if (this.settings.keyPosition === "suffix") base = `${safeTitle}${sep}${trekey}`;
		else base = `${trekey}${sep}${safeTitle}`;

		const path = `${base}.md`;
		if (this.app.vault.getAbstractFileByPath(path)) {
			new Notice(`TRELLIS: "${base}" already exists`);
			return;
		}
		const content = `---\ntags: [${tagPath}]\n---\n\n# ${safeTitle || trekey}\n`;
		try {
			const file = await this.app.vault.create(path, content);
			await this.app.workspace.getLeaf(false).openFile(file);
		} catch (e) {
			console.error("TRELLIS create failed", e);
			new Notice(`TRELLIS: failed to create "${base}"`);
		}
	}

	/** Open (or reveal) the tree view in the left sidebar. */
	private async activateTreeView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(TRELLIS_TREE_VIEW)[0];
		if (!leaf) {
			const left = workspace.getLeftLeaf(false);
			if (!left) return;
			leaf = left;
			await leaf.setViewState({ type: TRELLIS_TREE_VIEW, active: true });
		}
		void workspace.revealLeaf(leaf);
	}

	refreshTreeViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(TRELLIS_TREE_VIEW)) {
			const view = leaf.view;
			if (view instanceof TrellisTreeView) view.refresh();
		}
	}

	/** Reflect the tree-view on/off toggle: show/hide the ribbon, close panels. */
	applyTreeViewState() {
		if (this.settings.treeViewEnabled) {
			this.ribbonEl?.show();
		} else {
			this.ribbonEl?.hide();
			this.app.workspace.detachLeavesOfType(TRELLIS_TREE_VIEW);
		}
	}

	/** The note's location tag (namespace match), without the leading '#'. */
	private locationTagOf(file: TFile): string | null {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return null;
		const prefix = `#${this.settings.namespace}/`;
		const tag = (getAllTags(cache) ?? []).find((t) => t.startsWith(prefix));
		return tag ? tag.replace(/^#/, "") : null;
	}

	/**
	 * Cascade-rename a location tag across the whole vault: rewrite `from` and
	 * every tag under `from/…` to `to`. We only touch frontmatter tags (the
	 * source of truth); the tag edits then trigger filename renames via syncFile.
	 */
	private async cascadeRename(from: string, to: string) {
		if (from === to) return;
		const files = this.app.vault.getMarkdownFiles();
		let retagged = 0;
		for (const file of files) {
			let touched = false;
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				const tags = normalizeTagList(fm.tags);
				if (tags.length === 0) return;
				const next = tags.map((t) => renameTagPath(t, from, to) ?? t);
				if (next.some((t, i) => t !== tags[i])) {
					fm.tags = next;
					touched = true;
				}
			});
			if (touched) retagged++;
		}
		new Notice(
			retagged > 0
				? `TRELLIS: retagged ${retagged} file(s) ${from} → ${to}`
				: `TRELLIS: no files tagged ${from}`
		);
	}
}

/** Two-field modal: which tag path to rename, and to what. */
class CascadeRenameModal extends Modal {
	private from = "";
	private to = "";
	private readonly onSubmit: (from: string, to: string) => void;

	constructor(
		app: App,
		onSubmit: (from: string, to: string) => void,
		initialFrom = ""
	) {
		super(app);
		this.onSubmit = onSubmit;
		this.from = initialFrom;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Rename location tag (cascade)" });
		contentEl.createEl("p", {
			text: "Rewrites this tag and everything under it across the vault. Filenames follow automatically.",
			cls: "setting-item-description",
		});

		new Setting(contentEl)
			.setName("From")
			.setDesc("Existing tag — type to search, ↑↓ + Enter to pick")
			.addText((t) => {
				t.setPlaceholder("trel/S88")
					.setValue(this.from)
					.onChange((v) => (this.from = v.trim()));
				new TagPathSuggest(this.app, t.inputEl, (v) => (this.from = v));
			});
		new Setting(contentEl)
			.setName("To")
			.setDesc("New tag path (free text)")
			.addText((t) => {
				t.setPlaceholder("trel/S99").onChange((v) => (this.to = v.trim()));
				new TagPathSuggest(this.app, t.inputEl, (v) => (this.to = v));
			});

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Rename")
				.setCta()
				.onClick(() => {
					if (this.from && this.to) {
						this.close();
						this.onSubmit(this.from, this.to);
					} else {
						new Notice("TRELLIS: fill in both fields");
					}
				})
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** New-child-note modal: segment (auto-suggested, editable) + title. */
class NewChildNoteModal extends Modal {
	private segment: string;
	private title = "";
	private readonly parentTagPath: string;
	private readonly onSubmit: (segment: string, title: string) => void;

	constructor(
		app: App,
		parentTagPath: string,
		suggestedSegment: string,
		onSubmit: (segment: string, title: string) => void
	) {
		super(app);
		this.parentTagPath = parentTagPath;
		this.segment = suggestedSegment;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "New note" });
		contentEl.createEl("p", {
			text: `Under ${this.parentTagPath}. Segment is auto-filled (a number) — edit it to a key for a new sub-level.`,
			cls: "setting-item-description",
		});

		new Setting(contentEl)
			.setName("Segment")
			.setDesc("Number (atom) or key (sub-level), e.g. 05 or C")
			.addText((t) =>
				t.setValue(this.segment).onChange((v) => (this.segment = v.trim()))
			);
		new Setting(contentEl)
			.setName("Title")
			.addText((t) =>
				t.setPlaceholder("note title").onChange((v) => (this.title = v.trim()))
			);

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Create")
				.setCta()
				.onClick(() => {
					if (this.segment) {
						this.close();
						this.onSubmit(this.segment, this.title);
					} else {
						new Notice("TRELLIS: segment is required");
					}
				})
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Autocomplete for a tag-path text input, sourced from the vault's live tags
 *  (every nesting level). */
class TagPathSuggest extends AbstractInputSuggest<string> {
	private readonly textInput: HTMLInputElement;
	private readonly onPick: (value: string) => void;
	private readonly all: string[];

	constructor(
		app: App,
		textInput: HTMLInputElement,
		onPick: (value: string) => void
	) {
		super(app, textInput);
		this.textInput = textInput;
		this.onPick = onPick;

		// Collect every tag in the vault once (public API), expand to all levels.
		const tags = new Set<string>();
		for (const file of app.vault.getMarkdownFiles()) {
			const cache = app.metadataCache.getFileCache(file);
			if (cache) for (const t of getAllTags(cache) ?? []) tags.add(t);
		}
		this.all = expandTagPrefixes([...tags]);
	}

	getSuggestions(query: string): string[] {
		return filterTagSuggestions(this.all, query.trim());
	}

	renderSuggestion(value: string, el: HTMLElement) {
		el.setText(value);
	}

	selectSuggestion(value: string) {
		this.textInput.value = value;
		this.onPick(value);
		this.textInput.trigger("input");
		this.close();
	}
}

/** Settings: namespace, separator, key position. */
class TrellisSettingTab extends PluginSettingTab {
	private readonly plugin: TrellisPlugin;

	constructor(app: App, plugin: TrellisPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Location tag namespace")
			.setDesc(
				"Tags under this namespace are the source of truth. e.g. 'trel' → #trel/S88/B07"
			)
			.addText((text) =>
				text
					.setPlaceholder("trel")
					.setValue(this.plugin.settings.namespace)
					.onChange(async (value) => {
						const v = value.trim().replace(/^#/, "").replace(/\/$/, "");
						if (v === "") {
							new Notice("TRELLIS: namespace cannot be empty");
							return;
						}
						this.plugin.settings.namespace = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Separator")
			.setDesc("Single character between the trekey and the title. e.g. '-'")
			.addText((text) =>
				text
					.setPlaceholder("-")
					.setValue(this.plugin.settings.separator)
					.onChange(async (value) => {
						if (value.length !== 1) {
							new Notice("TRELLIS: separator must be exactly one character");
							return;
						}
						this.plugin.settings.separator = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Key position")
			.setDesc("Where the trekey sits in the filename.")
			.addDropdown((dd) =>
				dd
					.addOption("prefix", "Prefix — start of filename (S88B07-title)")
					.addOption("suffix", "Suffix — end of filename (title-S88B07)")
					.setValue(this.plugin.settings.keyPosition)
					.onChange(async (value) => {
						this.plugin.settings.keyPosition =
							value === "suffix" ? "suffix" : "prefix";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sidebar tree view")
			.setDesc(
				"Show a collapsible tree of the location-tag hierarchy in the sidebar (ribbon icon + command)."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.treeViewEnabled).onChange(async (value) => {
					this.plugin.settings.treeViewEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.applyTreeViewState();
				})
			);

		new Setting(containerEl)
			.setName("Tree sort by")
			.setDesc("Sort order in the tree (ascending/descending is toggled in the panel header).")
			.addDropdown((dd) =>
				dd
					.addOption("trekey", "Trekey (name)")
					.addOption("mtime", "Modified time")
					.addOption("ctime", "Created time")
					.setValue(this.plugin.settings.sortKey)
					.onChange(async (value) => {
						this.plugin.settings.sortKey =
							value === "mtime" || value === "ctime" ? value : "trekey";
						await this.plugin.saveSettings();
						this.plugin.rebuildTrees();
					})
			);
	}
}
