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
} from "obsidian";
import {
	TrellisConfig,
	pickTrekey,
	syncedBasename,
	renameTagPath,
	normalizeTagList,
	expandTagPrefixes,
	filterTagSuggestions,
} from "./trekey";

/**
 * TRELLIS — tag-driven trekey sync.
 *
 * When a note's location tag (e.g. #trel/…) changes, rewrite the filename
 * trekey slot to match, via the link-safe rename API. One direction only: the
 * tag is the source of truth. A cascade command renames a whole tag subtree.
 * Behaviour is driven by settings (namespace / separator / key position).
 * Deferred: multi-key, title-key upward sync, bootstrap, drift warnings.
 */

const DEFAULT_SETTINGS: TrellisConfig = {
	namespace: "trel",
	separator: "-",
	keyPosition: "prefix",
};

export default class TrellisPlugin extends Plugin {
	settings: TrellisConfig = { ...DEFAULT_SETTINGS };

	/** Infinite-loop guard: paths we are currently renaming, to ignore the
	 *  metadata/vault events our own rename triggers. */
	private renaming = new Set<string>();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new TrellisSettingTab(this.app, this));

		// metadataCache 'changed' fires after a file's tags/frontmatter are
		// parsed — the right moment to read the location tag.
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					void this.syncFile(file);
				}
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
			})
		);

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
	}
}
