import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	TFile,
	getAllTags,
} from "obsidian";
import {
	SeparatorSpacing,
	TrellisSchema,
	type KeySlot,
	type SlotWrapperKind,
	type TagValueRule,
	type TrellisTagDefinition,
	assembleBasenameMulti,
	isValidHierarchySeparator,
	isValidNamespace,
	isValidSeparator,
	isValidSlotWrapper,
	normalizeTagList,
	nsPath,
	renderSeparator,
	schemaTagDefinitions,
	separatorConflicts,
	separatorSpacingAt,
	tagDefinitionById,
} from "./tagkey";
import { TagInventory, type TagInventoryFile } from "./tag-inventory";
import { HEADER_BUTTON_IDS } from "./tree-view";
import { AlertModal } from "./modals";
import { setLang, t } from "./i18n";
import type TrellisPlugin from "./main";

const ROOT_NAMESPACE_PLACEHOLDER = "work";
const DASHED_DATE_FORMAT = "YYYY-MM-DD";
const SEGMENT_PRESETS = ["", ".", "-", "_"];
const BOUNDARY_PRESETS = ["-", "_", ".", "·"];
const SPACING_OPTIONS: SeparatorSpacing[] = ["none", "before", "after", "both"];
const WRAPPER_OPTIONS: SlotWrapperKind[] = ["none", "round", "custom"];

function cloneSchema(schema: TrellisSchema): TrellisSchema {
	return {
		rootNamespace: schema.rootNamespace,
		tagDefinitions: schema.tagDefinitions?.map((definition) => ({
			...definition,
			valueRule: definition.valueRule ? { ...definition.valueRule } : undefined,
		})),
		slots: schema.slots.map((slot) => ({
			...slot,
			wrapper: slot.wrapper ? { ...slot.wrapper } : undefined,
		})),
		separators: [...schema.separators],
		separatorSpacing: schema.separatorSpacing
			? [...schema.separatorSpacing]
			: undefined,
	};
}

function nextSlotId(schema: TrellisSchema): string {
	const used = new Set(schema.slots.map((slot) => slot.id));
	let index = schema.slots.length + 1;
	while (used.has(`slot-${index}`)) index++;
	return `slot-${index}`;
}

function defaultRule(kind: string): TagValueRule | undefined {
	if (kind === "alternating") {
		return {
			kind,
			firstLevel: "alphabet",
			letterCase: "upper",
			numberWidth: 2,
		};
	}
	if (kind === "sequence") return { kind, start: 1, numberWidth: "auto" };
	if (kind === "date") return { kind, dateFormat: "YYYYMMDD" };
	if (kind === "timestamp") {
		return { kind, timestampPrecision: "second", timezone: "local" };
	}
	return undefined;
}

