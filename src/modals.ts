import {
	App,
	Modal,
	Setting,
	TFile,
	TFolder,
	TAbstractFile,
	AbstractInputSuggest,
	ButtonComponent,
	TextComponent,
	getAllTags,
	Notice,
} from "obsidian";
import { t } from "./i18n";
import {
	DuplicateTagGroup,
	expandTagPrefixes,
	filterTagSuggestions,
} from "./tagkey";

/** Style a button as destructive via a CSS class (styles.css). Avoids both the
 *  deprecated setWarning() and the version-gated setDestructive(), so it works
 *  on every supported Obsidian without a runtime guard. */
function markDestructive(b: ButtonComponent): ButtonComponent {
	b.buttonEl.addClass("trellis-destructive");
	return b;
}

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
const TAG_PATH_PLACEHOLDER = "trel/S88";
const NEXT_TAG_PATH_PLACEHOLDER = "trel/S99";

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
		initialFrom = "",
		private readonly includeSuggestion: (tagPath: string) => boolean = () => true
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
					.setPlaceholder(TAG_PATH_PLACEHOLDER)
					.setValue(this.from)
					.onChange((v) => (this.from = v.trim()));
				new TagPathSuggest(
					this.app,
					input.inputEl,
					(v) => (this.from = v),
					this.includeSuggestion
				);
			});
		new Setting(contentEl)
			.setName(t("modal.cascade.toName"))
			.setDesc(t("modal.cascade.toDesc"))
			.addText((input) => {
				input
					.setPlaceholder(NEXT_TAG_PATH_PLACEHOLDER)
					.onChange((v) => (this.to = v.trim()));
				new TagPathSuggest(
					this.app,
					input.inputEl,
					(v) => (this.to = v),
					this.includeSuggestion
				);
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

export interface CascadePreviewRow {
	path: string;
	beforeTags: string[];
	afterTags: string[];
}

/** Exact dry-run for a managed cascade. No write occurs until the user reviews
 * the affected-note list and presses the destructive confirmation button. */
export class CascadePreviewModal extends Modal {
	constructor(
		app: App,
		private readonly from: string,
		private readonly to: string,
		private readonly rows: CascadePreviewRow[],
		private readonly onApply: () => void
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("modal.cascadePreview.title") });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("modal.cascadePreview.desc", {
				from: this.from,
				to: this.to,
				n: this.rows.length,
			}),
		});
		const details = contentEl.createEl("details");
		details.createEl("summary", {
			text: t("modal.cascadePreview.showList", { n: this.rows.length }),
		});
		const list = details.createDiv({ cls: "trellis-bootstrap-list" });
		for (const row of this.rows) {
			const item = list.createDiv({ cls: "trellis-bootstrap-row" });
			item.createDiv({ cls: "trellis-bootstrap-name", text: row.path });
			const before = row.beforeTags.filter(
				(tag, index) => tag !== row.afterTags[index]
			);
			const after = row.afterTags.filter(
				(tag, index) => tag !== row.beforeTags[index]
			);
			item.createDiv({
				cls: "trellis-bootstrap-tag",
				text: `${before.join(", ")} → ${after.join(", ")}`,
			});
		}

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(t("modal.cascadePreview.apply", { n: this.rows.length }))
					.setCta()
					.onClick(() => {
					this.close();
					this.onApply();
				})
			)
			.addButton((button) =>
				button.setButtonText(t("modal.confirm.cancel")).onClick(() => this.close())
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

export interface FilenameSyncPreviewRow {
	path: string;
	targetPath: string;
}

/** Turning live sync back on may affect many existing notes. Keep the toggle
 * off until the user has seen the exact old → new paths and explicitly applies. */
export class FilenameSyncPreviewModal extends Modal {
	constructor(
		app: App,
		private readonly rows: FilenameSyncPreviewRow[],
		private readonly onApply: () => void
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("modal.filenameSync.title") });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("modal.filenameSync.desc", { n: this.rows.length }),
		});
		const details = contentEl.createEl("details");
		details.createEl("summary", {
			text: t("modal.filenameSync.showList", { n: this.rows.length }),
		});
		const list = details.createDiv({ cls: "trellis-bootstrap-list" });
		for (const row of this.rows) {
			const item = list.createDiv({ cls: "trellis-bootstrap-row" });
			item.createDiv({ cls: "trellis-bootstrap-name", text: row.path });
			item.createDiv({ cls: "trellis-bootstrap-tag", text: `→ ${row.targetPath}` });
		}
		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(t("modal.filenameSync.apply", { n: this.rows.length }))
					.setCta()
					.onClick(() => {
						this.close();
						this.onApply();
					})
			)
			.addButton((button) =>
				button.setButtonText(t("modal.confirm.cancel")).onClick(() => this.close())
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** New-note modal. Parent: prefilled by the caller (clicked node, or the active
 *  note's location for the header button) and editable WITH tag autocomplete —
 *  it picks an existing location, so completing it is safe. Segment: the user
 *  assigns it by hand — TRELLIS is format-agnostic and must not guess the tagkey
 *  scheme (a wrong "01" in an alphabetic slot would just have to be retyped).
 *  EXCEPT when the primary slot has an ID scheme (0.3.0): then `suggest` yields
 *  a prefill for the segment, still fully editable, recomputed when the parent
 *  changes until the user types their own value. */
export class NewChildNoteModal extends Modal {
	private parent: string;
	private segment = "";
	private title = "";
	/** True once the user typed in the segment field — stop auto-suggesting. */
	private segmentTouched = false;
	private readonly onSubmit: (parent: string, segment: string, title: string) => void;
	private readonly suggest?: (parent: string) => string | null;

	constructor(
		app: App,
		initialParent: string,
		onSubmit: (parent: string, segment: string, title: string) => void,
		suggest?: (parent: string) => string | null
	) {
		super(app);
		this.parent = initialParent;
		this.onSubmit = onSubmit;
		this.suggest = suggest;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("modal.newNote.title") });
		contentEl.createEl("p", {
			text: t("modal.newNote.desc"),
			cls: "setting-item-description",
		});

		let segInput: TextComponent | null = null;
		// Refill the segment with the scheme suggestion for the current parent —
		// only while the user hasn't typed a value of their own.
		const refreshSuggestion = () => {
			if (this.segmentTouched || !this.suggest || !segInput) return;
			const s = this.suggest(this.parent);
			if (s !== null) {
				segInput.setValue(s); // setValue doesn't fire onChange
				this.segment = s;
			}
		};

		new Setting(contentEl)
			.setName(t("modal.newNote.parentName"))
			.setDesc(t("modal.newNote.parentDesc"))
			.addText((input) => {
				input
					.setPlaceholder(TAG_PATH_PLACEHOLDER)
					.setValue(this.parent)
					.onChange((v) => {
						this.parent = v.trim();
						refreshSuggestion();
					});
				new TagPathSuggest(this.app, input.inputEl, (v) => {
					this.parent = v;
					refreshSuggestion();
				});
			});
		new Setting(contentEl)
			.setName(t("modal.newNote.segmentName"))
			.setDesc(t("modal.newNote.segmentDesc"))
			.addText((input) => {
				segInput = input;
				input.setPlaceholder(t("ph.segment")).onChange((v) => {
					this.segment = v.trim();
					this.segmentTouched = true;
				});
			});
		refreshSuggestion();
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
		activeDocument.addEventListener("mouseup", this.onMouseUp);
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
			row.setCssProps({ "--trellis-depth": String(depth) });

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
			row.setCssProps({ "--trellis-depth": String(depth) });

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
		activeDocument.removeEventListener("mouseup", this.onMouseUp);
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
		private readonly noTagkey: string[],
		private readonly onApply: (rows: { path: string; tag: string }[]) => void,
		private readonly visibleSegmentSeparator = false
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
				none: this.noTagkey.length,
			}),
		});
		if (this.visibleSegmentSeparator) {
			contentEl.createEl("p", {
				cls: "setting-item-description",
				text: t("modal.bootstrap.segmentWarning"),
			});
		}

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

		if (this.noTagkey.length) {
			contentEl.createEl("h4", {
				text: t("modal.bootstrap.noTagkey", { n: this.noTagkey.length }),
			});
			const list = contentEl.createDiv({ cls: "trellis-bootstrap-list" });
			for (const n of this.noTagkey) {
				list.createDiv({ cls: "trellis-bootstrap-skip", text: n });
			}
		}

		const buttons = new Setting(contentEl);
		if (this.assign.length) {
			buttons.addButton((b) =>
				b
					.setButtonText(t("modal.bootstrap.apply", { n: this.assign.length }))
					.setCta()
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
		private readonly onApply: () => void,
		private readonly warning?: string
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
		if (this.warning) {
			contentEl.createEl("p", {
				cls: "trellis-danger-note",
				text: this.warning,
			});
		}

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
		buttons.addButton((b) => {
			b.setButtonText(t("modal.sep.apply", { n: this.rows.length }));
			if (this.warning) markDestructive(b);
			else b.setCta();
			b.onClick(() => {
				this.onApply();
				this.close();
			});
		});
		buttons.addButton((b) =>
			b.setButtonText(t("modal.sep.cancel")).onClick(() => this.close())
		);
	}

	onClose() {
		this.contentEl.empty();
		this.onClosed();
	}
}

