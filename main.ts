import {
	Plugin,
	TFile,
	getAllTags,
	Notice,
	Setting,
	PluginSettingTab,
	App,
	debounce,
	normalizePath,
	type WorkspaceLeaf,
} from "obsidian";
import {
	TrellisSchema,
	KeySlot,
	SchemeId,
	SCHEME_IDS,
	defaultSchema,
	schemaFromLegacy,
	primaryNamespace,
	primaryNsPath,
	nsPath,
	primarySeparator,
	tagPosition,
	duplicateLocationGroups,
	NoteTreeNode,
	TagTreeNode,
	pickTagkey,
	syncedBasename,
	renameTagPath,
	rootMigratedTag,
	suggestSegment,
	scaffoldingPaths,
	normalizeTagList,
	buildNoteTree,
	buildTagTree,
	sortNoteTree,
	parentTagPath,
	extractTagkey,
	tagkeyToTagPath,
	assembleBasenameMulti,
	separatorMigratedName,
	isMultiKey,
	syncedBasenameMulti,
	isValidNamespace,
	isValidSeparator,
	isValidTagSegment,
	isValidTagPath,
	tagNamespaces,
} from "./tagkey";
import {
	TrellisTreeView,
	TRELLIS_TREE_VIEW,
	HeaderButtonVisibility,
	HEADER_BUTTON_IDS,
} from "./tree-view";
import { t, setLang, LangSetting } from "./i18n";
import {
	DuplicateNote,
	DedupDecision,
	DuplicateTagsModal,
	CascadeRenameModal,
	NewChildNoteModal,
	BootstrapSelectModal,
	BootstrapPreviewModal,
	BootstrapErrorsModal,
	SeparatorChangeModal,
	BulkProgressModal,
	AlertModal,
	ConfirmModal,
} from "./modals";

type SortKey = "tagkey" | "mtime" | "ctime";

type PlainObject = Record<string, unknown>;

interface TrellisFrontmatter extends PlainObject {
	tags?: unknown;
}

function isPlainObject(value: unknown): value is PlainObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * TRELLIS — tag-driven tagkey sync.
 *
 * When a note's location tag (e.g. #trel/…) changes, rewrite the filename
 * tagkey slot to match, via the link-safe rename API. One direction only: the
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

/** The last root-namespace change (for undo — the migration is symmetric). */
interface RootChangeRecord {
	oldRoot: string;
	newRoot: string;
}

/** How the sidebar renders (0.3.0, experimental): "notes" = real notes only,
 *  segment layers transparent (classic); "tags" = the full nested tag
 *  hierarchy, folder-style, like the core tag pane. */
type TreeViewMode = "notes" | "tags";

/** What a note row shows in nested mode: its filename or its tag segment. */
type TreeLabelMode = "filename" | "tag";

interface TrellisSettings {
	/** Filename key schema (B09 path B). Single-key = a 2-slot [tag, name]. */
	schema: TrellisSchema;
	/** Advanced mode (0.2.0, experimental): expose the multi-key slot editor. */
	advancedMode: boolean;
	/** Suppress the confirm dialog when applying an advanced-mode schema edit. */
	suppressSchemaConfirm: boolean;
	treeViewEnabled: boolean;
	/** Custom tab title for the tree view; "" = the localized default. */
	treeViewName: string;
	/** Which action buttons show in the tree-view header (all on by default). */
	headerButtons: HeaderButtonVisibility;
	sortKey: SortKey;
	sortAsc: boolean;
	/** Sidebar mode (0.3.0): classic notes tree or nested tag tree. */
	treeViewMode: TreeViewMode;
	/** Nested mode: show the root/namespace scaffolding layers as rows. */
	treeShowRoot: boolean;
	/** Nested mode: list notes with no managed tag in a bottom section. */
	treeShowUntagged: boolean;
	/** Nested mode: note rows show the filename or only the tag segment. */
	treeLabelMode: TreeLabelMode;
	/** UI language: "auto" follows Obsidian, "en"/"ko" force it. */
	language: LangSetting;
	/** Files+tags written by the last bootstrap apply (for undo). */
	lastBootstrap?: BootstrapRecord[];
	/** The last separator change (for undo). */
	lastSeparatorChange?: SeparatorChangeRecord;
	/** Location tags removed by the last duplicate-tag cleanup (for undo). */
	lastDedup?: DedupRecord[];
	/** The last root-namespace change (for undo). */
	lastRootChange?: RootChangeRecord;
}

