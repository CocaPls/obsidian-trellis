import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	TFile,
	getAllTags,
} from "obsidian";
import {
	KeySlot,
	SCHEME_IDS,
	SchemeId,
	SegmentSeparator,
	SeparatorSpacing,
	TrellisSchema,
	isMultiKey,
	isValidNamespace,
	isValidSeparator,
	primaryNamespace,
	primarySeparator,
	primarySeparatorSymbol,
	renderSeparator,
	schemaFromLegacy,
	separatorConflicts,
	separatorSpacingAt,
	tagPosition,
	normalizeTagList,
} from "./tagkey";
import { TagInventory, type TagInventoryFile } from "./tag-inventory";
import { HEADER_BUTTON_IDS } from "./tree-view";
import { AlertModal } from "./modals";
import { setLang, t } from "./i18n";
import type TrellisPlugin from "./main";

const DEFAULT_NAMESPACE_PLACEHOLDER = "trel";
const ROOT_NAMESPACE_PLACEHOLDER = "trellis";
const SEGMENT_SEPARATORS: SegmentSeparator[] = ["", ".", "-", "_"];
const SEPARATOR_SPACING: SeparatorSpacing[] = ["none", "before", "after", "both"];

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

/** Settings: namespace, separator, key position. */
export class TrellisSettingTab extends PluginSettingTab {
	private readonly plugin: TrellisPlugin;
	/** Keep the experimental disclosure open across our own settings re-renders. */
	private experimentalOpen: boolean | null = null;
	private tagInventory: TagInventory | null = null;
	private inventorySchemaFingerprint = "";
	private statsEl: HTMLElement | null = null;
	private statsTimer: number | null = null;
	private statsCleanups: (() => void)[] = [];

	constructor(app: App, plugin: TrellisPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		this.stopStatsWatch();
		this.startStatsWatch();
		this.render();
	}

	hide() {
		this.stopStatsWatch();
		super.hide();
	}