export class TrellisSettingTab extends PluginSettingTab {
	private readonly plugin: TrellisPlugin;
	private draftSchema: TrellisSchema | null = null;
	private tagInventory: TagInventory | null = null;
	private inventorySchemaFingerprint = "";
	private statsEl: HTMLElement | null = null;
	private statsTimer: number | null = null;
	private statsCleanups: (() => void)[] = [];
	/** Session-only disclosure state. It keeps the settings page compact without
	 * making an open section snap shut whenever one of its controls re-renders. */
	private disclosureState = new Map<string, boolean>();

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
		this.plugin.flushQueuedSettingsSave();
		this.stopStatsWatch();
		super.hide();
	}

	private render() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("trellis-settings");
		this.ensureTagInventory();

		new Setting(containerEl).setName(t("setting.section.general")).setHeading();
		new Setting(containerEl)
			.setName(t("setting.langName"))
			.setDesc(t("setting.langDesc"))
			.addDropdown((dropdown) =>
				dropdown
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
						this.plugin.applyTreeViewName();
						this.render();
					})
			);

		this.renderTagDefinitions(containerEl);
		this.renderFilenameStructure(containerEl);
		this.renderSidebar(containerEl);

		new Setting(containerEl).setName(t("setting.section.status")).setHeading();
		const status = this.renderDisclosure(
			containerEl,
			"vault-status",
			t("setting.statusDisclosure"),
			t("setting.statusDisclosureDesc")
		);
		this.renderStats(status);
	}

	private resetDraft() {
		this.draftSchema = null;
		this.inventorySchemaFingerprint = "";
	}

	private renderDisclosure(
		containerEl: HTMLElement,
		key: string,
		title: string,
		description: string,
		defaultOpen = false
	): HTMLElement {
		const details = containerEl.createEl("details", {
			cls: "trellis-settings-disclosure",
		});
		details.open = this.disclosureState.get(key) ?? defaultOpen;
		details.createEl("summary", { text: title });
		if (description) {
			details.createEl("p", {
				cls: "setting-item-description trellis-settings-disclosure-desc",
				text: description,
			});
		}
		details.addEventListener("toggle", () => {
			this.disclosureState.set(key, details.open);
		});
		return details.createDiv({ cls: "trellis-settings-disclosure-body" });
	}

	private renderCardDisclosure(
		containerEl: HTMLElement,
		key: string,
		title: string,
		meta: string
	): HTMLElement {
		const details = containerEl.createEl("details", {
			cls: "trellis-settings-card",
		});
		details.open = this.disclosureState.get(key) ?? false;
		const summary = details.createEl("summary", {
			cls: "trellis-settings-card-summary",
		});
		summary.createSpan({ cls: "trellis-settings-card-title", text: title });
		summary.createEl("code", { cls: "trellis-settings-card-meta", text: meta });
		details.addEventListener("toggle", () => {
			this.disclosureState.set(key, details.open);
		});
		return details.createDiv({ cls: "trellis-settings-card-body" });
	}

	private renderTagDefinitions(containerEl: HTMLElement) {
		new Setting(containerEl).setName(t("setting.section.tags")).setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description trellis-section-description",
			text: t("setting.tagsDesc"),
		});
		// Keep display-mode examples neutral and stable. Using the first live
		// definition here leaked a user's own taxonomy into screenshots and made
		// the four choices harder to compare after a namespace rename.
		const exampleName = "Projects";
		const examplePath = "projects/website/design";
		const exampleTerminal = "design";
		new Setting(containerEl)
			.setName(t("setting.propertyTagDisplayName"))
			.setDesc(t("setting.propertyTagDisplayDesc"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("full", t("propertyTagDisplay.full", { path: examplePath }))
					.addOption("name", t("propertyTagDisplay.name", { name: exampleName }))
					.addOption(
						"name-terminal",
						t("propertyTagDisplay.nameTerminal", {
							name: exampleName,
							terminal: exampleTerminal,
						})
					)
					.addOption(
						"terminal",
						t("propertyTagDisplay.terminal", { terminal: exampleTerminal })
					)
					.setValue(this.plugin.settings.propertyTagDisplay)
					.onChange((value) => {
						const mode =
							value === "name" || value === "name-terminal" || value === "terminal"
								? value
								: "full";
						void this.plugin.setPropertyTagDisplay(mode);
					})
			);

		const ownerRoot = this.renderDisclosure(
			containerEl,
			"owner-root",
			t("setting.ownerAdvanced"),
			t("setting.ownerAdvancedDesc")
		);
		let pendingRoot = (this.plugin.settings.schema.rootNamespace ?? "").trim();
		new Setting(ownerRoot)
			.setName(t("setting.rootName"))
			.setDesc(t("setting.rootDesc"))
			.addText((text) =>
				text
					.setPlaceholder(ROOT_NAMESPACE_PLACEHOLDER)
					.setValue(pendingRoot)
					.onChange((value) => (pendingRoot = value))
			)
			.addButton((button) =>
				button.setButtonText(t("setting.apply")).onClick(() => {
					const next = pendingRoot.trim().replace(/^#/, "").replace(/\/$/, "");
					if (next && !isValidNamespace(next)) {
						new Notice(t("notice.rootBadChar"));
						return;
					}
					this.resetDraft();
					this.plugin.requestRootChange(next, () => this.render());
				})
			);

		for (const definition of this.plugin.tagDefinitions()) {
			this.renderTagDefinition(containerEl, definition);
		}

		let newName = "";
		let newNamespace = "";
		const addTag = this.renderDisclosure(
			containerEl,
			"add-tag",
			t("setting.tagAdd"),
			t("setting.tagAddDesc")
		);
		new Setting(addTag)
			.setName(t("setting.tagAddFields"))
			.addText((text) =>
				text
					.setPlaceholder(t("setting.tagNamePlaceholder"))
					.onChange((value) => (newName = value))
			)
			.addText((text) =>
				text
					.setPlaceholder(t("setting.tagNamespacePlaceholder"))
					.onChange((value) => (newNamespace = value))
			)
			.addButton((button) =>
				button.setButtonText(t("setting.add")).onClick(async () => {
					const clean = newNamespace.trim().replace(/^#/, "").replace(/\/$/, "");
					if (!isValidNamespace(clean)) {
						new Notice(t("notice.nsBadChar"));
						return;
					}
					const id = await this.plugin.addTagDefinition(clean, newName);
					if (!id) {
						new Notice(t("notice.tagDefinitionExists"));
						return;
					}
					this.resetDraft();
					this.render();
				})
			);
	}

	private renderTagDefinition(containerEl: HTMLElement, definition: TrellisTagDefinition) {
		const card = this.renderCardDisclosure(
			containerEl,
			`definition-${definition.id}`,
			definition.name || definition.namespace,
			`#${nsPath(this.plugin.settings.schema, definition.namespace)}/…`
		);

		let pendingName = definition.name;
		new Setting(card)
			.setName(t("setting.tagDisplayName"))
			.setDesc(t("setting.tagDisplayNameDesc"))
			.addText((text) => {
				text.setValue(definition.name).onChange((value) => (pendingName = value));
				text.inputEl.addEventListener("change", () => {
					void this.plugin.updateTagDefinition(definition.id, { name: pendingName });
				});
			});

		let pendingNamespace = definition.namespace;
		new Setting(card)
			.setName(t("setting.tagNamespace"))
			.setDesc(t("setting.tagNamespaceDesc"))
			.addText((text) =>
				text
					.setValue(definition.namespace)
					.onChange((value) => (pendingNamespace = value))
			)
			.addButton((button) =>
				button.setButtonText(t("setting.apply")).onClick(() => {
					const clean = pendingNamespace
						.trim()
						.replace(/^#/, "")
						.replace(/\/$/, "");
					if (!isValidNamespace(clean)) {
						new Notice(t("notice.nsBadChar"));
						return;
					}
					this.resetDraft();
					this.plugin.requestTagDefinitionNamespaceChange(
						definition.id,
						clean,
						() => this.render()
					);
				})
			);

		new Setting(card)
			.setName(t("setting.tagSidebarVisible"))
			.setDesc(t("setting.tagSidebarVisibleDesc"))
			.addToggle((toggle) =>
				toggle.setValue(definition.sidebarVisible).onChange(async (value) => {
					await this.plugin.updateTagDefinition(definition.id, {
						sidebarVisible: value,
					});
				})
			);

		const advanced = this.renderDisclosure(
			card,
			`tag-${definition.id}`,
			t("setting.tagAdvanced"),
			t("setting.tagAdvancedDesc")
		);

		new Setting(advanced)
			.setName(t("setting.tagColor"))
			.setDesc(t("setting.tagColorDesc"))
			.addColorPicker((picker) =>
				picker
					.setValue(definition.color ?? "#7c6df2")
					.onChange((value) => this.plugin.updateTagDefinitionColor(definition.id, value))
			)
			.addExtraButton((button) =>
				button
					.setIcon("rotate-ccw")
					.setTooltip(t("setting.colorReset"))
					.onClick(() => {
						void this.plugin
							.updateTagDefinition(definition.id, { color: "" })
							.then(() => this.render());
					})
			);

		new Setting(advanced)
			.setName(t("setting.valueRule"))
			.setDesc(t("setting.valueRuleDesc"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("", t("scheme.none"))
					.addOption("alternating", t("valueRule.alternating"))
					.addOption("sequence", t("valueRule.sequence"))
					.addOption("date", t("valueRule.date"))
					.addOption("timestamp", t("valueRule.timestamp"))
					.setValue(definition.valueRule?.kind ?? "")
					.onChange(async (value) => {
						await this.plugin.updateTagDefinition(definition.id, {
							valueRule: defaultRule(value) ?? null,
						});
						this.render();
					})
			);
		if (definition.valueRule) this.renderValueRuleOptions(advanced, definition);

		new Setting(advanced)
			.setName(t("setting.tagRemove"))
			.setDesc(t("setting.tagRemoveDesc"))
			.addButton((button) =>
				button
					.setButtonText(t("setting.tagRemoveButton"))
					.setClass("trellis-destructive")
					.onClick(async () => {
						if (!(await this.plugin.removeTagDefinition(definition.id))) {
							new Notice(t("notice.tagDefinitionInUse"));
							return;
						}
						this.resetDraft();
						this.render();
					})
			);
	}

	private renderValueRuleOptions(containerEl: HTMLElement, definition: TrellisTagDefinition) {
		const rule = definition.valueRule;
		if (!rule) return;
		const save = (next: TagValueRule) =>
			void this.plugin.updateTagDefinition(definition.id, { valueRule: next });

		if (rule.kind === "alternating") {
			new Setting(containerEl)
				.setName(t("valueRule.firstLevel"))
				.addDropdown((dropdown) =>
					dropdown
						.addOption("alphabet", t("valueRule.alphabet"))
						.addOption("number", t("valueRule.number"))
						.setValue(rule.firstLevel ?? "alphabet")
						.onChange((value) =>
							save({
								...rule,
								firstLevel: value === "number" ? "number" : "alphabet",
							})
						)
				)
				.addDropdown((dropdown) =>
					dropdown
						.addOption("upper", t("valueRule.upper"))
						.addOption("lower", t("valueRule.lower"))
						.setValue(rule.letterCase ?? "upper")
						.onChange((value) =>
							save({ ...rule, letterCase: value === "lower" ? "lower" : "upper" })
						)
				);
			this.renderNumberWidth(containerEl, rule, save);
		} else if (rule.kind === "sequence") {
			new Setting(containerEl)
				.setName(t("valueRule.sequenceStart"))
				.addDropdown((dropdown) =>
					dropdown
						.addOption("0", "0")
						.addOption("1", "1")
						.setValue(String(rule.start ?? 1))
						.onChange((value) => save({ ...rule, start: value === "0" ? 0 : 1 }))
				);
			this.renderNumberWidth(containerEl, rule, save);
		} else if (rule.kind === "date") {
			new Setting(containerEl)
				.setName(t("valueRule.dateFormat"))
				.addDropdown((dropdown) =>
					dropdown
						.addOption("YYYYMMDD", "YYYYMMDD")
						.addOption(DASHED_DATE_FORMAT, DASHED_DATE_FORMAT)
						.addOption("YYMMDD", "YYMMDD")
						.setValue(rule.dateFormat ?? "YYYYMMDD")
						.onChange((value) =>
							save({
								...rule,
								dateFormat:
									value === "YYYY-MM-DD" || value === "YYMMDD"
										? value
										: "YYYYMMDD",
							})
						)
				);
		} else {
			new Setting(containerEl)
				.setName(t("valueRule.timestampFormat"))
				.addDropdown((dropdown) =>
					dropdown
						.addOption("minute", t("valueRule.minute"))
						.addOption("second", t("valueRule.second"))
						.addOption("millisecond", t("valueRule.millisecond"))
						.setValue(rule.timestampPrecision ?? "second")
						.onChange((value) =>
							save({
								...rule,
								timestampPrecision:
									value === "minute" || value === "millisecond"
										? value
										: "second",
							})
						)
				)
				.addDropdown((dropdown) =>
					dropdown
						.addOption("local", t("valueRule.local"))
						.addOption("utc", "UTC")
						.setValue(rule.timezone ?? "local")
						.onChange((value) =>
							save({ ...rule, timezone: value === "utc" ? "utc" : "local" })
						)
				);
		}
		new Setting(containerEl)
			.setName(t("valueRule.example"))
			.setDesc(this.valueRuleExample(rule));
	}

	private renderNumberWidth(
		containerEl: HTMLElement,
		rule: TagValueRule,
		save: (next: TagValueRule) => void
	) {
		new Setting(containerEl)
			.setName(t("valueRule.numberWidth"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("auto", t("valueRule.auto"))
					.addOption("1", "1")
					.addOption("2", "2")
					.addOption("3", "3")
					.addOption("4", "4")
					.setValue(String(rule.numberWidth ?? "auto"))
					.onChange((value) => {
						const width = value === "auto" ? "auto" : Number(value);
						save({
							...rule,
							numberWidth:
								width === "auto" || width === 1 || width === 2 || width === 3 || width === 4
									? width
									: "auto",
						});
					})
			);
	}

	private valueRuleExample(rule: TagValueRule): string {
		if (rule.kind === "alternating") {
			const letter = rule.letterCase === "lower" ? "a" : "A";
			const width = rule.numberWidth === "auto" ? 1 : (rule.numberWidth ?? 2);
			const number = "1".padStart(width, "0");
			return rule.firstLevel === "number"
				? `${number} → ${letter} → ${String(2).padStart(width, "0")}`
				: `${letter} → ${number} → ${rule.letterCase === "lower" ? "b" : "B"}`;
		}
		if (rule.kind === "sequence") {
			const start = rule.start ?? 1;
			const width = rule.numberWidth === "auto" ? 1 : (rule.numberWidth ?? 1);
			return [start, start + 1, start + 2]
				.map((value) => String(value).padStart(width, "0"))
				.join(" → ");
		}
		if (rule.kind === "date") return rule.dateFormat ?? "YYYYMMDD";
		return `${rule.timezone === "utc" ? "UTC" : t("valueRule.local")} · ${t(
			`valueRule.${rule.timestampPrecision ?? "second"}`
		)}`;
	}

	private draft(): TrellisSchema {
		if (!this.draftSchema) {
			this.draftSchema = cloneSchema(this.plugin.settings.schema);
			this.ensureSeparators(this.draftSchema);
		} else {
			const live = cloneSchema(this.plugin.settings.schema);
			this.draftSchema.rootNamespace = live.rootNamespace;
			this.draftSchema.tagDefinitions = live.tagDefinitions;
		}
		return this.draftSchema;
	}

	private draftDirty(): boolean {
		return (
			this.draftSchema !== null &&
			JSON.stringify(this.draftSchema) !== JSON.stringify(this.plugin.settings.schema)
		);
	}

	private renderFilenameStructure(containerEl: HTMLElement) {
		new Setting(containerEl).setName(t("setting.section.filenameStructure")).setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description trellis-section-description",
			text: t("setting.filenameStructureDesc"),
		});
		new Setting(containerEl)
			.setName(t("setting.filenameSyncName"))
			.setDesc(
				this.plugin.settings.filenameSyncEnabled
					? t("setting.filenameSyncOn")
					: t("setting.filenameSyncOff")
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.filenameSyncEnabled)
					.onChange(async (value) => {
						await this.plugin.requestFilenameSyncEnabled(value, () => this.render());
						this.render();
					})
			);
		const schema = this.draft();
		this.ensureSeparators(schema);

		const preview = containerEl.createDiv({ cls: "trellis-filename-preview" });
		preview.createDiv({ cls: "trellis-filename-preview-label", text: t("setting.preview") });
		preview.createEl("code", { text: this.filenamePreview(schema) });
		const editor = this.renderDisclosure(
			containerEl,
			"filename-editor",
			t("setting.filenameEditor"),
			t("setting.filenameEditorDesc")
		);

		schema.slots.forEach((slot, index) => {
			this.renderFilenameSlot(editor, schema, slot, index);
			if (index < schema.slots.length - 1) {
				this.renderGap(editor, schema, index);
			}
		});

		const usedDefinitions = new Set(
			schema.slots
				.filter((slot) => slot.role === "tag")
				.map((slot) => slot.tagDefinitionId)
		);
		const available = schemaTagDefinitions(schema).find(
			(definition) => !usedDefinitions.has(definition.id)
		);
		const hasName = schema.slots.some((slot) => slot.role === "name");
		new Setting(editor)
			.setName(t("setting.slotAdd"))
			.setDesc(t("setting.slotAddDesc"))
			.addButton((button) =>
				button
					.setButtonText(t("setting.addTagSlot"))
					.setDisabled(!available)
					.onClick(() => {
						if (!available) return;
						schema.slots.push({
							id: nextSlotId(schema),
							role: "tag",
							tagDefinitionId: available.id,
						});
						this.ensureSeparators(schema);
						this.render();
					})
			)
			.addButton((button) =>
				button
					.setButtonText(t("setting.addNameSlot"))
					.setDisabled(hasName)
					.onClick(() => {
						if (hasName) return;
						schema.slots.push({ id: nextSlotId(schema), role: "name" });
						this.ensureSeparators(schema);
						this.render();
					})
			);

		if (this.draftDirty()) {
			new Setting(editor)
				.setName(t("adv.pending"))
				.setDesc(t("setting.pendingDesc"))
				.addButton((button) =>
					button
						.setButtonText(t("adv.apply"))
						.setCta()
						.onClick(() => {
							const error = this.validateDraft(schema);
							if (error) {
								new AlertModal(this.app, t("adv.invalidTitle"), error).open();
								return;
							}
							const staged = cloneSchema(schema);
							staged.rootNamespace = this.plugin.settings.schema.rootNamespace;
							staged.tagDefinitions = cloneSchema(
								this.plugin.settings.schema
							).tagDefinitions;
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
				.addButton((button) =>
					button.setButtonText(t("adv.revert")).onClick(() => {
						this.draftSchema = null;
						this.render();
					})
				);
		}
	}

	private filenamePreview(schema: TrellisSchema): string {
		const values = schema.slots.map((slot) => {
			if (slot.role === "name") return t("setting.previewName");
			return ["PRJ", "DOC", "01"].join(slot.segmentSeparator ?? "");
		});
		return assembleBasenameMulti(values, schema) || t("setting.previewUnmanaged");
	}

	private renderFilenameSlot(
		containerEl: HTMLElement,
		schema: TrellisSchema,
		slot: KeySlot,
		index: number
	) {
		const card = containerEl.createDiv({ cls: "trellis-slot-card" });
		const definition = tagDefinitionById(schema, slot.tagDefinitionId);
		const heading = new Setting(card)
			.setName(
				t("setting.slotTitle", {
					n: index + 1,
					type: slot.role === "tag" ? t("adv.roleTag") : t("adv.roleName"),
				})
			)
			.setDesc(
				slot.role === "tag" && definition
					? `${definition.name || definition.namespace} · #${nsPath(
							schema,
							definition.namespace
						)}/…`
					: t("setting.nameSlotDesc")
			)
			.setHeading();
		heading
			.addExtraButton((button) =>
				button
					.setIcon("arrow-up")
					.setTooltip(t("adv.moveUp"))
					.setDisabled(index === 0)
					.onClick(() => {
						if (index === 0) return;
						[schema.slots[index - 1], schema.slots[index]] = [
							schema.slots[index],
							schema.slots[index - 1],
						];
						this.render();
					})
			)
			.addExtraButton((button) =>
				button
					.setIcon("arrow-down")
					.setTooltip(t("adv.moveDown"))
					.setDisabled(index === schema.slots.length - 1)
					.onClick(() => {
						if (index === schema.slots.length - 1) return;
						[schema.slots[index], schema.slots[index + 1]] = [
							schema.slots[index + 1],
							schema.slots[index],
						];
						this.render();
					})
			)
			.addExtraButton((button) =>
				button
					.setIcon("trash-2")
					.setTooltip(t("adv.remove"))
					.onClick(() => {
						this.removeSlot(schema, index);
						this.render();
					})
			);

		if (slot.role === "tag") {
			new Setting(card)
				.setName(t("setting.slotSource"))
				.setDesc(t("setting.slotSourceDesc"))
				.addDropdown((dropdown) => {
					for (const candidate of schemaTagDefinitions(schema)) {
						dropdown.addOption(
							candidate.id,
							`${candidate.name || candidate.namespace} · #${candidate.namespace}`
						);
					}
					dropdown.setValue(slot.tagDefinitionId ?? "").onChange((value) => {
						slot.tagDefinitionId = value;
						this.render();
					});
				});
		}
		const formatting = this.renderDisclosure(
			card,
			`slot-${slot.id ?? index}`,
			t("setting.slotFormatting"),
			t("setting.slotFormattingDesc")
		);
		if (slot.role === "tag") this.renderHierarchySetting(formatting, slot);
		this.renderWrapperSetting(formatting, slot);
	}

	private renderHierarchySetting(containerEl: HTMLElement, slot: KeySlot) {
		const current = slot.segmentSeparator ?? "";
		let customInput: HTMLInputElement | null = null;
		new Setting(containerEl)
			.setName(t("setting.segmentSepName"))
			.setDesc(t("setting.segmentSepDesc"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("", t("segmentSep.hidden"))
					.addOption(".", ".")
					.addOption("-", "-")
					.addOption("_", "_")
					.addOption("custom", t("setting.sepCustom"))
					.setValue(SEGMENT_PRESETS.includes(current) ? current : "custom")
					.onChange((value) => {
						if (value === "custom") {
							customInput?.classList.remove("trellis-hidden");
							customInput?.focus();
							return;
						}
						slot.segmentSeparator = value;
						customInput?.classList.add("trellis-hidden");
						this.render();
					})
			)
			.addText((text) => {
				customInput = text.inputEl;
				text
					.setPlaceholder("~")
					.setValue(SEGMENT_PRESETS.includes(current) ? "" : current)
					.onChange((value) => (slot.segmentSeparator = value));
				text.inputEl.addEventListener("change", () => this.render());
				text.inputEl.classList.toggle("trellis-hidden", SEGMENT_PRESETS.includes(current));
			});
	}

	private renderWrapperSetting(containerEl: HTMLElement, slot: KeySlot) {
		const current = slot.wrapper?.kind ?? "none";
		let leftInput: HTMLInputElement | null = null;
		let rightInput: HTMLInputElement | null = null;
		const toggleCustom = (visible: boolean) => {
			leftInput?.classList.toggle("trellis-hidden", !visible);
			rightInput?.classList.toggle("trellis-hidden", !visible);
		};
		new Setting(containerEl)
			.setName(t("setting.wrapperName"))
			.setDesc(t("setting.wrapperDesc"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("none", t("wrapper.none"))
					.addOption("round", t("wrapper.round"))
					.addOption("custom", t("wrapper.custom"))
					.setValue(WRAPPER_OPTIONS.includes(current) ? current : "none")
					.onChange((value) => {
						const kind: SlotWrapperKind =
							value === "round" || value === "custom" ? value : "none";
						if (kind === "none") delete slot.wrapper;
						else if (kind === "round") slot.wrapper = { kind };
						else {
							slot.wrapper = {
								kind,
								left: leftInput?.value ?? "",
								right: rightInput?.value ?? "",
							};
						}
						toggleCustom(kind === "custom");
						this.render();
					})
			)
			.addText((text) => {
				leftInput = text.inputEl;
				text
					.setPlaceholder("〈")
					.setValue(slot.wrapper?.kind === "custom" ? (slot.wrapper.left ?? "") : "")
					.onChange((value) => {
						if (slot.wrapper?.kind === "custom") slot.wrapper.left = value;
					});
			})
			.addText((text) => {
				rightInput = text.inputEl;
				text
					.setPlaceholder("〉")
					.setValue(slot.wrapper?.kind === "custom" ? (slot.wrapper.right ?? "") : "")
					.onChange((value) => {
						if (slot.wrapper?.kind === "custom") slot.wrapper.right = value;
					});
			});
		toggleCustom(current === "custom");
	}

	private renderGap(containerEl: HTMLElement, schema: TrellisSchema, index: number) {
		const current = schema.separators[index] ?? "-";
		let customInput: HTMLInputElement | null = null;
		const row = new Setting(containerEl)
			.setName(t("adv.sep", { n: index + 1, a: index + 1, b: index + 2 }))
			.setDesc(
				t("setting.gapPreview", {
					value: renderSeparator(current, separatorSpacingAt(schema, index)),
				})
			)
			.addDropdown((dropdown) => {
				for (const preset of BOUNDARY_PRESETS) dropdown.addOption(preset, preset);
				dropdown
					.addOption("custom", t("setting.sepCustom"))
					.setValue(BOUNDARY_PRESETS.includes(current) ? current : "custom")
					.onChange((value) => {
						if (value === "custom") {
							customInput?.classList.remove("trellis-hidden");
							customInput?.focus();
						} else {
							schema.separators[index] = value;
							customInput?.classList.add("trellis-hidden");
							this.render();
						}
					});
			})
			.addText((text) => {
				customInput = text.inputEl;
				text
					.setPlaceholder("~")
					.setValue(BOUNDARY_PRESETS.includes(current) ? "" : current)
					.onChange((value) => (schema.separators[index] = value));
				text.inputEl.classList.toggle("trellis-hidden", BOUNDARY_PRESETS.includes(current));
			})
			.addDropdown((dropdown) => {
				for (const spacing of SPACING_OPTIONS) {
					dropdown.addOption(spacing, t(`spacing.${spacing}`));
				}
				dropdown.setValue(separatorSpacingAt(schema, index)).onChange((value) => {
					if (!schema.separatorSpacing) schema.separatorSpacing = [];
					schema.separatorSpacing[index] = SPACING_OPTIONS.includes(
						value as SeparatorSpacing
					)
						? (value as SeparatorSpacing)
						: "none";
					this.render();
				});
			});
		row.settingEl.addClass("trellis-gap-row");
	}

	private removeSlot(schema: TrellisSchema, index: number) {
		schema.slots.splice(index, 1);
		if (schema.separators.length > 0) {
			const gap = Math.min(index, schema.separators.length - 1);
			schema.separators.splice(gap, 1);
			schema.separatorSpacing?.splice(gap, 1);
		}
		this.ensureSeparators(schema);
	}

	private validateDraft(schema: TrellisSchema): string | null {
		if (schema.slots.filter((slot) => slot.role === "name").length > 1) {
			return t("adv.invalid.oneName");
		}
		const seenDefinitions = new Set<string>();
		for (const slot of schema.slots) {
			if (slot.role === "tag") {
				if (!tagDefinitionById(schema, slot.tagDefinitionId)) {
					return t("adv.invalid.missingDefinition");
				}
				if (seenDefinitions.has(slot.tagDefinitionId ?? "")) {
					return t("adv.invalid.duplicateDefinition");
				}
				seenDefinitions.add(slot.tagDefinitionId ?? "");
				if (!isValidHierarchySeparator(slot.segmentSeparator ?? "")) {
					return t("adv.invalid.segment");
				}
			}
			if (!isValidSlotWrapper(slot.wrapper)) return t("adv.invalid.wrapper");
		}
		const needed = Math.max(0, schema.slots.length - 1);
		for (let index = 0; index < needed; index++) {
			if (!isValidSeparator(schema.separators[index] ?? "")) {
				return t("adv.invalid.sep", { n: index + 1 });
			}
			if (!SPACING_OPTIONS.includes(separatorSpacingAt(schema, index))) {
				return t("adv.invalid.spacing", { n: index + 1 });
			}
		}
		if (separatorConflicts(schema).length > 0) return t("adv.invalid.conflict");
		return null;
	}

	private ensureSeparators(schema: TrellisSchema) {
		const needed = Math.max(0, schema.slots.length - 1);
		const fill = schema.separators[schema.separators.length - 1] || "-";
		while (schema.separators.length < needed) schema.separators.push(fill);
		schema.separators.length = needed;
		if (!schema.separatorSpacing) schema.separatorSpacing = [];
		while (schema.separatorSpacing.length < needed) {
			schema.separatorSpacing.push("none");
		}
		schema.separatorSpacing.length = needed;
	}

	private renderSidebar(containerEl: HTMLElement) {
		new Setting(containerEl).setName(t("setting.section.tree")).setHeading();
		new Setting(containerEl)
			.setName(t("setting.treeName"))
			.setDesc(t("setting.treeDesc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.treeViewEnabled).onChange(async (value) => {
					this.plugin.settings.treeViewEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.applyTreeViewState();
				})
			);

		const options = this.renderDisclosure(
			containerEl,
			"sidebar-options",
			t("setting.treeOptions"),
			t("setting.treeOptionsDesc")
		);
		const visible = this.plugin
			.tagDefinitions()
			.filter((definition) => definition.sidebarVisible);
		if (visible.length > 1) {
			new Setting(options)
				.setName(t("setting.treeTagKeyName"))
				.setDesc(t("setting.treeTagKeyDesc"))
				.addDropdown((dropdown) => {
					for (const definition of visible) {
						dropdown.addOption(
							definition.id,
							`${definition.name || definition.namespace} · #${nsPath(
								this.plugin.settings.schema,
								definition.namespace
							)}/…`
						);
					}
					dropdown
						.setValue(this.plugin.treeTagDefinitionId())
						.onChange((id) =>
							void this.plugin.setTreeTagDefinitionId(id)
						);
				});
		}

		new Setting(options)
			.setName(t("setting.treeLabelName"))
			.setDesc(t("setting.treeLabelDesc"))
			.addText((text) => {
				text
					.setPlaceholder(t("view.treeName"))
					.setValue(this.plugin.settings.treeViewName)
					.onChange((value) => {
						this.plugin.settings.treeViewName = value;
						this.plugin.applyTreeViewName();
					});
				text.inputEl.addEventListener("change", () => void this.plugin.saveSettings());
			});

		new Setting(options)
			.setName(t("setting.sortName"))
			.setDesc(t("setting.sortDesc"))
			.addDropdown((dropdown) =>
				dropdown
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

		new Setting(options)
			.setName(t("setting.treeModeName"))
			.setDesc(t("setting.treeModeDesc"))
			.addDropdown((dropdown) =>
				dropdown
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
			const hidden = this.plugin.hiddenSidebarBranches();
			if (hidden.length > 0) {
				new Setting(options)
					.setName(t("setting.hiddenBranchesName"))
					.setDesc(t("setting.hiddenBranchesDesc", { n: hidden.length }))
					.setHeading();
				for (const branch of hidden) {
					new Setting(options)
						.setName(branch.label)
						.addButton((button) =>
							button.setButtonText(t("setting.restore")).onClick(async () => {
								await this.plugin.restoreSidebarBranch(
									branch.tagDefinitionId,
									branch.relativePath
								);
								this.render();
							})
						);
				}
			}
			new Setting(options)
				.setName(t("setting.showRootName"))
				.setDesc(t("setting.showRootDesc"))
				.addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.treeShowRoot).onChange(async (value) => {
						this.plugin.settings.treeShowRoot = value;
						await this.plugin.saveSettings();
						this.plugin.rebuildTrees();
					})
				);
			new Setting(options)
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
			new Setting(options)
				.setName(t("setting.labelModeName"))
				.setDesc(t("setting.labelModeDesc"))
				.addDropdown((dropdown) =>
					dropdown
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

		const headerButtons = this.renderDisclosure(
			options,
			"sidebar-buttons",
			t("setting.headerButtonsName"),
			t("setting.headerButtonsDesc")
		);
		for (const id of HEADER_BUTTON_IDS) {
			new Setting(headerButtons)
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
		const unmanaged = snapshot.totalNotes - snapshot.managedNotes;
		new Setting(this.statsEl)
			.setName(t("setting.statsCombinationsName"))
			.setDesc(
				t("setting.statsCombinationsDesc", {
					n: snapshot.combinations.length,
					unmanaged,
				})
			);
		if (snapshot.combinations.length > 0) {
			const details = this.statsEl.createEl("details", {
				cls: "trellis-tag-inventory-paths",
			});
			details.createEl("summary", {
				text: t("setting.statsCombinationsShow", {
					n: Math.min(8, snapshot.combinations.length),
				}),
			});
			for (const combination of snapshot.combinations.slice(0, 8)) {
				details.createDiv({
					text: `${combination.namespaces.map((namespace) => `#${namespace}`).join(" + ")} · ${combination.notes}`,
					cls: "setting-item-description",
				});
			}
		}
		if (snapshot.filenameCollisions.length > 0) {
			const setting = new Setting(this.statsEl)
				.setName(t("setting.statsCollisionName"))
				.setDesc(
					t("setting.statsCollisionDesc", {
						n: snapshot.filenameCollisions.length,
					})
				);
			setting.settingEl.addClass("trellis-inventory-danger");
			const details = this.statsEl.createEl("details", {
				cls: "trellis-tag-inventory-paths trellis-inventory-danger-details",
			});
			details.createEl("summary", {
				text: t("setting.statsCollisionShow", {
					n: Math.min(5, snapshot.filenameCollisions.length),
				}),
			});
			for (const group of snapshot.filenameCollisions.slice(0, 5)) {
				details.createDiv({
					text: `${group.targetPath} ← ${group.notePaths.join(", ")}`,
					cls: "setting-item-description",
				});
			}
		}
		if (snapshot.filenameDrift.length > 0) {
			new Setting(this.statsEl)
				.setName(t("setting.statsDriftName"))
				.setDesc(
					t("setting.statsDriftDesc", {
						n: snapshot.filenameDrift.length,
						state: this.plugin.settings.filenameSyncEnabled
							? t("setting.statsDriftActive")
							: t("setting.statsDriftPaused"),
					})
				);
		}
		for (const key of snapshot.tagKeys) {
			new Setting(this.statsEl)
				.setName(
					key.slotIndex >= 0
						? t("setting.statsKeyName", {
								n: key.slotIndex + 1,
								ns: key.fullNamespace,
							})
						: t("setting.statsSidebarKeyName", { ns: key.fullNamespace })
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
}
