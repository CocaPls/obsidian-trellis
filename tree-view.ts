import { ItemView, WorkspaceLeaf, TFile, Menu, setIcon } from "obsidian";
import { NoteTreeNode } from "./trekey";

export const TRELLIS_TREE_VIEW = "trellis-tree-view";

/**
 * Sidebar panel that renders the note hierarchy implied by location tags.
 * Every row is a real NOTE: an index note tagged "trel/S88" becomes a
 * folder-style parent of notes tagged "trel/S88/…", and segment-only levels
 * (trel, S88, A …) are invisible. It reads the same tags the rename engine
 * writes, so the tree is a virtual folder structure with no real folders.
 *
 * The DOM mirrors Obsidian's core file explorer (nav-header / tree-item /
 * nav-folder / nav-file / collapse-icon) so the theme styles it like the native
 * explorer. Tree-build logic lives in trekey.ts (unit-tested); this view paints
 * it and handles collapse/active-file UI.
 */
export class TrellisTreeView extends ItemView {
	private readonly getRoots: () => NoteTreeNode[];
	private readonly getSortAsc: () => boolean;
	private readonly onToggleSort: () => void;
	private readonly onNewChild: (parentTagPath: string) => void;
	/** Tag paths whose children are hidden. Persists across refreshes. */
	private readonly collapsed = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		getRoots: () => NoteTreeNode[],
		getSortAsc: () => boolean,
		onToggleSort: () => void,
		onNewChild: (parentTagPath: string) => void
	) {
		super(leaf);
		this.getRoots = getRoots;
		this.getSortAsc = getSortAsc;
		this.onToggleSort = onToggleSort;
		this.onNewChild = onNewChild;
	}

	getViewType(): string {
		return TRELLIS_TREE_VIEW;
	}

	getDisplayText(): string {
		return "TRELLIS tree";
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

		// Header with action buttons (native explorer look).
		const header = container.createDiv({ cls: "nav-header" });
		const buttons = header.createDiv({ cls: "nav-buttons-container" });
		const asc = this.getSortAsc();
		this.addButton(
			buttons,
			asc ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow",
			asc ? "Sort: ascending (click for descending)" : "Sort: descending (click for ascending)",
			() => this.onToggleSort()
		);
		this.addButton(buttons, "chevrons-down-up", "Collapse / expand all", () =>
			this.toggleCollapseAll()
		);
		this.addButton(buttons, "crosshair", "Show current file", () =>
			this.revealActiveFile()
		);

		const roots = this.getRoots();
		const nav = container.createDiv({ cls: "nav-files-container" });
		if (roots.length === 0) {
			nav.createDiv({
				cls: "trellis-tree-empty",
				text: "No location-tagged notes found.",
			});
			return;
		}
		const activePath = this.app.workspace.getActiveFile()?.path ?? null;
		const treeRoot = nav.createDiv({ cls: "tree-item-children" });
		for (const node of roots) {
			this.renderNode(treeRoot, node, activePath);
		}
	}

	private addButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void
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

		// Right-click → create a child note under this node's trekey.
		self.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const menu = new Menu();
			menu.addItem((i) =>
				i
					.setTitle("New note here")
					.setIcon("file-plus")
					.onClick(() => this.onNewChild(node.tagPath))
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

	/** Collapse everything if anything is open, else expand everything. */
	private toggleCollapseAll() {
		const folders = new Set<string>();
		this.collectFolderPaths(this.getRoots(), folders);
		const allCollapsed = [...folders].every((p) => this.collapsed.has(p));
		if (allCollapsed) this.collapsed.clear();
		else folders.forEach((p) => this.collapsed.add(p));
		this.render();
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
		const tagPath = this.findTagPath(this.getRoots(), active.path);
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