const DEFAULT_SETTINGS: TrellisSettings = {
	schema: defaultSchema(),
	advancedMode: false,
	suppressSchemaConfirm: false,
	treeViewEnabled: true,
	treeViewName: "",
	headerButtons: {
		newNote: true,
		viewMode: true,
		sort: true,
		collapseAll: true,
		showCurrent: true,
		bootstrap: true,
		cascade: true,
		undo: true,
	},
	sortKey: "tagkey",
	sortAsc: true,
	treeViewMode: "notes",
	treeShowRoot: true,
	treeShowUntagged: true,
	treeLabelMode: "filename",
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
	/** Files already warned about a rename collision. Its own set — the
	 *  duplicate-tag branch clears multiWarned every sync, which would re-fire
	 *  a collision Notice on every edit of a still-colliding file. Cleared once
	 *  the file syncs cleanly (collision resolved). */
	private collisionWarned = new Set<string>();
	/** Suppress normal filename sync while separator migration owns renames. */
	private separatorMigrationRunning = false;
	/** A bulk pass (bootstrap / separator change / cascade) is running: suppress
	 *  per-file success/failure notices so the top-right doesn't flood — the
	 *  progress modal shows aggregate status instead. */
	private bulkActive = false;

	/** Cached note tree; null = stale, rebuilt on next sortedNoteTree(). */
	private treeCache: NoteTreeNode[] | null = null;

	/** Debounced tree refresh: data changes fire often (typing, cascade), so we
	 *  invalidate the cache and re-render at most once per 200ms. */
	private readonly scheduleTreeRefresh = debounce(
		() => {
			this.treeCache = null;
			this.tagTreeCache = null;
			this.untaggedCache = null;
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
		// Registering a view type that is already registered throws. A prior
		// instance that didn't fully unload — e.g. the plugin's files were
		// replaced without restarting Obsidian — can leave this type registered,
		// and an unguarded re-register would abort the entire plugin load. Guard
		// it so a stale registration is a no-op instead of a hard failure; a full
		// restart clears the stale one.
		try {
			this.registerView(
				TRELLIS_TREE_VIEW,
				(leaf) =>
					new TrellisTreeView(leaf, {
						getRoots: () => this.sortedNoteTree(),
						getSortAsc: () => this.settings.sortAsc,
						getDisplayName: () => this.treeDisplayName(),
						getButtons: () => this.settings.headerButtons,
						getViewMode: () => this.settings.treeViewMode,
						onToggleViewMode: () => void this.toggleTreeViewMode(),
						getTagRoot: () => this.fullTagTree(),
						getShowRoot: () => this.settings.treeShowRoot,
						getScaffolding: () => scaffoldingPaths(this.settings.schema),
						getLabelMode: () => this.settings.treeLabelMode,
						getShowUntagged: () => this.settings.treeShowUntagged,
						getUntagged: () => this.untaggedNotes(),
						onToggleSort: () => void this.toggleSortDir(),
						onNewChild: (parentTagPath) => this.openNewNoteModal(parentTagPath),
						onNewNote: () => this.newNoteFromActive(),
						onBootstrap: () =>
							new BootstrapSelectModal(
								this.app,
								(paths) => this.bootstrapDryRun(paths),
								(f) => this.locationTagOf(f) !== null
							).open(),
						onCascade: () =>
							new CascadeRenameModal(this.app, (from, to) =>
								void this.cascadeRename(from, to)
							).open(),
						onUndoBootstrap: () => void this.undoBootstrap(),
						onUndoSeparator: () => void this.undoSeparatorChange(),
						onUndoRoot: () => void this.undoRootChange(),
					})
			);
		} catch (e) {
			console.warn("TRELLIS: tree view type already registered (stale instance?)", e);
		}
		this.ribbonEl = this.addRibbonIcon("list-tree", this.treeDisplayName(), () =>
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
		// the source of truth. If the user edited the tagkey slot so it disagrees
		// with the tag, restore it; a title-only edit keeps the tagkey and passes
		// through untouched. The rename guard stops our own renames from looping.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.multiWarned.delete(oldPath); // stale warning key at the old path
				this.collisionWarned.delete(oldPath);
				if (file instanceof TFile && file.extension === "md") {
					void this.syncFile(file);
				}
				this.scheduleTreeRefresh();
			})
		);

		// Keep the tree in sync when files appear/disappear.
		this.registerEvent(this.app.vault.on("create", () => this.scheduleTreeRefresh()));
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.multiWarned.delete(file.path); // drop warning key for a gone file
				this.collisionWarned.delete(file.path);
				this.scheduleTreeRefresh();
			})
		);

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

		// Bootstrap an existing vault: read filename tagkey prefixes and propose
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
		this.registerRootCommands();

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
		const rawData: unknown = await this.loadData();
		const data = isPlainObject(rawData) ? rawData : {};
		const loaded = data as Partial<TrellisSettings> & Partial<LegacyConfig>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		// Give settings its OWN schema so edits never mutate the shared default.
		// Three cases: (a) saved schema → use it (loadData yields fresh objects);
		// (b) legacy scalar config → migrate; (c) fresh install → own default.
		if (!loaded.schema) {
			const legacy = loaded as LegacyConfig;
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
		// Own copy of headerButtons so a toggle never mutates the shared default;
		// missing keys (older saved data) fall back to visible.
		this.settings.headerButtons = {
			...DEFAULT_SETTINGS.headerButtons,
			...(isPlainObject(data.headerButtons)
				? (data.headerButtons as Partial<HeaderButtonVisibility>)
				: {}),
		};
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

	/** Sync one file's location tag into its filename tagkey (one direction). */
	private async syncFile(file: TFile) {
		if (this.separatorMigrationRunning) return;
		if (this.renaming.has(file.path)) return; // guard: our own rename echo

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return;
		const tags = getAllTags(cache) ?? [];

		// One note = one location per namespace. Warn once (lightly) if a note
		// carries duplicate location tags; the user resolves them in bulk via the
		// "check duplicate location tags" command. Detection uses frontmatter tags
		// only — that's what the cleanup can actually remove (inline body tags
		// aren't touched). We still sync from the first match (pickTagkey) so
		// behavior stays deterministic.
		const fmTags = normalizeTagList(cache.frontmatter?.tags).map((tg) => "#" + tg);
		const dupGroups = duplicateLocationGroups(fmTags, this.settings.schema);
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

		// Multi-key schema (advanced, experimental): every tag slot resolves from
		// its own namespace; the 2-slot single-key path stays the default.
		let newBasename: string | null;
		if (isMultiKey(this.settings.schema)) {
			newBasename = syncedBasenameMulti(file.basename, tags, this.settings.schema);
		} else {
			const tagkey = pickTagkey(tags, this.settings.schema);
			if (tagkey === null) return; // no location tag → never touch the file
			newBasename = syncedBasename(file.basename, tagkey, this.settings.schema);
		}
		if (newBasename === null) {
			// Already in sync — a previously reported collision (if any) is over.
			this.collisionWarned.delete(file.path);
			return;
		}

		const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
		const newPath = normalizePath(`${dir}${newBasename}.${file.extension}`);

		// Collision guard: never rename onto an existing DIFFERENT file — that
		// would clobber the target (or throw). Warn once and leave both files
		// alone; the user resolves the name clash by hand. Its own warned-set:
		// keyed per file until the clash resolves, and suppressed during bulk
		// passes like every other per-file notice.
		const existing = this.app.vault.getAbstractFileByPath(newPath);
		if (existing && existing !== file) {
			if (!this.collisionWarned.has(file.path)) {
				this.collisionWarned.add(file.path);
				if (!this.bulkActive) {
					new Notice(t("notice.renameCollision", { name: file.basename, target: newBasename }));
				}
				console.warn("TRELLIS: rename collision, skipping", file.path, "→", newPath);
			}
			return;
		}
		this.collisionWarned.delete(file.path);

		// Capture the OLD path first — renameFile mutates file.path to newPath
		// in place, so `file.path` in finally would otherwise be the new path.
		const oldPath = file.path;
		this.renaming.add(oldPath);
		this.renaming.add(newPath);
		try {
			// renameFile = same path as a manual rename → wikilinks auto-update.
			await this.app.fileManager.renameFile(file, newPath);
			if (!this.bulkActive) {
				new Notice(t("notice.renamed", { from: file.basename, to: newBasename }));
			}
		} catch (e) {
			console.error("TRELLIS rename failed", e);
			new Notice(t("notice.renameFailed", { name: file.basename }));
		} finally {
			this.renaming.delete(oldPath);
			// Release the new path after the follow-up events settle.
			window.setTimeout(() => this.renaming.delete(newPath), 200);
		}
	}

	/** Collect every note's location tag into the sidebar note-tree, sorted.
	 *  Cached; data/sort changes invalidate via scheduleTreeRefresh/rebuildTrees. */
	private sortedNoteTree(): NoteTreeNode[] {
		if (this.treeCache) return this.treeCache;
		const entries: { tagPath: string; notePath: string }[] = [];
		const full = primaryNsPath(this.settings.schema); // root-aware
		const prefix = `#${full}/`;
		const exact = `#${full}`;
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

	// --- Nested tag view data (0.3.0 experimental, B24) ---------------------

	/** Cached full tag tree (nested mode) + untagged note list. Invalidated
	 *  together with treeCache. */
	private tagTreeCache: TagTreeNode | null = null;
	private untaggedCache: string[] | null = null;

	/** Every managed tag on every note (ALL slot namespaces, root-aware), as
	 *  entries for the full nested tag tree. A note tagged in two namespaces
	 *  appears under both branches. Also collects the untagged list. */
	private fullTagTree(): TagTreeNode {
		if (this.tagTreeCache) return this.tagTreeCache;
		const entries: { tagPath: string; notePath: string }[] = [];
		const untagged: string[] = [];
		const fulls = tagNamespaces(this.settings.schema).map((ns) =>
			nsPath(this.settings.schema, ns)
		);
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const tags = cache ? getAllTags(cache) ?? [] : [];
			const managed = [
				...new Set(
					tags.filter((t) =>
						fulls.some((f) => t === `#${f}` || t.startsWith(`#${f}/`))
					)
				),
			];
			if (managed.length === 0) {
				untagged.push(file.path);
				continue;
			}
			for (const tag of managed) {
				entries.push({ tagPath: tag.replace(/^#/, ""), notePath: file.path });
			}
		}
		this.tagTreeCache = buildTagTree(entries);
		this.untaggedCache = untagged.sort();
		return this.tagTreeCache;
	}

	private untaggedNotes(): string[] {
		if (!this.untaggedCache) this.fullTagTree(); // fills both caches
		return this.untaggedCache ?? [];
	}

	/** Flip the sidebar between the classic notes tree and the nested tag tree. */
	async toggleTreeViewMode() {
		this.settings.treeViewMode =
			this.settings.treeViewMode === "tags" ? "notes" : "tags";
		await this.saveSettings();
		this.rebuildTrees();
	}

	/** Invalidate the cache and re-render immediately (sort/namespace change). */
	rebuildTrees() {
		this.treeCache = null;
		this.tagTreeCache = null;
		this.untaggedCache = null;
		this.refreshTreeViews();
	}

	/** Comparator from the current sort key + direction. tagkey = name order;
	 *  mtime/ctime read file stats. */
	private noteComparator(): (a: NoteTreeNode, b: NoteTreeNode) => number {
		const { sortKey, sortAsc } = this.settings;
		const dir = sortAsc ? 1 : -1;
		return (a, b) => {
			let r: number;
			if (sortKey === "tagkey") {
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
			(parent, segment, title) => void this.createChildNote(parent, segment, title),
			(parent) => this.segmentSuggestionFor(parent) // scheme prefill (0.3.0)
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

	/** The index of the tag slot whose (root-aware) namespace path contains this
	 *  tag path, or -1 when no slot owns it. Lets note creation and segment
	 *  suggestion work on EVERY namespace branch the nested view renders, not
	 *  just the primary one. */
	private slotForTagPath(tagPath: string): number {
		const s = this.settings.schema;
		return s.slots.findIndex((sl) => {
			if (sl.role !== "tag" || !sl.namespace) return false;
			const full = nsPath(s, sl.namespace);
			return tagPath === full || tagPath.startsWith(full + "/");
		});
	}

	/** Direct-child segments already in use under a parent tag path. The
	 *  namespace is derived from the parent itself (any slot), root-aware. */
	private childSegmentsOf(parentTagPath: string): string[] {
		const segs: string[] = [];
		const idx = this.slotForTagPath(parentTagPath);
		const slot = idx >= 0 ? this.settings.schema.slots[idx] : null;
		const full = slot?.namespace
			? nsPath(this.settings.schema, slot.namespace)
			: primaryNsPath(this.settings.schema);
		const prefix = `#${full}/`;
		const exact = `#${full}`;
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

	/** Create a new note as a child of parentTagPath with the given segment.
	 *  Works on any slot's namespace branch (the nested view offers "new here"
	 *  everywhere): the owning slot is resolved from the parent path, and the
	 *  filename is assembled with only that slot + the title filled in. */
	private async createChildNote(
		parentTagPath: string,
		segment: string,
		title: string
	) {
		const schema = this.settings.schema;
		// Validate BEFORE anything is assembled: the tag path is written into the
		// new note's inline `tags: [...]` frontmatter and the segment lands in the
		// filename, so YAML metacharacters or filename-illegal characters in a
		// hand-typed parent/segment would corrupt the note being created.
		if (!isValidTagSegment(segment)) {
			new Notice(t("notice.segmentBadChar"));
			return;
		}
		if (!isValidTagPath(parentTagPath)) {
			new Notice(t("notice.parentBadChar"));
			return;
		}
		const tagPath = `${parentTagPath}/${segment}`;
		const idx = this.slotForTagPath(tagPath);
		const slot = idx >= 0 ? schema.slots[idx] : null;
		if (!slot?.namespace) {
			new Notice(t("notice.noTagkey"));
			return;
		}
		const full = nsPath(schema, slot.namespace);
		const rest = tagPath === full ? "" : tagPath.slice(full.length + 1);
		const tagkey = rest.split("/").join("");
		if (!tagkey) {
			new Notice(t("notice.noTagkey"));
			return;
		}
		const safeTitle = title.trim().replace(/[\\/:*?"<>|]/g, "");
		const values = schema.slots.map((s, i) =>
			i === idx ? tagkey : s.role === "name" ? safeTitle : null
		);
		const base = assembleBasenameMulti(values, schema);

		const path = normalizePath(`${base}.md`);
		if (this.app.vault.getAbstractFileByPath(path)) {
			new Notice(t("notice.exists", { base }));
			return;
		}
		const body = `# ${safeTitle || tagkey}\n`;
		try {
			const file = await this.app.vault.create(path, body);
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				fm.tags = [tagPath];
			});
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
		this.revealTreeLeaf(leaf);
	}

	private revealTreeLeaf(leaf: WorkspaceLeaf) {
		// `workspace.revealLeaf()` would be ideal, but it requires Obsidian 1.7.2.
		// Keep 0.1.x compatible with minAppVersion 1.4.10 by using the older
		// public API. This focuses/activates the sidebar leaf after opening it.
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
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

	/** The tree view's tab title: the user's custom name, or the localized
	 *  default when the setting is blank. */
	private treeDisplayName(): string {
		return this.settings.treeViewName.trim() || t("view.treeName");
	}

	/** Re-apply the tree title to the ribbon tooltip and every open tree tab
	 *  after the name (or UI language) changes. updateHeader re-reads the view's
	 *  getDisplayText; it degrades to a no-op if the API is unavailable. */
	applyTreeViewName() {
		const name = this.treeDisplayName();
		this.ribbonEl?.setAttribute("aria-label", name);
		for (const leaf of this.app.workspace.getLeavesOfType(TRELLIS_TREE_VIEW)) {
			(leaf as { updateHeader?: () => void }).updateHeader?.();
		}
	}

	/** The note's location tag (namespace match, root-aware), without the '#'.
	 *  Matches the exact namespace-level tag too — a note tagged exactly
	 *  #trellis/tree IS managed (it shows in the tree), so bootstrap must not
	 *  offer to re-tag it and new-note-from-active must keep its context. */
	private locationTagOf(file: TFile): string | null {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return null;
		const full = primaryNsPath(this.settings.schema);
		const prefix = `#${full}/`;
		const exact = `#${full}`;
		const tag = (getAllTags(cache) ?? []).find(
			(t) => t === exact || t.startsWith(prefix)
		);
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
		// Suppress per-file rename notices: the tag edits below drive many syncFile
		// renames, which would otherwise flood the top-right one Notice per file.
		this.bulkActive = true;
		try {
			for (const file of files) {
				let touched = false;
				try {
					await this.app.fileManager.processFrontMatter(file, (fm: TrellisFrontmatter) => {
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
		} finally {
			this.bulkActive = false;
		}
		new Notice(
			retagged > 0
				? t("notice.retagged", { n: retagged, from, to })
				: t("notice.noFilesTagged", { from })
		);
		if (failed.length) new BootstrapErrorsModal(this.app, failed).open();
	}

	/** Bootstrap dry-run: scan the chosen markdown files (or the whole vault when
	 *  scopePaths is omitted), propose a location tag from each filename's tagkey
	 *  prefix, and show a preview. Writes nothing — the user reviews before any
	 *  real onboarding (apply step comes later). */
	private bootstrapDryRun(scopePaths?: Set<string>) {
		const assign: { name: string; path: string; tag: string }[] = [];
		const alreadyTagged: string[] = [];
		const noTagkey: string[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (scopePaths && !scopePaths.has(file.path)) continue;
			if (this.locationTagOf(file)) {
				alreadyTagged.push(file.basename);
				continue;
			}
			const tagkey = extractTagkey(file.basename, this.settings.schema);
			const tagPath = tagkey ? tagkeyToTagPath(tagkey, this.settings.schema) : null;
			if (tagPath) assign.push({ name: file.basename, path: file.path, tag: tagPath });
			else noTagkey.push(file.basename);
		}
		new BootstrapPreviewModal(this.app, assign, alreadyTagged, noTagkey, (rows) =>
			void this.applyBootstrap(rows)
		).open();
	}

	/** Apply: write the proposed location tag into each file's frontmatter
	 *  (existing content preserved), recording what was written so it can be
	 *  undone. Filenames usually don't change — the tagkey is already there.
	 *
	 *  Robust against a single bad file: a frontmatter parse error (e.g. a file
	 *  with duplicate YAML keys) is caught per-file and collected, so it can
	 *  never abort the whole pass. A progress modal (pause / cancel + live count)
	 *  tracks the run, and the undo record is saved in `finally` so even an
	 *  interrupted pass stays undoable; the modal's Done state lists the files it
	 *  had to skip. */
	private async applyBootstrap(assign: { path: string; tag: string }[]) {
		const record: BootstrapRecord[] = [];
		const failed: string[] = [];
		const total = assign.length;
		const progress = new BulkProgressModal(this.app, t("bulk.title.bootstrap"));
		progress.open();
		this.bulkActive = true;
		try {
			for (let i = 0; i < assign.length; i++) {
				if (!(await progress.gate())) break; // cancelled — keep what's written
				const r = assign[i];
				const file = this.app.vault.getAbstractFileByPath(r.path);
				if (file instanceof TFile) {
					try {
						await this.app.fileManager.processFrontMatter(file, (fm: TrellisFrontmatter) => {
							const before =
								typeof fm.tags === "string"
									? fm.tags.split(/[,\s]+/).filter(Boolean)
									: Array.isArray(fm.tags)
										? fm.tags.filter((t): t is string => typeof t === "string")
										: [];
							const tags = normalizeTagList(fm.tags);
							const added = !tags.includes(r.tag);
							if (added) tags.push(r.tag);
							const changed =
								tags.length !== before.length ||
								tags.some((tag, index) => tag !== before[index]);
							if (changed) fm.tags = tags;
							if (added) record.push({ path: r.path, tag: r.tag });
						});
					} catch (e) {
						failed.push(r.path);
						console.error("TRELLIS bootstrap skipped (frontmatter error)", r.path, e);
					}
				}
				progress.report(i + 1, total, failed.length);
			}
		} finally {
			this.bulkActive = false;
			// Save what we managed to write even if the loop threw — keeps undo intact.
			this.settings.lastBootstrap = record;
			await this.saveSettings();
			progress.finish({ processed: record.length, skipped: failed });
		}
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
		// Carry the root too — the clone must stay a faithful schema (dropping it
		// would make any namespace-matching on the clone silently rootless).
		return { rootNamespace: this.settings.schema.rootNamespace, slots, separators };
	}

	/** Dry-run: which tagged files a switch to `newSep` would rename. The tag is
	 *  the source of truth (tagkey from the tag, separator-agnostic), so untagged
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
			const tagkey = pickTagkey(getAllTags(cache) ?? [], oldSchema);
			if (tagkey === null) continue;
			const newName = separatorMigratedName(file.basename, tagkey, oldSchema, newSchema);
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
		if (rows.length === 0) {
			void this.applySeparatorChange(newSep, rows).finally(onDone);
			return;
		}
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
		const renames: SeparatorRename[] = [];
		const failedNames: string[] = [];
		const total = rows.length;
		// No files to rename → just flip the setting, no modal needed.
		const progress = total > 0 ? new BulkProgressModal(this.app, t("bulk.title.separator")) : null;
		progress?.open();
		this.separatorMigrationRunning = true;
		this.bulkActive = true;
		try {
			for (let i = 0; i < rows.length; i++) {
				if (progress && !(await progress.gate())) break; // cancelled — keep renames so far
				const r = rows[i];
				const file = this.app.vault.getAbstractFileByPath(r.path);
				if (file instanceof TFile) {
					const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
					const newPath = normalizePath(`${dir}${r.newName}.${file.extension}`);
					if (await this.renameGuarded(file, newPath)) {
						renames.push({ path: newPath, oldBasename: r.oldName });
					} else {
						failedNames.push(r.oldName);
					}
				}
				progress?.report(i + 1, total, failedNames.length);
			}
		} finally {
			this.bulkActive = false;
			if (progress?.wasCancelled) {
				// Cancel = clean rollback: undo the renames done so far and DON'T
				// commit the new separator, so the vault + setting stay consistent
				// (no old/new filenames coexisting under a half-applied setting).
				const { undone, failed: revertFailed } = await this.revertSeparatorRenames(renames);
				this.separatorMigrationRunning = false;
				this.settings.lastSeparatorChange =
					revertFailed > 0 ? { oldSep, newSep, renames } : undefined;
				await this.saveSettings();
				this.rebuildTrees();
				progress.finish({ processed: undone, skipped: failedNames });
			} else {
				this.separatorMigrationRunning = false;
				this.setPrimarySeparator(newSep);
				this.settings.lastSeparatorChange =
					renames.length > 0 ? { oldSep, newSep, renames } : undefined;
				await this.saveSettings();
				this.rebuildTrees();
				if (progress) progress.finish({ processed: renames.length, skipped: failedNames });
				else new Notice(t("notice.sepChanged", { n: renames.length, from: oldSep, to: newSep }));
			}
		}
	}

	/** Rename each recorded file back to its pre-change basename (link-safe).
	 *  Skips a file whose target already exists. Returns how many were restored
	 *  and how many failed, so callers can decide whether to keep the record. */
	private async revertSeparatorRenames(
		renames: SeparatorRename[]
	): Promise<{ undone: number; failed: number }> {
		let undone = 0;
		let failed = 0;
		for (const r of renames) {
			const file = this.app.vault.getAbstractFileByPath(r.path);
			if (!(file instanceof TFile)) {
				failed++;
				continue;
			}
			const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
			const newPath = normalizePath(`${dir}${r.oldBasename}.${file.extension}`);
			if (await this.renameGuarded(file, newPath)) undone++;
			else failed++;
		}
		return { undone, failed };
	}

	/** Undo the last separator change: restore the setting AND each filename.
	 *  Keeps the undo record if any file failed to restore, so it can be retried,
	 *  and only clears it once every recorded rename is reverted. */
	private async undoSeparatorChange() {
		const rec = this.settings.lastSeparatorChange;
		if (!rec || rec.renames.length === 0) {
			new Notice(t("notice.noSepChange"));
			return;
		}
		this.setPrimarySeparator(rec.oldSep);
		this.separatorMigrationRunning = true;
		const { undone, failed } = await this.revertSeparatorRenames(rec.renames);
		this.separatorMigrationRunning = false;
		this.settings.lastSeparatorChange = failed > 0 ? rec : undefined;
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
			// Frontmatter tags only — those are what applyDedup can remove. An
			// inline body tag would show up but couldn't be cleaned.
			const fmTags = normalizeTagList(cache.frontmatter?.tags).map((tg) => "#" + tg);
			const groups = duplicateLocationGroups(fmTags, this.settings.schema);
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
		// Save the record in `finally` so an interrupted pass (e.g. a broken YAML
		// file mid-loop) still leaves everything removed so far undoable, and
		// isolate per-file errors so one bad file can't abort the whole cleanup.
		try {
			for (const d of decisions) {
				const file = this.app.vault.getAbstractFileByPath(d.path);
				if (!(file instanceof TFile)) continue;
				const removed: string[] = [];
				try {
					await this.app.fileManager.processFrontMatter(file, (fm: TrellisFrontmatter) => {
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
				} catch (e) {
					console.error("TRELLIS dedup skipped (frontmatter error)", d.path, e);
					continue;
				}
				if (removed.length) {
					record.push({ path: d.path, removed });
					this.multiWarned.delete(d.path);
				}
			}
		} finally {
			this.settings.lastDedup = record;
			await this.saveSettings();
		}
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
		const failed: DedupRecord[] = [];
		for (const r of record) {
			const file = this.app.vault.getAbstractFileByPath(r.path);
			if (!(file instanceof TFile)) continue;
			// Per-file isolation: a malformed YAML file must not abort the whole
			// undo — collect it and keep the record so it can be retried.
			try {
				await this.app.fileManager.processFrontMatter(file, (fm: TrellisFrontmatter) => {
					const tags = normalizeTagList(fm.tags);
					for (const tg of r.removed) if (!tags.includes(tg)) tags.push(tg);
					fm.tags = tags;
				});
				restored++;
			} catch (e) {
				console.error("TRELLIS dedup undo skipped (frontmatter error)", r.path, e);
				failed.push(r);
			}
		}
		this.settings.lastDedup = failed.length > 0 ? failed : undefined;
		await this.saveSettings();
		new Notice(t("notice.dedupUndone", { n: restored }));
	}

	/** Rename a file with the infinite-loop guard set, so our own rename's
	 *  follow-up events don't re-trigger syncFile. Shared by sync + migration. */
	private async renameGuarded(file: TFile, newPath: string): Promise<boolean> {
		// Collision guard: refuse to rename onto a different existing file so a
		// separator migration / undo can never clobber an unrelated note.
		const existing = this.app.vault.getAbstractFileByPath(newPath);
		if (existing && existing !== file) {
			console.warn("TRELLIS: rename collision, skipping", file.path, "→", newPath);
			if (!this.bulkActive) {
				new Notice(t("notice.renameCollision", { name: file.basename, target: newPath }));
			}
			return false;
		}
		// Capture the OLD path — renameFile mutates file.path to newPath in place.
		const oldPath = file.path;
		this.renaming.add(oldPath);
		this.renaming.add(newPath);
		try {
			await this.app.fileManager.renameFile(file, newPath);
			return true;
		} catch (e) {
			console.error("TRELLIS rename failed", e);
			if (!this.bulkActive) new Notice(t("notice.renameFailed", { name: file.basename }));
			return false;
		} finally {
			this.renaming.delete(oldPath);
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
		const failed: BootstrapRecord[] = [];
		for (const r of record) {
			const file = this.app.vault.getAbstractFileByPath(r.path);
			if (!(file instanceof TFile)) continue;
			// Per-file isolation: a malformed YAML file must not abort the whole
			// undo — collect it and keep the record so it can be retried.
			try {
				await this.app.fileManager.processFrontMatter(file, (fm: TrellisFrontmatter) => {
					const tags = normalizeTagList(fm.tags);
					const next = tags.filter((t) => t !== r.tag);
					if (next.length) fm.tags = next;
					else delete fm.tags;
				});
				undone++;
			} catch (e) {
				console.error("TRELLIS bootstrap undo skipped (frontmatter error)", r.path, e);
				failed.push(r);
			}
		}
		this.settings.lastBootstrap = failed.length > 0 ? failed : [];
		await this.saveSettings();
		new Notice(t("notice.undid", { n: undone }));
	}

	// --- Root namespace change (0.3.0 experimental, B25) --------------------
	// The root is the layer-1 owner every managed tag starts with. Changing it
	// (including from/to "no root") is a vault-wide TAG migration: filenames
	// never change (the tagkey is namespace-independent), so this reuses the
	// bulk machinery (progress modal, per-file error isolation, undo) but only
	// rewrites frontmatter tags.

	/** How many notes a root change would rewrite (dry count for the confirm). */
	private countRootChange(oldRoot: string, newRoot: string): number {
		const slotNs = tagNamespaces(this.settings.schema);
		let n = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const tags = normalizeTagList(cache.frontmatter?.tags);
			if (tags.some((tg) => rootMigratedTag(tg, oldRoot, newRoot, slotNs) !== null))
				n++;
		}
		return n;
	}

	/** Confirm + run a root-namespace change (called from settings Apply). */
	requestRootChange(newRoot: string, onDone: () => void) {
		const oldRoot = (this.settings.schema.rootNamespace ?? "").trim();
		if (newRoot === oldRoot) {
			onDone();
			return;
		}
		const n = this.countRootChange(oldRoot, newRoot);
		new ConfirmModal(
			this.app,
			t("modal.root.title"),
			t("modal.root.desc", { from: oldRoot || "—", to: newRoot || "—", n }),
			() => void this.applyRootChange(newRoot).finally(onDone),
			false // vault-wide migration must always confirm — no "don't ask again"
		).open();
	}

	/** Rewrite one file's managed tags between root shapes. Returns true when
	 *  the file was actually changed. Shared by the forward pass and rollback. */
	private async migrateFileRoot(
		file: TFile,
		fromRoot: string,
		toRoot: string,
		slotNs: string[]
	): Promise<boolean> {
		let touched = false;
		await this.app.fileManager.processFrontMatter(file, (fm: TrellisFrontmatter) => {
			const tags = normalizeTagList(fm.tags);
			if (tags.length === 0) return;
			const next = tags.map((tg) => rootMigratedTag(tg, fromRoot, toRoot, slotNs) ?? tg);
			if (next.some((tg, j) => tg !== tags[j])) {
				fm.tags = next;
				touched = true;
			}
		});
		return touched;
	}

	/** Flip the schema's root, then rewrite every managed frontmatter tag to the
	 *  new shape. The schema flips FIRST so already-migrated tags are managed
	 *  (and sync-checked) under the new shape while not-yet-migrated ones are
	 *  simply unmanaged-and-untouched — never mis-parsed. Cancel = clean
	 *  rollback (separator-change parity): the files already rewritten are
	 *  migrated back and the old root is restored, so no half-migrated state
	 *  persists — a lingering half state would let bootstrap re-tag the
	 *  untouched notes and create duplicate location tags. A completed pass is
	 *  undoable via the symmetric migration back. */
	private async applyRootChange(newRoot: string) {
		const oldRoot = (this.settings.schema.rootNamespace ?? "").trim();
		// Whatever undo record exists NOW is valid for the pre-apply state — a
		// cancelled pass rolls the vault back to exactly that state, so the record
		// must be restored (not cleared): dropping it on a cancelled UNDO would
		// lose the only way to retry the undo.
		const prevRec = this.settings.lastRootChange;
		const slotNs = tagNamespaces(this.settings.schema);
		this.settings.schema.rootNamespace = newRoot;
		await this.saveSettings();
		let changed = 0;
		const touchedPaths: string[] = [];
		const failed: string[] = [];
		const files = this.app.vault.getMarkdownFiles();
		const progress = new BulkProgressModal(this.app, t("bulk.title.root"));
		progress.open();
		this.bulkActive = true;
		try {
			for (let i = 0; i < files.length; i++) {
				if (!(await progress.gate())) break; // cancelled — rolled back below
				const file = files[i];
				try {
					if (await this.migrateFileRoot(file, oldRoot, newRoot, slotNs)) {
						changed++;
						touchedPaths.push(file.path);
					}
				} catch (e) {
					failed.push(file.basename);
					console.error("TRELLIS root change skipped (frontmatter error)", file.path, e);
				}
				progress.report(i + 1, files.length, failed.length);
			}
		} finally {
			if (progress.wasCancelled) {
				// Roll back what was rewritten (schema still = newRoot while the
				// reverted tags land, so nothing is mis-parsed mid-rollback), then
				// restore the old root. Nothing to undo afterwards.
				let reverted = 0;
				for (const path of touchedPaths) {
					const file = this.app.vault.getAbstractFileByPath(path);
					if (!(file instanceof TFile)) continue;
					try {
						if (await this.migrateFileRoot(file, newRoot, oldRoot, slotNs)) reverted++;
					} catch (e) {
						console.error("TRELLIS root rollback skipped (frontmatter error)", path, e);
					}
				}
				this.bulkActive = false;
				this.settings.schema.rootNamespace = oldRoot;
				this.settings.lastRootChange = prevRec;
				await this.saveSettings();
				this.rebuildTrees();
				progress.finish({ processed: reverted, skipped: failed });
			} else {
				this.bulkActive = false;
				this.settings.lastRootChange = { oldRoot, newRoot };
				await this.saveSettings();
				this.rebuildTrees();
				progress.finish({ processed: changed, skipped: failed });
				new Notice(
					t("notice.rootChanged", { from: oldRoot || "—", to: newRoot || "—", n: changed })
				);
			}
		}
	}

	/** Undo the last root change: run the symmetric migration back. The apply
	 *  pass reports its own count Notice; no separate tally here (a post-hoc
	 *  count would read the already-migrated state and always be 0). */
	private async undoRootChange() {
		const rec = this.settings.lastRootChange;
		if (!rec) {
			new Notice(t("notice.noRootChange"));
			return;
		}
		// Do NOT clear the record first: applyRootChange overwrites it in both
		// outcomes (completed → the symmetric redo record; cancelled → restores
		// what existed at entry, i.e. this record, so the undo can be retried).
		await this.applyRootChange(rec.oldRoot);
	}

	registerRootCommands() {
		this.addCommand({
			id: "root-change-undo",
			name: t("cmd.rootUndo"),
			callback: () => void this.undoRootChange(),
		});
	}

	// --- ID scheme (0.3.0 experimental, B26) ---------------------------------

	/** Read/write the primary tag slot's scheme (simple-mode dropdown). */
	getPrimaryScheme(): SchemeId | "" {
		return this.settings.schema.slots.find((s) => s.role === "tag")?.scheme ?? "";
	}

	setPrimaryScheme(scheme: SchemeId | "") {
		const slot = this.firstTagSlot();
		if (scheme === "") delete slot.scheme;
		else slot.scheme = scheme;
	}

	/** Suggested next segment under a parent, per the OWNING slot's scheme
	 *  (resolved from the parent path — nested mode offers creation on every
	 *  namespace branch). null = no scheme (the modal stays fully manual). */
	segmentSuggestionFor(parent: string): string | null {
		if (!parent) return null;
		const idx = this.slotForTagPath(parent);
		const scheme =
			idx >= 0
				? this.settings.schema.slots[idx].scheme
				: this.settings.schema.slots.find((s) => s.role === "tag")?.scheme;
		if (!scheme) return null;
		const parentSeg = parent.split("/").pop() ?? "";
		return suggestSegment(scheme, parentSeg, this.childSegmentsOf(parent), new Date());
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
		this.render();
	}

	/** Imperative render of the settings tab. Our own re-render triggers call
	 *  this directly instead of the framework's deprecated display() entry. */
	private render() {
		const { containerEl } = this;
		containerEl.empty();

		// ── General ──────────────────────────────────────────────────────────
		new Setting(containerEl).setName(t("setting.section.general")).setHeading();

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
						this.plugin.applyTreeViewName(); // re-localize the tab title
						this.render(); // re-render this tab in the new language
					})
			);

		// ── Filename scheme ──────────────────────────────────────────────────
		new Setting(containerEl).setName(t("setting.section.scheme")).setHeading();

		this.renderStats(containerEl);

		// Simple (single-key) schema knobs. Hidden in advanced mode — the slot
		// editor covers namespace/separator/position as slot properties.
		if (!this.plugin.settings.advancedMode) {
			// Namespace: staged in the field, committed on the Apply button — no
			// silent per-keystroke changes to the source-of-truth namespace.
			{
				let pending = primaryNamespace(this.plugin.settings.schema);
				new Setting(containerEl)
					.setName(t("setting.nsName"))
					.setDesc(t("setting.nsDesc"))
					.addText((text) =>
						text
							.setPlaceholder("trel")
							.setValue(pending)
							.onChange((v) => (pending = v))
					)
					.addButton((b) =>
						b.setButtonText(t("setting.apply")).onClick(async () => {
							const v = pending.trim().replace(/^#/, "").replace(/\/$/, "");
							if (v === "") {
								new Notice(t("notice.nsEmpty"));
								return;
							}
							if (!isValidNamespace(v)) {
								new Notice(t("notice.nsBadChar"));
								return;
							}
							if (v === primaryNamespace(this.plugin.settings.schema)) return;
							this.plugin.setPrimaryNamespace(v);
							await this.plugin.saveSettings();
							this.plugin.rebuildTrees();
							new Notice(t("notice.nsApplied", { ns: v }));
						})
					);
			}

			// Separator: staged in the field; Apply opens the confirm dialog +
			// vault-wide batch rename (one-directional, like the tag engine).
			{
				let pending = primarySeparator(this.plugin.settings.schema);
				new Setting(containerEl)
					.setName(t("setting.sepName"))
					.setDesc(t("setting.sepDesc"))
					.addText((text) =>
						text
							.setPlaceholder("-")
							.setValue(pending)
							.onChange((v) => (pending = v))
					)
					.addButton((b) =>
						b.setButtonText(t("setting.apply")).onClick(() => {
							const v = pending;
							if (v === primarySeparator(this.plugin.settings.schema)) return;
							// A separator goes into the filename: reject empty, letters,
							// digits, and filename/wikilink-illegal characters. Shown as a
							// dialog (not a corner Notice) so it isn't missed.
							if (!isValidSeparator(v)) {
								new AlertModal(
									this.app,
									t("modal.badSep.title"),
									t("modal.badSep.desc")
								).open();
								return;
							}
							// Re-render on close so the field reflects the final value.
							this.plugin.requestSeparatorChange(v, () => this.render());
						})
					);
			}

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

			// ID scheme preset for the primary tag slot (0.3.0, experimental). In
			// advanced mode the per-slot dropdown in the editor covers this.
			new Setting(containerEl)
				.setName(t("setting.schemeName"))
				.setDesc(t("setting.schemeDesc"))
				.addDropdown((dd) => {
					dd.addOption("", t("scheme.none"));
					for (const id of SCHEME_IDS) dd.addOption(id, t(`scheme.${id}`));
					dd.setValue(this.plugin.getPrimaryScheme()).onChange(async (v) => {
						this.plugin.setPrimaryScheme(
							(SCHEME_IDS as string[]).includes(v) ? (v as SchemeId) : ""
						);
						await this.plugin.saveSettings();
					});
				});
		}

		// Root namespace (0.3.0, experimental — B25). Applies to every slot, so
		// it lives outside the simple/advanced split. Staged + Apply: committing
		// runs a vault-wide tag migration behind a confirm (undoable).
		{
			let pending = (this.plugin.settings.schema.rootNamespace ?? "").trim();
			new Setting(containerEl)
				.setName(t("setting.rootName"))
				.setDesc(t("setting.rootDesc"))
				.addText((text) =>
					text
						.setPlaceholder("trellis")
						.setValue(pending)
						.onChange((v) => (pending = v))
				)
				.addButton((b) =>
					b.setButtonText(t("setting.apply")).onClick(() => {
						const v = pending.trim().replace(/^#/, "").replace(/\/$/, "");
						if (v !== "" && !isValidNamespace(v)) {
							new Notice(t("notice.rootBadChar"));
							return;
						}
						this.plugin.requestRootChange(v, () => this.render());
					})
				);
		}

		// Advanced mode (0.2.0, experimental): the multi-key slot editor.
		new Setting(containerEl)
			.setName(t("setting.advName"))
			.setDesc(t("setting.advDesc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.advancedMode)
					.onChange(async (value) => {
						this.plugin.settings.advancedMode = value;
						this.draftSchema = null; // drop any staged (unapplied) edits
						if (!value && isMultiKey(this.plugin.settings.schema)) {
							// Simple mode keeps the single-key invariant: collapse to
							// the primary tag slot + a name slot, primary separator.
							// Root + primary scheme survive the collapse — losing the
							// root here would silently orphan every managed tag.
							const old = this.plugin.settings.schema;
							const ns = primaryNamespace(old) || "trel";
							const sep = primarySeparator(old) || "-";
							const pos = tagPosition(old);
							const scheme = old.slots.find((s) => s.role === "tag")?.scheme;
							const next = schemaFromLegacy(ns, sep, pos);
							next.rootNamespace = old.rootNamespace;
							const tagSlot = next.slots.find((s) => s.role === "tag");
							if (tagSlot && scheme) tagSlot.scheme = scheme;
							this.plugin.settings.schema = next;
							new Notice(t("notice.advReset"));
						}
						await this.plugin.saveSettings();
						this.plugin.rebuildTrees();
						this.render();
					})
			);
		if (this.plugin.settings.advancedMode) this.renderSlotEditor(containerEl);

		// ── Sidebar tree view ────────────────────────────────────────────────
		new Setting(containerEl).setName(t("setting.section.tree")).setHeading();

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

		// Custom tab title for the tree view (blank = the localized default).
		new Setting(containerEl)
			.setName(t("setting.treeLabelName"))
			.setDesc(t("setting.treeLabelDesc"))
			.addText((text) =>
				text
					.setPlaceholder(t("view.treeName"))
					.setValue(this.plugin.settings.treeViewName)
					.onChange(async (value) => {
						this.plugin.settings.treeViewName = value;
						await this.plugin.saveSettings();
						this.plugin.applyTreeViewName();
					})
			);

		new Setting(containerEl)
			.setName(t("setting.sortName"))
			.setDesc(t("setting.sortDesc"))
			.addDropdown((dd) =>
				dd
					.addOption("tagkey", t("setting.sortTagkey"))
					.addOption("mtime", t("setting.sortMtime"))
					.addOption("ctime", t("setting.sortCtime"))
					.setValue(this.plugin.settings.sortKey)
					.onChange(async (value) => {
						this.plugin.settings.sortKey =
							value === "mtime" || value === "ctime" ? value : "tagkey";
						await this.plugin.saveSettings();
						this.plugin.rebuildTrees();
					})
			);

		// Nested tag mode (0.3.0, experimental — B24).
		new Setting(containerEl)
			.setName(t("setting.treeModeName"))
			.setDesc(t("setting.treeModeDesc"))
			.addDropdown((dd) =>
				dd
					.addOption("notes", t("setting.treeModeNotes"))
					.addOption("tags", t("setting.treeModeTags"))
					.setValue(this.plugin.settings.treeViewMode)
					.onChange(async (value) => {
						this.plugin.settings.treeViewMode = value === "tags" ? "tags" : "notes";
						await this.plugin.saveSettings();
						this.plugin.rebuildTrees();
						this.render();
					})
			);
		if (this.plugin.settings.treeViewMode === "tags") {
			new Setting(containerEl)
				.setName(t("setting.showRootName"))
				.setDesc(t("setting.showRootDesc"))
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.treeShowRoot)
						.onChange(async (value) => {
							this.plugin.settings.treeShowRoot = value;
							await this.plugin.saveSettings();
							this.plugin.rebuildTrees();
						})
				);
			new Setting(containerEl)
				.setName(t("setting.untaggedName"))
				.setDesc(t("setting.untaggedDesc"))
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.treeShowUntagged)
						.onChange(async (value) => {
							this.plugin.settings.treeShowUntagged = value;
							await this.plugin.saveSettings();
							this.plugin.rebuildTrees();
						})
				);
			new Setting(containerEl)
				.setName(t("setting.labelModeName"))
				.setDesc(t("setting.labelModeDesc"))
				.addDropdown((dd) =>
					dd
						.addOption("filename", t("setting.labelModeFilename"))
						.addOption("tag", t("setting.labelModeTag"))
						.setValue(this.plugin.settings.treeLabelMode)
						.onChange(async (value) => {
							this.plugin.settings.treeLabelMode =
								value === "tag" ? "tag" : "filename";
							await this.plugin.saveSettings();
							this.plugin.rebuildTrees();
						})
				);
		}

		// Per-button visibility for the tree-view header. A hidden button's action
		// is still reachable from the command palette (bootstrap, cascade, undo…).
		new Setting(containerEl)
			.setName(t("setting.headerButtonsName"))
			.setDesc(t("setting.headerButtonsDesc"))
			.setHeading();
		for (const id of HEADER_BUTTON_IDS) {
			new Setting(containerEl)
				.setName(t(`setting.hb.${id}`))
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.headerButtons[id])
						.onChange(async (value) => {
							this.plugin.settings.headerButtons[id] = value;
							await this.plugin.saveSettings();
							this.plugin.rebuildTrees();
						})
				);
		}
	}

	// --- Multi-key slot editor (advanced mode, 0.2.0 experimental) ----------
	// Edits are STAGED in a draft schema (draft()) and only reach the live
	// settings when Apply commits them — no per-keystroke writes to the schema.
	// Guards keep a committed schema valid: ≥1 tag slot, ≤1 name slot, distinct
	// namespaces, legal non-empty separators (slots n → separators n-1).

	/** The staged schema for advanced mode. null = no pending edits (== live). */
	private draftSchema: TrellisSchema | null = null;

	private draft(): TrellisSchema {
		if (!this.draftSchema) {
			this.draftSchema = JSON.parse(
				JSON.stringify(this.plugin.settings.schema)
			) as TrellisSchema;
			this.ensureSeparators(this.draftSchema);
		}
		return this.draftSchema;
	}

	private draftDirty(): boolean {
		return (
			this.draftSchema != null &&
			JSON.stringify(this.draftSchema) !==
				JSON.stringify(this.plugin.settings.schema)
		);
	}

	/** First problem with a staged schema as a human message, or null if valid. */
	private validateDraft(schema: TrellisSchema): string | null {
		const tags = schema.slots.filter((s) => s.role === "tag");
		if (tags.length < 1) return t("adv.invalid.needTag");
		if (schema.slots.filter((s) => s.role === "name").length > 1)
			return t("adv.invalid.oneName");
		const seen = new Set<string>();
		for (const s of tags) {
			const ns = (s.namespace ?? "").trim();
			if (ns === "") return t("adv.invalid.nsEmpty");
			if (!isValidNamespace(ns)) return t("adv.invalid.nsBad", { ns });
			if (seen.has(ns)) return t("adv.invalid.nsDup", { ns });
			seen.add(ns);
		}
		const need = Math.max(0, schema.slots.length - 1);
		for (let i = 0; i < need; i++) {
			if (!isValidSeparator(schema.separators[i] ?? ""))
				return t("adv.invalid.sep", { n: i + 1 });
		}
		return null;
	}

	private renderSlotEditor(containerEl: HTMLElement) {
		const schema = this.draft();
		// Re-render from the draft after a structural edit; nothing is saved until
		// Apply. Text fields (namespace, gap separator) mutate the draft in place
		// and are validated on Apply, so they don't re-render on every keystroke.
		const refresh = () => {
			this.ensureSeparators(schema);
			this.render();
		};

		new Setting(containerEl).setName(t("setting.advSlots")).setHeading();

		schema.slots.forEach((slot, i) => {
			const row = new Setting(containerEl).setName(t("adv.slot", { n: i + 1 }));
			row.addDropdown((dd) =>
				dd
					.addOption("tag", t("adv.roleTag"))
					.addOption("name", t("adv.roleName"))
					.setValue(slot.role)
					.onChange((v) => {
						const role = v === "name" ? "name" : "tag";
						if (role === slot.role) return;
						if (role === "name") {
							if (schema.slots.some((s, j) => j !== i && s.role === "name")) {
								new Notice(t("notice.advOneName"));
								this.render();
								return;
							}
							if (schema.slots.filter((s) => s.role === "tag").length <= 1) {
								new Notice(t("notice.advLastTag"));
								this.render();
								return;
							}
							slot.role = "name";
							delete slot.namespace;
						} else {
							slot.role = "tag";
							slot.namespace = slot.namespace || this.nextFreeNamespace(schema);
						}
						refresh();
					})
			);
			if (slot.role === "tag") {
				row.addText((text) =>
					text
						.setPlaceholder(t("adv.nsPh"))
						.setValue(slot.namespace ?? "")
						.onChange((v) => {
							// Staged raw; validated on Apply (no live save/re-render).
							slot.namespace = v.trim().replace(/^#/, "").replace(/\/$/, "");
						})
				);
				// Per-slot ID scheme (0.3.0). Staged like the rest of the draft.
				row.addDropdown((dd) => {
					dd.addOption("", t("scheme.none"));
					for (const id of SCHEME_IDS) dd.addOption(id, t(`scheme.${id}`));
					dd.setValue(slot.scheme ?? "").onChange((v) => {
						if ((SCHEME_IDS as string[]).includes(v)) slot.scheme = v as SchemeId;
						else delete slot.scheme;
					});
				});
			}
			row.addExtraButton((b) =>
				b
					.setIcon("arrow-up")
					.setTooltip(t("adv.moveUp"))
					.setDisabled(i === 0)
					.onClick(() => {
						if (i === 0) return;
						[schema.slots[i - 1], schema.slots[i]] = [schema.slots[i], schema.slots[i - 1]];
						refresh();
					})
			);
			row.addExtraButton((b) =>
				b
					.setIcon("arrow-down")
					.setTooltip(t("adv.moveDown"))
					.setDisabled(i === schema.slots.length - 1)
					.onClick(() => {
						if (i === schema.slots.length - 1) return;
						[schema.slots[i], schema.slots[i + 1]] = [schema.slots[i + 1], schema.slots[i]];
						refresh();
					})
			);
			row.addExtraButton((b) =>
				b
					.setIcon("trash")
					.setTooltip(t("adv.remove"))
					.onClick(() => {
						if (
							slot.role === "tag" &&
							schema.slots.filter((s) => s.role === "tag").length <= 1
						) {
							new Notice(t("notice.advLastTag"));
							return;
						}
						schema.slots.splice(i, 1);
						refresh();
					})
			);
			// The separator between this slot and the next (slots n → seps n-1).
			if (i < schema.slots.length - 1) {
				new Setting(containerEl)
					.setName(t("adv.sep", { n: i + 1, a: i + 1, b: i + 2 }))
					.addText((text) =>
						text
							.setPlaceholder("-")
							.setValue(schema.separators[i] ?? "-")
							.onChange((v) => {
								// Staged raw; validated on Apply.
								schema.separators[i] = v;
							})
					);
			}
		});

		// One "Add slot" button: a new slot defaults to a tag role (the safe
		// minimum) and the per-row role dropdown converts it to a name slot if
		// wanted — replacing the old separate add-tag / add-name buttons.
		new Setting(containerEl).addButton((b) =>
			b.setButtonText(t("adv.addSlot")).onClick(() => {
				schema.slots.push({
					role: "tag",
					namespace: this.nextFreeNamespace(schema),
				});
				refresh();
			})
		);

		// Apply / Revert — the staged schema only reaches the engine here. Shown
		// only when the draft differs from the live schema.
		if (this.draftDirty()) {
			new Setting(containerEl)
				.setName(t("adv.pending"))
				.addButton((b) =>
					b
						.setButtonText(t("adv.apply"))
						.setCta()
						.onClick(() => {
							const err = this.validateDraft(schema);
							if (err) {
								new AlertModal(this.app, t("adv.invalidTitle"), err).open();
								return;
							}
							const commit = async () => {
								this.ensureSeparators(schema);
								// The root is edited OUTSIDE the draft (its own Apply runs a
								// vault migration). Always take the LIVE root: a stale draft
								// copy would otherwise revert a migrated root with no
								// migration, orphaning every managed tag.
								schema.rootNamespace = this.plugin.settings.schema.rootNamespace;
								this.plugin.settings.schema = schema;
								this.draftSchema = null;
								await this.plugin.saveSettings();
								this.plugin.rebuildTrees();
								new Notice(t("notice.advApplied"));
								this.render();
							};
							if (this.plugin.settings.suppressSchemaConfirm) {
								void commit();
								return;
							}
							new ConfirmModal(
								this.app,
								t("modal.applySchema.title"),
								t("modal.applySchema.desc"),
								(dontAsk) => {
									if (dontAsk)
										this.plugin.settings.suppressSchemaConfirm = true;
									void commit();
								}
							).open();
						})
				)
				.addButton((b) =>
					b.setButtonText(t("adv.revert")).onClick(() => {
						this.draftSchema = null;
						this.render();
					})
				);
		}
	}

	/** Read-only summary: how many notes carry a managed location tag, and which
	 *  namespaces TRELLIS is currently managing. */
	private renderStats(containerEl: HTMLElement) {
		const schema = this.plugin.settings.schema;
		const fulls = tagNamespaces(schema).map((ns) => nsPath(schema, ns)); // root-aware
		const files = this.app.vault.getMarkdownFiles();
		let managed = 0;
		for (const f of files) {
			const cache = this.app.metadataCache.getFileCache(f);
			const tags = cache ? getAllTags(cache) ?? [] : [];
			if (
				// Only tags that resolve to a real tagkey (#ns/...): a bare
				// namespace tag is never managed, so counting it would overstate.
				tags.some((tag) => fulls.some((ns) => tag.startsWith(`#${ns}/`)))
			)
				managed++;
		}
		new Setting(containerEl)
			.setName(t("setting.statsName"))
			.setDesc(
				t("setting.statsDesc", {
					managed,
					total: files.length,
					ns: fulls.join(", ") || "—",
				})
			);
	}

	/** Keep separators aligned with the slot count (n slots → n-1 separators). */
	private ensureSeparators(schema: TrellisSchema) {
		const need = Math.max(0, schema.slots.length - 1);
		const fill = schema.separators[schema.separators.length - 1] || "-";
		while (schema.separators.length < need) schema.separators.push(fill);
		schema.separators.length = need;
	}

	/** A namespace not yet used by any tag slot, for a freshly added slot. */
	private nextFreeNamespace(schema: TrellisSchema): string {
		const used = new Set(
			schema.slots.filter((s) => s.role === "tag").map((s) => s.namespace)
		);
		if (!used.has("trel")) return "trel";
		let i = 2;
		while (used.has(`key${i}`)) i++;
		return `key${i}`;
	}
}
