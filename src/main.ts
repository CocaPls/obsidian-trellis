import {
	Plugin,
	TFile,
	getAllTags,
	getFrontMatterInfo,
	Notice,
	debounce,
	normalizePath,
	parseYaml,
	type WorkspaceLeaf,
} from "obsidian";
import {
	TrellisSchema,
	KeySlot,
	SegmentSeparator,
	SeparatorSpacing,
	SchemeId,
	defaultSchema,
	schemaFromLegacy,
	primaryNamespace,
	primaryNsPath,
	nsPath,
	primarySeparator,
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
	isMultiKey,
	syncedBasenameMulti,
	isValidTagSegmentForSlot,
	isValidTagPath,
	tagNamespaces,
	separatorConflicts,
	schemaMigratedName,
} from "./tagkey";
import {
	TrellisTreeView,
	TRELLIS_TREE_VIEW,
	HeaderButtonVisibility,
} from "./tree-view";
import { t, setLang, LangSetting } from "./i18n";
import {
	inspectNoteState,
	planNoteChange,
	validatePlanSnapshot,
	type AutomationResult,
	type TrellisApplyResult,
	type TrellisChangePlan,
	type TrellisChangeRequest,
	type TrellisNoteInspection,
	type TrellisNoteState,
} from "./automation";
import {
	DuplicateNote,
	DedupDecision,
	DuplicateTagsModal,
	CascadeRenameModal,
	CascadePreviewModal,
	type CascadePreviewRow,
	NewChildNoteModal,
	BootstrapSelectModal,
	BootstrapPreviewModal,
	SeparatorChangeModal,
	BulkProgressModal,
	AlertModal,
	ConfirmModal,
} from "./modals";

import { TrellisSettingTab } from "./settings-tab";

const SEGMENT_SEPARATORS: SegmentSeparator[] = ["", ".", "-", "_"];
const SEPARATOR_SPACING: SeparatorSpacing[] = ["none", "before", "after", "both"];

type SortKey = "tagkey" | "mtime" | "ctime";

type PlainObject = Record<string, unknown>;

interface TrellisFrontmatter extends PlainObject {
	tags?: unknown;
}

function isPlainObject(value: unknown): value is PlainObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStrings(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
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
	/** Full schemas are present on new records. Scalar fields keep old data.json undoable. */
	oldSchema?: TrellisSchema;
	newSchema?: TrellisSchema;
	oldSep?: string;
	newSep?: string;
	renames: SeparatorRename[];
}

/** One file's location tags removed by a dedup pass, so it can be undone. */
interface DedupRecord {
	path: string;
	removed: string[];
}

/** One note changed by a cascade pass. Both paths are retained because the
 * tag edit can drive a filename rename; undo restores the exact original path. */
interface CascadeRecord {
	originalPath: string;
	currentPath: string;
	beforeTags: string[];
	afterTags: string[];
}

/** The last root-namespace change (for undo — the migration is symmetric). */
interface RootChangeRecord {
	oldRoot: string;
	newRoot: string;
}

/** Exact state needed to reverse a primary namespace migration safely. */
interface NamespaceChangeRecord {
	oldSchema: TrellisSchema;
	newSchema: TrellisSchema;
	changes: CascadeRecord[];
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
	/** The last completed (or incompletely rolled-back) cascade pass. */
	lastCascade?: CascadeRecord[];
	/** The last root-namespace change (for undo). */
	lastRootChange?: RootChangeRecord;
	/** The last primary-namespace migration (for undo). */
	lastNamespaceChange?: NamespaceChangeRecord;
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

function cloneSchema(schema: TrellisSchema): TrellisSchema {
	return {
		rootNamespace: schema.rootNamespace,
		slots: schema.slots.map((slot) => ({ ...slot })),
		separators: [...schema.separators],
		separatorSpacing: schema.separatorSpacing
			? [...schema.separatorSpacing]
			: undefined,
	};
}

/** Normalize old/manual data without changing its rendered filenames. */
function normalizeSchemaFormatting(schema: TrellisSchema): TrellisSchema {
	const normalized = cloneSchema(schema);
	normalized.slots = normalized.slots.map((slot) => {
		if (
			slot.role === "tag" &&
			slot.segmentSeparator !== undefined &&
			!SEGMENT_SEPARATORS.includes(slot.segmentSeparator)
		) {
			return { ...slot, segmentSeparator: "" };
		}
		return slot;
	});
	normalized.separatorSpacing = normalized.separators.map((raw, i) => {
		const saved = normalized.separatorSpacing?.[i];
		const before = /^\s/.test(raw);
		const after = /\s$/.test(raw);
		normalized.separators[i] = raw.trim();
		if (saved && SEPARATOR_SPACING.includes(saved)) return saved;
		if (before && after) return "both";
		if (before) return "before";
		if (after) return "after";
		return "none";
	});
	return normalized;
}

export default class TrellisPlugin extends Plugin {
	settings: TrellisSettings = { ...DEFAULT_SETTINGS };

	/** Guarded in-process automation surface. No network, URI, REST, or MCP
	 * endpoint is opened; callers must already hold this plugin instance. */
	readonly automation = Object.freeze({
		inspectNote: (path: string) => this.inspectNote(path),
		planChange: (request: TrellisChangeRequest) => this.planChange(request),
		applyChange: (plan: TrellisChangePlan) => this.applyChange(plan),
	});

	/** Ribbon button for the tree view, kept so we can show/hide it on toggle. */
	private ribbonEl: HTMLElement | null = null;

