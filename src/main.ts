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
	suggestTagValue,
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
	tagChangeProjectedName,
	isValidTagSegmentForSlot,
	isValidTagSegment,
	isValidTagPath,
	isValidNamespace,
	tagNamespaces,
	separatorConflicts,
	schemaMigratedName,
	extractNameMulti,
	slotTagkeys,
	portableBasenameIssue,
	matchTagKey,
	normalizeSchemaModel,
	tagDefinitionById,
	schemaTagDefinitions,
	legacySchemeFromValueRule,
	valueRuleFromLegacyScheme,
	slotValueRule,
	type TagKeyMatch,
	type TrellisTagDefinition,
	type TagValueRule,
	sameTagPath,
	tagPathInNamespace,
	tagPathRelativeToNamespace,
	tagPathToFilenameKey,
} from "./tagkey";
import {
	TrellisTreeView,
	TRELLIS_TREE_VIEW,
} from "./tree-view";
import { t, setLang } from "./i18n";
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
	FilenameSyncPreviewModal,
	type FilenameSyncPreviewRow,
} from "./modals";

import { TrellisSettingTab } from "./settings-tab";
import { TagInventory } from "./tag-inventory";
import {
	TrellisOperationTracker,
	type TrellisOperationKind,
	type TrellisOperationReport,
	type TrellisOperationStatus,
} from "./operation-state";
import {
	DEFAULT_SETTINGS,
	cloneSchema,
	isPlainObject,
	normalizeLoadedSettings,
	type BootstrapRecord,
	type CascadeRecord,
	type DedupRecord,
	type PropertyTagDisplayMode,
	type SeparatorChangeRecord,
	type SeparatorRename,
	type TrellisSettings,
} from "./settings-model";

type PlainObject = Record<string, unknown>;

interface TrellisFrontmatter extends PlainObject {
	tags?: unknown;
}

