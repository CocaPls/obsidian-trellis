import {
	App,
	Modal,
	Setting,
	TFile,
	TFolder,
	TAbstractFile,
	AbstractInputSuggest,
	ButtonComponent,
	getAllTags,
	Notice,
} from "obsidian";
import { t } from "./i18n";
import {
	DuplicateTagGroup,
	expandTagPrefixes,
	filterTagSuggestions,
} from "./trekey";

/** Two-field modal: which tag path to rename, and to what. */
export interface DuplicateNote {
	file: TFile;
	groups: DuplicateTagGroup[];
}

export interface DedupDecision {
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
export class DuplicateTagsModal extends Modal {
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

export class CascadeRenameModal extends Modal {
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
export class NewChildNoteModal extends Modal {
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
export class BootstrapSelectModal extends Modal {
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
export class BootstrapPreviewModal extends Modal {
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
export class BootstrapErrorsModal extends Modal {
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
export class SeparatorChangeModal extends Modal {
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
