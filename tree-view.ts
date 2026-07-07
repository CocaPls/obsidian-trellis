import { ItemView, WorkspaceLeaf, TFile, Menu, setIcon } from "obsidian";
import { NoteTreeNode, TagTreeNode } from "./tagkey";
import { t } from "./i18n";

export const TRELLIS_TREE_VIEW = "trellis-tree-view";

/** Visibility of each action button in the tree-view header. */
export interface HeaderButtonVisibility {
	newNote: boolean;
	viewMode: boolean;
	sort: boolean;
	collapseAll: boolean;
	showCurrent: boolean;
	bootstrap: boolean;
	cascade: boolean;
	undo: boolean;
}

/** Header-button ids in render (left-to-right) order — the single source shared
 *  by the view (which buttons to draw) and settings (which toggles to list). */
export const HEADER_BUTTON_IDS: (keyof HeaderButtonVisibility)[] = [
	"newNote",
	"viewMode",
	"sort",
	"collapseAll",
	"showCurrent",
	"bootstrap",
	"cascade",
	"undo",
];

/** Everything the view reads or calls back into the plugin for. Grouped into
 *  one object so the constructor stays readable as the view grows. */
export interface TrellisTreeCallbacks {
	getRoots: () => NoteTreeNode[];
	getSortAsc: () => boolean;
	/** The tab title, already resolved (custom name or localized default). */
	getDisplayName: () => string;
	/** Which header buttons are enabled in settings. */
	getButtons: () => HeaderButtonVisibility;
	onToggleSort: () => void;
	onNewChild: (parentTagPath: string) => void;
	onNewNote: () => void;
	onBootstrap: () => void;
	onCascade: () => void;
	onUndoBootstrap: () => void;
	onUndoSeparator: () => void;
	// Nested tag mode (0.3.0 experimental, B24)
	getViewMode: () => "notes" | "tags";
	onToggleViewMode: () => void;
	/** The full tag tree (synthetic root; children are the top segments). */
	getTagRoot: () => TagTreeNode;
	/** Show the root/namespace scaffolding layers as rows? */
	getShowRoot: () => boolean;
	/** Paths that ARE namespace scaffolding (skipped when show-root is off). */
	getScaffolding: () => Set<string>;
	/** Note rows show the filename or only the tag segment. */
	getLabelMode: () => "filename" | "tag";
	/** List untagged notes in a bottom section? */
	getShowUntagged: () => boolean;
	getUntagged: () => string[];
}

/**
 * Sidebar panel that renders the note hierarchy implied by location tags.
 * Every row is a real NOTE: an index note tagged "trel/S88" becomes a
 * folder-style parent of notes tagged "trel/S88/…", and segment-only levels
 * (trel, S88, A …) are invisible. It reads the same tags the rename engine
 * writes, so the tree is a virtual folder structure with no real folders.
 *
 * The DOM mirrors Obsidian's core file explorer (nav-header / tree-item /
 * nav-folder / nav-file / collapse-icon) so the theme styles it like the native
 * explorer. Tree-build logic lives in tagkey.ts (unit-tested); this view paints
 * it and handles collapse/active-file UI.
 */
export class TrellisTreeView extends ItemView {
	private readonly cb: TrellisTreeCallbacks;
	/** Tag paths whose children are hidden. Persists across refreshes. */
	private readonly collapsed = new Set<string>();

	constructor(leaf: WorkspaceLeaf, cb: TrellisTreeCallbacks) {
		super(leaf);
		this.cb = cb;
	}

	getViewType(): string {
		return TRELLIS_TREE_VIEW;
	}

	getDisplayText(): string {
		return this.cb.getDisplayName();
	}

	getIcon(): string {
		return "list-tree";
	}

