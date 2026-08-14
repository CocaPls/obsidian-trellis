import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	TFile,
	getAllTags,
	type ButtonComponent,
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

type FilenameSelection =
	| { kind: "slot"; index: number }
	| { kind: "gap"; index: number };

type SettingsSection = "overview" | "tags" | "filename" | "views";

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

function cleanNamespaceInput(value: string): string {
	return value.trim().replace(/^#/, "").replace(/\/$/, "");
}

export class TrellisSettingTab extends PluginSettingTab {
	private readonly plugin: TrellisPlugin;
	private draftSchema: TrellisSchema | null = null;
	private tagInventory: TagInventory | null = null;
	private inventorySchemaFingerprint = "";
	private statsEl: HTMLElement | null = null;
	private statsTimer: number | null = null;
	private statsCleanups: (() => void)[] = [];
	private filenameSelection: FilenameSelection | null = null;
	private activeSection: SettingsSection = "overview";
	private statusExpanded = false;
	private selectedTagDefinitionId: string | null = null;
	private addingTagDefinition = false;
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

		containerEl.createEl("p", {
			cls: "setting-item-description trellis-settings-intro",
			text: t("setting.intro"),
		});
		this.renderNavigation(containerEl);
		const panel = containerEl.createDiv({
			cls: "trellis-settings-panel",
			attr: {
				role: "tabpanel",
				id: `trellis-settings-panel-${this.activeSection}`,
				"aria-labelledby": `trellis-settings-tab-${this.activeSection}`,
			},
		});
		if (this.activeSection === "overview") this.renderOverview(panel);
		else if (this.activeSection === "tags") this.renderTagDefinitions(panel);
		else if (this.activeSection === "filename") this.renderFilenameStructure(panel);
		else this.renderViews(panel);
	}

	private renderNavigation(containerEl: HTMLElement) {
		const sections: SettingsSection[] = ["overview", "tags", "filename", "views"];
		const nav = containerEl.createDiv({
			cls: "trellis-settings-nav",
			attr: { role: "tablist", "aria-label": t("setting.navLabel") },
		});
		for (const section of sections) {
			const selected = section === this.activeSection;
			const button = nav.createEl("button", {
				cls: "trellis-settings-nav-item",
				text: t(`setting.nav.${section}`),
				attr: {
					type: "button",
					role: "tab",
					id: `trellis-settings-tab-${section}`,
					"aria-selected": String(selected),
					"aria-controls": `trellis-settings-panel-${section}`,
					tabindex: selected ? "0" : "-1",
				},
			});
			button.classList.toggle("is-active", selected);
			button.classList.toggle(
				"has-pending",
				section === "filename" && this.draftDirty()
			);
			const activate = () => {
				this.activeSection = section;
				this.render();
				this.containerEl.scrollTop = 0;
			};
			button.addEventListener("click", activate);
			button.addEventListener("keydown", (event) => {
				let nextIndex = sections.indexOf(section);
				if (event.key === "ArrowRight") nextIndex = (nextIndex + 1) % sections.length;
				else if (event.key === "ArrowLeft") {
					nextIndex = (nextIndex - 1 + sections.length) % sections.length;
				} else if (event.key === "Home") nextIndex = 0;
				else if (event.key === "End") nextIndex = sections.length - 1;
				else return;
				event.preventDefault();
				this.activeSection = sections[nextIndex];
				this.render();
				this.containerEl
					.querySelector<HTMLElement>(".trellis-settings-nav-item.is-active")
					?.focus();
			});
		}
	}

	private renderOverview(containerEl: HTMLElement) {
		new Setting(containerEl).setName(t("setting.overviewName")).setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description trellis-section-description",
			text: t("setting.overviewDesc"),
		});
		const snapshot = this.tagInventory?.snapshot();
		if (snapshot) {
			const metrics = containerEl.createDiv({ cls: "trellis-settings-metrics" });
			this.renderMetric(
				metrics,
				t("setting.metricManaged"),
				`${snapshot.managedNotes} / ${snapshot.totalNotes}`
			);
			this.renderMetric(
				metrics,
				t("setting.metricPaths"),
				String(snapshot.uniqueManagedPaths)
			);
			this.renderMetric(
				metrics,
				t("setting.metricDrift"),
				String(snapshot.filenameDrift.length),
				snapshot.filenameDrift.length > 0 ? "warning" : "ok"
			);
			this.renderMetric(
				metrics,
				t("setting.metricCollisions"),
				String(snapshot.filenameCollisions.length),
				snapshot.filenameCollisions.length > 0 ? "danger" : "ok"
			);
		}

		new Setting(containerEl)
			.setName(t("setting.overviewFilename"))
			.setDesc(
				this.plugin.settings.filenameSyncEnabled
					? t("setting.filenameSyncOn")
					: t("setting.filenameSyncOff")
			)
			.addButton((button) =>
				button.setButtonText(t("setting.configureFilename")).onClick(() => {
					this.activeSection = "filename";
					this.render();
				})
			);
		new Setting(containerEl)
			.setName(t("setting.overviewViews"))
			.setDesc(
				this.plugin.settings.treeViewEnabled
					? t("setting.treeEnabled")
					: t("setting.treeDisabled")
			)
			.addButton((button) =>
				button.setButtonText(t("setting.configureViews")).onClick(() => {
					this.activeSection = "views";
					this.render();
				})
			);

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

		const details = containerEl.createEl("details", {
			cls: "trellis-settings-details",
		});
		details.open = this.statusExpanded;
		const summary = details.createEl("summary", {
			cls: "trellis-settings-details-summary",
		});
		const copy = summary.createSpan({ cls: "trellis-settings-details-copy" });
		copy.createSpan({
			cls: "trellis-settings-details-title",
			text: t("setting.statusDisclosure"),
		});
		copy.createSpan({
			cls: "trellis-settings-details-desc",
			text: t("setting.statusDisclosureDesc"),
		});
		details.addEventListener("toggle", () => {
			this.statusExpanded = details.open;
		});
		this.renderStats(details);
	}

	private renderMetric(
		containerEl: HTMLElement,
		label: string,
		value: string,
		state: "ok" | "warning" | "danger" = "ok"
	) {
		const metric = containerEl.createDiv({ cls: `trellis-settings-metric is-${state}` });
		metric.createDiv({ cls: "trellis-settings-metric-value", text: value });
		metric.createDiv({ cls: "trellis-settings-metric-label", text: label });
	}

	private resetDraft() {
		this.draftSchema = null;
		this.inventorySchemaFingerprint = "";
	}

	private renderTagDefinitions(containerEl: HTMLElement) {
		const heading = new Setting(containerEl)
			.setName(t("setting.section.tags"))
			.setHeading();
		heading.addButton((button) =>
			button
				.setButtonText(t("setting.tagAdd"))
				.onClick(() => {
					this.addingTagDefinition = true;
					this.render();
				})
		);
		containerEl.createEl("p", {
			cls: "setting-item-description trellis-section-description",
			text: t("setting.tagsDesc"),
		});
		const currentRoot = (this.plugin.settings.schema.rootNamespace ?? "").trim();
		let pendingRoot = currentRoot;
		let rootApply: ButtonComponent | null = null;
		const updateRootApply = () => {
			const next = cleanNamespaceInput(pendingRoot);
			rootApply?.setDisabled(next === currentRoot || Boolean(next && !isValidNamespace(next)));
		};
		new Setting(containerEl)
			.setName(t("setting.ownerAdvanced"))
			.setDesc(t("setting.ownerAdvancedDesc"))
			.addText((text) =>
				text
					.setPlaceholder(ROOT_NAMESPACE_PLACEHOLDER)
					.setValue(pendingRoot)
					.onChange((value) => {
						pendingRoot = value;
						updateRootApply();
					})
			)
			.addButton((button) => {
				rootApply = button;
				button
					.setButtonText(t("setting.apply"))
					.setDisabled(true)
					.onClick(() => {
						const next = cleanNamespaceInput(pendingRoot);
						if (next && !isValidNamespace(next)) {
							new Notice(t("notice.rootBadChar"));
							return;
						}
						this.resetDraft();
						this.plugin.requestRootChange(next, () => this.render());
					});
			});

		const definitions = this.plugin.tagDefinitions();
		if (this.addingTagDefinition || definitions.length === 0) {
			this.renderTagDefinitionAdd(containerEl, definitions.length > 0);
		}
		if (!definitions.some((definition) => definition.id === this.selectedTagDefinitionId)) {
			this.selectedTagDefinitionId = definitions[0]?.id ?? null;
		}
		if (definitions.length > 0) {
			if (definitions.length > 1) {
				const list = containerEl.createDiv({ cls: "trellis-tag-definition-list" });
				for (const definition of definitions) {
					this.renderTagDefinitionChoice(list, definition);
				}
			}
			const selected = definitions.find(
				(definition) => definition.id === this.selectedTagDefinitionId
			);
			if (selected) this.renderTagDefinition(containerEl, selected);
		}

	}

	private renderTagDefinitionAdd(containerEl: HTMLElement, cancellable: boolean) {
		let newName = "";
		let newNamespace = "";
		let addButton: ButtonComponent | null = null;
		const updateAddButton = () => {
			addButton?.setDisabled(!isValidNamespace(cleanNamespaceInput(newNamespace)));
		};
		const setting = new Setting(containerEl)
			.setName(t("setting.tagAdd"))
			.setDesc(t("setting.tagAddDesc"))
			.addText((text) =>
				text
					.setPlaceholder(t("setting.tagNamePlaceholder"))
					.onChange((value) => (newName = value))
			)
			.addText((text) =>
				text
					.setPlaceholder(t("setting.tagNamespacePlaceholder"))
					.onChange((value) => {
						newNamespace = value;
						updateAddButton();
					})
			)
			.addButton((button) => {
				addButton = button;
				button
					.setButtonText(t("setting.add"))
					.setCta()
					.setDisabled(true)
					.onClick(async () => {
						const clean = cleanNamespaceInput(newNamespace);
						if (!isValidNamespace(clean)) {
							new Notice(t("notice.nsBadChar"));
							return;
						}
						const id = await this.plugin.addTagDefinition(clean, newName);
						if (!id) {
							new Notice(t("notice.tagDefinitionExists"));
							return;
						}
						this.selectedTagDefinitionId = id;
						this.addingTagDefinition = false;
						this.resetDraft();
						this.render();
					});
			});
		setting.settingEl.addClass("trellis-tag-definition-add");
		if (cancellable) {
			setting.addButton((button) =>
				button.setButtonText(t("modal.confirm.cancel")).onClick(() => {
					this.addingTagDefinition = false;
					this.render();
				})
			);
		}
	}

	private renderTagDefinitionChoice(
		containerEl: HTMLElement,
		definition: TrellisTagDefinition
	) {
		const selected = definition.id === this.selectedTagDefinitionId;
		const inFilename = this.plugin.settings.schema.slots.some(
			(slot) => slot.role === "tag" && slot.tagDefinitionId === definition.id
		);
		const button = containerEl.createEl("button", {
			cls: "trellis-tag-definition-choice",
			attr: { type: "button", "aria-pressed": String(selected) },
		});
		button.classList.toggle("is-selected", selected);
		const color = button.createSpan({ cls: "trellis-tag-definition-color" });
		color.style.setProperty("--trellis-tag-color", definition.color || "#7c6df2");
		const text = button.createSpan({ cls: "trellis-tag-definition-text" });
		text.createSpan({
			cls: "trellis-tag-definition-name",
			text: definition.name || definition.namespace,
		});
		text.createEl("code", {
			cls: "trellis-tag-definition-path",
			text: `#${nsPath(this.plugin.settings.schema, definition.namespace)}/…`,
		});
		const badges = button.createSpan({ cls: "trellis-tag-definition-badges" });
		if (inFilename) {
			badges.createSpan({
				cls: "trellis-tag-definition-badge",
				text: t("setting.tagBadgeFilename"),
			});
		}
		if (definition.sidebarVisible) {
			badges.createSpan({
				cls: "trellis-tag-definition-badge",
				text: t("setting.tagBadgeSidebar"),
			});
		}
		button.addEventListener("click", () => {
			this.selectedTagDefinitionId = definition.id;
			this.render();
		});
	}

	private renderTagDefinition(containerEl: HTMLElement, definition: TrellisTagDefinition) {
		const editor = containerEl.createDiv({
			cls: "trellis-settings-card trellis-tag-editor-card",
		});
		const header = editor.createDiv({ cls: "trellis-tag-editor-header" });
		const identity = header.createDiv({ cls: "trellis-tag-editor-identity" });
		const color = identity.createSpan({ cls: "trellis-tag-definition-color" });
		color.style.setProperty("--trellis-tag-color", definition.color || "#7c6df2");
		const title = identity.createDiv({ cls: "trellis-tag-editor-title" });
		title.createSpan({
			cls: "trellis-tag-definition-name",
			text: definition.name || definition.namespace,
		});
		title.createEl("code", {
			cls: "trellis-tag-definition-path",
			text: `#${nsPath(this.plugin.settings.schema, definition.namespace)}/…`,
		});
		const badges = header.createDiv({ cls: "trellis-tag-definition-badges" });
		if (
			this.plugin.settings.schema.slots.some(
				(slot) => slot.role === "tag" && slot.tagDefinitionId === definition.id
			)
		) {
			badges.createSpan({
				cls: "trellis-tag-definition-badge",
				text: t("setting.tagBadgeFilename"),
			});
		}
		if (definition.sidebarVisible) {
			badges.createSpan({
				cls: "trellis-tag-definition-badge",
				text: t("setting.tagBadgeSidebar"),
			});
		}
		const card = editor.createDiv({ cls: "trellis-settings-card-body" });

		let pendingName = definition.name;
		new Setting(card)
			.setName(t("setting.tagDisplayName"))
			.setDesc(t("setting.tagDisplayNameDesc"))
			.addText((text) => {
				text.setValue(definition.name).onChange((value) => (pendingName = value));
				text.inputEl.addEventListener("change", () => {
					void this.plugin
						.updateTagDefinition(definition.id, { name: pendingName })
						.then(() => this.render());
				});
			});

		let pendingNamespace = definition.namespace;
		let namespaceApply: ButtonComponent | null = null;
		const updateNamespaceApply = () => {
			const next = cleanNamespaceInput(pendingNamespace);
			namespaceApply?.setDisabled(
				!isValidNamespace(next) || next === definition.namespace
			);
		};
		new Setting(card)
			.setName(t("setting.tagNamespace"))
			.setDesc(t("setting.tagNamespaceDesc"))
			.addText((text) =>
				text
					.setValue(definition.namespace)
					.onChange((value) => {
						pendingNamespace = value;
						updateNamespaceApply();
					})
			)
			.addButton((button) => {
				namespaceApply = button;
				button
					.setButtonText(t("setting.apply"))
					.setDisabled(true)
					.onClick(() => {
						const clean = cleanNamespaceInput(pendingNamespace);
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
					});
			});

		new Setting(card)
			.setName(t("setting.tagSidebarVisible"))
			.setDesc(t("setting.tagSidebarVisibleDesc"))
			.addToggle((toggle) =>
				toggle.setValue(definition.sidebarVisible).onChange(async (value) => {
					await this.plugin.updateTagDefinition(definition.id, {
						sidebarVisible: value,
					});
					this.render();
				})
			);

		new Setting(card)
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

		new Setting(card)
			.setName(t("setting.valueRule"))
			.setDesc(t("setting.valueRuleDesc"))
			.addDropdown((dropdown) =>
					dropdown
						.addOption("", t("valueRule.none"))
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
		if (definition.valueRule) this.renderValueRuleOptions(card, definition);

		new Setting(card)
			.setName(t("setting.tagRemove"))
			.setDesc(t("setting.tagRemoveDesc"))
			.addButton((button) =>
				button
					.setButtonText(t("setting.tagRemoveButton"))
					.setClass("trellis-destructive")
					.setDisabled(
						this.plugin.settings.schema.slots.some(
							(slot) =>
								slot.role === "tag" && slot.tagDefinitionId === definition.id
						) ||
							Boolean(
								this.tagInventory
									?.snapshot()
									.tagKeys.find((row) => row.tagDefinitionId === definition.id)
									?.notes
							)
					)
					.onClick(async () => {
						if (!(await this.plugin.removeTagDefinition(definition.id))) {
							new Notice(t("notice.tagDefinitionInUse"));
							return;
						}
						this.selectedTagDefinitionId = null;
						this.resetDraft();
						this.render();
					})
			);
	}

	private renderViews(containerEl: HTMLElement) {
		new Setting(containerEl).setName(t("setting.section.views")).setHeading();
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
		this.renderSidebar(containerEl);
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
		const selection = this.ensureFilenameSelection(schema);
		const exampleParts = schema.slots.map((slot, index) => {
			if (slot.role === "name") return t("setting.filenameExampleName");
			const definition = tagDefinitionById(schema, slot.tagDefinitionId);
			const sample = (definition?.name || definition?.namespace || `TAG${index + 1}`)
				.trim()
				.replace(/\s+/g, "");
			return sample || `TAG${index + 1}`;
		});
		const filenameResult = containerEl.createDiv({
			cls: "trellis-filename-result",
		});
		const resultCopy = filenameResult.createDiv({
			cls: "trellis-filename-result-copy",
		});
		resultCopy.createSpan({
			cls: "trellis-filename-result-label",
			text: t("setting.filenamePreview"),
		});
		resultCopy.createSpan({
			cls: "trellis-filename-result-hint",
			text: t("setting.filenamePreviewHint"),
		});
		filenameResult.createEl("code", {
			text: assembleBasenameMulti(exampleParts, schema) || "—",
		});

		const workspace = containerEl.createDiv({ cls: "trellis-filename-workspace" });
		const outline = workspace.createDiv({ cls: "trellis-filename-outline" });
		outline.createDiv({
			cls: "trellis-filename-outline-title",
			text: t("setting.filenameParts"),
		});
		const sequence = outline.createDiv({ cls: "trellis-filename-sequence" });
		schema.slots.forEach((slot, index) => {
			this.renderFilenameSequenceSlot(sequence, schema, slot, index, selection);
			if (index < schema.slots.length - 1) {
				this.renderFilenameSequenceGap(sequence, schema, index, selection);
			}
		});

		const selectedEditor = workspace.createDiv({
			cls: "trellis-filename-selection",
		});
		if (selection?.kind === "slot") {
			const index = selection.index;
			if (index >= 0) {
				this.renderFilenameSlotEditor(
					selectedEditor,
					schema,
					schema.slots[index],
					index
				);
			}
		} else if (selection?.kind === "gap") {
			this.renderGapEditor(selectedEditor, schema, selection.index);
		}

		const usedDefinitions = new Set(
			schema.slots
				.filter((slot) => slot.role === "tag")
				.map((slot) => slot.tagDefinitionId)
		);
		const available = schemaTagDefinitions(schema).find(
			(definition) => !usedDefinitions.has(definition.id)
		);
		const hasName = schema.slots.some((slot) => slot.role === "name");
		if (available || !hasName) {
			const addSlot = new Setting(containerEl)
				.setName(t("setting.slotAdd"))
				.setDesc(t("setting.slotAddDesc"));
			if (available) {
				addSlot.addButton((button) =>
					button.setButtonText(t("setting.addTagSlot")).onClick(() => {
						const id = nextSlotId(schema);
						schema.slots.push({
							id,
							role: "tag",
							tagDefinitionId: available.id,
						});
						this.filenameSelection = {
							kind: "slot",
							index: schema.slots.length - 1,
						};
						this.ensureSeparators(schema);
						this.render();
					})
				);
			}
			if (!hasName) {
				addSlot.addButton((button) =>
					button.setButtonText(t("setting.addNameSlot")).onClick(() => {
						const id = nextSlotId(schema);
						schema.slots.push({ id, role: "name" });
						this.filenameSelection = {
							kind: "slot",
							index: schema.slots.length - 1,
						};
						this.ensureSeparators(schema);
						this.render();
					})
				);
			}
		}

		if (this.draftDirty()) {
			new Setting(containerEl)
				.setName(t("setting.filenamePending"))
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
						this.filenameSelection = null;
						this.render();
					})
				);
		}
	}

	private ensureFilenameSelection(
		schema: TrellisSchema
	): FilenameSelection | null {
		if (
			this.filenameSelection?.kind === "slot" &&
			this.filenameSelection.index >= 0 &&
			this.filenameSelection.index < schema.slots.length
		) {
			return this.filenameSelection;
		}
		if (
			this.filenameSelection?.kind === "gap" &&
			this.filenameSelection.index >= 0 &&
			this.filenameSelection.index < schema.slots.length - 1
		) {
			return this.filenameSelection;
		}
		const first = schema.slots[0];
		this.filenameSelection = first ? { kind: "slot", index: 0 } : null;
		return this.filenameSelection;
	}

	private filenamePartLabel(
		schema: TrellisSchema,
		slot: KeySlot,
		index: number
	): { title: string; meta: string } {
		const definition = tagDefinitionById(schema, slot.tagDefinitionId);
		const partType =
			slot.role === "tag"
				? t("setting.filenamePartTag")
				: t("setting.filenamePartName");
		return {
			title: t("setting.slotTitle", { n: index + 1, type: partType }),
			meta:
				slot.role === "tag" && definition
					? definition.name || definition.namespace
					: "",
		};
	}

	private renderFilenameSequenceSlot(
		containerEl: HTMLElement,
		schema: TrellisSchema,
		slot: KeySlot,
		index: number,
		selection: FilenameSelection | null
	) {
		const label = this.filenamePartLabel(schema, slot, index);
		const button = containerEl.createEl("button", {
			cls: "trellis-filename-sequence-slot",
			attr: { type: "button" },
		});
		button.createSpan({
			cls: "trellis-filename-sequence-title",
			text: label.title,
		});
		if (label.meta) {
			button.createSpan({
				cls: "trellis-filename-sequence-meta",
				text: label.meta,
			});
		}
		const selected = selection?.kind === "slot" && selection.index === index;
		button.classList.toggle("is-selected", selected);
		button.setAttribute("aria-pressed", String(selected));
		button.addEventListener("click", () => {
			this.filenameSelection = { kind: "slot", index };
			this.render();
		});
	}

	private renderFilenameSequenceGap(
		containerEl: HTMLElement,
		schema: TrellisSchema,
		index: number,
		selection: FilenameSelection | null
	) {
		const button = containerEl.createEl("button", {
			cls: "trellis-filename-sequence-gap",
			attr: {
				type: "button",
				"aria-label": t("setting.gapName", { a: index + 1, b: index + 2 }),
			},
		});
		button.createSpan({
			cls: "trellis-filename-sequence-title",
			text: t("setting.filenameSeparatorPart"),
		});
		button.createEl("code", {
			text: renderSeparator(
				schema.separators[index] ?? "-",
				separatorSpacingAt(schema, index)
			),
		});
		const selected = selection?.kind === "gap" && selection.index === index;
		button.classList.toggle("is-selected", selected);
		button.setAttribute("aria-pressed", String(selected));
		button.addEventListener("click", () => {
			this.filenameSelection = { kind: "gap", index };
			this.render();
		});
	}

	private renderFilenameSlotEditor(
		containerEl: HTMLElement,
		schema: TrellisSchema,
		slot: KeySlot,
		index: number
	) {
		const definition = tagDefinitionById(schema, slot.tagDefinitionId);
		const label = this.filenamePartLabel(schema, slot, index);
		const heading = new Setting(containerEl).setName(label.title).setHeading();
		if (slot.role === "tag" && definition) {
			heading.setDesc(
				`${definition.name || definition.namespace} · #${nsPath(
					schema,
					definition.namespace
				)}/…`
			);
		}
		heading
			.addExtraButton((button) =>
				button
					.setIcon("chevron-left")
					.setTooltip(t("setting.partMoveUp"))
					.setDisabled(index === 0)
					.onClick(() => {
						if (index === 0) return;
						[schema.slots[index - 1], schema.slots[index]] = [
							schema.slots[index],
							schema.slots[index - 1],
						];
						this.filenameSelection = { kind: "slot", index: index - 1 };
						this.render();
					})
			)
			.addExtraButton((button) =>
				button
					.setIcon("chevron-right")
					.setTooltip(t("setting.partMoveDown"))
					.setDisabled(index === schema.slots.length - 1)
					.onClick(() => {
						if (index === schema.slots.length - 1) return;
						[schema.slots[index], schema.slots[index + 1]] = [
							schema.slots[index + 1],
							schema.slots[index],
						];
						this.filenameSelection = { kind: "slot", index: index + 1 };
						this.render();
					})
			)
			.addExtraButton((button) =>
				button
					.setIcon("trash-2")
					.setTooltip(t("setting.partRemove"))
					.onClick(() => {
						this.removeSlot(schema, index);
						this.filenameSelection = schema.slots.length
							? {
									kind: "slot",
									index: Math.min(index, schema.slots.length - 1),
								}
							: null;
						this.render();
					})
			);

		const definitions = schemaTagDefinitions(schema);
		if (slot.role === "tag" && (definitions.length > 1 || !definition)) {
			new Setting(containerEl)
				.setName(t("setting.slotSource"))
				.addDropdown((dropdown) => {
					for (const candidate of definitions) {
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
		if (slot.role === "tag") this.renderHierarchySetting(containerEl, slot);
		this.renderWrapperSetting(containerEl, slot);
	}

	private renderHierarchySetting(containerEl: HTMLElement, slot: KeySlot) {
		const current = slot.segmentSeparator ?? "";
		let customInput: HTMLInputElement | null = null;
		new Setting(containerEl)
			.setName(t("setting.segmentSepName"))
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
				text.inputEl.addEventListener("change", () => this.render());
			})
			.addText((text) => {
				rightInput = text.inputEl;
				text
					.setPlaceholder("〉")
					.setValue(slot.wrapper?.kind === "custom" ? (slot.wrapper.right ?? "") : "")
					.onChange((value) => {
						if (slot.wrapper?.kind === "custom") slot.wrapper.right = value;
					});
				text.inputEl.addEventListener("change", () => this.render());
			});
		toggleCustom(current === "custom");
	}

	private renderGapEditor(
		containerEl: HTMLElement,
		schema: TrellisSchema,
		index: number
	) {
		const current = schema.separators[index] ?? "-";
		let customInput: HTMLInputElement | null = null;
		new Setting(containerEl)
			.setName(t("setting.gapName", { a: index + 1, b: index + 2 }))
			.setHeading();
		new Setting(containerEl)
			.setName(t("setting.separatorSymbol"))
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
				text.inputEl.addEventListener("change", () => this.render());
				text.inputEl.classList.toggle("trellis-hidden", BOUNDARY_PRESETS.includes(current));
			});
		new Setting(containerEl)
			.setName(t("setting.separatorSpacing"))
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
					this.render();
				})
			);

		const options = containerEl.createDiv({ cls: "trellis-sidebar-options" });
		if (!this.plugin.settings.treeViewEnabled) {
			options.addClass("is-disabled");
			options.setAttribute("aria-disabled", "true");
			options.createEl("p", {
				cls: "setting-item-description trellis-sidebar-disabled-note",
				text: t("setting.treeOptionsDisabled"),
			});
		}
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

		new Setting(options)
			.setName(t("setting.headerButtonsName"))
			.setDesc(t("setting.headerButtonsDesc"))
			.setHeading();
		const headerButtons = options.createDiv({ cls: "trellis-settings-toggle-grid" });
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
		if (!this.plugin.settings.treeViewEnabled) {
			options
				.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
					"input, select, button"
				)
				.forEach((control) => {
					control.disabled = true;
				});
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
			if (this.activeSection === "overview") this.render();
			else this.renderStatsContents();
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
		if (snapshot.filenameCollisions.length > 0) {
			const setting = new Setting(this.statsEl)
				.setName(t("setting.statsCollisionName"))
				.setDesc(
					t("setting.statsCollisionDesc", {
						n: snapshot.filenameCollisions.length,
					})
				);
			setting.settingEl.addClass("trellis-inventory-danger");
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