/**
 * A small modal that tracks a long bulk pass (bootstrap apply, separator change)
 * with a live count + progress bar, Pause/Resume and Cancel, then a Done state
 * with a review list of skipped notes and an OK button. Replaces the old
 * Notice-based progress (which poked the unofficial `Notice.noticeEl`).
 *
 * The driving loop calls `gate()` each iteration (blocks while paused, returns
 * false once cancelled so the caller breaks) and `report()` to update the UI,
 * then `finish()` once — which swaps the modal to its summary state and keeps it
 * open until the user clicks OK.
 */
export class BulkProgressModal extends Modal {
	private paused = false;
	private cancelled = false;
	private finished = false;
	private waiters: (() => void)[] = [];
	private startedAt = 0;
	private barFill!: HTMLElement;
	private barEl!: HTMLElement;
	private countEl!: HTMLElement;
	private metaEl!: HTMLElement;
	private hintEl!: HTMLElement;

	constructor(app: App, private readonly title: string) {
		super(app);
	}

	onOpen() {
		this.startedAt = Date.now();
		const { contentEl } = this;
		contentEl.addClass("trellis-progress-modal");
		contentEl.createEl("h3", { text: this.title });

		this.barEl = contentEl.createDiv({
			cls: "trellis-progress-bar",
			attr: {
				role: "progressbar",
				"aria-label": this.title,
				"aria-valuemin": "0",
				"aria-valuemax": "100",
				"aria-valuenow": "0",
			},
		});
		this.barFill = this.barEl.createDiv({ cls: "trellis-progress-bar-fill" });
		this.countEl = contentEl.createDiv({ cls: "trellis-progress-count", text: "0 / 0" });
		this.countEl.setAttribute("aria-live", "polite");
		this.metaEl = contentEl.createDiv({ cls: "trellis-progress-meta" });
		this.hintEl = contentEl.createDiv({ cls: "trellis-progress-hint" });

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText(t("bulk.pause")).onClick(() => {
					this.paused = !this.paused;
					b.setButtonText(this.paused ? t("bulk.resume") : t("bulk.pause"));
					if (!this.paused) this.release();
				})
			)
			.addButton((b) =>
				markDestructive(b.setButtonText(t("bulk.cancel"))).onClick(() => {
					this.cancelled = true;
					this.paused = false;
					this.release();
				})
			);
	}

	private release() {
		const w = this.waiters;
		this.waiters = [];
		for (const r of w) r();
	}

	/** Await while paused; resolves false once cancelled (caller should break). */
	async gate(): Promise<boolean> {
		while (this.paused && !this.cancelled) {
			await new Promise<void>((res) => this.waiters.push(res));
		}
		return !this.cancelled;
	}

	get wasCancelled(): boolean {
		return this.cancelled;
	}

	/** Update the bar, count, and elapsed/error meta (call as work progresses). */
	report(done: number, total: number, failed: number) {
		const pct = total > 0 ? Math.round((done / total) * 100) : 0;
		this.barFill.setCssStyles({ width: `${pct}%` });
		this.barEl.setAttribute("aria-valuenow", String(pct));
		this.barEl.setAttribute("aria-valuetext", t("bulk.progress", { done, total }));
		this.countEl.setText(t("bulk.progress", { done, total }));
		const sec = Math.round((Date.now() - this.startedAt) / 1000);
		let meta = t("bulk.elapsed", { sec });
		if (failed > 0) meta += ` · ${t("bulk.errors", { n: failed })}`;
		this.metaEl.setText(meta);
		this.hintEl.setText(sec > 10 ? t("bulk.slowHint") : "");
	}

	/** Swap to the summary state: a done/cancelled/rolled-back heading, the processed count,
	 *  a collapsible list of skipped notes, and an OK button that closes. */
	finish(opts: {
		processed: number;
		skipped: string[];
		outcome?: "done" | "rolled-back";
	}) {
		this.finished = true;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("trellis-progress-modal");
		const outcomeLabel = this.cancelled
			? t("bulk.cancelledLabel")
			: opts.outcome === "rolled-back"
				? t("bulk.rolledBack")
				: t("bulk.done");
		contentEl.createEl("h3", {
			text: `${this.title} — ${outcomeLabel}`,
		});
		const bar = contentEl.createDiv({
			cls: "trellis-progress-bar",
			attr: {
				role: "progressbar",
				"aria-label": this.title,
				"aria-valuemin": "0",
				"aria-valuemax": "100",
				"aria-valuenow": "100",
				"aria-valuetext": outcomeLabel,
			},
		});
		const fill = bar.createDiv({ cls: "trellis-progress-bar-fill is-full" });
		if (this.cancelled) fill.addClass("is-cancelled");

		const summary = contentEl.createDiv({
			cls: "trellis-progress-count",
			text: t("bulk.summary", { done: opts.processed, skipped: opts.skipped.length }),
		});
		summary.setAttribute("aria-live", "polite");

		if (opts.skipped.length) {
			const details = contentEl.createEl("details", { cls: "trellis-progress-skipped" });
			details.createEl("summary", {
				text: t("bulk.skippedTitle", { n: opts.skipped.length }),
			});
			details.createEl("p", {
				cls: "setting-item-description",
				text: t("bulk.skippedDesc"),
			});
			const list = details.createDiv({ cls: "trellis-bootstrap-list" });
			for (const p of opts.skipped) {
				list.createDiv({ cls: "trellis-bootstrap-skip", text: p });
			}
		}

		new Setting(contentEl).addButton((b) =>
			b.setButtonText(t("bulk.ok")).setCta().onClick(() => this.close())
		);
	}

	onClose() {
		// Closing before finish (Esc / backdrop) counts as cancel so the loop stops.
		if (!this.finished) {
			this.cancelled = true;
			this.release();
		}
		this.contentEl.empty();
	}
}