	async onOpen() {
		// Follow the active file: re-render so the open note is highlighted.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.render())
		);
		this.render();
	}

	async onClose() {
		this.contentEl.empty();
	}

	/** Re-render from current vault state (called on tag/file changes). */
	refresh() {
		this.render();
	}

	private render() {
		const container = this.contentEl;
		container.empty();
		container.addClass("trellis-tree");

		// Header with action buttons (native explorer look). Each button is
		// individually toggleable in settings; the header still renders (empty) so
		// the panel keeps its native spacing even with every button hidden.
		const vis = this.cb.getButtons();
		const header = container.createDiv({ cls: "nav-header" });
		const buttons = header.createDiv({ cls: "nav-buttons-container" });
		// New note — like the file explorer's new-note button, it creates at the
		// current context (the active note's parent is prefilled in the modal).
		if (vis.newNote) {
			this.addButton(buttons, "file-plus", t("tree.newNote"), () =>
				this.cb.onNewNote()
			);
		}
		// Mode toggle (0.3.0): classic notes tree ↔ nested tag tree.
		if (vis.viewMode) {
			const tagsMode = this.cb.getViewMode() === "tags";
			this.addButton(
				buttons,
				tagsMode ? "files" : "tags",
				tagsMode ? t("tree.modeToNotes") : t("tree.modeToTags"),
				() => this.cb.onToggleViewMode()
			);
		}
		// Sort applies to the notes tree only — nested mode is fixed segment
		// order (buildTagTree), so hide the button there instead of showing a
		// control that does nothing.
		if (vis.sort && this.cb.getViewMode() !== "tags") {
			const asc = this.cb.getSortAsc();
			this.addButton(
				buttons,
				asc ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow",
				asc ? t("tree.sortAsc") : t("tree.sortDesc"),
				() => this.cb.onToggleSort()
			);
		}
		if (vis.collapseAll) {
			this.addButton(buttons, "chevrons-down-up", t("tree.collapseAll"), () =>
				this.toggleCollapseAll()
			);
		}
		if (vis.showCurrent) {
			this.addButton(buttons, "crosshair", t("tree.showCurrent"), () =>
				this.revealActiveFile()
			);
		}
		if (vis.bootstrap) {
			this.addButton(buttons, "wand-2", t("tree.bootstrap"), () =>
				this.cb.onBootstrap()
			);
		}
		if (vis.cascade) {
			this.addButton(buttons, "pencil-line", t("tree.cascade"), () =>
				this.cb.onCascade()
			);
		}
		if (vis.undo) {
			this.addButton(buttons, "undo-2", t("tree.undo"), (e) => {
				const menu = new Menu();
				menu.addItem((i) =>
					i
						.setTitle(t("cmd.bootstrapUndo"))
						.setIcon("wand-2")
						.onClick(() => this.cb.onUndoBootstrap())
				);
				menu.addItem((i) =>
					i
						.setTitle(t("cmd.sepUndo"))
						.setIcon("scissors")
						.onClick(() => this.cb.onUndoSeparator())
				);
				menu.showAtMouseEvent(e);
			});
		}

		const nav = container.createDiv({ cls: "nav-files-container" });
		const activePath = this.app.workspace.getActiveFile()?.path ?? null;

		// Nested tag mode (0.3.0): the full tag hierarchy, folder-style.
		if (this.cb.getViewMode() === "tags") {
			let tops = this.cb.getTagRoot().children;
			if (!this.cb.getShowRoot()) {
				// Hide the root/namespace scaffolding layers: render their children
				// in their place (recursively — a root and its slot namespace are
				// both scaffolding). A scaffolding node that CARRIES a note is kept
				// visible — promoting it would drop that note from the tree.
				const scaff = this.cb.getScaffolding();
				const promote = (nodes: TagTreeNode[]): TagTreeNode[] =>
					nodes.flatMap((n) =>
						scaff.has(n.path) && n.notePaths.length === 0
							? promote(n.children)
							: [n]
					);
				tops = promote(tops);
			}
			if (tops.length === 0 && this.cb.getUntagged().length === 0) {
				nav.createDiv({ cls: "trellis-tree-empty", text: t("tree.empty") });
				return;
			}
			for (const node of tops) {
				this.renderTagNode(nav, node, activePath);
			}
			if (this.cb.getShowUntagged()) this.renderUntagged(nav, activePath);
			return;
		}

		const roots = this.cb.getRoots();
		if (roots.length === 0) {
			nav.createDiv({
				cls: "trellis-tree-empty",
				text: t("tree.empty"),
			});
			return;
		}
		// Render roots DIRECTLY under .nav-files-container. The core file
		// explorer does NOT wrap top-level items in .tree-item-children — only
		// each node's *children* get that wrapper. Wrapping the roots added a
		// spurious top-level indent guide (border-inline-start) and one extra
		// indent step, which made the tree look unlike the native explorer.
		for (const node of roots) {
			this.renderNode(nav, node, activePath);
		}
	}

	private addButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: (e: MouseEvent) => void
	) {
		const btn = parent.createDiv({
			cls: "clickable-icon nav-action-button",
			attr: { "aria-label": label },
		});
		setIcon(btn, icon);
		btn.addEventListener("click", onClick);
	}

	private renderNode(
		parent: HTMLElement,
		node: NoteTreeNode,
		activePath: string | null
	) {
		const hasChildren = node.children.length > 0;
		const isCollapsed = hasChildren && this.collapsed.has(node.tagPath);

		const item = parent.createDiv({
			cls: hasChildren ? "tree-item nav-folder" : "tree-item nav-file",
		});
		if (isCollapsed) item.addClass("is-collapsed");

		const self = item.createDiv({
			cls: hasChildren
				? "tree-item-self nav-folder-title is-clickable mod-collapsible"
				: "tree-item-self nav-file-title is-clickable",
		});
		if (node.notePath === activePath) self.addClass("is-active");

		if (hasChildren) {
			const icon = self.createDiv({ cls: "tree-item-icon collapse-icon" });
			setIcon(icon, "right-triangle");
			icon.addEventListener("click", (e) => {
				e.stopPropagation();
				if (this.collapsed.has(node.tagPath)) this.collapsed.delete(node.tagPath);
				else this.collapsed.add(node.tagPath);
				this.render();
			});
		}

		// Every row is a note — clicking the row opens it (index notes too).
		const inner = self.createDiv({
			cls: hasChildren
				? "tree-item-inner nav-folder-title-content"
				: "tree-item-inner nav-file-title-content",
		});
		inner.setText(this.basename(node.notePath));
		self.addEventListener("click", () => this.openNote(node.notePath));

		// Right-click → create a child note under this node's tagkey.
		self.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const menu = new Menu();
			menu.addItem((i) =>
				i
					.setTitle(t("menu.newHere"))
					.setIcon("file-plus")
					.onClick(() => this.cb.onNewChild(node.tagPath))
			);
			menu.showAtMouseEvent(e);
		});

		if (hasChildren && !isCollapsed) {
			const childWrap = item.createDiv({
				cls: "tree-item-children nav-folder-children",
			});
			for (const child of node.children) {
				this.renderNode(childWrap, child, activePath);
			}
		}
	}

	// --- Nested tag mode rendering (0.3.0 experimental, B24) ----------------

	/**
	 * One node of the nested tag tree. Unlike notes mode, every tag level is a
	 * row. Click behaviour splits on whether a note sits AT this exact tag:
	 *  - note attached → the row opens the note (underlined, folder-note style);
	 *  - pure branch  → the row only collapses/expands (file-explorer folder
	 *    feel), no note to open.
	 * Extra notes at the same tag (rare) render as leaf children.
	 */
	private renderTagNode(
		parent: HTMLElement,
		node: TagTreeNode,
		activePath: string | null
	) {
		const ownNote = node.notePaths[0] ?? null;
		const extras = node.notePaths.slice(1);
		const hasKids = node.children.length > 0 || extras.length > 0;
		const isCollapsed = hasKids && this.collapsed.has(node.path);

		const item = parent.createDiv({
			cls: hasKids ? "tree-item nav-folder" : "tree-item nav-file",
		});
		if (isCollapsed) item.addClass("is-collapsed");

		const self = item.createDiv({
			cls: hasKids
				? "tree-item-self nav-folder-title is-clickable mod-collapsible"
				: "tree-item-self nav-file-title is-clickable",
		});
		if (ownNote && ownNote === activePath) self.addClass("is-active");

		const toggle = () => {
			if (!hasKids) return;
			if (this.collapsed.has(node.path)) this.collapsed.delete(node.path);
			else this.collapsed.add(node.path);
			this.render();
		};

		if (hasKids) {
			const icon = self.createDiv({ cls: "tree-item-icon collapse-icon" });
			setIcon(icon, "right-triangle");
			icon.addEventListener("click", (e) => {
				e.stopPropagation();
				toggle();
			});
		}

		const inner = self.createDiv({
			cls: hasKids
				? "tree-item-inner nav-folder-title-content"
				: "tree-item-inner nav-file-title-content",
		});
		const label =
			this.cb.getLabelMode() === "tag"
				? node.segment
				: ownNote
					? this.basename(ownNote)
					: node.segment;
		inner.setText(label);
		if (ownNote) {
			// Underline affordance: this tag HAS a note — clicking goes somewhere.
			inner.addClass("trellis-has-note");
			self.addEventListener("click", () => this.openNote(ownNote));
		} else {
			self.addEventListener("click", toggle);
		}

		// Right-click → create a child note under this tag path.
		self.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const menu = new Menu();
			menu.addItem((i) =>
				i
					.setTitle(t("menu.newHere"))
					.setIcon("file-plus")
					.onClick(() => this.cb.onNewChild(node.path))
			);
			menu.showAtMouseEvent(e);
		});

		if (hasKids && !isCollapsed) {
			const wrap = item.createDiv({
				cls: "tree-item-children nav-folder-children",
			});
			// Extra notes at this exact tag first (leaf rows), then subtags.
			for (const extra of extras) {
				this.renderLeafNote(wrap, extra, activePath);
			}
			for (const child of node.children) {
				this.renderTagNode(wrap, child, activePath);
			}
		}
	}

	/** A plain note leaf row (extra same-tag notes, untagged list). */
	private renderLeafNote(
		parent: HTMLElement,
		notePath: string,
		activePath: string | null
	) {
		const item = parent.createDiv({ cls: "tree-item nav-file" });
		const self = item.createDiv({
			cls: "tree-item-self nav-file-title is-clickable",
		});
		if (notePath === activePath) self.addClass("is-active");
		self
			.createDiv({ cls: "tree-item-inner nav-file-title-content" })
			.setText(this.basename(notePath));
		self.addEventListener("click", () => this.openNote(notePath));
	}

	/** Collapse key for the untagged section (not a real tag path). */
	private static readonly UNTAGGED_KEY = "//untagged";

	/** Bottom section listing notes with no managed tag (collapsible), so
	 *  onboarding misses stay visible from the sidebar itself. */
	private renderUntagged(parent: HTMLElement, activePath: string | null) {
		const list = this.cb.getUntagged();
		if (list.length === 0) return;
		const key = TrellisTreeView.UNTAGGED_KEY;
		const isCollapsed = this.collapsed.has(key);

		const item = parent.createDiv({
			cls: "tree-item nav-folder trellis-untagged",
		});
		if (isCollapsed) item.addClass("is-collapsed");
		const self = item.createDiv({
			cls: "tree-item-self nav-folder-title is-clickable mod-collapsible",
		});
		const icon = self.createDiv({ cls: "tree-item-icon collapse-icon" });
		setIcon(icon, "right-triangle");
		self
			.createDiv({ cls: "tree-item-inner nav-folder-title-content" })
			.setText(t("tree.untagged", { n: list.length }));
		self.addEventListener("click", () => {
			if (this.collapsed.has(key)) this.collapsed.delete(key);
			else this.collapsed.add(key);
			this.render();
		});

		if (!isCollapsed) {
			const wrap = item.createDiv({
				cls: "tree-item-children nav-folder-children",
			});
			for (const notePath of list) {
				this.renderLeafNote(wrap, notePath, activePath);
			}
		}
	}

	/** Collapse everything if anything is open, else expand everything. */
	private toggleCollapseAll() {
		const folders = new Set<string>();
		if (this.cb.getViewMode() === "tags") {
			this.collectTagFolderPaths(this.cb.getTagRoot().children, folders);
			folders.add(TrellisTreeView.UNTAGGED_KEY);
		} else {
			this.collectFolderPaths(this.cb.getRoots(), folders);
		}
		const allCollapsed = [...folders].every((p) => this.collapsed.has(p));
		if (allCollapsed) this.collapsed.clear();
		else folders.forEach((p) => this.collapsed.add(p));
		this.render();
	}

	private collectTagFolderPaths(nodes: TagTreeNode[], acc: Set<string>) {
		for (const n of nodes) {
			if (n.children.length > 0 || n.notePaths.length > 1) {
				acc.add(n.path);
				this.collectTagFolderPaths(n.children, acc);
			}
		}
	}

	private collectFolderPaths(nodes: NoteTreeNode[], acc: Set<string>) {
		for (const n of nodes) {
			if (n.children.length > 0) {
				acc.add(n.tagPath);
				this.collectFolderPaths(n.children, acc);
			}
		}
	}

	/** Expand the active file's ancestors, re-render, and scroll to it. */
	private revealActiveFile() {
		const active = this.app.workspace.getActiveFile();
		if (!active) return;
		const tagPath =
			this.cb.getViewMode() === "tags"
				? this.findTagPathInTagTree(this.cb.getTagRoot().children, active.path)
				: this.findTagPath(this.cb.getRoots(), active.path);
		if (tagPath) {
			// Un-collapse every ancestor of the active note.
			for (const p of [...this.collapsed]) {
				if (tagPath === p || tagPath.startsWith(p + "/")) this.collapsed.delete(p);
			}
		}
		this.render();
		const el = this.contentEl.querySelector(".is-active");
		if (el) el.scrollIntoView({ block: "center" });
	}

	private findTagPathInTagTree(nodes: TagTreeNode[], notePath: string): string | null {
		for (const n of nodes) {
			if (n.notePaths.includes(notePath)) return n.path;
			const found = this.findTagPathInTagTree(n.children, notePath);
			if (found) return found;
		}
		return null;
	}

	private findTagPath(nodes: NoteTreeNode[], notePath: string): string | null {
		for (const n of nodes) {
			if (n.notePath === notePath) return n.tagPath;
			const found = this.findTagPath(n.children, notePath);
			if (found) return found;
		}
		return null;
	}

	private openNote(path: string) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			void this.app.workspace.getLeaf(false).openFile(file);
		}
	}

	private basename(path: string): string {
		const name = path.split("/").pop() ?? path;
		return name.replace(/\.md$/, "");
	}
}
