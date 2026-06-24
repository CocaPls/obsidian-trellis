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
	parentTagPath,
	extractTrekey,
	trekeyToTagPath,
} from "./trekey";
import { TrellisTreeView, TRELLIS_TREE_VIEW } from "./tree-view";
import { t, setLang, LangSetting } from "./i18n";

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
/** What one bootstrap pass wrote, kept so it can be undone. */
interface BootstrapRecord {
	path: string;
	tag: string;
}

interface TrellisSettings extends TrellisConfig {
	treeViewEnabled: boolean;
	sortKey: SortKey;
	sortAsc: boolean;
	/** UI language: "auto" follows Obsidian, "en"/"ko" force it. */
	language: LangSetting;
	/** Files+tags written by the last bootstrap apply (for undo). */
	lastBootstrap?: BootstrapRecord[];
}

const DEFAULT_SETTINGS: TrellisSettings = {
	namespace: "trel",
	separator: "-",
	keyPosition: "prefix",
	treeViewEnabled: true,
	sortKey: "trekey",
	sortAsc: true,
	language: "auto",
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
		setLang(this.settings.language);
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
					(parentTagPath) => this.openNewNoteModal(parentTagPath),
					() => this.newNoteFromActive()
				)
		);
		this.ribbonEl = this.addRibbonIcon("list-tree", t("view.treeName"), () =>
			void this.activateTreeView()
		);
		this.addCommand({
			id: "open-tree-view",
			name: t("cmd.openTree"),
			callback: () => {
				if (this.settings.treeViewEnabled) void this.activateTreeView();
				else new Notice(t("notice.treeOff"));
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
			name: t("cmd.cascade"),
			callback: () => {
				new CascadeRenameModal(this.app, (from, to) =>
					void this.cascadeRename(from, to)
				).open();
			},
		});

		// Bootstrap an existing vault: read filename trekey prefixes and propose
		// location tags. Dry-run only — shows a preview, writes nothing.
		this.addCommand({
			id: "bootstrap-preview",
			name: t("cmd.bootstrapPreview"),
			callback: () => this.bootstrapDryRun(),
		});
		this.addCommand({
			id: "bootstrap-undo",
			name: t("cmd.bootstrapUndo"),
			callback: () => void this.undoBootstrap(),
		});

		// Right-click a note → cascade-rename its location tag (From prefilled).
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				const from = this.locationTagOf(file);
				if (from === null) return;
				menu.addItem((item) =>
					item
						.setTitle(t("cmd.cascade"))
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
			new Notice(t("notice.renamed", { from: file.basename, to: newBasename }));
		} catch (e) {
			console.error("TRELLIS rename failed", e);
			new Notice(t("notice.renameFailed", { name: file.basename }));
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

	/** Open the new-note modal with a parent prefilled (editable). Used by both
	 *  the right-click entry (clicked node) and the header button (active note). */
	private openNewNoteModal(initialParent: string) {
		new NewChildNoteModal(
			this.app,
			initialParent,
			(parent, segment, title) => void this.createChildNote(parent, segment, title)
		).open();
	}

	/** Header "new note" button: prefill the parent from the active note, like
	 *  the file explorer's create-at-current. File-explorer parity: an index note
	 *  (has children → acts as a folder) gets a CHILD; a leaf note gets a SIBLING
	 *  (created under its parent). Either way the parent stays editable. */
	private newNoteFromActive() {
		const active = this.app.workspace.getActiveFile();
		const tag = active ? this.locationTagOf(active) : null;
		if (!tag) {
			this.openNewNoteModal("");
			return;
		}
		const parent =
			this.childSegmentsOf(tag).length > 0 ? tag : parentTagPath(tag);
		this.openNewNoteModal(parent);
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
			new Notice(t("notice.noTrekey"));
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
			new Notice(t("notice.exists", { base }));
			return;
		}
		const content = `---\ntags: [${tagPath}]\n---\n\n# ${safeTitle || trekey}\n`;
		try {
			const file = await this.app.vault.create(path, content);
			await this.app.workspace.getLeaf(false).openFile(file);
		} catch (e) {
			console.error("TRELLIS create failed", e);
			new Notice(t("notice.createFailed", { base }));
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
				? t("notice.retagged", { n: retagged, from, to })
				: t("notice.noFilesTagged", { from })
		);
	}

	/** Bootstrap dry-run: scan every markdown file, propose a location tag from
	 *  its filename trekey prefix, and show a preview. Writes nothing — the user
	 *  reviews before any real onboarding (apply step comes later). */
	private bootstrapDryRun() {
		const assign: { name: string; path: string; tag: string }[] = [];
		const alreadyTagged: string[] = [];
		const noTrekey: string[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.locationTagOf(file)) {
				alreadyTagged.push(file.basename);
				continue;
			}
			const trekey = extractTrekey(file.basename, this.settings);
			const tagPath = trekey ? trekeyToTagPath(trekey, this.settings) : null;
			if (tagPath) assign.push({ name: file.basename, path: file.path, tag: tagPath });
			else noTrekey.push(file.basename);
		}
		new BootstrapPreviewModal(this.app, assign, alreadyTagged, noTrekey, (rows) =>
			void this.applyBootstrap(rows)
		).open();
	}

	/** Apply: write the proposed location tag into each file's frontmatter
	 *  (existing content preserved), recording what was written so it can be
	 *  undone. Filenames usually don't change — the trekey is already there. */
	private async applyBootstrap(assign: { path: string; tag: string }[]) {
		const record: BootstrapRecord[] = [];
		for (const r of assign) {
			const file = this.app.vault.getAbstractFileByPath(r.path);
			if (!(file instanceof TFile)) continue;
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				const tags = normalizeTagList(fm.tags);
				if (!tags.includes(r.tag)) fm.tags = [...tags, r.tag];
			});
			record.push({ path: r.path, tag: r.tag });
		}
		this.settings.lastBootstrap = record;
		await this.saveSettings();
		new Notice(t("notice.bootstrapped", { n: record.length }));
	}

	/** Undo the last bootstrap: remove exactly the tags it added. */
	private async undoBootstrap() {
		const record = this.settings.lastBootstrap ?? [];
		if (record.length === 0) {
			new Notice(t("notice.noBootstrap"));
			return;
		}
		let undone = 0;
		for (const r of record) {
			const file = this.app.vault.getAbstractFileByPath(r.path);
			if (!(file instanceof TFile)) continue;
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				const tags = normalizeTagList(fm.tags);
				const next = tags.filter((t) => t !== r.tag);
				if (next.length) fm.tags = next;
				else delete fm.tags;
			});
			undone++;
		}
		this.settings.lastBootstrap = [];
		await this.saveSettings();
		new Notice(t("notice.undid", { n: undone }));
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
		contentEl.createEl("h3", { text: t("modal.cascade.title") });
		contentEl.createEl("p", {
			text: t("modal.cascade.desc"),
			cls: "setting-item-description",
		});

		new Setting(contentEl)
			.setName(t("modal.cascade.fromName"))
			.setDesc(t("modal.cascade.fromDesc"))
			.addText((input) => {
				input
					.setPlaceholder("trel/S88")
					.setValue(this.from)
					.onChange((v) => (this.from = v.trim()));
				new TagPathSuggest(this.app, input.inputEl, (v) => (this.from = v));
			});
		new Setting(contentEl)
			.setName(t("modal.cascade.toName"))
			.setDesc(t("modal.cascade.toDesc"))
			.addText((input) => {
				input.setPlaceholder("trel/S99").onChange((v) => (this.to = v.trim()));
				new TagPathSuggest(this.app, input.inputEl, (v) => (this.to = v));
			});

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText(t("modal.cascade.submit"))
				.setCta()
				.onClick(() => {
					if (this.from && this.to) {
						this.close();
						this.onSubmit(this.from, this.to);
					} else {
						new Notice(t("notice.fillBoth"));
					}
				})
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** New-note modal. Parent: prefilled by the caller (clicked node, or the active
 *  note's location for the header button) and editable WITH tag autocomplete —
 *  it picks an existing location, so completing it is safe. Segment: the user
 *  assigns it by hand — TRELLIS is format-agnostic and must not guess the trekey
 *  scheme (a wrong "01" in an alphabetic slot would just have to be retyped). */
class NewChildNoteModal extends Modal {
	private parent: string;
	private segment = "";
	private title = "";
	private readonly onSubmit: (parent: string, segment: string, title: string) => void;

	constructor(
		app: App,
		initialParent: string,
		onSubmit: (parent: string, segment: string, title: string) => void
	) {
		super(app);
		this.parent = initialParent;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("modal.newNote.title") });
		contentEl.createEl("p", {
			text: t("modal.newNote.desc"),
			cls: "setting-item-description",
		});

		new Setting(contentEl)
			.setName(t("modal.newNote.parentName"))
			.setDesc(t("modal.newNote.parentDesc"))
			.addText((input) => {
				input
					.setPlaceholder("trel/S88")
					.setValue(this.parent)
					.onChange((v) => (this.parent = v.trim()));
				new TagPathSuggest(this.app, input.inputEl, (v) => (this.parent = v));
			});
		new Setting(contentEl)
			.setName(t("modal.newNote.segmentName"))
			.setDesc(t("modal.newNote.segmentDesc"))
			.addText((input) =>
				input
					.setPlaceholder(t("ph.segment"))
					.onChange((v) => (this.segment = v.trim()))
			);
		new Setting(contentEl)
			.setName(t("modal.newNote.titleName"))
			.addText((input) =>
				input
					.setPlaceholder(t("ph.noteTitle"))
					.onChange((v) => (this.title = v.trim()))
			);

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText(t("modal.newNote.submit"))
				.setCta()
				.onClick(() => {
					if (!this.parent) {
						new Notice(t("notice.parentRequired"));
						return;
					}
					if (!this.segment) {
						new Notice(t("notice.segmentRequired"));
						return;
					}
					this.close();
					this.onSubmit(this.parent, this.segment, this.title);
				})
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Bootstrap dry-run preview: lists files grouped by what would happen. Shows
 *  only — the apply step (with backup) is a separate, later command. */
class BootstrapPreviewModal extends Modal {
	constructor(
		app: App,
		private readonly assign: { name: string; path: string; tag: string }[],
		private readonly alreadyTagged: string[],
		private readonly noTrekey: string[],
		private readonly onApply: (rows: { path: string; tag: string }[]) => void
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("modal.bootstrap.title") });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("modal.bootstrap.summary", {
				assign: this.assign.length,
				already: this.alreadyTagged.length,
				none: this.noTrekey.length,
			}),
		});

		if (this.assign.length) {
			contentEl.createEl("h4", {
				text: t("modal.bootstrap.willAssign", { n: this.assign.length }),
			});
			const list = contentEl.createDiv({ cls: "trellis-bootstrap-list" });
			for (const r of this.assign) {
				const row = list.createDiv({ cls: "trellis-bootstrap-row" });
				row.createSpan({ cls: "trellis-bootstrap-name", text: r.name });
				row.createSpan({ cls: "trellis-bootstrap-arrow", text: " → " });
				row.createSpan({ cls: "trellis-bootstrap-tag", text: "#" + r.tag });
			}
		}

		if (this.noTrekey.length) {
			contentEl.createEl("h4", {
				text: t("modal.bootstrap.noTrekey", { n: this.noTrekey.length }),
			});
			const list = contentEl.createDiv({ cls: "trellis-bootstrap-list" });
			for (const n of this.noTrekey) {
				list.createDiv({ cls: "trellis-bootstrap-skip", text: n });
			}
		}

		const buttons = new Setting(contentEl);
		if (this.assign.length) {
			buttons.addButton((b) =>
				b
					.setButtonText(t("modal.bootstrap.apply", { n: this.assign.length }))
					.setWarning()
					.onClick(() => {
						this.onApply(this.assign.map((r) => ({ path: r.path, tag: r.tag })));
						this.close();
					})
			);
		}
		buttons.addButton((b) =>
			b.setButtonText(t("modal.bootstrap.close")).onClick(() => this.close())
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
			.setName(t("setting.langName"))
			.setDesc(t("setting.langDesc"))
			.addDropdown((dd) =>
				dd
					.addOption("auto", t("setting.langAuto"))
					.addOption("ko", "한국어")
					.addOption("en", "English")
					.setValue(this.plugin.settings.language)
					.onChange(async (value) => {
						this.plugin.settings.language =
							value === "ko" || value === "en" ? value : "auto";
						setLang(this.plugin.settings.language);
						await this.plugin.saveSettings();
						this.plugin.rebuildTrees();
						this.display(); // re-render this tab in the new language
					})
			);

		new Setting(containerEl)
			.setName(t("setting.nsName"))
			.setDesc(t("setting.nsDesc"))
			.addText((text) =>
				text
					.setPlaceholder("trel")
					.setValue(this.plugin.settings.namespace)
					.onChange(async (value) => {
						const v = value.trim().replace(/^#/, "").replace(/\/$/, "");
						if (v === "") {
							new Notice(t("notice.nsEmpty"));
							return;
						}
						this.plugin.settings.namespace = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("setting.sepName"))
			.setDesc(t("setting.sepDesc"))
			.addText((text) =>
				text
					.setPlaceholder("-")
					.setValue(this.plugin.settings.separator)
					.onChange(async (value) => {
						if (value.length !== 1) {
							new Notice(t("notice.sepOneChar"));
							return;
						}
						this.plugin.settings.separator = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("setting.posName"))
			.setDesc(t("setting.posDesc"))
			.addDropdown((dd) =>
				dd
					.addOption("prefix", t("setting.posPrefix"))
					.addOption("suffix", t("setting.posSuffix"))
					.setValue(this.plugin.settings.keyPosition)
					.onChange(async (value) => {
						this.plugin.settings.keyPosition =
							value === "suffix" ? "suffix" : "prefix";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("setting.treeName"))
			.setDesc(t("setting.treeDesc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.treeViewEnabled)
					.onChange(async (value) => {
						this.plugin.settings.treeViewEnabled = value;
						await this.plugin.saveSettings();
						this.plugin.applyTreeViewState();
					})
			);

		new Setting(containerEl)
			.setName(t("setting.sortName"))
			.setDesc(t("setting.sortDesc"))
			.addDropdown((dd) =>
				dd
					.addOption("trekey", t("setting.sortTrekey"))
					.addOption("mtime", t("setting.sortMtime"))
					.addOption("ctime", t("setting.sortCtime"))
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
