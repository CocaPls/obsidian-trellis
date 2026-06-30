import {
	Plugin,
	TFile,
	TFolder,
	TAbstractFile,
	getAllTags,
	Notice,
	Modal,
	Setting,
	PluginSettingTab,
	App,
	AbstractInputSuggest,
	ButtonComponent,
	debounce,
	normalizePath,
} from "obsidian";
import {
	TrellisSchema,
	KeySlot,
	defaultSchema,
	schemaFromLegacy,
	primaryNamespace,
	primarySeparator,
	tagPosition,
	duplicateLocationGroups,
	DuplicateTagGroup,
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
	parentTagPath,
	extractTrekey,
	trekeyToTagPath,
	assembleBasename,
	separatorMigratedName,
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
 * The filename key schema (slots + separators, B09) is configurable; the
 * single-key default is a 2-slot [tag, name].
 * Deferred: multi-key UI & parsing (data model ready), title-key upward sync,
 * drift warnings.
 */

/** What one bootstrap pass wrote, kept so it can be undone. */
interface BootstrapRecord {
	path: string;
	tag: string;
}

/** One file renamed by a separator change: its post-change path + the basename
 *  it had before, so the change can be undone. */
interface SeparatorRename {
	path: string;
	oldBasename: string;
}

/** The last separator-change pass: the renames plus the separators it moved
 *  between, so undo restores both the filenames and the setting. */
interface SeparatorChangeRecord {
	oldSep: string;
	newSep: string;
	renames: SeparatorRename[];
}

/** One file's location tags removed by a dedup pass, so it can be undone. */
interface DedupRecord {
	path: string;
	removed: string[];
}

interface TrellisSettings {
	/** Filename key schema (B09 path B). Single-key = a 2-slot [tag, name]. */
	schema: TrellisSchema;
	treeViewEnabled: boolean;
	sortKey: SortKey;
	sortAsc: boolean;
	/** UI language: "auto" follows Obsidian, "en"/"ko" force it. */
	language: LangSetting;
	/** Files+tags written by the last bootstrap apply (for undo). */
	lastBootstrap?: BootstrapRecord[];
	/** The last separator change (for undo). */
	lastSeparatorChange?: SeparatorChangeRecord;
	/** Location tags removed by the last duplicate-tag cleanup (for undo). */
	lastDedup?: DedupRecord[];
}

const DEFAULT_SETTINGS: TrellisSettings = {
	schema: defaultSchema(),
	treeViewEnabled: true,
	sortKey: "trekey",
	sortAsc: true,
	language: "auto",
};

/** Legacy (pre-multi-key) scalar config, as older saved data may hold it. */
interface LegacyConfig {
	namespace?: string;
	separator?: string;
	keyPosition?: "prefix" | "suffix";
}

export default class TrellisPlugin extends Plugin {
	settings: TrellisSettings = { ...DEFAULT_SETTINGS };

	/** Ribbon button for the tree view, kept so we can show/hide it on toggle. */
	private ribbonEl: HTMLElement | null = null;

	/** Infinite-loop guard: paths we are currently renaming, to ignore the
	 *  metadata/vault events our own rename triggers. */
	private renaming = new Set<string>();
	/** Files already warned about carrying multiple location tags (one note =
	 *  one location). Cleared when a file returns to a single location tag. */
	private multiWarned = new Set<string>();

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
					() => this.newNoteFromActive(),
					() =>
						new BootstrapSelectModal(
							this.app,
							(paths) => this.bootstrapDryRun(paths),
							(f) => this.locationTagOf(f) !== null
						).open(),
					() =>
						new CascadeRenameModal(this.app, (from, to) =>
							void this.cascadeRename(from, to)
						).open(),
					() => void this.undoBootstrap(),
					() => void this.undoSeparatorChange()
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
		// New note under the active note's location tag (same as the tree header's
		// new-note button), available from the command palette too.
		this.addCommand({
			id: "new-note",
			name: t("cmd.newNote"),
			callback: () => this.newNoteFromActive(),
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
			callback: () =>
				new BootstrapSelectModal(
					this.app,
					(paths) => this.bootstrapDryRun(paths),
					(f) => this.locationTagOf(f) !== null
				).open(),
		});
		this.addCommand({
			id: "bootstrap-undo",
			name: t("cmd.bootstrapUndo"),
			callback: () => void this.undoBootstrap(),
		});
		this.addCommand({
			id: "separator-change-undo",
			name: t("cmd.sepUndo"),
			callback: () => void this.undoSeparatorChange(),
		});
		this.addCommand({
			id: "check-duplicate-location-tags",
			name: t("cmd.checkDuplicates"),
			callback: () => this.openDuplicateTagsModal(),
		});
		this.addCommand({
			id: "dedup-undo",
			name: t("cmd.dedupUndo"),
			callback: () => void this.undoDedup(),
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
	}

	async loadSettings() {
		const data = (await this.loadData()) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// Give settings its OWN schema so edits never mutate the shared default.
		// Three cases: (a) saved schema → use it (loadData yields fresh objects);
		// (b) legacy scalar config → migrate; (c) fresh install → own default.
		if (!data.schema) {
			const legacy = data as LegacyConfig;
			const hasLegacy =
				legacy.namespace !== undefined ||
				legacy.separator !== undefined ||
				legacy.keyPosition !== undefined;
			this.settings.schema = hasLegacy
				? schemaFromLegacy(
						legacy.namespace ?? "trel",
						legacy.separator ?? "-",
						legacy.keyPosition ?? "prefix"
					)
				: defaultSchema();
			// Drop migrated legacy scalar keys so they don't linger in data.json.
			const s = this.settings as Partial<LegacyConfig>;
			delete s.namespace;
			delete s.separator;
			delete s.keyPosition;
		}
	}

	// --- Single-key view of the schema (settings-tab read/write helpers) ----
	// The settings tab exposes the default single-key knobs; these read/write
	// them onto the schema's first tag slot, preserving any extra slots.

	private firstTagSlot(): KeySlot {
		const slot = this.settings.schema.slots.find((s) => s.role === "tag");
		if (slot) return slot;
		// Schema with no tag slot shouldn't happen; repair to a fresh default.
		this.settings.schema = defaultSchema();
		return this.settings.schema.slots.find((s) => s.role === "tag")!;
	}

	setPrimaryNamespace(ns: string) {
		this.firstTagSlot().namespace = ns;
	}

	setPrimarySeparator(sep: string) {
		if (this.settings.schema.separators.length === 0) this.settings.schema.separators = [sep];
		else this.settings.schema.separators[0] = sep;
	}

	setKeyPosition(pos: "prefix" | "suffix") {
		const s = this.settings.schema;
		const tag = s.slots.find((x) => x.role === "tag");
		const name = s.slots.find((x) => x.role === "name");
		if (!tag) return;
		s.slots = (pos === "suffix" ? [name, tag] : [tag, name]).filter(
			(x): x is KeySlot => x !== undefined
		);
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

		// One note = one location per namespace. Warn once (lightly) if a note
		// carries duplicate location tags; the user resolves them in bulk via the
		// "check duplicate location tags" command. We still sync from the first
		// match (pickTrekey) so behavior stays deterministic.
		const dupGroups = duplicateLocationGroups(tags, this.settings.schema);
		if (dupGroups.length > 0) {
			if (!this.multiWarned.has(file.path)) {
				this.multiWarned.add(file.path);
				const n = dupGroups.reduce((sum, g) => sum + g.tags.length, 0);
				new Notice(t("notice.multiLocation", { name: file.basename, n }));
				console.warn("TRELLIS: duplicate location tags on", file.path, dupGroups);
			}
		} else {
			this.multiWarned.delete(file.path);
		}

		const trekey = pickTrekey(tags, this.settings.schema);
		if (trekey === null) return; // no location tag → never touch the file

		const newBasename = syncedBasename(file.basename, trekey, this.settings.schema);
		if (newBasename === null) return; // already in sync

		const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
		const newPath = normalizePath(`${dir}${newBasename}.${file.extension}`);

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
		const ns = primaryNamespace(this.settings.schema);
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
		const ns = primaryNamespace(this.settings.schema);
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
		const trekey = tagToTrekey(`#${tagPath}`, this.settings.schema);
		if (!trekey) {
			new Notice(t("notice.noTrekey"));
			return;
		}
		const safeTitle = title.trim().replace(/[\\/:*?"<>|]/g, "");
		const base = assembleBasename(trekey, safeTitle, this.settings.schema);

		const path = normalizePath(`${base}.md`);
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
		const prefix = `#${primaryNamespace(this.settings.schema)}/`;
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
		const failed: string[] = [];
		for (const file of files) {
			let touched = false;
			try {
				await this.app.fileManager.processFrontMatter(file, (fm) => {
					const tags = normalizeTagList(fm.tags);
					if (tags.length === 0) return;
					const next = tags.map((t) => renameTagPath(t, from, to) ?? t);
					if (next.some((t, i) => t !== tags[i])) {
						fm.tags = next;
						touched = true;
					}
				});
			} catch (e) {
				// A malformed YAML file must not abort the whole cascade.
				console.error("TRELLIS cascade skipped (frontmatter error)", file.path, e);
				failed.push(file.basename);
				continue;
			}
			if (touched) retagged++;
		}
		new Notice(
			retagged > 0
				? t("notice.retagged", { n: retagged, from, to })
				: t("notice.noFilesTagged", { from })
		);
		if (failed.length) new BootstrapErrorsModal(this.app, failed).open();
	}

	/** Bootstrap dry-run: scan the chosen markdown files (or the whole vault when
	 *  scopePaths is omitted), propose a location tag from each filename's trekey
	 *  prefix, and show a preview. Writes nothing — the user reviews before any
	 *  real onboarding (apply step comes later). */
	private bootstrapDryRun(scopePaths?: Set<string>) {
		const assign: { name: string; path: string; tag: string }[] = [];
		const alreadyTagged: string[] = [];
		const noTrekey: string[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (scopePaths && !scopePaths.has(file.path)) continue;
			if (this.locationTagOf(file)) {
				alreadyTagged.push(file.basename);
				continue;
			}
			const trekey = extractTrekey(file.basename, this.settings.schema);
			const tagPath = trekey ? trekeyToTagPath(trekey, this.settings.schema) : null;
			if (tagPath) assign.push({ name: file.basename, path: file.path, tag: tagPath });
			else noTrekey.push(file.basename);
		}
		new BootstrapPreviewModal(this.app, assign, alreadyTagged, noTrekey, (rows) =>
			void this.applyBootstrap(rows)
		).open();
	}

	/** Apply: write the proposed location tag into each file's frontmatter
	 *  (existing content preserved), recording what was written so it can be
	 *  undone. Filenames usually don't change — the trekey is already there.
	 *
	 *  Robust against a single bad file: a frontmatter parse error (e.g. a file
	 *  with duplicate YAML keys) is caught per-file and collected, so it can
	 *  never abort the whole pass. A live progress Notice tracks the run, and the
	 *  undo record is saved in `finally` so even an interrupted pass stays
	 *  undoable. */
	private async applyBootstrap(assign: { path: string; tag: string }[]) {
		const record: BootstrapRecord[] = [];
		const failed: string[] = [];
		const total = assign.length;
		const progress = new Notice(t("notice.bootstrapProgress", { done: 0, total }), 0);
		try {
			for (let i = 0; i < assign.length; i++) {
				const r = assign[i];
				const file = this.app.vault.getAbstractFileByPath(r.path);
				if (file instanceof TFile) {
					try {
						await this.app.fileManager.processFrontMatter(file, (fm) => {
							const tags = normalizeTagList(fm.tags);
							if (!tags.includes(r.tag)) fm.tags = [...tags, r.tag];
						});
						record.push({ path: r.path, tag: r.tag });
					} catch (e) {
						failed.push(r.path);
						console.error("TRELLIS bootstrap skipped (frontmatter error)", r.path, e);
					}
				}
				if ((i + 1) % 25 === 0 || i + 1 === total) {
					progress.setMessage(t("notice.bootstrapProgress", { done: i + 1, total }));
				}
			}
		} finally {
			progress.hide();
			// Save what we managed to write even if the loop threw — keeps undo intact.
			this.settings.lastBootstrap = record;
			await this.saveSettings();
		}
		new Notice(
			failed.length
				? t("notice.bootstrappedWithErrors", { n: record.length, failed: failed.length })
				: t("notice.bootstrapped", { n: record.length })
		);
		if (failed.length) new BootstrapErrorsModal(this.app, failed).open();
	}

	// --- Separator batch change (v0.0.7) -----------------------------------
	// One-directional, like the tag→filename engine: the SETTING is the source
	// of truth. Changing the separator in settings rewrites every tagged file's
	// boundary separator to match (title-internal symbols preserved), behind a
	// confirm dialog with a dry-run preview and a one-step undo.

	/** A clone of the current schema with a different primary separator, for
	 *  computing the migrated names without mutating live settings. */
	private schemaWithSeparator(sep: string): TrellisSchema {
		const slots = this.settings.schema.slots.map((s) => ({ ...s }));
		const separators = [...this.settings.schema.separators];
		if (separators.length === 0) separators.push(sep);
		else separators[0] = sep;
		return { slots, separators };
	}

	/** Dry-run: which tagged files a switch to `newSep` would rename. The tag is
	 *  the source of truth (trekey from the tag, separator-agnostic), so untagged
	 *  files are never touched — bootstrap onboards those first. */
	private previewSeparatorChange(
		newSep: string
	): { path: string; oldName: string; newName: string }[] {
		const oldSchema = this.settings.schema;
		const newSchema = this.schemaWithSeparator(newSep);
		const out: { path: string; oldName: string; newName: string }[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const trekey = pickTrekey(getAllTags(cache) ?? [], oldSchema);
			if (trekey === null) continue;
			const newName = separatorMigratedName(file.basename, trekey, oldSchema, newSchema);
			if (newName !== null) out.push({ path: file.path, oldName: file.basename, newName });
		}
		return out;
	}

	/** Open the confirm dialog for a separator change (called from settings). */
	requestSeparatorChange(newSep: string, onDone: () => void) {
		const oldSep = primarySeparator(this.settings.schema);
		if (newSep === oldSep) {
			onDone();
			return;
		}
		const rows = this.previewSeparatorChange(newSep);
		new SeparatorChangeModal(this.app, oldSep, newSep, rows, onDone, () =>
			void this.applySeparatorChange(newSep, rows)
		).open();
	}

	/** Apply: flip the setting, then rename every affected file (link-safe),
	 *  recording the renames so the whole pass can be undone. */
	private async applySeparatorChange(
		newSep: string,
		rows: { path: string; oldName: string; newName: string }[]
	) {
		const oldSep = primarySeparator(this.settings.schema);
		// Flip the setting first so one-directional sync now targets the new sep.
		this.setPrimarySeparator(newSep);
		await this.saveSettings();
		const renames: SeparatorRename[] = [];
		const total = rows.length;
		const progress = new Notice(t("notice.sepProgress", { done: 0, total }), 0);
		try {
			for (let i = 0; i < rows.length; i++) {
				const r = rows[i];
				const file = this.app.vault.getAbstractFileByPath(r.path);
				if (file instanceof TFile) {
					const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
					const newPath = normalizePath(`${dir}${r.newName}.${file.extension}`);
					await this.renameGuarded(file, newPath); // own try/catch — bad file can't abort
					renames.push({ path: newPath, oldBasename: r.oldName });
				}
				if ((i + 1) % 25 === 0 || i + 1 === total) {
					progress.setMessage(t("notice.sepProgress", { done: i + 1, total }));
				}
			}
		} finally {
			progress.hide();
			this.settings.lastSeparatorChange = { oldSep, newSep, renames };
			await this.saveSettings();
		}
		this.rebuildTrees();
		new Notice(t("notice.sepChanged", { n: renames.length, from: oldSep, to: newSep }));
	}

	/** Undo the last separator change: restore the setting AND each filename. */
	private async undoSeparatorChange() {
		const rec = this.settings.lastSeparatorChange;
		if (!rec || rec.renames.length === 0) {
			new Notice(t("notice.noSepChange"));
			return;
		}
		this.setPrimarySeparator(rec.oldSep);
		await this.saveSettings();
		let undone = 0;
		for (const r of rec.renames) {
			const file = this.app.vault.getAbstractFileByPath(r.path);
			if (!(file instanceof TFile)) continue;
			const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
			const newPath = normalizePath(`${dir}${r.oldBasename}.${file.extension}`);
			await this.renameGuarded(file, newPath);
			undone++;
		}
		this.settings.lastSeparatorChange = undefined;
		await this.saveSettings();
		this.rebuildTrees();
		new Notice(t("notice.sepReverted", { n: undone }));
	}

	/** Scan every note for namespaces carrying 2+ location tags and open the
	 *  cleanup modal. One note = one location per namespace; the user picks which
	 *  tag to keep and the rest are removed from frontmatter (undoable). */
	private openDuplicateTagsModal() {
		const dups: DuplicateNote[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const groups = duplicateLocationGroups(
				getAllTags(cache) ?? [],
				this.settings.schema
			);
			if (groups.length) dups.push({ file, groups });
		}
		if (dups.length === 0) {
			new Notice(t("notice.noDuplicates"));
			return;
		}
		new DuplicateTagsModal(this.app, dups, (decisions) =>
			void this.applyDedup(decisions)
		).open();
	}

	/** Apply the modal's decisions: keep the chosen tag per namespace and remove
	 *  the rest from each file's frontmatter, recording removals for undo. */
	private async applyDedup(decisions: DedupDecision[]) {
		const record: DedupRecord[] = [];
		for (const d of decisions) {
			const file = this.app.vault.getAbstractFileByPath(d.path);
			if (!(file instanceof TFile)) continue;
			const removed: string[] = [];
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				const tags = normalizeTagList(fm.tags);
				const next = tags.filter((tg) => {
					const hashed = "#" + tg;
					let inAnyGroup = false;
					for (const [ns, keep] of Object.entries(d.keep)) {
						if (hashed === `#${ns}` || hashed.startsWith(`#${ns}/`)) {
							inAnyGroup = true;
							if (hashed === keep) return true; // the chosen tag stays
						}
					}
					if (inAnyGroup) {
						removed.push(tg);
						return false;
					}
					return true; // unrelated tag — leave it
				});
				if (removed.length) fm.tags = next;
			});
			if (removed.length) {
				record.push({ path: d.path, removed });
				this.multiWarned.delete(d.path);
			}
		}
		this.settings.lastDedup = record;
		await this.saveSettings();
		new Notice(
			record.length > 0
				? t("notice.deduped", { n: record.length })
				: t("notice.noDuplicates")
		);
	}

	/** Undo the last dedup: add the removed location tags back to each file. */
	private async undoDedup() {
		const record = this.settings.lastDedup ?? [];
		if (record.length === 0) {
			new Notice(t("notice.noDedup"));
			return;
		}
		let restored = 0;
		for (const r of record) {
			const file = this.app.vault.getAbstractFileByPath(r.path);
			if (!(file instanceof TFile)) continue;
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				const tags = normalizeTagList(fm.tags);
				for (const tg of r.removed) if (!tags.includes(tg)) tags.push(tg);
				fm.tags = tags;
			});
			restored++;
		}
		this.settings.lastDedup = undefined;
		await this.saveSettings();
		new Notice(t("notice.dedupUndone", { n: restored }));
	}

	/** Rename a file with the infinite-loop guard set, so our own rename's
	 *  follow-up events don't re-trigger syncFile. Shared by sync + migration. */
	private async renameGuarded(file: TFile, newPath: string) {
		this.renaming.add(file.path);
		this.renaming.add(newPath);
		try {
			await this.app.fileManager.renameFile(file, newPath);
		} catch (e) {
			console.error("TRELLIS rename failed", e);
			new Notice(t("notice.renameFailed", { name: file.basename }));
		} finally {
			this.renaming.delete(file.path);
			window.setTimeout(() => this.renaming.delete(newPath), 200);
		}
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
interface DuplicateNote {
	file: TFile;
	groups: DuplicateTagGroup[];
}

interface DedupDecision {
	path: string;
	/** namespace → the tag to keep (with leading '#'). */
	keep: Record<string, string>;
}

/** Max notes shown in one cleanup pass — large batches are split so the modal
 *  stays usable. The user applies, then re-runs the check for the next batch. */
const DEDUP_BATCH_LIMIT = 50;

/** Resolve notes carrying duplicate location tags: the user picks which tag to
 *  keep per namespace, then applies (removes the rest, undoable) or defers.
 *  Shows the total count and, for large batches, only the first N at a time. */
class DuplicateTagsModal extends Modal {
	private keep = new Map<string, Record<string, string>>();
	private readonly visible: DuplicateNote[];

	constructor(
		app: App,
		private readonly dups: DuplicateNote[],
		private readonly onApply: (decisions: DedupDecision[]) => void
	) {
		super(app);
		this.visible = dups.slice(0, DEDUP_BATCH_LIMIT);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: t("dedup.title") });
		contentEl.createEl("p", { text: t("dedup.desc"), cls: "trellis-dedup-desc" });
		contentEl.createEl("p", {
			text: t("dedup.count", { n: this.dups.length }),
			cls: "trellis-dedup-count",
		});
		const rest = this.dups.length - this.visible.length;
		if (rest > 0) {
			contentEl.createEl("p", {
				text: t("dedup.more", { shown: this.visible.length, rest }),
				cls: "trellis-dedup-more",
			});
		}

		const list = contentEl.createDiv({ cls: "trellis-dedup-list" });
		for (const d of this.visible) {
			const keepMap: Record<string, string> = {};
			this.keep.set(d.file.path, keepMap);

			const section = list.createDiv({ cls: "trellis-dedup-note" });
			section.createDiv({ cls: "trellis-dedup-file", text: d.file.basename });

			for (const g of d.groups) {
				keepMap[g.namespace] = g.tags[0]; // default: keep the first
				const groupEl = section.createDiv({ cls: "trellis-dedup-group" });
				const radioName = `${d.file.path}::${g.namespace}`;
				for (const tag of g.tags) {
					const label = groupEl.createEl("label", {
						cls: "trellis-dedup-option",
					});
					const radio = label.createEl("input", {
						attr: { type: "radio", name: radioName },
					});
					radio.checked = tag === g.tags[0];
					radio.addEventListener("change", () => {
						keepMap[g.namespace] = tag;
					});
					label.createSpan({ text: " " + tag });
				}
			}
		}

		const btns = contentEl.createDiv({ cls: "trellis-dedup-buttons" });
		const apply = btns.createEl("button", {
			text: t("dedup.apply"),
			cls: "mod-cta",
		});
		apply.addEventListener("click", () => {
			const decisions: DedupDecision[] = this.visible.map((d) => ({
				path: d.file.path,
				keep: this.keep.get(d.file.path) ?? {},
			}));
			this.close();
			this.onApply(decisions);
		});
		const defer = btns.createEl("button", { text: t("dedup.defer") });
		defer.addEventListener("click", () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

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

/** Bootstrap target picker: a checkbox tree of the vault's folders and notes.
 *  Checking a folder selects every markdown note under it; notes can be toggled
 *  individually, and folders + loose notes can be mixed. "Select all" grabs the
 *  whole vault (the original whole-vault bootstrap). Confirm hands the chosen
 *  paths to the dry-run, which previews only those before anything is written. */
class BootstrapSelectModal extends Modal {
	private readonly selected = new Set<string>();
	private readonly expanded = new Set<string>();
	private treeEl!: HTMLElement;
	private filter = "";
	/** When on, already-tagged notes are hidden — only bootstrap targets show. */
	private untaggedOnly = true;
	/** Visible note paths in render (top-to-bottom) order — drives Shift-range. */
	private visibleFiles: string[] = [];
	private lastClicked: string | null = null;
	private nextBtn?: ButtonComponent;
	/** Drag-to-select: while dragging we update checkboxes IN PLACE (no
	 *  re-render) so mouseenter keeps firing; mouseup does a final render to sync
	 *  folder tristates. The start row's state flips the mode (select/deselect). */
	private dragging = false;
	private dragMode: "select" | "deselect" = "select";
	private readonly cbByPath = new Map<string, HTMLInputElement>();
	private readonly onMouseUp = () => {
		if (!this.dragging) return;
		this.dragging = false;
		this.renderTree();
	};

	constructor(
		app: App,
		private readonly onConfirm: (paths: Set<string>) => void,
		private readonly isTagged: (file: TFile) => boolean
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("modal.bootstrapSelect.title") });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("modal.bootstrapSelect.desc"),
		});

		const search = contentEl.createEl("input", {
			type: "text",
			cls: "trellis-bootstrap-search",
			attr: { placeholder: t("ph.bootstrapSearch") },
		});
		search.addEventListener("input", () => {
			this.filter = search.value.trim();
			this.renderTree();
		});

		new Setting(contentEl)
			.setName(t("modal.bootstrapSelect.untaggedOnly"))
			.addToggle((tg) =>
				tg.setValue(this.untaggedOnly).onChange((v) => {
					this.untaggedOnly = v;
					this.renderTree();
				})
			);

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText(t("modal.bootstrapSelect.selectAll")).onClick(() => {
					for (const f of this.app.vault.getMarkdownFiles())
						if (this.fileVisible(f)) this.selected.add(f.path);
					this.renderTree();
				})
			)
			.addButton((b) =>
				b.setButtonText(t("modal.bootstrapSelect.clear")).onClick(() => {
					this.selected.clear();
					this.renderTree();
				})
			);

		this.treeEl = contentEl.createDiv({ cls: "trellis-bootstrap-tree" });
		document.addEventListener("mouseup", this.onMouseUp);
		this.renderTree();

		new Setting(contentEl)
			.addButton((b) => {
				this.nextBtn = b;
				b.setCta().onClick(() => {
					if (this.selected.size === 0) {
						new Notice(t("notice.bootstrapNoSelection"));
						return;
					}
					const chosen = new Set(this.selected);
					this.close();
					this.onConfirm(chosen);
				});
			})
			.addButton((b) =>
				b.setButtonText(t("modal.bootstrap.close")).onClick(() => this.close())
			);
		this.updateNextLabel();

		// Focus the search box so the user can type to filter immediately.
		search.focus();
	}

	private updateNextLabel() {
		this.nextBtn?.setButtonText(
			t("modal.bootstrapSelect.next", { n: this.selected.size })
		);
	}

	/** Direct children of a folder: subfolders first, then markdown notes. */
	private childrenOf(folder: TFolder): TAbstractFile[] {
		const folders = folder.children.filter(
			(c): c is TFolder => c instanceof TFolder
		);
		const files = folder.children.filter(
			(c): c is TFile => c instanceof TFile && c.extension === "md"
		);
		folders.sort((a, b) => a.name.localeCompare(b.name));
		files.sort((a, b) => a.name.localeCompare(b.name));
		return [...folders, ...files];
	}

	/** Every markdown file anywhere under a folder (recursive). */
	private mdFilesUnder(folder: TFolder): TFile[] {
		const out: TFile[] = [];
		const walk = (f: TFolder) => {
			for (const c of f.children) {
				if (c instanceof TFolder) walk(c);
				else if (c instanceof TFile && c.extension === "md") out.push(c);
			}
		};
		walk(folder);
		return out;
	}

	/** A note shows when it matches the search AND passes the tagged filter. */
	private fileVisible(file: TFile): boolean {
		if (
			this.filter &&
			!file.basename.toLowerCase().includes(this.filter.toLowerCase())
		)
			return false;
		if (this.untaggedOnly && this.isTagged(file)) return false;
		return true;
	}

	/** A folder shows only if some descendant note is currently visible. */
	private folderHasVisible(folder: TFolder): boolean {
		return this.mdFilesUnder(folder).some((f) => this.fileVisible(f));
	}

	private renderTree() {
		this.treeEl.empty();
		this.visibleFiles = [];
		this.cbByPath.clear();
		for (const child of this.childrenOf(this.app.vault.getRoot())) {
			this.renderNode(this.treeEl, child, 0);
		}
		if (this.visibleFiles.length === 0) {
			this.treeEl.createDiv({
				cls: "trellis-bootstrap-empty",
				text: t("modal.bootstrapSelect.empty"),
			});
		}
		this.updateNextLabel();
	}

	/** Select every visible note between two paths (inclusive) — Shift-range. */
	private selectRange(a: string, b: string) {
		const i = this.visibleFiles.indexOf(a);
		const j = this.visibleFiles.indexOf(b);
		if (i < 0 || j < 0) {
			this.selected.add(b);
			return;
		}
		const [lo, hi] = i < j ? [i, j] : [j, i];
		for (let k = lo; k <= hi; k++) this.selected.add(this.visibleFiles[k]);
	}

	private renderNode(parent: HTMLElement, node: TAbstractFile, depth: number) {
		if (node instanceof TFolder) {
			if (!this.folderHasVisible(node)) return;
			const visible = this.mdFilesUnder(node).filter((f) => this.fileVisible(f));
			const sel = visible.filter((f) => this.selected.has(f.path)).length;
			// While searching, force every shown folder open so matches are visible.
			const open = this.filter ? true : this.expanded.has(node.path);

			const row = parent.createDiv({
				cls: "trellis-bootstrap-treerow trellis-bootstrap-folder",
			});
			row.style.paddingLeft = `${depth * 1.3}em`;

			const caret = row.createSpan({
				cls: "trellis-bootstrap-caret",
				text: open ? "▾" : "▸",
			});
			const toggleOpen = () => {
				if (this.filter) return; // caret inert while searching
				if (this.expanded.has(node.path)) this.expanded.delete(node.path);
				else this.expanded.add(node.path);
				this.renderTree();
			};
			caret.addEventListener("click", toggleOpen);

			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = visible.length > 0 && sel === visible.length;
			cb.indeterminate = sel > 0 && sel < visible.length;
			cb.addEventListener("change", () => {
				if (cb.checked) visible.forEach((f) => this.selected.add(f.path));
				else visible.forEach((f) => this.selected.delete(f.path));
				this.renderTree();
			});

			const name = row.createSpan({
				cls: "trellis-bootstrap-foldername",
				text: `${node.name} (${visible.length})`,
			});
			name.addEventListener("click", toggleOpen);

			if (open) {
				for (const child of this.childrenOf(node)) {
					this.renderNode(parent, child, depth + 1);
				}
			}
		} else if (node instanceof TFile) {
			if (!this.fileVisible(node)) return;
			this.visibleFiles.push(node.path);
			const tagged = this.isTagged(node);

			const row = parent.createDiv({
				cls: tagged
					? "trellis-bootstrap-treerow trellis-bootstrap-file trellis-bootstrap-tagged"
					: "trellis-bootstrap-treerow trellis-bootstrap-file",
			});
			row.style.paddingLeft = `${depth * 1.3}em`;

			row.createSpan({ cls: "trellis-bootstrap-caret", text: "" });

			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = this.selected.has(node.path);
			this.cbByPath.set(node.path, cb);

			row.createSpan({
				cls: "trellis-bootstrap-filename",
				text: node.basename,
			});
			if (tagged) {
				row.createSpan({
					cls: "trellis-bootstrap-badge",
					text: t("modal.bootstrapSelect.tagged"),
				});
			}

			// Left-press starts a drag-select; dragging across rows paints them.
			// The start row's current state flips the mode (select vs deselect),
			// so one drag both selects and clears. A press without moving = toggle.
			// Shift+press extends the visible range from the last click.
			row.addEventListener("mousedown", (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				if (e.shiftKey && this.lastClicked) {
					this.selectRange(this.lastClicked, node.path);
					this.renderTree();
					return;
				}
				this.dragging = true;
				this.dragMode = this.selected.has(node.path) ? "deselect" : "select";
				this.applyDrag(node.path);
				this.lastClicked = node.path;
			});
			row.addEventListener("mouseenter", () => {
				if (this.dragging) this.applyDrag(node.path);
			});
		}
	}

	/** Apply the active drag mode to one note, updating its checkbox in place
	 *  (no re-render — keeps the drag's mouseenter stream alive). */
	private applyDrag(path: string) {
		if (this.dragMode === "select") this.selected.add(path);
		else this.selected.delete(path);
		const cb = this.cbByPath.get(path);
		if (cb) cb.checked = this.selected.has(path);
	}

	onClose() {
		document.removeEventListener("mouseup", this.onMouseUp);
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

/** Lists files a bootstrap pass had to skip (frontmatter parse errors, e.g.
 *  duplicate YAML keys). Shown after apply so the user can fix them by hand. */
class BootstrapErrorsModal extends Modal {
	constructor(app: App, private readonly failed: string[]) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("modal.bootstrapErrors.title") });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("modal.bootstrapErrors.desc", { n: this.failed.length }),
		});
		const list = contentEl.createDiv({ cls: "trellis-bootstrap-list" });
		for (const p of this.failed) {
			list.createDiv({ cls: "trellis-bootstrap-skip", text: p });
		}
		new Setting(contentEl).addButton((b) =>
			b.setButtonText(t("modal.bootstrap.close")).onClick(() => this.close())
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Confirm dialog for a separator change. Small by default — shows the count
 *  and a collapsible list of exactly which files would be renamed — with a
 *  warning-styled apply and a cancel. Closing it always calls onClose (the
 *  settings tab re-renders so the input matches the final state). */
class SeparatorChangeModal extends Modal {
	constructor(
		app: App,
		private readonly oldSep: string,
		private readonly newSep: string,
		private readonly rows: { path: string; oldName: string; newName: string }[],
		private readonly onClosed: () => void,
		private readonly onApply: () => void
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("modal.sep.title") });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("modal.sep.desc", { from: this.oldSep, to: this.newSep }),
		});

		if (this.rows.length === 0) {
			contentEl.createEl("p", { text: t("modal.sep.none") });
			new Setting(contentEl).addButton((b) =>
				b.setButtonText(t("modal.sep.cancel")).onClick(() => this.close())
			);
			return;
		}

		contentEl.createEl("p", {
			text: t("modal.sep.count", { n: this.rows.length }),
		});

		// Collapsible exact list — open it to review every rename before applying.
		const details = contentEl.createEl("details");
		details.createEl("summary", { text: t("modal.sep.showList") });
		const list = details.createDiv({ cls: "trellis-bootstrap-list" });
		for (const r of this.rows) {
			const row = list.createDiv({ cls: "trellis-bootstrap-row" });
			row.createSpan({ cls: "trellis-bootstrap-name", text: r.oldName });
			row.createSpan({ cls: "trellis-bootstrap-arrow", text: " → " });
			row.createSpan({ cls: "trellis-bootstrap-tag", text: r.newName });
		}

		const buttons = new Setting(contentEl);
		buttons.addButton((b) =>
			b
				.setButtonText(t("modal.sep.apply", { n: this.rows.length }))
				.setWarning()
				.onClick(() => {
					this.onApply();
					this.close();
				})
		);
		buttons.addButton((b) =>
			b.setButtonText(t("modal.sep.cancel")).onClick(() => this.close())
		);
	}

	onClose() {
		this.contentEl.empty();
		this.onClosed();
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
					.setValue(primaryNamespace(this.plugin.settings.schema))
					.onChange(async (value) => {
						const v = value.trim().replace(/^#/, "").replace(/\/$/, "");
						if (v === "") {
							new Notice(t("notice.nsEmpty"));
							return;
						}
						this.plugin.setPrimaryNamespace(v);
						await this.plugin.saveSettings();
					})
			);

		// Separator: changing it triggers a confirm dialog + vault-wide batch
		// rename (one-directional, like the tag engine). We commit on blur/Enter,
		// not per keystroke, so the dialog appears once the edit is finished.
		new Setting(containerEl)
			.setName(t("setting.sepName"))
			.setDesc(t("setting.sepDesc"))
			.addText((text) => {
				const current = () => primarySeparator(this.plugin.settings.schema);
				let pending = current();
				text.setPlaceholder("-").setValue(pending).onChange((v) => (pending = v));
				const reset = () => text.setValue(current());
				const commit = () => {
					const v = pending;
					if (v === current()) return; // unchanged
					if (v === "") {
						new Notice(t("notice.sepEmpty"));
						reset();
						return;
					}
					if (/[A-Za-z0-9/]/.test(v)) {
						new Notice(t("notice.sepBadChar"));
						reset();
						return;
					}
					// Confirm + batch apply; re-render the tab when the dialog closes
					// so the input reflects the final (applied or cancelled) value.
					this.plugin.requestSeparatorChange(v, () => this.display());
				};
				text.inputEl.addEventListener("blur", commit);
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						text.inputEl.blur();
					}
				});
			});

		new Setting(containerEl)
			.setName(t("setting.posName"))
			.setDesc(t("setting.posDesc"))
			.addDropdown((dd) =>
				dd
					.addOption("prefix", t("setting.posPrefix"))
					.addOption("suffix", t("setting.posSuffix"))
					.setValue(tagPosition(this.plugin.settings.schema))
					.onChange(async (value) => {
						this.plugin.setKeyPosition(value === "suffix" ? "suffix" : "prefix");
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