/** A minimal alert dialog: title, message, OK. Used for validation failures
 *  (e.g. an illegal separator) where a corner Notice is too easy to miss. */
export class AlertModal extends Modal {
	constructor(
		app: App,
		private readonly titleText: string,
		private readonly message: string
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.titleText });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: this.message,
		});
		new Setting(contentEl).addButton((b) =>
			b.setButtonText(t("modal.ok")).setCta().onClick(() => this.close())
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** A confirm dialog with an optional "don't ask again" checkbox. onConfirm is
 *  passed whether the box was ticked so the caller can persist the suppression.
 *  Reserved for non-destructive confirms (applying a schema edit); destructive
 *  passes like a separator batch-rename keep their own always-shown modal. */
export class ConfirmModal extends Modal {
	private dontAsk = false;

	constructor(
		app: App,
		private readonly titleText: string,
		private readonly message: string,
		private readonly onConfirm: (dontAsk: boolean) => void,
		/** Offer the "don't ask again" toggle. Callers that ignore the flag
		 *  (e.g. the vault-wide root migration — it must ALWAYS confirm) pass
		 *  false so no phantom checkbox is shown. */
		private readonly showDontAsk = true
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.titleText });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: this.message,
		});
		if (this.showDontAsk) {
			new Setting(contentEl)
				.setName(t("modal.confirm.dontAsk"))
				.addToggle((tg) => tg.setValue(false).onChange((v) => (this.dontAsk = v)));
		}
		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText(t("modal.confirm.ok"))
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm(this.dontAsk);
					})
			)
			.addButton((b) =>
				b.setButtonText(t("modal.confirm.cancel")).onClick(() => this.close())
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
		onPick: (value: string) => void,
		include: (tagPath: string) => boolean = () => true
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
		this.all = expandTagPrefixes([...tags]).filter(include);
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