	/** Imperative render of the settings tab. Our own re-render triggers call
	 *  this directly instead of the framework's deprecated display() entry. */
	private render() {
		const { containerEl } = this;
		containerEl.empty();
		this.ensureTagInventory();

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
							.setPlaceholder(DEFAULT_NAMESPACE_PLACEHOLDER)
							.setValue(pending)
							.onChange((v) => (pending = v))
					)
					.addButton((b) =>
						b.setButtonText(t("setting.apply")).onClick(() => {
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
							this.plugin.requestPrimaryNamespaceChange(v, () => this.render());
						})
					);
			}

			// Filename formatting is staged as one transaction: boundary symbol,
			// boundary spacing, and the tag hierarchy's visible segment joiner.
			{
				const schema = this.plugin.settings.schema;
				const currentSymbol = primarySeparatorSymbol(schema);
				const presetSymbols = ["-", "_", "."];
				let pendingSymbol = currentSymbol;
				let pendingSpacing = separatorSpacingAt(schema, 0);
				let pendingSegment =
					schema.slots.find((slot) => slot.role === "tag")?.segmentSeparator ?? "";
				let customInput: HTMLInputElement | null = null;
				let previewEl: HTMLElement | null = null;
				const updatePreview = () => {
					if (!previewEl) return;
					const key = pendingSegment ? `S88${pendingSegment}A01` : "S88A01";
					previewEl.setText(
						t("setting.formatPreview", {
							name: `${key}${renderSeparator(pendingSymbol, pendingSpacing)}Sample note`,
						})
					);
				};
				new Setting(containerEl)
					.setName(t("setting.sepName"))
					.setDesc(t("setting.sepDesc"))
					.addDropdown((dropdown) =>
						dropdown
							.addOption("-", "-")
							.addOption("_", "_")
							.addOption(".", ".")
							.addOption("custom", t("setting.sepCustom"))
							.setValue(presetSymbols.includes(currentSymbol) ? currentSymbol : "custom")
							.onChange((value) => {
								if (value === "custom") {
									pendingSymbol = customInput?.value ?? "";
									customInput?.classList.remove("trellis-hidden");
									customInput?.focus();
								} else {
									pendingSymbol = value;
									customInput?.classList.add("trellis-hidden");
								}
								updatePreview();
							})
					)
					.addText((text) => {
						customInput = text.inputEl;
						text
							.setPlaceholder("~")
							.setValue(presetSymbols.includes(currentSymbol) ? "" : currentSymbol)
							.onChange((value) => {
								pendingSymbol = value;
								updatePreview();
							});
						text.inputEl.classList.toggle(
							"trellis-hidden",
							presetSymbols.includes(currentSymbol)
						);
					});

				new Setting(containerEl)
					.setName(t("setting.sepSpacingName"))
					.setDesc(t("setting.sepSpacingDesc"))
					.addDropdown((dropdown) => {
						for (const spacing of SEPARATOR_SPACING)
							dropdown.addOption(spacing, t(`spacing.${spacing}`));
						dropdown.setValue(pendingSpacing).onChange((value) => {
							pendingSpacing = SEPARATOR_SPACING.includes(value as SeparatorSpacing)
								? (value as SeparatorSpacing)
								: "none";
							updatePreview();
						});
					});

				new Setting(containerEl)
					.setName(t("setting.segmentSepName"))
					.setDesc(t("setting.segmentSepDesc"))
					.addDropdown((dropdown) => {
						dropdown.addOption("", t("segmentSep.hidden"));
						for (const separator of SEGMENT_SEPARATORS.slice(1))
							dropdown.addOption(separator, separator);
						dropdown.setValue(pendingSegment).onChange((value) => {
							pendingSegment = SEGMENT_SEPARATORS.includes(value as SegmentSeparator)
								? (value as SegmentSeparator)
								: "";
							updatePreview();
						});
					});

				previewEl = containerEl.createDiv({ cls: "setting-item-description" });
				updatePreview();
				new Setting(containerEl)
					.setName(t("setting.formatApplyName"))
					.setDesc(t("setting.formatApplyDesc"))
					.addButton((button) =>
						button.setButtonText(t("setting.apply")).onClick(() => {
							if (!isValidSeparator(pendingSymbol)) {
								new AlertModal(
									this.app,
									t("modal.badSep.title"),
									t("modal.badSep.desc")
								).open();
								return;
							}
							this.plugin.requestPrimaryFormattingChange(
								pendingSymbol,
								pendingSpacing,
								pendingSegment,
								() => this.render()
							);
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
						.onChange((value) => {
							const staged = cloneSchema(this.plugin.settings.schema);
							const tag = staged.slots.find((slot) => slot.role === "tag");
							const name = staged.slots.find((slot) => slot.role === "name");
							if (!tag) return;
							staged.slots = (
								value === "suffix" ? [name, tag] : [tag, name]
							).filter((slot): slot is KeySlot => slot !== undefined);
							this.plugin.requestSchemaChange(staged, () => this.render());
						})
				);

		}

		// Optional schema features stay physically out of the primary path. Keeping
		// them available but collapsed prevents a single-key setup from reading like
		// a schema editor. The disclosure remembers its state during local re-renders.
		const experimental = containerEl.createEl("details", {
			cls: "trellis-settings-disclosure",
		});
		experimental.open = this.experimentalOpen ?? this.plugin.settings.advancedMode;
		experimental.addEventListener("toggle", () => {
			this.experimentalOpen = experimental.open;
		});
		experimental.createEl("summary", { text: t("setting.experimentalName") });
		experimental.createEl("p", {
			cls: "setting-item-description trellis-settings-disclosure-desc",
			text: t("setting.experimentalDesc"),
		});

		// ID scheme preset for the primary tag slot (0.3.0, experimental). In
		// advanced mode the per-slot dropdown in the editor covers this.
		if (!this.plugin.settings.advancedMode) {
			new Setting(experimental)
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
			new Setting(experimental)
				.setName(t("setting.rootName"))
				.setDesc(t("setting.rootDesc"))
				.addText((text) =>
					text
						.setPlaceholder(ROOT_NAMESPACE_PLACEHOLDER)
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
		new Setting(experimental)
			.setName(t("setting.advName"))
			.setDesc(t("setting.advDesc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.advancedMode)
					.onChange(async (value) => {
						this.draftSchema = null; // drop any staged (unapplied) edits
						if (value) {
							this.plugin.settings.advancedMode = true;
							await this.plugin.saveSettings();
							this.render();
							return;
						}
						if (isMultiKey(this.plugin.settings.schema)) {
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
							this.plugin.requestSchemaChange(next, () => {
								if (
									JSON.stringify(this.plugin.settings.schema) ===
									JSON.stringify(next)
								) {
									this.plugin.settings.advancedMode = false;
									void this.plugin.saveSettings();
									new Notice(t("notice.advReset"));
								}
								this.render();
							});
							return;
						}
						this.plugin.settings.advancedMode = false;
						await this.plugin.saveSettings();
						this.plugin.rebuildTrees();
						this.render();
					})
			);
		if (this.plugin.settings.advancedMode) this.renderSlotEditor(experimental);

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
			if (!SEPARATOR_SPACING.includes(separatorSpacingAt(schema, i)))
				return t("adv.invalid.spacing", { n: i + 1 });
		}
		if (separatorConflicts(schema).length > 0) return t("adv.invalid.conflict");
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
			row.settingEl.addClass("trellis-slot-row");
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
							delete slot.scheme;
							delete slot.segmentSeparator;
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
				row.addDropdown((dropdown) => {
					dropdown.addOption("", t("segmentSep.hidden"));
					for (const separator of SEGMENT_SEPARATORS.slice(1))
						dropdown.addOption(separator, separator);
					dropdown.setValue(slot.segmentSeparator ?? "").onChange((value) => {
						slot.segmentSeparator = SEGMENT_SEPARATORS.includes(
							value as SegmentSeparator
						)
							? (value as SegmentSeparator)
							: "";
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
				const current = schema.separators[i] ?? "-";
				const presets = ["-", "_", "."];
				let customInput: HTMLInputElement | null = null;
				const separatorRow = new Setting(containerEl)
					.setName(t("adv.sep", { n: i + 1, a: i + 1, b: i + 2 }))
					.addDropdown((dropdown) =>
						dropdown
							.addOption("-", "-")
							.addOption("_", "_")
							.addOption(".", ".")
							.addOption("custom", t("setting.sepCustom"))
							.setValue(presets.includes(current) ? current : "custom")
							.onChange((value) => {
								if (value === "custom") {
									customInput?.classList.remove("trellis-hidden");
									customInput?.focus();
								} else {
									schema.separators[i] = value;
									customInput?.classList.add("trellis-hidden");
								}
							})
					)
					.addText((text) => {
						customInput = text.inputEl;
						text
							.setPlaceholder("~")
							.setValue(presets.includes(current) ? "" : current)
							.onChange((value) => (schema.separators[i] = value));
						text.inputEl.classList.toggle("trellis-hidden", presets.includes(current));
					})
					.addDropdown((dropdown) => {
						for (const spacing of SEPARATOR_SPACING)
							dropdown.addOption(spacing, t(`spacing.${spacing}`));
						dropdown.setValue(separatorSpacingAt(schema, i)).onChange((value) => {
							if (!schema.separatorSpacing) schema.separatorSpacing = [];
							schema.separatorSpacing[i] = SEPARATOR_SPACING.includes(
								value as SeparatorSpacing
							)
								? (value as SeparatorSpacing)
								: "none";
						});
					});
				separatorRow.settingEl.addClass("trellis-slot-row");
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
							this.ensureSeparators(schema);
							schema.rootNamespace = this.plugin.settings.schema.rootNamespace;
							const staged = cloneSchema(schema);
							this.plugin.requestSchemaChange(staged, () => {
								if (
									JSON.stringify(this.plugin.settings.schema) ===
									JSON.stringify(staged)
								) {
									this.draftSchema = null;
									new Notice(t("notice.advApplied"));
								}
								this.render();
							});
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

	private inventoryFile(file: TFile): TagInventoryFile {
		const cache = this.app.metadataCache.getFileCache(file);
		return {
			path: file.path,
			allTags: cache ? getAllTags(cache) ?? [] : [],
			frontmatterTags: normalizeTagList(cache?.frontmatter?.tags),
		};
	}

	private rebuildTagInventory() {
		const schema = cloneSchema(this.plugin.settings.schema);
		const inventory = new TagInventory(schema);
		for (const file of this.app.vault.getMarkdownFiles()) {
			inventory.upsertFile(this.inventoryFile(file));
		}
		this.tagInventory = inventory;
		this.inventorySchemaFingerprint = JSON.stringify(this.plugin.settings.schema);
	}

	private ensureTagInventory() {
		const fingerprint = JSON.stringify(this.plugin.settings.schema);
		if (!this.tagInventory || this.inventorySchemaFingerprint !== fingerprint) {
			this.rebuildTagInventory();
		}
	}

	private scheduleStatsRender() {
		if (this.statsTimer !== null) window.clearTimeout(this.statsTimer);
		this.statsTimer = window.setTimeout(() => {
			this.statsTimer = null;
			this.renderStatsContents();
		}, 200);
	}

	private updateInventoryFile(file: TFile) {
		if (file.extension !== "md" || !this.tagInventory) return;
		if (this.tagInventory.upsertFile(this.inventoryFile(file))) {
			this.scheduleStatsRender();
		}
	}

	private startStatsWatch() {
		this.rebuildTagInventory();
		const changed = this.app.metadataCache.on("changed", (file) =>
			this.updateInventoryFile(file)
		);
		this.statsCleanups.push(() => this.app.metadataCache.offref(changed));
		const created = this.app.vault.on("create", (file) => {
			if (file instanceof TFile) this.updateInventoryFile(file);
		});
		this.statsCleanups.push(() => this.app.vault.offref(created));
		const deleted = this.app.vault.on("delete", (file) => {
			if (file instanceof TFile && this.tagInventory?.removeFile(file.path)) {
				this.scheduleStatsRender();
			}
		});
		this.statsCleanups.push(() => this.app.vault.offref(deleted));
		const renamed = this.app.vault.on("rename", (file, oldPath) => {
			if (
				file instanceof TFile &&
				file.extension === "md" &&
				this.tagInventory?.renameFile(oldPath, this.inventoryFile(file))
			) {
				this.scheduleStatsRender();
			}
		});
		this.statsCleanups.push(() => this.app.vault.offref(renamed));
	}

	private stopStatsWatch() {
		for (const cleanup of this.statsCleanups.splice(0)) cleanup();
		if (this.statsTimer !== null) window.clearTimeout(this.statsTimer);
		this.statsTimer = null;
		this.statsEl = null;
		this.tagInventory = null;
		this.inventorySchemaFingerprint = "";
	}

	/** Live, read-only inventory under the currently applied filename schema. */
	private renderStats(containerEl: HTMLElement) {
		this.statsEl = containerEl.createDiv({ cls: "trellis-tag-inventory" });
		this.renderStatsContents();
	}

	private renderStatsContents() {
		if (!this.statsEl?.isConnected) return;
		this.ensureTagInventory();
		const inventory = this.tagInventory;
		if (!inventory) return;
		const snapshot = inventory.snapshot();
		this.statsEl.empty();
		new Setting(this.statsEl)
			.setName(t("setting.statsName"))
			.setDesc(
				t("setting.statsDesc", {
					managed: snapshot.managedNotes,
					total: snapshot.totalNotes,
					tags: snapshot.managedOccurrences,
					paths: snapshot.uniqueManagedPaths,
				})
			);
		new Setting(this.statsEl)
			.setName(t("setting.statsGeneralName"))
			.setDesc(
				t("setting.statsGeneralDesc", {
					tags: snapshot.generalOccurrences,
					unique: snapshot.uniqueGeneralTags,
				})
			);
		for (const key of snapshot.tagKeys) {
			new Setting(this.statsEl)
				.setName(
					t("setting.statsKeyName", {
						n: key.slotIndex + 1,
						ns: key.fullNamespace,
					})
				)
				.setDesc(
					t("setting.statsKeyDesc", {
						notes: key.notes,
						tags: key.occurrences,
						paths: key.uniquePaths,
						duplicates: key.duplicateNotes,
						inline: key.inlineOnlyNotes,
						roots: key.namespaceNodeNotes,
					})
				);
			if (key.paths.length > 0) {
				const details = this.statsEl.createEl("details", {
					cls: "trellis-tag-inventory-paths",
				});
				details.createEl("summary", {
					text: t("setting.statsPaths", { n: Math.min(5, key.paths.length) }),
				});
				for (const path of key.paths.slice(0, 5)) {
					details.createDiv({
						text: `#${path.tagPath} · ${path.count}`,
						cls: "setting-item-description",
					});
				}
				if (key.paths.length > 5) {
					details.createDiv({
						text: t("setting.statsMore", { n: key.paths.length - 5 }),
						cls: "setting-item-description",
					});
				}
			}
		}
		if (snapshot.rootOwnedUnmatchedOccurrences > 0) {
			new Setting(this.statsEl)
				.setName(t("setting.statsRootUnknownName"))
				.setDesc(
					t("setting.statsRootUnknownDesc", {
						n: snapshot.rootOwnedUnmatchedOccurrences,
					})
				);
		}
	}

	/** Keep separators aligned with the slot count (n slots → n-1 separators). */
	private ensureSeparators(schema: TrellisSchema) {
		const need = Math.max(0, schema.slots.length - 1);
		const fill = schema.separators[schema.separators.length - 1] || "-";
		while (schema.separators.length < need) schema.separators.push(fill);
		schema.separators.length = need;
		if (!schema.separatorSpacing) schema.separatorSpacing = [];
		while (schema.separatorSpacing.length < need)
			schema.separatorSpacing.push("none");
		schema.separatorSpacing.length = need;
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