	/** Infinite-loop guard: paths we are currently renaming, to ignore the
	 *  metadata/vault events our own rename triggers. */
	private renaming = new Set<string>();
	/** Suppress metadata-triggered live sync while guarded automation owns a
	 * note's frontmatter + filename transaction. */
	private automationApplying = new Set<string>();
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
	private activeBulkOperation: string | null = null;
	/** Paths whose frontmatter + filename are currently owned by a bulk pass. */
	private bulkApplying = new Set<string>();

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
	/** Persist user-driven path repairs without writing data.json on every rename event. */
	private readonly scheduleUndoPathSave = debounce(
		() => void this.saveSettings(),
		500,
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
						getUndoAvailability: () => ({
							cascade: this.settings.lastCascade?.length ?? 0,
							namespace: this.settings.lastNamespaceChange?.changes.length ?? 0,
							bootstrap: this.settings.lastBootstrap?.length ?? 0,
							separator: this.settings.lastSeparatorChange?.renames.length ?? 0,
							dedup: this.settings.lastDedup?.length ?? 0,
							root: this.settings.lastRootChange !== undefined,
						}),
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
								this.requestCascadeRename(from, to)
							).open(),
						onUndoBootstrap: () => void this.undoBootstrap(),
						onUndoSeparator: () => void this.undoSeparatorChange(),
						onUndoRoot: () => void this.undoRootChange(),
						onUndoCascade: () => void this.undoCascade(),
						onUndoNamespace: () => void this.undoPrimaryNamespaceChange(),
						onUndoDedup: () => void this.undoDedup(),
					})
			);
		} catch (e) {
			console.warn("TRELLIS: tree view type already registered (stale instance?)", e);
		}
		await this.rehydrateStaleTreeViews();
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
					// Bulk/AI transactions own and record their own final paths. Ordinary
					// user renames (including the live-sync correction they trigger) must
					// carry saved undo records forward to the final file path.
					if (!this.bulkActive && this.automationApplying.size === 0) {
						if (this.updateUndoPaths(oldPath, file.path)) {
							this.scheduleUndoPathSave();
						}
					}
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
					this.requestCascadeRename(from, to)
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
		this.addCommand({
			id: "cascade-undo",
			name: t("cmd.cascadeUndo"),
			callback: () => void this.undoCascade(),
		});
		this.addCommand({
			id: "namespace-change-undo",
			name: t("cmd.namespaceUndo"),
			callback: () => void this.undoPrimaryNamespaceChange(),
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
								(f, t) => this.requestCascadeRename(f, t),
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
		this.settings.schema = normalizeSchemaFormatting(this.settings.schema);
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

	/** Count notes carrying a real descendant tag under one full namespace. */
	private managedNoteCountForNamespace(namespace: string): number {
		let count = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const tags = normalizeTagList(cache?.frontmatter?.tags);
			if (tags.some((tag) => tag.startsWith(`${namespace}/`))) count++;
		}
		return count;
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

	/** Keep every path-bearing undo journal attached to a user-renamed note. */
	private updateUndoPaths(oldPath: string, newPath: string): boolean {
		let changed = false;
		const replace = (value: string): string => {
			if (value !== oldPath) return value;
			changed = true;
			return newPath;
		};
		for (const record of this.settings.lastBootstrap ?? []) {
			record.path = replace(record.path);
		}
		for (const record of this.settings.lastDedup ?? []) {
			record.path = replace(record.path);
		}
		for (const record of this.settings.lastSeparatorChange?.renames ?? []) {
			record.path = replace(record.path);
		}
		for (const record of this.settings.lastCascade ?? []) {
			record.currentPath = replace(record.currentPath);
		}
		for (const record of this.settings.lastNamespaceChange?.changes ?? []) {
			record.currentPath = replace(record.currentPath);
		}
		return changed;
	}

	/** Read the file text directly instead of trusting metadataCache. This is the
	 * final optimistic-concurrency check used by the AI apply surface. */
	private async freshFrontmatterTags(file: TFile): Promise<string[]> {
		const content = await this.app.vault.read(file);
		const info = getFrontMatterInfo(content);
		if (!info.exists) return [];
		const parsed: unknown = parseYaml(info.frontmatter);
		return normalizeTagList(isPlainObject(parsed) ? parsed.tags : undefined).map(
			(tag) => tag.replace(/^#/, "")
		);
	}

	/** Only one vault-wide mutation may run at a time. This prevents two command
	 * palette actions from interleaving their writes and overwriting undo state. */
	private beginBulkOperation(label: string): boolean {
		if (this.activeBulkOperation !== null) {
			new Notice(
				t("notice.bulkBusy", {
					active: this.activeBulkOperation,
				})
			);
			return false;
		}
		this.activeBulkOperation = label;
		return true;
	}

	private endBulkOperation(label: string) {
		if (this.activeBulkOperation === label) this.activeBulkOperation = null;
	}

	private get bulkActive(): boolean {
		return this.activeBulkOperation !== null;
	}

	private noteState(path: string): AutomationResult<TrellisNoteState> {
		const normalized = normalizePath(path);
		const abstract = this.app.vault.getAbstractFileByPath(normalized);
		if (!abstract) {
			return {
				ok: false,
				error: {
					code: "note-not-found",
					message: `No vault file exists at '${normalized}'.`,
				},
			};
		}
		if (!(abstract instanceof TFile) || abstract.extension !== "md") {
			return {
				ok: false,
				error: {
					code: "not-a-markdown-file",
					message: `'${normalized}' is not a Markdown note.`,
				},
			};
		}
		const cache = this.app.metadataCache.getFileCache(abstract);
		if (!cache) {
			return {
				ok: false,
				error: {
					code: "metadata-unavailable",
					message: `Metadata is not ready for '${normalized}'.`,
				},
			};
		}
		const frontmatter = isPlainObject(cache.frontmatter) ? cache.frontmatter : {};
		return {
			ok: true,
			value: {
				path: abstract.path,
				basename: abstract.basename,
				extension: abstract.extension,
				mtime: abstract.stat.mtime,
				allTags: getAllTags(cache) ?? [],
				frontmatterTags: normalizeTagList(frontmatter.tags).map((tag) =>
					tag.replace(/^#/, "")
				),
			},
		};
	}

	/** Read-only, structured note inspection for internal automation. */
	inspectNote(path: string): AutomationResult<TrellisNoteInspection> {
		const state = this.noteState(path);
		return state.ok
			? { ok: true, value: inspectNoteState(state.value, this.settings.schema) }
			: state;
	}

	/** Read-only dry-run with an optimistic-concurrency snapshot. */
	planChange(request: TrellisChangeRequest): AutomationResult<TrellisChangePlan> {
		const state = this.noteState(request.path);
		return state.ok
			? planNoteChange(state.value, this.settings.schema, request)
			: state;
	}

	/** Apply exactly one previously reviewed plan. Re-checks path, basename,
	 * mtime, frontmatter tags and schema before writing. If the rename fails,
	 * frontmatter is restored; if that rollback fails too, the structured error
	 * reports both failures instead of pretending the operation was atomic. */
	async applyChange(
		plan: TrellisChangePlan
	): Promise<AutomationResult<TrellisApplyResult>> {
		const stateResult = this.noteState(plan.expected.path);
		if (!stateResult.ok) return stateResult;
		const snapshot = validatePlanSnapshot(
			stateResult.value,
			this.settings.schema,
			plan
		);
		if (!snapshot.ok) return snapshot;
		// Never trust caller-supplied `next` fields. Recompute the plan from the
		// validated request and current state, then require byte-for-byte parity.
		const recomputed = planNoteChange(
			stateResult.value,
			this.settings.schema,
			plan.request
		);
		if (!recomputed.ok) return recomputed;
		if (JSON.stringify(recomputed.value) !== JSON.stringify(plan)) {
			return {
				ok: false,
				error: {
					code: "stale-plan",
					message: "The supplied plan does not match a fresh dry-run of its request.",
				},
			};
		}
		const verifiedPlan = recomputed.value;
		const file = this.app.vault.getAbstractFileByPath(verifiedPlan.expected.path);
		if (!(file instanceof TFile)) {
			return {
				ok: false,
				error: { code: "note-not-found", message: "The planned note no longer exists." },
			};
		}
		let freshTags: string[];
		try {
			freshTags = await this.freshFrontmatterTags(file);
		} catch (error) {
			return {
				ok: false,
				error: {
					code: "stale-plan",
					message: "The note could not be re-read before apply.",
					details: { error: String(error) },
				},
			};
		}
		if (!sameStrings(freshTags, verifiedPlan.expected.frontmatterTags)) {
			return {
				ok: false,
				error: {
					code: "stale-plan",
					message: "The note's frontmatter changed after the dry-run.",
				},
			};
		}
		if (verifiedPlan.status === "noop") {
			return {
				ok: true,
				value: {
					status: "noop",
					previousPath: verifiedPlan.expected.path,
					path: verifiedPlan.expected.path,
					changes: verifiedPlan.changes,
				},
			};
		}
		if (verifiedPlan.changes.rename) {
			const target = this.app.vault.getAbstractFileByPath(verifiedPlan.next.path);
			if (target && target !== file) {
				return {
					ok: false,
					error: {
						code: "target-exists",
						message: `A vault item already exists at '${verifiedPlan.next.path}'.`,
					},
				};
			}
		}

		const guardedPaths = [verifiedPlan.expected.path, verifiedPlan.next.path];
		for (const path of guardedPaths) this.automationApplying.add(path);
		try {
		if (verifiedPlan.changes.frontmatter) {
			let stale = false;
			try {
				await this.app.fileManager.processFrontMatter(
					file,
					(frontmatter: TrellisFrontmatter) => {
						const current = normalizeTagList(frontmatter.tags).map((tag) =>
							tag.replace(/^#/, "")
						);
						if (!sameStrings(current, verifiedPlan.expected.frontmatterTags)) {
							stale = true;
							return;
						}
						frontmatter.tags = [...verifiedPlan.next.frontmatterTags];
					}
				);
				if (stale) {
					return {
						ok: false,
						error: {
							code: "stale-plan",
							message: "The note's frontmatter changed while apply was starting.",
						},
					};
				}
			} catch (error) {
				return {
					ok: false,
					error: {
						code: "frontmatter-write-failed",
						message: "Obsidian could not write the planned frontmatter tags.",
						details: { error: String(error) },
					},
				};
			}
		}

		if (verifiedPlan.changes.rename) {
			const renamed = await this.renameGuarded(file, verifiedPlan.next.path);
			if (!renamed) {
				let rollbackError: string | undefined;
				if (verifiedPlan.changes.frontmatter) {
					try {
						await this.app.fileManager.processFrontMatter(
							file,
							(frontmatter: TrellisFrontmatter) => {
								frontmatter.tags = [...verifiedPlan.expected.frontmatterTags];
							}
						);
					} catch (error) {
						rollbackError = String(error);
					}
				}
				return {
					ok: false,
					error: {
						code: "rename-failed",
						message: rollbackError
							? "The rename failed and frontmatter rollback also failed."
							: "The rename failed; any frontmatter change was rolled back.",
						details: rollbackError ? { rollbackError } : undefined,
					},
				};
			}
		}
			this.rebuildTrees();
			return {
				ok: true,
				value: {
					status: "applied",
					previousPath: verifiedPlan.expected.path,
					path: verifiedPlan.next.path,
					changes: verifiedPlan.changes,
				},
			};
		} finally {
			window.setTimeout(() => {
				for (const path of guardedPaths) this.automationApplying.delete(path);
			}, 200);
		}
	}

	/** Sync one file's location tag into its filename tagkey (one direction). */
	private async syncFile(file: TFile) {
		if (this.separatorMigrationRunning) return;
		if (this.automationApplying.has(file.path)) return;
		if (this.bulkApplying.has(file.path)) return;
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
		if (!isValidTagSegmentForSlot(segment, slot)) {
			new Notice(t("notice.segmentBadChar"));
			return;
		}
		const full = nsPath(schema, slot.namespace);
		const rest = tagPath === full ? "" : tagPath.slice(full.length + 1);
		const tagkey = rest.split("/").join(slot.segmentSeparator ?? "");
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
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
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
		if (leaf && !(leaf.view instanceof TrellisTreeView)) {
			await this.rehydrateTreeLeaf(leaf);
		}
		if (!leaf) {
			const left = workspace.getLeftLeaf(false);
			if (!left) return;
			leaf = left;
			await leaf.setViewState({ type: TRELLIS_TREE_VIEW, active: true });
		}
		this.revealTreeLeaf(leaf);
	}

	/**
	 * Obsidian hot-updates plugins by disabling and enabling them in place. An
	 * already-open custom-view leaf can survive that cycle as an UnknownView,
	 * even after the replacement view factory has been registered. Recreate only
	 * those stale leaves so an ordinary plugin update does not require an app
	 * restart or manual tab repair.
	 */
	private async rehydrateStaleTreeViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(TRELLIS_TREE_VIEW)) {
			if (!(leaf.view instanceof TrellisTreeView)) {
				await this.rehydrateTreeLeaf(leaf);
			}
		}
	}

	private async rehydrateTreeLeaf(leaf: WorkspaceLeaf) {
		await leaf.setViewState({ type: "empty", active: false });
		await leaf.setViewState({ type: TRELLIS_TREE_VIEW, active: false });
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

	/** Exact frontmatter changes a managed cascade would make. The command is
	 * deliberately limited to the primary managed namespace; it is not a generic
	 * vault-wide tag replacement tool. */
	private previewCascade(from: string, to: string): CascadePreviewRow[] {
		const rows: CascadePreviewRow[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const beforeTags = normalizeTagList(cache.frontmatter?.tags);
			const afterTags = beforeTags.map((tag) => renameTagPath(tag, from, to) ?? tag);
			if (!sameStrings(beforeTags, afterTags)) {
				rows.push({ path: file.path, beforeTags, afterTags });
			}
		}
		return rows;
	}

	/** Validate scope, build an exact dry-run, then ask once before writing. */
	private requestCascadeRename(rawFrom: string, rawTo: string) {
		const from = rawFrom.trim().replace(/^#/, "").replace(/\/$/, "");
		const to = rawTo.trim().replace(/^#/, "").replace(/\/$/, "");
		if (from === to) return;
		if (!isValidTagPath(from) || !isValidTagPath(to)) {
			new Notice(t("notice.cascadeBadPath"));
			return;
		}
		const namespace = primaryNsPath(this.settings.schema);
		const isManagedChild = (path: string) => path.startsWith(`${namespace}/`);
		if (!isManagedChild(from) || !isManagedChild(to)) {
			new Notice(t("notice.cascadeOutside", { ns: namespace }));
			return;
		}
		const rows = this.previewCascade(from, to);
		if (rows.length === 0) {
			new Notice(t("notice.noFilesTagged", { from }));
			return;
		}
		new CascadePreviewModal(this.app, from, to, rows, () => {
			void this.applyCascade(from, to, rows);
		}).open();
	}

	/** Compute the link-safe filename target for explicit, already-validated tags.
	 * Used by cascade so it does not depend on metadata-cache timing after the
	 * frontmatter write. */
	private syncedPathForTags(file: TFile, tags: string[]): string | null {
		let basename: string | null;
		if (isMultiKey(this.settings.schema)) {
			basename = syncedBasenameMulti(file.basename, tags, this.settings.schema);
		} else {
			const tagkey = pickTagkey(tags, this.settings.schema);
			if (tagkey === null) return null;
			basename = syncedBasename(file.basename, tagkey, this.settings.schema);
		}
		if (basename === null) return null;
		const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
		return normalizePath(`${dir}${basename}.${file.extension}`);
	}

	/** Restore a cascade record exactly: original tags and original file path.
	 * A record that cannot be restored is retained for a later retry. */
	private async revertCascadeRecords(
		records: CascadeRecord[]
	): Promise<{ restored: number; remaining: CascadeRecord[] }> {
		let restored = 0;
		const remaining: CascadeRecord[] = [];
		for (const record of [...records].reverse()) {
			const abstract = this.app.vault.getAbstractFileByPath(record.currentPath);
			if (!(abstract instanceof TFile)) {
				remaining.unshift(record);
				continue;
			}
			const guarded = new Set([record.currentPath, record.originalPath]);
			for (const path of guarded) this.bulkApplying.add(path);
			let tagsRestored = false;
			try {
				await this.app.fileManager.processFrontMatter(
					abstract,
					(frontmatter: TrellisFrontmatter) => {
						const current = normalizeTagList(frontmatter.tags);
						if (!sameStrings(current, record.afterTags)) {
							throw new Error("cascade undo state changed");
						}
						frontmatter.tags = [...record.beforeTags];
						tagsRestored = true;
					}
				);
				if (
					abstract.path !== record.originalPath &&
					!(await this.renameGuarded(abstract, record.originalPath))
				) {
					throw new Error("cascade undo rename failed");
				}
				restored++;
			} catch (error) {
				console.error("TRELLIS cascade rollback skipped", record.currentPath, error);
				// If tags were restored but the path was not, this retry now expects the
				// restored tags instead of an after-state that no longer exists.
				remaining.unshift(
					tagsRestored
						? { ...record, afterTags: [...record.beforeTags] }
						: record
				);
			} finally {
				window.setTimeout(() => {
					for (const path of guarded) this.bulkApplying.delete(path);
				}, 200);
			}
		}
		return { restored, remaining };
	}

	/** Apply the reviewed cascade as an all-or-rollback batch. */
	private async applyCascade(
		from: string,
		to: string,
		rows: CascadePreviewRow[]
	) {
		const operation = t("bulk.title.cascade");
		if (!this.beginBulkOperation(operation)) return;
		const previousUndo = this.settings.lastCascade;
		const records: CascadeRecord[] = [];
		const failed: string[] = [];
		const progress = new BulkProgressModal(this.app, operation);
		progress.open();
		try {
			for (let i = 0; i < rows.length; i++) {
				if (!(await progress.gate())) break;
				const row = rows[i];
				const abstract = this.app.vault.getAbstractFileByPath(row.path);
				if (!(abstract instanceof TFile)) {
					failed.push(row.path);
					break;
				}
				const originalPath = abstract.path;
				const guarded = new Set([originalPath]);
				this.bulkApplying.add(originalPath);
				let stale = false;
				const record: CascadeRecord = {
					originalPath,
					currentPath: originalPath,
					beforeTags: [...row.beforeTags],
					afterTags: [...row.afterTags],
				};
				try {
					await this.app.fileManager.processFrontMatter(
						abstract,
						(frontmatter: TrellisFrontmatter) => {
							const current = normalizeTagList(frontmatter.tags);
							if (!sameStrings(current, row.beforeTags)) {
								stale = true;
								return;
							}
							frontmatter.tags = [...row.afterTags];
						}
					);
					if (stale) throw new Error("cascade preview became stale");
					records.push(record);
					const nextPath = this.syncedPathForTags(
						abstract,
						row.afterTags.map((tag) => `#${tag}`)
					);
					if (nextPath !== null) {
						guarded.add(nextPath);
						this.bulkApplying.add(nextPath);
						if (!(await this.renameGuarded(abstract, nextPath))) {
							throw new Error("cascade filename rename failed");
						}
						record.currentPath = abstract.path;
					}
				} catch (error) {
					// A stale preview or target collision is an expected guarded abort:
					// the completed prefix is rolled back below, so do not report it as
					// an uncaught plugin error in Obsidian's developer console.
					console.warn("TRELLIS cascade apply aborted", row.path, error);
					failed.push(row.path);
					break;
				} finally {
					window.setTimeout(() => {
						for (const path of guarded) this.bulkApplying.delete(path);
					}, 200);
				}
				progress.report(i + 1, rows.length, failed.length);
			}

			if (progress.wasCancelled || failed.length > 0) {
				const { restored, remaining } = await this.revertCascadeRecords(records);
				this.settings.lastCascade = remaining.length > 0 ? remaining : previousUndo;
				await this.saveSettings();
				this.rebuildTrees();
				progress.finish({
					processed: restored,
					skipped: failed,
					outcome: "rolled-back",
				});
				return;
			}

			this.settings.lastCascade = records;
			await this.saveSettings();
			this.rebuildTrees();
			progress.finish({ processed: records.length, skipped: [] });
			new Notice(t("notice.retagged", { n: records.length, from, to }));
		} finally {
			this.endBulkOperation(operation);
		}
	}

	private async undoCascade() {
		const records = this.settings.lastCascade ?? [];
		if (records.length === 0) {
			new Notice(t("notice.noCascade"));
			return;
		}
		const operation = t("bulk.title.cascadeUndo");
		if (!this.beginBulkOperation(operation)) return;
		try {
			const { restored, remaining } = await this.revertCascadeRecords(records);
			this.settings.lastCascade = remaining.length > 0 ? remaining : undefined;
			await this.saveSettings();
			this.rebuildTrees();
			new Notice(t("notice.cascadeUndone", { n: restored }));
		} finally {
			this.endBulkOperation(operation);
		}
	}

	/** Rename the simple-mode namespace together with every managed frontmatter
	 * tag. A setting-only flip would make the existing tags invisible to TRELLIS. */
	requestPrimaryNamespaceChange(newNamespace: string, onDone: () => void) {
		const oldSchema = cloneSchema(this.settings.schema);
		const oldNamespace = primaryNamespace(oldSchema);
		if (newNamespace === oldNamespace) {
			onDone();
			return;
		}
		const newSchema = cloneSchema(oldSchema);
		const primary = newSchema.slots.find((slot) => slot.role === "tag");
		if (!primary) return;
		primary.namespace = newNamespace;
		const from = primaryNsPath(oldSchema);
		const to = primaryNsPath(newSchema);
		const rows = this.previewCascade(from, to);
		if (rows.length === 0) {
			void this.applyNamespaceMigration(oldSchema, newSchema, rows, false).finally(
				onDone
			);
			return;
		}
		new CascadePreviewModal(this.app, from, to, rows, () => {
			void this.applyNamespaceMigration(oldSchema, newSchema, rows, false).finally(
				onDone
			);
		}).open();
	}

	/** Apply or undo an exact primary-namespace migration. The target schema is
	 * active during writes so every completed note remains managed; cancel or a
	 * stale/error row restores both completed notes and the source schema. */
	private async applyNamespaceMigration(
		sourceSchema: TrellisSchema,
		targetSchema: TrellisSchema,
		rows: CascadePreviewRow[],
		undoing: boolean
	) {
		const operation = t(
			undoing ? "bulk.title.namespaceUndo" : "bulk.title.namespace"
		);
		if (!this.beginBulkOperation(operation)) return;
		const previousUndo = this.settings.lastNamespaceChange;
		const records: CascadeRecord[] = [];
		const failed: string[] = [];
		const progress =
			rows.length > 0 ? new BulkProgressModal(this.app, operation) : null;
		progress?.open();
		try {
			this.settings.schema = cloneSchema(targetSchema);
			await this.saveSettings();
			for (let i = 0; i < rows.length; i++) {
				if (progress && !(await progress.gate())) break;
				const row = rows[i];
				const file = this.app.vault.getAbstractFileByPath(row.path);
				if (!(file instanceof TFile)) {
					failed.push(row.path);
					break;
				}
				const record: CascadeRecord = {
					originalPath: file.path,
					currentPath: file.path,
					beforeTags: [...row.beforeTags],
					afterTags: [...row.afterTags],
				};
				const guarded = new Set([file.path]);
				this.bulkApplying.add(file.path);
				let stale = false;
				try {
					await this.app.fileManager.processFrontMatter(
						file,
						(frontmatter: TrellisFrontmatter) => {
							const current = normalizeTagList(frontmatter.tags);
							if (!sameStrings(current, row.beforeTags)) {
								stale = true;
								return;
							}
							frontmatter.tags = [...row.afterTags];
						}
					);
					if (stale) throw new Error("namespace preview became stale");
					records.push(record);
					const nextPath = this.syncedPathForTags(
						file,
						row.afterTags.map((tag) => `#${tag}`)
					);
					if (nextPath !== null) {
						guarded.add(nextPath);
						this.bulkApplying.add(nextPath);
						if (!(await this.renameGuarded(file, nextPath))) {
							throw new Error("namespace filename rename failed");
						}
						record.currentPath = file.path;
					}
				} catch (error) {
					console.error("TRELLIS namespace migration failed", row.path, error);
					failed.push(row.path);
					break;
				} finally {
					window.setTimeout(() => {
						for (const path of guarded) this.bulkApplying.delete(path);
					}, 200);
				}
				progress?.report(i + 1, rows.length, failed.length);
			}

			if (progress?.wasCancelled || failed.length > 0) {
				const { restored, remaining } = await this.revertCascadeRecords(records);
				this.settings.schema = cloneSchema(sourceSchema);
				this.settings.lastNamespaceChange = previousUndo;
				await this.saveSettings();
				this.rebuildTrees();
				progress?.finish({
					processed: restored,
					skipped: [...failed, ...remaining.map((record) => record.currentPath)],
					outcome: "rolled-back",
				});
				return;
			}

			this.settings.lastNamespaceChange = undoing
				? undefined
				: {
						oldSchema: cloneSchema(sourceSchema),
						newSchema: cloneSchema(targetSchema),
						changes: records,
					};
			await this.saveSettings();
			this.rebuildTrees();
			progress?.finish({ processed: records.length, skipped: [] });
			new Notice(
				t(undoing ? "notice.namespaceUndone" : "notice.nsApplied", {
					n: records.length,
					ns: primaryNamespace(targetSchema),
				})
			);
		} finally {
			this.endBulkOperation(operation);
		}
	}

	private async undoPrimaryNamespaceChange() {
		const record = this.settings.lastNamespaceChange;
		if (!record) {
			new Notice(t("notice.noNamespaceChange"));
			return;
		}
		if (JSON.stringify(this.settings.schema) !== JSON.stringify(record.newSchema)) {
			new Notice(t("notice.namespaceUndoStale"));
			return;
		}
		const rows = record.changes.map((change) => ({
			path: change.currentPath,
			beforeTags: [...change.afterTags],
			afterTags: [...change.beforeTags],
		}));
		await this.applyNamespaceMigration(
			record.newSchema,
			record.oldSchema,
			rows,
			true
		);
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
		new BootstrapPreviewModal(
			this.app,
			assign,
			alreadyTagged,
			noTagkey,
			(rows) => void this.applyBootstrap(rows),
			Boolean(
				this.settings.schema.slots.find((slot) => slot.role === "tag")
					?.segmentSeparator
			)
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
		const operation = t("bulk.title.bootstrap");
		if (!this.beginBulkOperation(operation)) return;
		const record: BootstrapRecord[] = [];
		const failed: string[] = [];
		const total = assign.length;
		const progress = new BulkProgressModal(this.app, operation);
		progress.open();
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
			try {
				// Save what we managed to write even if the loop threw — keeps undo intact.
				this.settings.lastBootstrap = record;
				await this.saveSettings();
				progress.finish({ processed: record.length, skipped: failed });
			} finally {
				this.endBulkOperation(operation);
			}
		}
	}

	// --- Separator batch change (v0.0.7) -----------------------------------
	// One-directional, like the tag→filename engine: the SETTING is the source
	// of truth. Changing the separator in settings rewrites every tagged file's
	// boundary separator to match (title-internal symbols preserved), behind a
	// confirm dialog with a dry-run preview and a one-step undo.

	/** Build a staged simple-mode formatting schema without mutating settings. */
	private schemaWithPrimaryFormatting(
		symbol: string,
		spacing: SeparatorSpacing,
		segmentSeparator: SegmentSeparator
	): TrellisSchema {
		const schema = cloneSchema(this.settings.schema);
		if (schema.separators.length === 0) schema.separators.push(symbol);
		else schema.separators[0] = symbol;
		if (!schema.separatorSpacing) schema.separatorSpacing = [];
		schema.separatorSpacing[0] = spacing;
		const slot = schema.slots.find((candidate) => candidate.role === "tag");
		if (slot) slot.segmentSeparator = segmentSeparator;
		return schema;
	}

	/** Dry-run all filename changes produced by a staged schema. */
	private previewSchemaChange(
		newSchema: TrellisSchema
	): { path: string; oldName: string; newName: string }[] {
		const oldSchema = this.settings.schema;
		const out: { path: string; oldName: string; newName: string }[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const tags = getAllTags(cache) ?? [];
			const newName = schemaMigratedName(file.basename, tags, oldSchema, newSchema);
			if (newName !== null) out.push({ path: file.path, oldName: file.basename, newName });
		}
		return out;
	}

	requestPrimaryFormattingChange(
		symbol: string,
		spacing: SeparatorSpacing,
		segmentSeparator: SegmentSeparator,
		onDone: () => void
	) {
		const schema = this.schemaWithPrimaryFormatting(symbol, spacing, segmentSeparator);
		if (separatorConflicts(schema).length > 0) {
			new AlertModal(
				this.app,
				t("modal.badSep.title"),
				t("modal.badSep.conflict")
			).open();
			return;
		}
		this.requestSchemaChange(schema, onDone);
	}

	/** Preview and confirm a schema edit before any setting or filename changes. */
	requestSchemaChange(newSchema: TrellisSchema, onDone: () => void) {
		const oldSchema = this.settings.schema;
		if (JSON.stringify(newSchema) === JSON.stringify(oldSchema)) {
			onDone();
			return;
		}
		const oldNamespaces = tagNamespaces(oldSchema).map((ns) => nsPath(oldSchema, ns));
		const newNamespaces = new Set(
			tagNamespaces(newSchema).map((ns) => nsPath(newSchema, ns))
		);
		const orphaned = oldNamespaces
			.filter((namespace) => !newNamespaces.has(namespace))
			.map((namespace) => ({
				namespace,
				count: this.managedNoteCountForNamespace(namespace),
			}))
			.filter(({ count }) => count > 0);
		if (orphaned.length > 0) {
			new AlertModal(
				this.app,
				t("modal.namespaceBlocked.title"),
				t("modal.namespaceBlocked.desc", {
					items: orphaned
						.map(({ namespace, count }) => `#${namespace} (${count})`)
						.join(", "),
				})
			).open();
			onDone();
			return;
		}
		const rows = this.previewSchemaChange(newSchema);
		if (rows.length === 0) {
			void this.applySchemaChange(newSchema, rows).finally(onDone);
			return;
		}
		const label = (schema: TrellisSchema) => {
			const segment = schema.slots.find((slot) => slot.role === "tag")
				?.segmentSeparator;
			return `${segment || "∅"} / ${JSON.stringify(primarySeparator(schema))}`;
		};
		let applied = false;
		new SeparatorChangeModal(
			this.app,
			label(oldSchema),
			label(newSchema),
			rows,
			() => {
				if (!applied) onDone();
			},
			() => {
				applied = true;
				void this.applySchemaChange(newSchema, rows).finally(onDone);
			}
		).open();
	}

	/** Apply staged names link-safely. Cancel or any failure rolls the completed
	 * portion back and leaves the live schema unchanged. */
	private async applySchemaChange(
		newSchema: TrellisSchema,
		rows: { path: string; oldName: string; newName: string }[]
	) {
		const operation = t("bulk.title.separator");
		if (!this.beginBulkOperation(operation)) return;
		const oldSchema = cloneSchema(this.settings.schema);
		const renames: SeparatorRename[] = [];
		const failedNames: string[] = [];
		const total = rows.length;
		// No files to rename → just flip the setting, no modal needed.
		const progress = total > 0 ? new BulkProgressModal(this.app, operation) : null;
		progress?.open();
		this.separatorMigrationRunning = true;
		let fatal = false;
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
		} catch (error) {
			fatal = true;
			console.error("TRELLIS schema migration failed", error);
			failedNames.push(t("bulk.unexpectedFailure"));
		} finally {
			try {
				if (fatal || progress?.wasCancelled || failedNames.length > 0) {
					const { undone, remaining } = await this.revertSeparatorRenames(renames);
					this.settings.lastSeparatorChange =
						remaining.length > 0
							? {
									oldSchema,
									newSchema: cloneSchema(newSchema),
									renames: remaining,
								}
							: undefined;
					await this.saveSettings();
					this.rebuildTrees();
					progress?.finish({
						processed: undone,
						skipped: failedNames,
						outcome: "rolled-back",
					});
				} else {
					this.settings.schema = cloneSchema(newSchema);
					this.settings.lastSeparatorChange =
						renames.length > 0
							? {
									oldSchema,
									newSchema: cloneSchema(newSchema),
									renames,
								}
							: undefined;
					await this.saveSettings();
					this.rebuildTrees();
					if (progress)
						progress.finish({ processed: renames.length, skipped: failedNames });
					else
						new Notice(
							t("notice.sepChanged", {
								n: renames.length,
								from: primarySeparator(oldSchema),
								to: primarySeparator(newSchema),
							})
						);
				}
			} finally {
				this.separatorMigrationRunning = false;
				this.endBulkOperation(operation);
			}
		}
	}

	/** Rename each recorded file back to its pre-change basename (link-safe).
	 *  Skips a file whose target already exists. Returns how many were restored
	 *  and how many failed, so callers can decide whether to keep the record. */
	private async revertSeparatorRenames(
		renames: SeparatorRename[]
	): Promise<{ undone: number; remaining: SeparatorRename[] }> {
		let undone = 0;
		const remaining: SeparatorRename[] = [];
		for (const r of renames) {
			const file = this.app.vault.getAbstractFileByPath(r.path);
			if (!(file instanceof TFile)) {
				remaining.push(r);
				continue;
			}
			const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
			const newPath = normalizePath(`${dir}${r.oldBasename}.${file.extension}`);
			if (await this.renameGuarded(file, newPath)) undone++;
			else remaining.push(r);
		}
		return { undone, remaining };
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
		const operation = t("cmd.separatorUndo");
		if (!this.beginBulkOperation(operation)) return;
		const oldSchema = rec.oldSchema
			? cloneSchema(rec.oldSchema)
			: (() => {
					const schema = cloneSchema(this.settings.schema);
					if (rec.oldSep !== undefined) schema.separators[0] = rec.oldSep;
					return schema;
				})();
		try {
			this.settings.schema = oldSchema;
			this.separatorMigrationRunning = true;
			const { undone, remaining } = await this.revertSeparatorRenames(rec.renames);
			this.settings.lastSeparatorChange =
				remaining.length > 0 ? { ...rec, renames: remaining } : undefined;
			await this.saveSettings();
			this.rebuildTrees();
			new Notice(t("notice.sepReverted", { n: undone }));
		} finally {
			this.separatorMigrationRunning = false;
			this.endBulkOperation(operation);
		}
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
		const operation = t("dedup.title");
		if (!this.beginBulkOperation(operation)) return;
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
			try {
				this.settings.lastDedup = record;
				await this.saveSettings();
			} finally {
				this.endBulkOperation(operation);
			}
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
		const operation = t("cmd.dedupUndo");
		if (!this.beginBulkOperation(operation)) return;
		let restored = 0;
		const failed: DedupRecord[] = [];
		try {
		for (const r of record) {
			const file = this.app.vault.getAbstractFileByPath(r.path);
			if (!(file instanceof TFile)) {
				failed.push(r);
				continue;
			}
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
		} finally {
			this.endBulkOperation(operation);
		}
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
		const operation = t("cmd.bootstrapUndo");
		if (!this.beginBulkOperation(operation)) return;
		let undone = 0;
		const failed: BootstrapRecord[] = [];
		try {
		for (const r of record) {
			const file = this.app.vault.getAbstractFileByPath(r.path);
			if (!(file instanceof TFile)) {
				failed.push(r);
				continue;
			}
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
		} finally {
			this.endBulkOperation(operation);
		}
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
		const operation = t("bulk.title.root");
		if (!this.beginBulkOperation(operation)) return;
		const oldRoot = (this.settings.schema.rootNamespace ?? "").trim();
		// Whatever undo record exists NOW is valid for the pre-apply state — a
		// cancelled pass rolls the vault back to exactly that state, so the record
		// must be restored (not cleared): dropping it on a cancelled UNDO would
		// lose the only way to retry the undo.
		const prevRec = this.settings.lastRootChange;
		const slotNs = tagNamespaces(this.settings.schema);
		let changed = 0;
		const touchedPaths: string[] = [];
		const failed: string[] = [];
		const files = this.app.vault.getMarkdownFiles();
		const progress = new BulkProgressModal(this.app, operation);
		progress.open();
		try {
			this.settings.schema.rootNamespace = newRoot;
			await this.saveSettings();
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
		} catch (error) {
			failed.push(t("bulk.unexpectedFailure"));
			console.error("TRELLIS root migration failed", error);
		} finally {
			try {
			if (progress.wasCancelled || failed.length > 0) {
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
				this.settings.schema.rootNamespace = oldRoot;
				this.settings.lastRootChange = prevRec;
				await this.saveSettings();
				this.rebuildTrees();
				progress.finish({
					processed: reverted,
					skipped: failed,
					outcome: "rolled-back",
				});
			} else {
				this.settings.lastRootChange = { oldRoot, newRoot };
				await this.saveSettings();
				this.rebuildTrees();
				progress.finish({ processed: changed, skipped: failed });
				new Notice(
					t("notice.rootChanged", { from: oldRoot || "—", to: newRoot || "—", n: changed })
				);
			}
			} finally {
				this.endBulkOperation(operation);
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