function sameStrings(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function hashedTagList(raw: unknown): string[] {
	return normalizeTagList(raw).map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
}

/**
 * TRELLIS — tag-driven tagkey sync.
 *
 * When a note's location tag (e.g. #trel/…) changes, rewrite the filename
 * tagkey slot to match, via the link-safe rename API. One direction only: the
 * tag is the source of truth. A cascade command renames a whole tag subtree.
 * The filename structure (slots + separators) is configurable; the default is
 * a 2-slot [managed tag, free name] layout. Multiple managed-tag slots remain
 * one-way projections from frontmatter; filenames never rewrite tags.
 */

interface SeparatorUndoPlanRow {
	currentPath: string;
	targetPath: string;
}

interface LiveSyncResult {
	status: "noop" | "renamed" | "blocked" | "failed";
	message?: string;
}

type GuardedRenameResult =
	| { status: "renamed"; basename: string }
	| { status: "not-portable"; basename: string; issue: string }
	| { status: "collision"; basename: string }
	| { status: "failed"; basename: string; error: unknown };

interface TrellisOperationStatusView {
	idle: boolean;
	pendingSyncs: number;
	needsAttention: boolean;
	current: TrellisOperationReport | null;
	last: TrellisOperationReport | null;
	attention: TrellisOperationReport | null;
}

interface MutableOperationOutcome {
	status: Exclude<TrellisOperationStatus, "running">;
	processed: number;
	issues: { path?: string; message: string }[];
}

function newOperationOutcome(): MutableOperationOutcome {
	return { status: "completed", processed: 0, issues: [] };
}

function recordUnexpectedFailure(outcome: MutableOperationOutcome, error: unknown) {
	outcome.status = outcome.processed > 0 ? "partial-failed" : "failed";
	outcome.issues.push({ message: String(error) });
}

function operationNeedsAttention(report: TrellisOperationReport): boolean {
	return (
		report.status === "failed" ||
		report.status === "partial-failed" ||
		report.status === "interrupted"
	);
}

export default class TrellisPlugin extends Plugin {
	settings: TrellisSettings = { ...DEFAULT_SETTINGS };

	/** Guarded in-process automation surface. No network, URI, REST, or MCP
	 * endpoint is opened; callers must already hold this plugin instance. */
	readonly automation = Object.freeze({
		describe: () => this.describeAutomationModel(),
		inspectNote: (path: string) => this.inspectNote(path),
		planChange: (request: TrellisChangeRequest) => this.planChange(request),
		applyChange: (plan: TrellisChangePlan) => this.applyChange(plan),
		operationStatus: () => this.operationStatus(),
		awaitIdle: () => this.awaitTrellisIdle(),
		acknowledgeOperation: (id: string) => this.acknowledgeOperation(id),
	});
	private readonly operations = new TrellisOperationTracker();
	private interruptedOperationOnLoad: TrellisOperationReport | null = null;
	/** Coalesce metadata and rename events by path before calculating filenames. */
	private pendingLiveSyncPaths = new Set<string>();
	private liveSyncTimer: number | null = null;
	private idleWaiters: ((status: TrellisOperationStatusView) => void)[] = [];

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
	/** Files already warned about a generated basename that is legal locally but
	 *  unsafe on another supported filesystem (notably Windows). */
	private portabilityWarned = new Set<string>();
	/** Suppress normal filename sync while separator migration owns renames. */
	private separatorMigrationRunning = false;
	/** Paths whose frontmatter + filename are currently owned by a bulk pass. */
	private bulkApplying = new Set<string>();
	/** Managed notes remembered while the active schema has no name-key. This
	 * identifies the direct-edit transition where the final tag-key disappears. */
	private noNameManagedPaths = new Set<string>();

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
	/** High-frequency visual controls (notably the color picker) update live but
	 * coalesce their full data.json write. Settings-tab hide flushes this queue. */
	private readonly scheduleSettingsSave = debounce(
		() => void this.saveSettings(),
		300,
		true
	);
	private readonly schedulePropertyTagDecoration = debounce(
		() => this.decoratePropertyTags(),
		50,
		true
	);
	private readonly propertyTagObservers = new Map<HTMLElement, MutationObserver>();

	async onload() {
		await this.loadSettings();
		this.registerLiveSyncCleanup();
		setLang(this.settings.language);
		if (this.interruptedOperationOnLoad) {
			new Notice(
				t("notice.operationInterrupted", {
					name: this.interruptedOperationOnLoad.label,
				})
			);
		}
		this.refreshNoNameManagedPaths();
		this.addSettingTab(new TrellisSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => this.installPropertyTagDecorator());
		this.registerTreeViewType();
		await this.rehydrateStaleTreeViews();
		this.registerTreeEntryPoints();
		this.registerVaultObservers();
		this.registerBulkCommands();
		this.registerFileMenuEntry();
	}

	private registerLiveSyncCleanup() {
		this.register(() => {
			if (this.liveSyncTimer !== null) window.clearTimeout(this.liveSyncTimer);
			this.liveSyncTimer = null;
			this.pendingLiveSyncPaths.clear();
		});
	}

	private registerTreeViewType() {
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
						getTagColor: (tagPath) => this.tagColor(tagPath),
						onHideBranch: (tagPath) => void this.hideSidebarBranch(tagPath),
						canHideBranch: (tagPath) => {
							const match = matchTagKey(tagPath, this.settings.schema);
							return Boolean(match?.tagDefinitionId && match.keyPath);
						},
						onToggleSort: () => void this.toggleSortDir(),
						onNewChild: (parentTagPath) => this.openNewNoteModal(parentTagPath),
						onNewNote: () => this.newNoteFromActive(),
						onBootstrap: () =>
							new BootstrapSelectModal(
								this.app,
								(paths) => this.bootstrapDryRun(paths),
								(f) => this.locationTagOf(f) !== null
							).open(),
						onCascade: () => this.openCascadeRenameModal(),
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
	}

	private registerTreeEntryPoints() {
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
	}

	private registerVaultObservers() {
		// metadataCache 'changed' fires after a file's tags/frontmatter are
		// parsed — the right moment to read the location tag.
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.queueLiveSync(file.path);
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
				this.portabilityWarned.delete(oldPath);
				if (this.noNameManagedPaths.delete(oldPath) && file instanceof TFile) {
					this.noNameManagedPaths.add(file.path);
				}
				if (file instanceof TFile && file.extension === "md") {
					// Bulk/AI transactions own and record their own final paths. Ordinary
					// user renames (including the live-sync correction they trigger) must
					// carry saved undo records forward to the final file path.
					if (!this.bulkActive && this.automationApplying.size === 0) {
						if (this.updateUndoPaths(oldPath, file.path)) {
							this.scheduleUndoPathSave();
						}
					}
					this.queueLiveSync(file.path);
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
				this.portabilityWarned.delete(file.path);
				this.noNameManagedPaths.delete(file.path);
				this.scheduleTreeRefresh();
			})
		);
	}

	private registerBulkCommands() {
		// Cascade: rename a location tag (and everything under it) across the
		// vault. The tag edits then drive each file's rename through syncFile.
		this.addCommand({
			id: "cascade-rename-tag",
			name: t("cmd.cascade"),
			callback: () => this.openCascadeRenameModal(),
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
	}

	private registerFileMenuEntry() {
		// Right-click a note → cascade-rename one of its managed tag-keys. A note
		// with exactly one managed value is prefilled; with several, the filtered
		// picker stays empty so no key is silently preferred.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				const managed = this.managedTagPathsOf(file);
				if (managed.length === 0) return;
				menu.addItem((item) =>
					item
						.setTitle(t("cmd.cascade"))
						.setIcon("tags")
						.onClick(() =>
							this.openCascadeRenameModal(managed.length === 1 ? managed[0] : "")
						)
				);
			})
		);
	}

	async loadSettings() {
		const normalized = normalizeLoadedSettings(await this.loadData());
		this.settings = normalized.settings;
		this.interruptedOperationOnLoad = normalized.interruptedOperation;
		if (normalized.shouldSave) await this.saveSettings();
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
			if (
				tags.some(
					(tag) => tagPathInNamespace(tag, namespace) && !sameTagPath(tag, namespace)
				)
			) count++;
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
		this.schedulePropertyTagDecoration();
	}

	private installPropertyTagDecorator() {
		this.syncPropertyTagObservers();
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.syncPropertyTagObservers();
				this.schedulePropertyTagDecoration();
			})
		);
		this.register(() => {
			for (const observer of this.propertyTagObservers.values()) observer.disconnect();
			this.propertyTagObservers.clear();
		});
		this.decoratePropertyTags();
	}

	private syncPropertyTagObservers() {
		const containers = new Set(
			this.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view.containerEl)
		);
		for (const [container, observer] of this.propertyTagObservers) {
			if (containers.has(container)) continue;
			observer.disconnect();
			this.propertyTagObservers.delete(container);
		}
		for (const container of containers) {
			if (this.propertyTagObservers.has(container)) continue;
			const observer = new MutationObserver(() => this.schedulePropertyTagDecoration());
			observer.observe(container, { childList: true, subtree: true });
			this.propertyTagObservers.set(container, observer);
		}
	}

	/** Visual-only decoration. The original full path stays as the actual DOM
	 * text and editing value; CSS overlays a shorter label, so clicking/removing
	 * the pill still operates on the unmodified Obsidian tag. */
	decoratePropertyTags() {
		const pills: HTMLElement[] = [];
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const container: HTMLElement = leaf.view.containerEl;
			const matches: NodeListOf<HTMLElement> =
				container.querySelectorAll<HTMLElement>(
					'.metadata-property[data-property-key="tags"] .multi-select-pill'
				);
			matches.forEach((pill: HTMLElement) => pills.push(pill));
		}
		for (const pill of pills) {
			pill.classList.remove("trellis-property-tag-pill");
			pill.style.removeProperty("--trellis-tag-color");
			const content = pill.querySelector<HTMLElement>(".multi-select-pill-content");
			if (!content) continue;
			content.classList.remove("trellis-property-tag-label");
			delete content.dataset.trellisLabel;
			content.removeAttribute("title");

			const raw = content.textContent?.trim() ?? "";
			const match = matchTagKey(raw, this.settings.schema);
			if (!match?.tagDefinitionId) continue;
			const definition = tagDefinitionById(this.settings.schema, match.tagDefinitionId);
			if (!definition) continue;
			pill.classList.add("trellis-property-tag-pill");
			if (definition.color) {
				pill.style.setProperty("--trellis-tag-color", definition.color);
			}
			if (this.settings.propertyTagDisplay === "full") continue;
			const name = definition.name || definition.namespace;
			const terminal = match.keyPath.split("/").filter(Boolean).pop() ?? name;
			const label =
				this.settings.propertyTagDisplay === "name"
					? name
					: this.settings.propertyTagDisplay === "name-terminal"
						? `${name} · ${terminal}`
						: terminal;
			content.dataset.trellisLabel = label;
			content.setAttribute("title", raw);
			content.classList.add("trellis-property-tag-label");
		}
	}

	async setPropertyTagDisplay(mode: PropertyTagDisplayMode) {
		this.settings.propertyTagDisplay = mode;
		await this.saveSettings();
		this.decoratePropertyTags();
	}

	private currentTagInventory(): TagInventory {
		const inventory = new TagInventory(cloneSchema(this.settings.schema));
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			inventory.upsertFile({
				path: file.path,
				allTags: cache ? getAllTags(cache) ?? [] : [],
				frontmatterTags: normalizeTagList(cache?.frontmatter?.tags),
			});
		}
		return inventory;
	}

	/** Pause immediately. Resuming is intentionally two-step whenever current
	 * frontmatter would rename files: inventory → exact preview → guarded batch. */
	async requestFilenameSyncEnabled(enabled: boolean, onChanged?: () => void) {
		if (!enabled) {
			this.settings.filenameSyncEnabled = false;
			await this.saveSettings();
			onChanged?.();
			return;
		}
		if (this.settings.filenameSyncEnabled) return;
		const snapshot = this.currentTagInventory().snapshot();
		if (snapshot.filenameCollisions.length > 0) {
			new AlertModal(
				this.app,
				t("modal.filenameSync.blockedTitle"),
				t("modal.filenameSync.blockedDesc", {
					n: snapshot.filenameCollisions.length,
				})
			).open();
			return;
		}
		if (snapshot.filenameDrift.length === 0) {
			this.settings.filenameSyncEnabled = true;
			await this.saveSettings();
			onChanged?.();
			return;
		}
		new FilenameSyncPreviewModal(this.app, snapshot.filenameDrift, () => {
			void this.applyFilenameSyncPreview(snapshot.filenameDrift, onChanged);
		}).open();
	}

	private async applyFilenameSyncPreview(
		rows: FilenameSyncPreviewRow[],
		onChanged?: () => void
	) {
		const operation = t("bulk.title.filenameSync");
		await this.runBulkOperation(operation, rows.length, async (operationId, outcome) => {
			const renamed: { originalPath: string; currentPath: string }[] = [];
			const failed: string[] = [];
			const progress = new BulkProgressModal(this.app, operation);
			progress.open();
			for (let index = 0; index < rows.length; index++) {
				if (!(await progress.gate())) break;
				const row = rows[index];
				const file = this.app.vault.getAbstractFileByPath(row.path);
				if (!(file instanceof TFile)) {
					failed.push(row.path);
					break;
				}
				const cache = this.app.metadataCache.getFileCache(file);
				const tags = hashedTagList(cache?.frontmatter?.tags);
				const currentTarget = this.syncedPathForTags(file, tags);
				if (currentTarget !== row.targetPath) {
					failed.push(row.path);
					break;
				}
				if (!(await this.renameGuarded(file, row.targetPath))) {
					failed.push(row.path);
					break;
				}
				renamed.push({ originalPath: row.path, currentPath: file.path });
				this.operations.progress(operationId, {
					processed: index + 1,
					currentPath: row.path,
				});
				progress.report(index + 1, rows.length, failed.length);
			}

			if (progress.wasCancelled || failed.length > 0) {
				const rollbackFailed: string[] = [];
				for (const record of [...renamed].reverse()) {
					const file = this.app.vault.getAbstractFileByPath(record.currentPath);
					if (!(file instanceof TFile) || !(await this.renameGuarded(file, record.originalPath))) {
						rollbackFailed.push(record.currentPath);
					}
				}
				progress.finish({
					processed: renamed.length - rollbackFailed.length,
					skipped: [...failed, ...rollbackFailed],
					outcome: "rolled-back",
				});
				outcome.status = rollbackFailed.length > 0 ? "partial-failed" : "rolled-back";
				outcome.processed = renamed.length - rollbackFailed.length;
				outcome.issues = [...failed, ...rollbackFailed].map((path) => ({
					path,
					message: rollbackFailed.includes(path)
						? "Filename rollback failed."
						: "Filename synchronization stopped.",
				}));
				return;
			}

			this.settings.filenameSyncEnabled = true;
			await this.saveSettings();
			this.rebuildTrees();
			progress.finish({ processed: renamed.length, skipped: [] });
			outcome.processed = renamed.length;
			onChanged?.();
		});
	}

	/** Managed tag branches are independent from filename slots in 0.5. */
	tagDefinitions(): TrellisTagDefinition[] {
		return this.settings.schema.tagDefinitions ?? [];
	}

	private nextDefinitionId(namespace: string): string {
		const used = new Set(this.tagDefinitions().map((definition) => definition.id));
		const hint = namespace
			.normalize("NFKD")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "tag";
		let id = `tag-${hint}`;
		let suffix = 2;
		while (used.has(id)) id = `tag-${hint}-${suffix++}`;
		return id;
	}

	async addTagDefinition(namespace: string, name: string): Promise<string | null> {
		const clean = namespace.trim().replace(/^#/, "").replace(/\/$/, "");
		if (!isValidNamespace(clean)) return null;
		if (this.tagDefinitions().some((definition) => sameTagPath(definition.namespace, clean))) {
			return null;
		}
		const definition: TrellisTagDefinition = {
			id: this.nextDefinitionId(clean),
			name: name.trim() || clean,
			namespace: clean,
			sidebarVisible: true,
		};
		if (!this.settings.schema.tagDefinitions) this.settings.schema.tagDefinitions = [];
		this.settings.schema.tagDefinitions.push(definition);
		await this.saveSettings();
		this.rebuildTrees();
		return definition.id;
	}

	async updateTagDefinition(
		id: string,
		changes: Partial<
			Pick<TrellisTagDefinition, "name" | "sidebarVisible" | "archived" | "color">
		> & {
			valueRule?: TagValueRule | null;
		}
	): Promise<void> {
		const definition = this.tagDefinitions().find((candidate) => candidate.id === id);
		if (!definition) return;
		if (changes.name !== undefined) definition.name = changes.name.trim();
		if (changes.archived !== undefined) {
			if (changes.archived) {
				definition.archived = true;
				definition.sidebarVisible = false;
				if (this.settings.treeTagDefinitionId === id) {
					this.settings.treeTagDefinitionId =
						this.tagDefinitions().find(
							(candidate) =>
								candidate.id !== id &&
								candidate.sidebarVisible &&
								!candidate.archived
						)?.id ?? "";
				}
			} else {
				delete definition.archived;
			}
		}
		if (changes.sidebarVisible !== undefined && !definition.archived) {
			definition.sidebarVisible = changes.sidebarVisible;
		}
		if (changes.color !== undefined) {
			if (changes.color) definition.color = changes.color;
			else delete definition.color;
		}
		if (changes.valueRule !== undefined) {
			if (changes.valueRule === null) delete definition.valueRule;
			else definition.valueRule = { ...changes.valueRule };
		}
		await this.saveSettings();
		this.rebuildTrees();
	}

	updateTagDefinitionColor(id: string, color: string): void {
		const definition = this.tagDefinitions().find((candidate) => candidate.id === id);
		if (!definition) return;
		if (color) definition.color = color;
		else delete definition.color;
		this.scheduleSettingsSave();
		this.scheduleTreeRefresh();
		this.schedulePropertyTagDecoration();
	}

	flushQueuedSettingsSave(): void {
		this.scheduleSettingsSave.run();
	}

	async removeTagDefinition(id: string): Promise<boolean> {
		const definition = this.tagDefinitions().find((candidate) => candidate.id === id);
		if (!definition) return false;
		if (
			this.settings.schema.slots.some(
				(slot) => slot.role === "tag" && slot.tagDefinitionId === id
			)
		) return false;
		const full = nsPath(this.settings.schema, definition.namespace);
		if (this.managedNoteCountForNamespace(full) > 0) return false;
		this.settings.schema.tagDefinitions = this.tagDefinitions().filter(
			(candidate) => candidate.id !== id
		);
		await this.saveSettings();
		this.rebuildTrees();
		return true;
	}

	private schemaHasNameKey(): boolean {
		return this.settings.schema.slots.some((slot) => slot.role === "name");
	}

	private hasManagedTagValue(tags: string[]): boolean {
		return tags.some((tag) => {
			const match = matchTagKey(tag, this.settings.schema);
			return match !== null && match.keyPath !== "";
		});
	}

	/** Rebuild the direct-edit baseline after load or a committed schema-shape
	 * change. Cache-missing notes join on their next metadata event. */
	private refreshNoNameManagedPaths() {
		this.noNameManagedPaths.clear();
		if (this.schemaHasNameKey()) return;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache && this.hasManagedTagValue(hashedTagList(cache.frontmatter?.tags))) {
				this.noNameManagedPaths.add(file.path);
			}
		}
	}

	private trackNoNameManagement(file: TFile, tags: string[]) {
		if (this.schemaHasNameKey()) {
			this.noNameManagedPaths.delete(file.path);
			return;
		}
		if (this.hasManagedTagValue(tags)) {
			this.noNameManagedPaths.add(file.path);
			return;
		}
		if (this.noNameManagedPaths.delete(file.path)) {
			new Notice(t("notice.noNameUnmanaged", { name: file.basename }));
		}
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

	/** Only one vault-wide mutation may run at a time. Live sync, automation and
	 * bulk commands share the same owner instead of maintaining parallel locks. */
	private async beginRecordedOperation(
		kind: TrellisOperationKind,
		label: string,
		total: number
	): Promise<TrellisOperationReport | null> {
		const operation = this.operations.begin(kind, label, total);
		if (!operation) return null;
		this.settings.lastOperation = operation;
		try {
			await this.saveSettings();
			return operation;
		} catch (error) {
			console.error("TRELLIS could not record operation start", error);
			this.operations.finish(operation.id, {
				status: "failed",
				issues: [{ message: `Could not record operation start: ${String(error)}` }],
			});
			this.afterWriteOperation();
			return null;
		}
	}

	private async beginBulkOperation(label: string, total = 0): Promise<string | null> {
		const activeBefore = this.operations.current();
		if (activeBefore) {
			new Notice(t("notice.bulkBusy", { active: activeBefore.label }));
			return null;
		}
		const operation = await this.beginRecordedOperation("bulk", label, total);
		if (!operation) {
			new Notice(t("notice.operationRecordFailed"));
			return null;
		}
		return operation.id;
	}

	private async finishRecordedOperation(
		id: string,
		status: Exclude<TrellisOperationStatus, "running"> = "completed",
		processed?: number,
		issues: { path?: string; message: string }[] = []
	) {
		const report = this.operations.finish(id, { status, processed, issues });
		if (report) {
			this.settings.lastOperation = report;
			if (operationNeedsAttention(report)) this.settings.operationAttention = report;
			try {
				await this.saveSettings();
			} catch (error) {
				// Keep the in-memory result. The still-running durable marker is safer
				// than falsely recording completion if settings persistence failed.
				console.error("TRELLIS could not record operation completion", error);
			}
		}
		this.afterWriteOperation();
	}

	private async endBulkOperation(
		id: string,
		outcome: MutableOperationOutcome
	) {
		await this.finishRecordedOperation(
			id,
			outcome.status,
			outcome.processed,
			outcome.issues
		);
	}

	/** Own the durable start/failure/finish lifecycle for one bulk mutation. */
	private async runBulkOperation(
		label: string,
		total: number,
		run: (operationId: string, outcome: MutableOperationOutcome) => Promise<void>
	): Promise<void> {
		const operationId = await this.beginBulkOperation(label, total);
		if (!operationId) return;
		const outcome = newOperationOutcome();
		try {
			await run(operationId, outcome);
		} catch (error) {
			recordUnexpectedFailure(outcome, error);
			throw error;
		} finally {
			await this.endBulkOperation(operationId, outcome);
		}
	}

	private get bulkActive(): boolean {
		return this.operations.current()?.kind === "bulk";
	}

	private operationStatus(): TrellisOperationStatusView {
		const pendingSyncs = this.pendingLiveSyncPaths.size;
		const attention = this.settings.operationAttention ?? null;
		return {
			idle:
				this.operations.isIdle() &&
				pendingSyncs === 0 &&
				this.liveSyncTimer === null,
			pendingSyncs,
			needsAttention: attention !== null,
			current: this.operations.current(),
			last: this.operations.lastReport() ?? this.settings.lastOperation ?? null,
			attention,
		};
	}

	private async acknowledgeOperation(id: string): Promise<boolean> {
		const report = this.settings.operationAttention;
		if (report?.id !== id) return false;
		this.settings.operationAttention = undefined;
		try {
			await this.saveSettings();
			return true;
		} catch (error) {
			this.settings.operationAttention = report;
			console.error("TRELLIS could not acknowledge operation report", error);
			return false;
		}
	}

	private awaitTrellisIdle(): Promise<TrellisOperationStatusView> {
		const status = this.operationStatus();
		if (status.idle) return Promise.resolve(status);
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	private resolveIdleWaiters() {
		const status = this.operationStatus();
		if (!status.idle) return;
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve(status);
	}

	private afterWriteOperation() {
		if (this.pendingLiveSyncPaths.size > 0) this.scheduleLiveSyncDrain(0);
		else this.resolveIdleWaiters();
	}

	private queueLiveSync(path: string) {
		if (!this.settings.filenameSyncEnabled) return;
		this.pendingLiveSyncPaths.add(normalizePath(path));
		this.scheduleLiveSyncDrain(120, true);
	}

	private scheduleLiveSyncDrain(delay: number, restart = false) {
		if (restart && this.liveSyncTimer !== null) {
			window.clearTimeout(this.liveSyncTimer);
			this.liveSyncTimer = null;
		}
		if (this.liveSyncTimer !== null) return;
		this.liveSyncTimer = window.setTimeout(() => {
			this.liveSyncTimer = null;
			void this.drainLiveSyncQueue();
		}, delay);
	}

	private async drainLiveSyncQueue() {
		if (!this.operations.isIdle()) return;
		const paths = [...this.pendingLiveSyncPaths];
		if (paths.length === 0) {
			this.resolveIdleWaiters();
			return;
		}
		this.pendingLiveSyncPaths.clear();
		const operation = this.operations.begin("live-sync", t("operation.liveSync"), paths.length);
		if (!operation) {
			for (const path of paths) this.pendingLiveSyncPaths.add(path);
			return;
		}
		const issues: { path?: string; message: string }[] = [];
		let processed = 0;
		for (const path of paths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && file.extension === "md") {
				try {
					const result = await this.syncFile(file);
					if (result.status === "blocked" || result.status === "failed") {
						issues.push({ path, message: result.message ?? result.status });
					}
				} catch (error) {
					issues.push({ path, message: String(error) });
				}
			}
			processed++;
			this.operations.progress(operation.id, { processed, currentPath: path });
		}
		const report = this.operations.finish(operation.id, {
			status: issues.length > 0 ? "partial-failed" : "completed",
			processed,
			issues,
		});
		if (issues.length > 0 && report) {
			this.settings.lastOperation = report;
			this.settings.operationAttention = report;
			try {
				await this.saveSettings();
			} catch (error) {
				console.error("TRELLIS could not record live-sync failure", error);
			}
		}
		this.afterWriteOperation();
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
	private describeAutomationModel() {
		return {
			settingsVersion: this.settings.settingsVersion,
			filenameSyncEnabled: this.settings.filenameSyncEnabled,
			rootNamespace: this.settings.schema.rootNamespace ?? "",
			tagDefinitions: this.tagDefinitions().map((definition) => ({
				...definition,
				fullNamespace: nsPath(this.settings.schema, definition.namespace),
				valueRule: definition.valueRule ? { ...definition.valueRule } : undefined,
			})),
			filenameSlots: this.settings.schema.slots.map((slot, index) => ({
				index,
				...slot,
				wrapper: slot.wrapper ? { ...slot.wrapper } : undefined,
			})),
			separators: [...this.settings.schema.separators],
			separatorSpacing: [...(this.settings.schema.separatorSpacing ?? [])],
		};
	}

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
			? planNoteChange(state.value, this.settings.schema, {
					...request,
					syncFilename: request.syncFilename ?? this.settings.filenameSyncEnabled,
				})
			: state;
	}

	/** Apply exactly one previously reviewed plan. Re-checks path, basename,
	 * mtime, frontmatter tags and schema before writing. If the rename fails,
	 * frontmatter is restored; if that rollback fails too, the structured error
	 * reports both failures instead of pretending the operation was atomic. */
	async applyChange(
		plan: TrellisChangePlan
	): Promise<AutomationResult<TrellisApplyResult>> {
		const activeBefore = this.operations.current();
		if (activeBefore) {
			return {
				ok: false,
				error: {
					code: "write-in-progress",
					message: "Another Trellis write is already in progress.",
					details: { active: activeBefore.label },
				},
			};
		}
		const operation = await this.beginRecordedOperation(
			"automation",
			t("operation.automation"),
			1
		);
		if (!operation) {
			return {
				ok: false,
				error: {
					code: "operation-record-failed",
					message: "Trellis could not record the operation safely, so nothing was applied.",
				},
			};
		}
		try {
			const result = await this.applyChangeUnlocked(plan);
			await this.finishRecordedOperation(
				operation.id,
				result.ok ? "completed" : "failed",
				result.ok && result.value.status === "applied" ? 1 : 0,
				result.ok
					? []
					: [{ path: plan.expected.path, message: result.error.message }]
			);
			return result;
		} catch (error) {
			await this.finishRecordedOperation(operation.id, "failed", 0, [
				{ path: plan.expected.path, message: String(error) },
			]);
			throw error;
		}
	}

	/** Apply after the global managed-write gate has been acquired. */
	private async applyChangeUnlocked(
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
			if (verifiedPlan.request.allowUnmanaged) {
				this.noNameManagedPaths.delete(verifiedPlan.expected.path);
				this.noNameManagedPaths.delete(verifiedPlan.next.path);
			}
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

	/** Sync one note's managed tags into its filename slots (one direction). */
	private async syncFile(file: TFile): Promise<LiveSyncResult> {
		if (!this.settings.filenameSyncEnabled) return { status: "noop" };
		if (this.separatorMigrationRunning) return { status: "noop" };
		if (this.automationApplying.has(file.path)) return { status: "noop" };
		if (this.bulkApplying.has(file.path)) return { status: "noop" };
		if (this.renaming.has(file.path)) return { status: "noop" }; // own rename echo

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return { status: "noop" };
		const fmTags = hashedTagList(cache.frontmatter?.tags);
		this.trackNoNameManagement(file, fmTags);

		// One note = one location per namespace. Warn once (lightly) if a note
		// carries duplicate location tags; the user resolves them in bulk via the
		// "check duplicate location tags" command. Detection uses frontmatter tags
		// only — that's what the cleanup can actually remove (inline body tags
		// aren't touched). Synchronization stops until the ambiguity is resolved;
		// Trellis never silently chooses one value from a single-valued branch.
		const dupGroups = duplicateLocationGroups(fmTags, this.settings.schema);
		if (dupGroups.length > 0) {
			if (!this.multiWarned.has(file.path)) {
				this.multiWarned.add(file.path);
				const n = dupGroups.reduce((sum, g) => sum + g.tags.length, 0);
				new Notice(t("notice.multiLocation", { name: file.basename, n }));
				console.warn("TRELLIS: duplicate location tags on", file.path, dupGroups);
			}
			return {
				status: "blocked",
				message: "More than one managed tag resolves to the same filename slot.",
			};
		} else {
			this.multiWarned.delete(file.path);
		}

		// Multi-key schema (advanced, experimental): every tag slot resolves from
		// its own namespace; the 2-slot single-key path stays the default.
		let newBasename: string | null;
		if (isMultiKey(this.settings.schema)) {
			newBasename = syncedBasenameMulti(file.basename, fmTags, this.settings.schema);
		} else {
			const tagkey = pickTagkey(fmTags, this.settings.schema);
			if (tagkey === null) return { status: "noop" }; // unmanaged → untouched
			newBasename = syncedBasename(file.basename, tagkey, this.settings.schema);
		}
		if (newBasename === null) {
			// Already in sync — a previously reported collision (if any) is over.
			this.collisionWarned.delete(file.path);
			this.portabilityWarned.delete(file.path);
			return { status: "noop" };
		}
		const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
		const newPath = normalizePath(`${dir}${newBasename}.${file.extension}`);
		const oldPath = file.path;
		const oldBasename = file.basename;
		const renameResult = await this.performGuardedRename(file, newPath);

		if (renameResult.status === "not-portable") {
			if (!this.portabilityWarned.has(oldPath)) {
				this.portabilityWarned.add(oldPath);
				if (!this.bulkActive) {
					new Notice(t("notice.filenameNotPortable", { name: newBasename }));
				}
				console.warn(
					"TRELLIS: cross-platform filename guard, skipping",
					oldPath,
					"→",
					newBasename,
					renameResult.issue
				);
			}
			return {
				status: "blocked",
				message: `The projected filename is not portable: ${renameResult.issue}`,
			};
		}
		this.portabilityWarned.delete(oldPath);

		// Collision guard: never rename onto an existing DIFFERENT file — that
		// would clobber the target (or throw). Warn once and leave both files
		// alone; the user resolves the name clash by hand. Its own warned-set:
		// keyed per file until the clash resolves, and suppressed during bulk
		// passes like every other per-file notice.
		if (renameResult.status === "collision") {
			if (!this.collisionWarned.has(oldPath)) {
				this.collisionWarned.add(oldPath);
				if (!this.bulkActive) {
					new Notice(t("notice.renameCollision", { name: file.basename, target: newBasename }));
				}
				console.warn("TRELLIS: rename collision, skipping", oldPath, "→", newPath);
			}
			return {
				status: "blocked",
				message: `The target path already exists: ${newPath}`,
			};
		}
		this.collisionWarned.delete(oldPath);

		if (renameResult.status === "renamed") {
			if (!this.bulkActive) {
				new Notice(t("notice.renamed", { from: oldBasename, to: newBasename }));
			}
			return { status: "renamed" };
		}

		console.error("TRELLIS rename failed", renameResult.error);
		new Notice(t("notice.renameFailed", { name: file.basename }));
		return { status: "failed", message: String(renameResult.error) };
	}

	/** Collect every note's location tag into the sidebar note-tree, sorted.
	 *  Cached; data/sort changes invalidate via scheduleTreeRefresh/rebuildTrees. */
	private sortedNoteTree(): NoteTreeNode[] {
		if (this.treeCache) return this.treeCache;
		const entries: { tagPath: string; notePath: string }[] = [];
		const full = nsPath(this.settings.schema, this.treeTagKeyNamespace());
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const tag = hashedTagList(cache.frontmatter?.tags).find((candidate) => {
				const match = matchTagKey(candidate, this.settings.schema);
				return match !== null && sameTagPath(match.fullNamespace, full);
			});
			if (!tag) continue;
			const tagPath = tag.replace(/^#/, "");
			const match = matchTagKey(tagPath, this.settings.schema);
			if (
				match?.tagDefinitionId &&
				this.isSidebarBranchHidden(match.tagDefinitionId, match.keyPath)
			) continue;
			entries.push({ tagPath, notePath: file.path });
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
		const visibleDefinitions = new Set(
			this.tagDefinitions()
				.filter((definition) => definition.sidebarVisible)
				.map((definition) => definition.id)
		);
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const tags = cache ? hashedTagList(cache.frontmatter?.tags) : [];
			const allManaged: TagKeyMatch[] = [];
			for (const tag of tags) {
				const match = matchTagKey(tag, this.settings.schema);
				if (match) allManaged.push(match);
			}
			const managed = new Set<string>();
			for (const match of allManaged) {
				const id = match.tagDefinitionId;
				if (!id || !visibleDefinitions.has(id)) continue;
				if (this.isSidebarBranchHidden(id, match.keyPath)) continue;
				managed.add(`#${match.tagPath}`);
			}
			if (allManaged.length === 0) {
				untagged.push(file.path);
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

	private isSidebarBranchHidden(tagDefinitionId: string, relativePath: string): boolean {
		return this.settings.hiddenTagBranches.some(
			(branch) =>
				branch.tagDefinitionId === tagDefinitionId &&
				(relativePath === branch.relativePath ||
					relativePath.startsWith(`${branch.relativePath}/`))
		);
	}

	async hideSidebarBranch(tagPath: string) {
		const match = matchTagKey(tagPath, this.settings.schema);
		if (!match?.tagDefinitionId || !match.keyPath) return;
		if (!this.isSidebarBranchHidden(match.tagDefinitionId, match.keyPath)) {
			this.settings.hiddenTagBranches.push({
				tagDefinitionId: match.tagDefinitionId,
				relativePath: match.keyPath,
			});
			await this.saveSettings();
		}
		this.rebuildTrees();
	}

	async restoreSidebarBranch(tagDefinitionId: string, relativePath: string) {
		this.settings.hiddenTagBranches = this.settings.hiddenTagBranches.filter(
			(branch) =>
				branch.tagDefinitionId !== tagDefinitionId || branch.relativePath !== relativePath
		);
		await this.saveSettings();
		this.rebuildTrees();
	}

	hiddenSidebarBranches(): { tagDefinitionId: string; label: string; relativePath: string }[] {
		const visible: { tagDefinitionId: string; label: string; relativePath: string }[] = [];
		for (const branch of this.settings.hiddenTagBranches) {
			const definition = tagDefinitionById(this.settings.schema, branch.tagDefinitionId);
			if (!definition) continue;
			visible.push({
				tagDefinitionId: branch.tagDefinitionId,
				relativePath: branch.relativePath,
				label: `#${nsPath(this.settings.schema, definition.namespace)}/${branch.relativePath}`,
			});
		}
		return visible;
	}

	tagColor(tagPath: string): string | undefined {
		const match = matchTagKey(tagPath, this.settings.schema);
		return match?.tagDefinitionId
			? tagDefinitionById(this.settings.schema, match.tagDefinitionId)?.color
			: undefined;
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
		const tag = active ? this.treeTagOf(active) : null;
		if (!tag) {
			this.openNewNoteModal("");
			return;
		}
		const parent =
			this.childSegmentsOf(tag).length > 0 ? tag : parentTagPath(tag);
		this.openNewNoteModal(parent);
	}

	/** Direct-child segments already in use under a parent tag path. The
	 * registered tag definition is derived from the parent itself, including
	 * definitions that are shown in the sidebar but not projected to filenames. */
	private childSegmentsOf(parentTagPath: string): string[] {
		const parentMatch = matchTagKey(parentTagPath, this.settings.schema);
		if (!parentMatch?.tagDefinitionId) return [];
		const segs = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			for (const tag of hashedTagList(cache.frontmatter?.tags)) {
				const match = matchTagKey(tag, this.settings.schema);
				if (match?.tagDefinitionId !== parentMatch.tagDefinitionId) continue;
				const rest = tagPathRelativeToNamespace(match.tagPath, parentTagPath);
				if (rest && !rest.includes("/")) segs.add(rest);
			}
		}
		return [...segs];
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
		const match = matchTagKey(tagPath, schema);
		const idx = match?.slotIndex ?? -1;
		const slot = idx >= 0 ? schema.slots[idx] : null;
		if (!match?.tagDefinitionId) {
			new Notice(t("notice.noTagkey"));
			return;
		}
		if (
			(slot && !isValidTagSegmentForSlot(segment, slot)) ||
			(!slot && !isValidTagSegment(segment))
		) {
			new Notice(t("notice.segmentBadChar"));
			return;
		}
		if (this.childSegmentsOf(parentTagPath).includes(segment)) {
			new Notice(t("notice.tagValueExists", { value: segment }));
			return;
		}
		const tagkey = slot ? tagPathToFilenameKey(match.keyPath, slot) : "";
		const safeTitle = title.trim().replace(/[\\/:*?"<>|]/g, "");
		const values = schema.slots.map((s, i) =>
			i === idx ? tagkey : s.role === "name" ? safeTitle : null
		);
		const base = assembleBasenameMulti(values, schema) || safeTitle || segment;
		if (portableBasenameIssue(base)) {
			new Notice(t("notice.filenameNotPortable", { name: base }));
			return;
		}

		const path = normalizePath(`${base}.md`);
		if (this.app.vault.getAbstractFileByPath(path)) {
			new Notice(t("notice.exists", { base }));
			return;
		}
		const body = `# ${safeTitle || tagkey || segment}\n`;
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

	/** The note's primary tag-key value (root-aware), without the '#'. Kept for
	 * primary-only reverse import; the classic tree uses treeTagOf instead.
	 *  Matches the exact namespace-level tag too — a note tagged exactly
	 *  #trellis/tree IS managed (it shows in the tree), so bootstrap must not
	 *  offer to re-tag it. */
	private locationTagOf(file: TFile): string | null {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return null;
		const full = primaryNsPath(this.settings.schema);
		if (!full) return null;
		const tag = hashedTagList(cache.frontmatter?.tags).find((candidate) => {
			const match = matchTagKey(candidate, this.settings.schema);
			return match !== null && sameTagPath(match.fullNamespace, full);
		});
		return tag ? tag.replace(/^#/, "") : null;
	}

	/** Currently selected managed tag for the classic notes-only tree. The
	 * persisted identity is its stable definition ID, so namespace renames do
	 * not silently switch the selected branch. */
	private treeTagDefinition(): TrellisTagDefinition | undefined {
		return (
			this.tagDefinitions().find(
				(definition) =>
					definition.id === this.settings.treeTagDefinitionId &&
					definition.sidebarVisible &&
					!definition.archived
			) ??
			this.tagDefinitions().find(
				(definition) => definition.sidebarVisible && !definition.archived
			)
		);
	}

	treeTagDefinitionId(): string {
		return this.treeTagDefinition()?.id ?? "";
	}

	private treeTagKeyNamespace(): string {
		return this.treeTagDefinition()?.namespace ?? primaryNamespace(this.settings.schema);
	}

	async setTreeTagDefinitionId(id: string) {
		if (
			!this.tagDefinitions().some(
				(definition) =>
					definition.id === id && definition.sidebarVisible && !definition.archived
			)
		) {
			return;
		}
		this.settings.treeTagDefinitionId = id;
		await this.saveSettings();
		this.rebuildTrees();
	}

	private treeTagOf(file: TFile): string | null {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return null;
		const full = nsPath(this.settings.schema, this.treeTagKeyNamespace());
		const tag = hashedTagList(cache.frontmatter?.tags).find((candidate) => {
			const match = matchTagKey(candidate, this.settings.schema);
			return match !== null && sameTagPath(match.fullNamespace, full);
		});
		return tag ? tag.replace(/^#/, "") : null;
	}

	/** Every filename-bearing managed tag on one note, across all tag-keys. */
	private managedTagPathsOf(file: TFile): string[] {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return [];
		const paths = new Set<string>();
		for (const tag of hashedTagList(cache.frontmatter?.tags)) {
			const match = matchTagKey(tag, this.settings.schema);
			if (match && match.keyPath !== "") paths.add(match.tagPath);
		}
		return [...paths];
	}

	private isManagedTagValue(tagPath: string): boolean {
		const match = matchTagKey(tagPath, this.settings.schema);
		return match !== null && match.keyPath !== "";
	}

	private openCascadeRenameModal(initialFrom = "") {
		new CascadeRenameModal(
			this.app,
			(from, to) => this.requestCascadeRename(from, to),
			initialFrom,
			(tagPath) => this.isManagedTagValue(tagPath)
		).open();
	}

	/** Exact frontmatter changes a managed cascade would make. Scope validation
	 * happens before this scan; it is not a generic vault-wide tag replacement. */
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
		const fromKey = matchTagKey(from, this.settings.schema);
		const toKey = matchTagKey(to, this.settings.schema);
		if (!fromKey || !toKey || fromKey.keyPath === "" || toKey.keyPath === "") {
			const namespaces = this.tagDefinitions()
				.map((definition) => nsPath(this.settings.schema, definition.namespace))
				.join(", ");
			new Notice(t("notice.cascadeOutside", { ns: namespaces || "—" }));
			return;
		}
		const rows = this.previewCascade(from, to);
		if (rows.length === 0) {
			new Notice(t("notice.noFilesTagged", { from }));
			return;
		}
		const conflicts = this.cascadePreviewConflicts(rows);
		if (conflicts.length > 0) {
			new AlertModal(
				this.app,
				t("modal.cascadeConflict.title"),
				t("modal.cascadeConflict.desc", {
					n: conflicts.length,
					items: conflicts.slice(0, 5).join(", "),
				})
			).open();
			return;
		}
		new CascadePreviewModal(this.app, from, to, rows, () => {
			void this.applyCascade(from, to, rows);
		}).open();
	}

	/** Conservative preflight for both same-definition moves and cross-definition
	 * branch transfers (split/merge). Ambiguous post-tags or an occupied target
	 * path are blocked before the review modal. */
	private cascadePreviewConflicts(rows: CascadePreviewRow[]): string[] {
		const conflicts = new Set<string>();
		const targetSources = new Map<string, string>();
		for (const row of rows) {
			const tags = row.afterTags.map((tag) => `#${tag}`);
			if (duplicateLocationGroups(tags, this.settings.schema).length > 0) {
				conflicts.add(row.path);
				continue;
			}
			if (!this.settings.filenameSyncEnabled) continue;
			const file = this.app.vault.getAbstractFileByPath(row.path);
			if (!(file instanceof TFile)) {
				conflicts.add(row.path);
				continue;
			}
			const targetPath = this.projectedPathForTagChange(
				file,
				row.beforeTags,
				row.afterTags
			);
			if (!targetPath || targetPath === row.path) continue;
			const firstSource = targetSources.get(targetPath);
			if (firstSource && firstSource !== row.path) {
				conflicts.add(targetPath);
			} else {
				targetSources.set(targetPath, row.path);
			}
			const occupied = this.app.vault.getAbstractFileByPath(targetPath);
			if (occupied && occupied !== file) conflicts.add(targetPath);
		}
		return [...conflicts].sort();
	}

	private projectedPathForTagChange(
		file: TFile,
		beforeTags: string[],
		afterTags: string[]
	): string | null {
		const basename = tagChangeProjectedName(
			file.basename,
			beforeTags.map((tag) => `#${tag}`),
			afterTags.map((tag) => `#${tag}`),
			this.settings.schema
		);
		if (!basename) return null;
		const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
		return normalizePath(`${dir}${basename}.${file.extension}`);
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
		await this.runBulkOperation(operation, rows.length, async (operationId, outcome) => {
			const previousUndo = this.settings.lastCascade;
			const records: CascadeRecord[] = [];
			const failed: string[] = [];
			const progress = new BulkProgressModal(this.app, operation);
			progress.open();
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
					const nextPath = this.settings.filenameSyncEnabled
						? this.projectedPathForTagChange(
								abstract,
								row.beforeTags,
								row.afterTags
							)
						: null;
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
				this.operations.progress(operationId, {
					processed: i + 1,
					currentPath: row.path,
				});
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
				outcome.status = remaining.length > 0 ? "partial-failed" : "rolled-back";
				outcome.processed = restored;
				outcome.issues = [
					...failed.map((path) => ({ path, message: "Tag move stopped." })),
					...remaining.map((record) => ({
						path: record.currentPath,
						message: "Tag move rollback is incomplete.",
					})),
				];
				return;
			}

			this.settings.lastCascade = records;
			await this.saveSettings();
			this.rebuildTrees();
			progress.finish({ processed: records.length, skipped: [] });
			outcome.processed = records.length;
			new Notice(t("notice.retagged", { n: records.length, from, to }));
		});
	}

	private async undoCascade() {
		const records = this.settings.lastCascade ?? [];
		if (records.length === 0) {
			new Notice(t("notice.noCascade"));
			return;
		}
		const operation = t("bulk.title.cascadeUndo");
		await this.runBulkOperation(operation, records.length, async (_operationId, outcome) => {
			const { restored, remaining } = await this.revertCascadeRecords(records);
			this.settings.lastCascade = remaining.length > 0 ? remaining : undefined;
			await this.saveSettings();
			this.rebuildTrees();
			new Notice(t("notice.cascadeUndone", { n: restored }));
			outcome.processed = restored;
			if (remaining.length > 0) {
				outcome.status = "partial-failed";
				outcome.issues = remaining.map((record) => ({
					path: record.currentPath,
					message: "Tag move undo is incomplete.",
				}));
			}
		});
	}

	/** Rename the simple-mode namespace together with every managed frontmatter
	 * tag. A setting-only flip would make the existing tags invisible to TRELLIS. */
	requestPrimaryNamespaceChange(newNamespace: string, onDone: () => void) {
		const primary = this.settings.schema.slots.find((slot) => slot.role === "tag");
		if (!primary?.tagDefinitionId) {
			onDone();
			return;
		}
		this.requestTagDefinitionNamespaceChange(
			primary.tagDefinitionId,
			newNamespace,
			onDone
		);
	}

	/** Rename any managed tag branch while preserving its stable definition ID. */
	requestTagDefinitionNamespaceChange(
		definitionId: string,
		newNamespace: string,
		onDone: () => void
	) {
		if (!isValidNamespace(newNamespace)) {
			new Notice(t("notice.nsBadChar"));
			onDone();
			return;
		}
		const oldSchema = cloneSchema(this.settings.schema);
		const oldDefinition = tagDefinitionById(oldSchema, definitionId);
		if (!oldDefinition || newNamespace === oldDefinition.namespace) {
			onDone();
			return;
		}
		if (
			schemaTagDefinitions(oldSchema).some(
				(definition) =>
					definition.id !== definitionId &&
					sameTagPath(definition.namespace, newNamespace)
			)
		) {
			new Notice(t("notice.advNsDup"));
			onDone();
			return;
		}
		const newSchema = cloneSchema(oldSchema);
		const newDefinition = tagDefinitionById(newSchema, definitionId);
		if (!newDefinition) {
			onDone();
			return;
		}
		newDefinition.namespace = newNamespace;
		const to = nsPath(newSchema, newNamespace);
		const oldPath = nsPath(oldSchema, oldDefinition.namespace);
		const rows = this.previewCascade(oldPath, to);
		if (rows.length === 0) {
			void this.applyNamespaceMigration(oldSchema, newSchema, rows, false).finally(
				onDone
			);
			return;
		}
		new CascadePreviewModal(this.app, oldPath, to, rows, () => {
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
		await this.runBulkOperation(operation, rows.length, async (operationId, outcome) => {
			const previousUndo = this.settings.lastNamespaceChange;
			const records: CascadeRecord[] = [];
			const failed: string[] = [];
			const progress =
				rows.length > 0 ? new BulkProgressModal(this.app, operation) : null;
			progress?.open();
			this.settings.schema = normalizeSchemaModel(cloneSchema(targetSchema));
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
				this.operations.progress(operationId, {
					processed: i + 1,
					currentPath: row.path,
				});
			}

			if (progress?.wasCancelled || failed.length > 0) {
				const { restored, remaining } = await this.revertCascadeRecords(records);
				this.settings.schema = normalizeSchemaModel(cloneSchema(sourceSchema));
				this.settings.lastNamespaceChange = previousUndo;
				await this.saveSettings();
				this.rebuildTrees();
				progress?.finish({
					processed: restored,
					skipped: [...failed, ...remaining.map((record) => record.currentPath)],
					outcome: "rolled-back",
				});
				outcome.status = remaining.length > 0 ? "partial-failed" : "rolled-back";
				outcome.processed = restored;
				outcome.issues = [
					...failed.map((path) => ({ path, message: "Namespace change stopped." })),
					...remaining.map((record) => ({
						path: record.currentPath,
						message: "Namespace rollback is incomplete.",
					})),
				];
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
			outcome.processed = records.length;
			new Notice(
				t(undoing ? "notice.namespaceUndone" : "notice.nsApplied", {
					n: records.length,
					ns: primaryNamespace(targetSchema),
				})
			);
		});
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
		await this.runBulkOperation(operation, assign.length, async (operationId, outcome) => {
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
							await this.app.fileManager.processFrontMatter(
								file,
								(fm: TrellisFrontmatter) => {
									const before =
										typeof fm.tags === "string"
											? fm.tags.split(/[,\s]+/).filter(Boolean)
											: Array.isArray(fm.tags)
												? fm.tags.filter(
														(t): t is string => typeof t === "string"
													)
												: [];
									const tags = normalizeTagList(fm.tags);
									const added = !tags.includes(r.tag);
									if (added) tags.push(r.tag);
									const changed =
										tags.length !== before.length ||
										tags.some((tag, index) => tag !== before[index]);
									if (changed) fm.tags = tags;
									if (added) record.push({ path: r.path, tag: r.tag });
								}
							);
						} catch (e) {
							failed.push(r.path);
							console.error(
								"TRELLIS bootstrap skipped (frontmatter error)",
								r.path,
								e
							);
						}
					}
					progress.report(i + 1, total, failed.length);
					this.operations.progress(operationId, {
						processed: i + 1,
						currentPath: r.path,
					});
				}
			} finally {
				// Save what we managed to write even if the loop threw — keeps undo intact.
				this.settings.lastBootstrap = record;
				outcome.processed = record.length;
				if (progress.wasCancelled) outcome.status = "cancelled";
				else if (failed.length > 0) outcome.status = "partial-failed";
				outcome.issues.push(
					...failed.map((path) => ({ path, message: "Bootstrap skipped this note." }))
				);
				await this.saveSettings();
				progress.finish({ processed: record.length, skipped: failed });
			}
		});
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
			const tags = hashedTagList(cache.frontmatter?.tags);
			const newName = schemaMigratedName(file.basename, tags, oldSchema, newSchema);
			if (newName !== null) out.push({ path: file.path, oldName: file.basename, newName });
		}
		return out;
	}

	/** Managed filenames whose non-empty free name would be discarded by a
	 * schema that removes the name-key. This powers an explicit danger warning;
	 * the exact old → new filename list remains the final source of truth. */
	private nameKeyLossCount(newSchema: TrellisSchema): number {
		const oldSchema = this.settings.schema;
		if (
			!oldSchema.slots.some((slot) => slot.role === "name") ||
			newSchema.slots.some((slot) => slot.role === "name")
		) {
			return 0;
		}
		let count = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const tags = hashedTagList(cache.frontmatter?.tags);
			const oldKeys = slotTagkeys(tags, oldSchema);
			if (!oldKeys.some(Boolean)) continue;
			if (extractNameMulti(file.basename, oldKeys, oldSchema) !== "") count++;
		}
		return count;
	}

	/** Prospective exact-path collisions under a staged schema. Only groups that
	 * include a file this schema edit would rename block the apply; unrelated
	 * pre-existing drift remains visible in the live settings inventory. */
	private schemaFilenameCollisions(
		rows: { path: string; newName: string }[]
	): { targetPath: string; notePaths: string[] }[] {
		const sources = new Map<string, Set<string>>();
		for (const row of rows) {
			const file = this.app.vault.getAbstractFileByPath(row.path);
			if (!(file instanceof TFile)) continue;
			const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
			const targetPath = normalizePath(`${dir}${row.newName}.${file.extension}`);
			const group = sources.get(targetPath) ?? new Set<string>();
			group.add(row.path);
			const occupied = this.app.vault.getAbstractFileByPath(targetPath);
			if (occupied && occupied !== file) group.add(targetPath);
			sources.set(targetPath, group);
		}
		return [...sources.entries()]
			.filter(([, paths]) => paths.size > 1)
			.map(([targetPath, paths]) => ({
				targetPath,
				notePaths: [...paths].sort(),
			}));
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
		// Definitions outlive filename slots. Removing a projection never orphans
		// its tags; with live sync on we clean the projected filename portion after
		// an exact preview, while paused mode keeps current filenames verbatim.
		const rows = this.settings.filenameSyncEnabled
			? this.previewSchemaChange(newSchema)
			: [];
		const collisions = this.schemaFilenameCollisions(rows);
		if (collisions.length > 0) {
			new AlertModal(
				this.app,
				t("modal.schemaCollision.title"),
				t("modal.schemaCollision.desc", {
					n: collisions.length,
					items: collisions
						.slice(0, 5)
						.map((group) => group.targetPath)
						.join(", "),
				})
			).open();
			onDone();
			return;
		}
		const lostNames = this.nameKeyLossCount(newSchema);
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
			},
			lostNames > 0 ? t("modal.schemaNameLoss", { n: lostNames }) : undefined
		).open();
	}

	/** Apply staged names link-safely. Cancel or any failure rolls the completed
	 * portion back and leaves the live schema unchanged. */
	private async applySchemaChange(
		newSchema: TrellisSchema,
		rows: { path: string; oldName: string; newName: string }[]
	) {
		const operation = t("bulk.title.separator");
		await this.runBulkOperation(operation, rows.length, async (operationId, outcome) => {
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
						const dir =
							file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
						const newPath = normalizePath(`${dir}${r.newName}.${file.extension}`);
						if (await this.renameGuarded(file, newPath)) {
							renames.push({ path: newPath, oldBasename: r.oldName });
						} else {
							failedNames.push(r.oldName);
						}
					}
					progress?.report(i + 1, total, failedNames.length);
					this.operations.progress(operationId, {
						processed: i + 1,
						currentPath: r.path,
					});
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
						this.refreshNoNameManagedPaths();
						this.rebuildTrees();
						progress?.finish({
							processed: undone,
							skipped: failedNames,
							outcome: "rolled-back",
						});
						outcome.status =
							remaining.length > 0 ? "partial-failed" : "rolled-back";
						outcome.processed = undone;
						outcome.issues = [
							...failedNames.map((message) => ({ message })),
							...remaining.map((record) => ({
								path: record.path,
								message: "Filename rollback is incomplete.",
							})),
						];
					} else {
						this.settings.schema = normalizeSchemaModel(cloneSchema(newSchema));
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
						if (progress) {
							progress.finish({ processed: renames.length, skipped: failedNames });
						} else {
							new Notice(
								t("notice.sepChanged", {
									n: renames.length,
									from: primarySeparator(oldSchema),
									to: primarySeparator(newSchema),
								})
							);
						}
						outcome.processed = renames.length;
					}
				} finally {
					this.separatorMigrationRunning = false;
				}
			}
		});
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

	/** Resolve an undo completely before changing either filenames or settings.
	 * Legacy scalar-only journals cannot prove which full slot schema produced
	 * their filenames, so they are deliberately rejected instead of guessing. */
	private separatorUndoPlan(
		rec: SeparatorChangeRecord
	): { oldSchema: TrellisSchema; rows: SeparatorUndoPlanRow[] } | null {
		if (!rec.oldSchema || !rec.newSchema) return null;

		const oldSchema = normalizeSchemaModel(cloneSchema(rec.oldSchema));
		const newSchema = normalizeSchemaModel(cloneSchema(rec.newSchema));
		const currentSchema = normalizeSchemaModel(cloneSchema(this.settings.schema));
		const currentJson = JSON.stringify(currentSchema);
		// A failed forward migration can leave the old schema active with a small
		// set of filenames still at their new paths. Both recorded endpoints are
		// safe; any third schema means the journal is stale.
		if (
			currentJson !== JSON.stringify(oldSchema) &&
			currentJson !== JSON.stringify(newSchema)
		) return null;

		const seenCurrent = new Set<string>();
		const seenTargets = new Set<string>();
		const rows: SeparatorUndoPlanRow[] = [];
		for (const rename of rec.renames) {
			const file = this.app.vault.getAbstractFileByPath(rename.path);
			if (!(file instanceof TFile) || seenCurrent.has(file.path)) return null;
			const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
			const targetPath = normalizePath(`${dir}${rename.oldBasename}.${file.extension}`);
			if (seenTargets.has(targetPath)) return null;
			const occupied = this.app.vault.getAbstractFileByPath(targetPath);
			if (occupied && occupied !== file) return null;
			seenCurrent.add(file.path);
			seenTargets.add(targetPath);
			rows.push({ currentPath: file.path, targetPath });
		}
		return { oldSchema, rows };
	}

	/** Undo the last separator change: restore the setting AND each filename.
	 *  The operation is preflighted and transactional: the schema changes only
	 *  after every rename succeeds; cancel/failure rolls completed rows forward. */
	private async undoSeparatorChange() {
		const rec = this.settings.lastSeparatorChange;
		if (!rec || rec.renames.length === 0) {
			new Notice(t("notice.noSepChange"));
			return;
		}
		const plan = this.separatorUndoPlan(rec);
		if (!plan) {
			new Notice(t("notice.sepUndoStale"));
			return;
		}
		const operation = t("cmd.sepUndo");
		await this.runBulkOperation(operation, plan.rows.length, async (operationId, outcome) => {
			const progress = new BulkProgressModal(this.app, operation);
			progress.open();
			const completed: SeparatorUndoPlanRow[] = [];
			const failed: string[] = [];
			try {
				this.separatorMigrationRunning = true;
				for (let i = 0; i < plan.rows.length; i++) {
					if (!(await progress.gate())) break;
					const row = plan.rows[i];
					const file = this.app.vault.getAbstractFileByPath(row.currentPath);
					if (
						!(file instanceof TFile) ||
						!(await this.renameGuarded(file, row.targetPath))
					) {
						failed.push(row.currentPath);
						break;
					}
					completed.push(row);
					this.operations.progress(operationId, {
						processed: i + 1,
						currentPath: row.currentPath,
					});
					progress.report(i + 1, plan.rows.length, failed.length);
				}

				if (progress.wasCancelled || failed.length > 0) {
					const rollbackFailed: string[] = [];
					for (const row of [...completed].reverse()) {
						const file = this.app.vault.getAbstractFileByPath(row.targetPath);
						if (
							!(file instanceof TFile) ||
							!(await this.renameGuarded(file, row.currentPath))
						) {
							rollbackFailed.push(row.targetPath);
						}
					}
					progress.finish({
						processed: completed.length - rollbackFailed.length,
						skipped: [...failed, ...rollbackFailed],
						outcome: "rolled-back",
					});
					outcome.status =
						rollbackFailed.length > 0 ? "partial-failed" : "rolled-back";
					outcome.processed = completed.length - rollbackFailed.length;
					outcome.issues = [
						...failed.map((path) => ({ path, message: "Separator undo stopped." })),
						...rollbackFailed.map((path) => ({
							path,
							message: "Separator undo rollback is incomplete.",
						})),
					];
					return;
				}

				this.settings.schema = plan.oldSchema;
				this.settings.lastSeparatorChange = undefined;
				await this.saveSettings();
				this.refreshNoNameManagedPaths();
				this.rebuildTrees();
				progress.finish({ processed: completed.length, skipped: [] });
				outcome.processed = completed.length;
				new Notice(t("notice.sepReverted", { n: completed.length }));
			} finally {
				this.separatorMigrationRunning = false;
			}
		});
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
		await this.runBulkOperation(operation, decisions.length, async (operationId, outcome) => {
			const record: DedupRecord[] = [];
			const failed: string[] = [];
			// Save the record in `finally` so an interrupted pass (e.g. a broken YAML
			// file mid-loop) still leaves everything removed so far undoable, and
			// isolate per-file errors so one bad file can't abort the whole cleanup.
			try {
				for (let index = 0; index < decisions.length; index++) {
					const d = decisions[index];
					const file = this.app.vault.getAbstractFileByPath(d.path);
					if (!(file instanceof TFile)) {
						failed.push(d.path);
						continue;
					}
					const removed: string[] = [];
					try {
						await this.app.fileManager.processFrontMatter(
							file,
							(fm: TrellisFrontmatter) => {
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
							}
						);
					} catch (e) {
						console.error("TRELLIS dedup skipped (frontmatter error)", d.path, e);
						failed.push(d.path);
						continue;
					}
					if (removed.length) {
						record.push({ path: d.path, removed });
						this.multiWarned.delete(d.path);
					}
					this.operations.progress(operationId, {
						processed: index + 1,
						currentPath: d.path,
					});
				}
			} finally {
				this.settings.lastDedup = record;
				outcome.processed = decisions.length - failed.length;
				if (failed.length > 0) outcome.status = "partial-failed";
				outcome.issues = failed.map((path) => ({
					path,
					message: "Duplicate-tag cleanup skipped this note.",
				}));
				await this.saveSettings();
			}
			new Notice(
				record.length > 0
					? t("notice.deduped", { n: record.length })
					: t("notice.noDuplicates")
			);
		});
	}

	/** Undo the last dedup: add the removed location tags back to each file. */
	private async undoDedup() {
		const record = this.settings.lastDedup ?? [];
		if (record.length === 0) {
			new Notice(t("notice.noDedup"));
			return;
		}
		const operation = t("cmd.dedupUndo");
		await this.runBulkOperation(operation, record.length, async (_operationId, outcome) => {
			let restored = 0;
			const failed: DedupRecord[] = [];
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
			outcome.processed = restored;
			if (failed.length > 0) outcome.status = "partial-failed";
			outcome.issues = failed.map((record) => ({
				path: record.path,
				message: "Duplicate-tag undo skipped this note.",
			}));
		});
	}

	/** Apply every filename safety rule through Obsidian's link-safe rename API. */
	private async performGuardedRename(
		file: TFile,
		newPath: string
	): Promise<GuardedRenameResult> {
		const filename = newPath.split("/").pop() ?? "";
		const extension = `.${file.extension}`;
		const basename = filename.endsWith(extension)
			? filename.slice(0, -extension.length)
			: filename;
		const portabilityIssue = portableBasenameIssue(basename);
		if (portabilityIssue) {
			return { status: "not-portable", basename, issue: portabilityIssue };
		}
		// Collision guard: refuse to rename onto a different existing file so a
		// separator migration / undo can never clobber an unrelated note.
		const existing = this.app.vault.getAbstractFileByPath(newPath);
		if (existing && existing !== file) {
			return { status: "collision", basename };
		}
		// Capture the OLD path — renameFile mutates file.path to newPath in place.
		const oldPath = file.path;
		this.renaming.add(oldPath);
		this.renaming.add(newPath);
		try {
			// Same path as a manual rename, so Obsidian updates internal links.
			await this.app.fileManager.renameFile(file, newPath);
			return { status: "renamed", basename };
		} catch (error) {
			return { status: "failed", basename, error };
		} finally {
			this.renaming.delete(oldPath);
			window.setTimeout(() => this.renaming.delete(newPath), 200);
		}
	}

	/** Rename a file for bulk and automation flows, with user-facing feedback. */
	private async renameGuarded(file: TFile, newPath: string): Promise<boolean> {
		const result = await this.performGuardedRename(file, newPath);
		if (result.status === "renamed") return true;

		if (result.status === "not-portable") {
			console.warn(
				"TRELLIS: cross-platform filename guard, skipping",
				file.path,
				"→",
				newPath,
				result.issue
			);
			if (!this.bulkActive) {
				new Notice(t("notice.filenameNotPortable", { name: result.basename }));
			}
			return false;
		}

		if (result.status === "collision") {
			console.warn("TRELLIS: rename collision, skipping", file.path, "→", newPath);
			if (!this.bulkActive) {
				new Notice(t("notice.renameCollision", { name: file.basename, target: newPath }));
			}
			return false;
		}

		console.error("TRELLIS rename failed", result.error);
		if (!this.bulkActive) new Notice(t("notice.renameFailed", { name: file.basename }));
		return false;
	}

	/** Undo the last bootstrap: remove exactly the tags it added. */
	private async undoBootstrap() {
		const record = this.settings.lastBootstrap ?? [];
		if (record.length === 0) {
			new Notice(t("notice.noBootstrap"));
			return;
		}
		const operation = t("cmd.bootstrapUndo");
		await this.runBulkOperation(operation, record.length, async (_operationId, outcome) => {
			let undone = 0;
			const failed: BootstrapRecord[] = [];
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
			outcome.processed = undone;
			if (failed.length > 0) outcome.status = "partial-failed";
			outcome.issues = failed.map((record) => ({
				path: record.path,
				message: "Bootstrap undo skipped this note.",
			}));
		});
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
		const files = this.app.vault.getMarkdownFiles();
		await this.runBulkOperation(operation, files.length, async (operationId, outcome) => {
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
						console.error(
							"TRELLIS root change skipped (frontmatter error)",
							file.path,
							e
						);
					}
					progress.report(i + 1, files.length, failed.length);
					this.operations.progress(operationId, {
						processed: i + 1,
						currentPath: file.path,
					});
				}
			} catch (error) {
				failed.push(t("bulk.unexpectedFailure"));
				console.error("TRELLIS root migration failed", error);
			} finally {
				if (progress.wasCancelled || failed.length > 0) {
					// Roll back what was rewritten (schema still = newRoot while the
					// reverted tags land, so nothing is mis-parsed mid-rollback), then
					// restore the old root. Nothing to undo afterwards.
					let reverted = 0;
					const rollbackFailed: string[] = [];
					for (const path of touchedPaths) {
						const file = this.app.vault.getAbstractFileByPath(path);
						if (!(file instanceof TFile)) continue;
						try {
							if (await this.migrateFileRoot(file, newRoot, oldRoot, slotNs)) reverted++;
						} catch (e) {
							console.error("TRELLIS root rollback skipped (frontmatter error)", path, e);
							rollbackFailed.push(path);
						}
					}
					this.settings.schema.rootNamespace = oldRoot;
					this.settings.lastRootChange = prevRec;
					await this.saveSettings();
					this.rebuildTrees();
					progress.finish({
						processed: reverted,
						skipped: [...failed, ...rollbackFailed],
						outcome: "rolled-back",
					});
					outcome.status = rollbackFailed.length > 0 ? "partial-failed" : "rolled-back";
					outcome.processed = reverted;
					outcome.issues = [
						...failed.map((path) => ({ path, message: "Root change stopped." })),
						...rollbackFailed.map((path) => ({
							path,
							message: "Root change rollback is incomplete.",
						})),
					];
				} else {
					this.settings.lastRootChange = { oldRoot, newRoot };
					await this.saveSettings();
					this.rebuildTrees();
					progress.finish({ processed: changed, skipped: failed });
					outcome.processed = changed;
					new Notice(
						t("notice.rootChanged", { from: oldRoot || "—", to: newRoot || "—", n: changed })
					);
				}
			}
		});
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
		const slot = this.settings.schema.slots.find((candidate) => candidate.role === "tag");
		return slot ? legacySchemeFromValueRule(slotValueRule(this.settings.schema, slot)) ?? "" : "";
	}

	setPrimaryScheme(scheme: SchemeId | "") {
		const slot = this.firstTagSlot();
		const definition = tagDefinitionById(this.settings.schema, slot.tagDefinitionId);
		if (!definition) return;
		if (scheme === "") delete definition.valueRule;
		else definition.valueRule = valueRuleFromLegacyScheme(scheme);
	}

	/** Suggested next segment under a parent, per the OWNING slot's scheme
	 *  (resolved from the parent path — nested mode offers creation on every
	 *  namespace branch). null = no scheme (the modal stays fully manual). */
	segmentSuggestionFor(parent: string): string | null {
		if (!parent) return null;
		const match = matchTagKey(parent, this.settings.schema);
		if (!match?.tagDefinitionId) return null;
		const definition = tagDefinitionById(this.settings.schema, match.tagDefinitionId);
		if (!definition?.valueRule) return null;
		const parentDepth = match.keyPath ? match.keyPath.split("/").length : 0;
		return suggestTagValue(
			definition.valueRule,
			parentDepth,
			this.childSegmentsOf(parent),
			new Date()
		);
	}
}
