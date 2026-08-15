import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	TFile,
	getAllTags,
	setIcon,
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

type SettingsSection = "structure" | "general";
type FilenameSelection =
	| { kind: "slot"; index: number }
	| { kind: "gap"; index: number };
type TagDefinitionFilter = "active" | "archived" | "all";

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
	private statsCleanups: (() => void)[] = [];
	private activeSection: SettingsSection = "general";
	private filenameSelection: FilenameSelection | null = null;
	private draggedSlotIndex: number | null = null;
	private selectedTagDefinitionId: string | null = null;
	private addingTagDefinition = false;
	private tagDefinitionFilter: TagDefinitionFilter = "active";
	private tagSearchQuery = "";
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
		if (this.activeSection === "structure") this.renderStructure(panel);
		else this.renderGeneralSettings(panel);
	}

	private renderNavigation(containerEl: HTMLElement) {
		const sections: SettingsSection[] = ["general", "structure"];
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
				section === "structure" && this.draftDirty()
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

	private filenameUsesTagDefinition(id: string): boolean {
		const schemas = this.draftSchema
			? [this.plugin.settings.schema, this.draftSchema]
			: [this.plugin.settings.schema];
		return schemas.some((schema) =>
			schema.slots.some(
				(slot) => slot.role === "tag" && slot.tagDefinitionId === id
			)
		);
	}

	private renderStructure(containerEl: HTMLElement) {
		this.renderFilenameStructure(containerEl);
		this.renderTagDefinitions(containerEl);
	}

	private renderTagDefinitions(containerEl: HTMLElement) {
		new Setting(containerEl).setName(t("setting.section.tags")).setHeading();
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
						this.plugin.requestRootChange(next, () => this.render());
					});
				});

		const definitions = this.plugin.tagDefinitions();
		const activeDefinitions = definitions.filter((definition) => !definition.archived);
		const archivedDefinitions = definitions.filter((definition) => definition.archived);
		if (activeDefinitions.length === 0 && archivedDefinitions.length > 0) {
			this.tagDefinitionFilter = "archived";
		}
		if (definitions.length === 0) this.addingTagDefinition = true;
		const scopedDefinitions =
			this.tagDefinitionFilter === "active"
				? activeDefinitions
				: this.tagDefinitionFilter === "archived"
					? archivedDefinitions
					: [...activeDefinitions, ...archivedDefinitions];
		if (
			!this.addingTagDefinition &&
			!scopedDefinitions.some(
				(definition) => definition.id === this.selectedTagDefinitionId
			)
		) {
			this.selectedTagDefinitionId = scopedDefinitions[0]?.id ?? null;
		}

		const workspace = containerEl.createDiv({ cls: "trellis-tag-workspace" });
		const browser = workspace.createDiv({ cls: "trellis-tag-browser" });
		const toolbar = browser.createDiv({ cls: "trellis-tag-toolbar" });
		const search = toolbar.createDiv({ cls: "trellis-tag-search" });
		const searchIcon = search.createSpan({ cls: "trellis-tag-search-icon" });
		setIcon(searchIcon, "search");
		const searchInput = search.createEl("input", {
			type: "search",
			placeholder: t("setting.tagSearchPlaceholder"),
			value: this.tagSearchQuery,
			attr: { "aria-label": t("setting.tagSearch") },
		});
		const controls = toolbar.createDiv({ cls: "trellis-tag-toolbar-controls" });
		const filter = controls.createEl("select", {
			attr: { "aria-label": t("setting.tagFilter") },
		});
		filter.createEl("option", {
			value: "active",
			text: t("setting.tagFilterActive", { n: activeDefinitions.length }),
		});
		filter.createEl("option", {
			value: "archived",
			text: t("setting.tagFilterArchived", { n: archivedDefinitions.length }),
		});
		filter.createEl("option", {
			value: "all",
			text: t("setting.tagFilterAll", { n: definitions.length }),
		});
		filter.value = this.tagDefinitionFilter;
		filter.addEventListener("change", () => {
			this.tagDefinitionFilter =
				filter.value === "archived" || filter.value === "all"
					? filter.value
					: "active";
			this.addingTagDefinition = false;
			this.render();
		});
		const add = controls.createEl("button", {
			attr: { type: "button" },
		});
		const addIcon = add.createSpan({ cls: "trellis-button-icon" });
		setIcon(addIcon, "plus");
		add.createSpan({ text: t("setting.tagAdd") });
		add.disabled = this.addingTagDefinition;
		add.addEventListener("click", () => {
			this.addingTagDefinition = true;
			this.render();
		});

		const count = browser.createDiv({ cls: "trellis-tag-list-count" });
		const list = browser.createDiv({ cls: "trellis-tag-list" });
		const renderList = () => {
			list.empty();
			const query = this.tagSearchQuery.trim().toLocaleLowerCase();
			const shown = scopedDefinitions.filter((definition) => {
				if (!query) return true;
				const path = nsPath(this.plugin.settings.schema, definition.namespace);
				return `${definition.name} ${definition.namespace} ${path}`
					.toLocaleLowerCase()
					.includes(query);
			});
			count.setText(
				t("setting.tagListCount", {
					shown: shown.length,
					total: scopedDefinitions.length,
				})
			);
			if (shown.length === 0) {
				list.createDiv({
					cls: "trellis-tag-list-empty",
					text: t("setting.tagListEmpty"),
				});
				return;
			}
			for (const definition of shown) {
				const row = list.createEl("button", {
					cls: "trellis-tag-list-row",
					attr: { type: "button" },
				});
				row.classList.toggle(
					"is-selected",
					!this.addingTagDefinition &&
						definition.id === this.selectedTagDefinitionId
				);
				row.setAttribute(
					"aria-pressed",
					String(
						!this.addingTagDefinition &&
							definition.id === this.selectedTagDefinitionId
					)
				);
				const dot = row.createSpan({ cls: "trellis-tag-list-dot" });
				dot.style.setProperty(
					"--trellis-tag-list-color",
					definition.color || "var(--interactive-accent)"
				);
				const copy = row.createSpan({ cls: "trellis-tag-list-copy" });
				copy.createSpan({
					cls: "trellis-tag-list-name",
					text: definition.name || definition.namespace,
				});
				copy.createSpan({
					cls: "trellis-tag-list-path",
					text: `#${nsPath(this.plugin.settings.schema, definition.namespace)}/…`,
				});
				const badges = row.createSpan({ cls: "trellis-tag-list-badges" });
				if (this.filenameUsesTagDefinition(definition.id)) {
					badges.createSpan({
						cls: "trellis-tag-list-badge",
						text: t("setting.tagBadgeFilename"),
					});
				}
				if (definition.archived) {
					badges.createSpan({
						cls: "trellis-tag-list-badge is-archived",
						text: t("setting.tagArchivedSuffix"),
					});
				} else if (definition.sidebarVisible) {
					badges.createSpan({
						cls: "trellis-tag-list-badge",
						text: t("setting.tagBadgeSidebar"),
					});
				}
				row.addEventListener("click", () => {
					this.selectedTagDefinitionId = definition.id;
					this.addingTagDefinition = false;
					this.render();
				});
			}
		};
		searchInput.addEventListener("input", () => {
			this.tagSearchQuery = searchInput.value;
			renderList();
		});
		renderList();

		const detail = workspace.createDiv({ cls: "trellis-tag-detail" });
		if (this.addingTagDefinition) {
			this.renderTagDefinitionAdd(detail, definitions.length > 0);
		} else {
			const selected = definitions.find(
				(definition) => definition.id === this.selectedTagDefinitionId
			);
			if (selected) this.renderTagDefinition(detail, selected);
			else {
				detail.createDiv({
					cls: "trellis-tag-detail-empty",
					text: t("setting.tagDetailEmpty"),
				});
			}
		}
	}

	private renderTagDefinitionAdd(containerEl: HTMLElement, cancellable: boolean) {
		let newName = "";
		let newNamespace = "";
		let addButton: ButtonComponent | null = null;
		const updateAddButton = () => {
			addButton?.setDisabled(!isValidNamespace(cleanNamespaceInput(newNamespace)));
		};
		new Setting(containerEl)
			.setName(t("setting.tagAdd"))
			.setDesc(t("setting.tagAddDesc"))
			.setHeading();
		new Setting(containerEl)
			.setName(t("setting.tagDisplayName"))
			.addText((text) =>
				text
					.setPlaceholder(t("setting.tagNamePlaceholder"))
					.onChange((value) => (newName = value))
			);
		new Setting(containerEl)
			.setName(t("setting.tagNamespace"))
			.addText((text) =>
				text
					.setPlaceholder(t("setting.tagNamespacePlaceholder"))
					.onChange((value) => {
						newNamespace = value;
						updateAddButton();
					})
			);
		const actions = new Setting(containerEl)
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
						this.tagDefinitionFilter = "active";
						this.tagSearchQuery = "";
						this.render();
					});
			});
		actions.infoEl.remove();
		actions.settingEl.addClass("trellis-setting-actions");
		if (cancellable) {
			actions.addButton((button) =>
				button.setButtonText(t("modal.confirm.cancel")).onClick(() => {
					this.addingTagDefinition = false;
					this.render();
				})
			);
		}
	}

	private renderTagDefinition(containerEl: HTMLElement, definition: TrellisTagDefinition) {
		new Setting(containerEl)
			.setName(definition.name || definition.namespace)
			.setDesc(
				`#${nsPath(this.plugin.settings.schema, definition.namespace)}/…${
					definition.archived ? ` · ${t("setting.tagArchivedSuffix")}` : ""
				}`
			)
			.setHeading();
		const card = containerEl;

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
						this.plugin.requestTagDefinitionNamespaceChange(
							definition.id,
							clean,
							() => this.render()
						);
					});
			});

		if (!definition.archived) {
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
		}

		new Setting(containerEl)
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

		new Setting(containerEl)
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
		if (definition.valueRule) this.renderValueRuleOptions(containerEl, definition);

		const inFilename = this.filenameUsesTagDefinition(definition.id);
		if (definition.archived) {
			new Setting(containerEl)
				.setName(t("setting.tagRestore"))
				.setDesc(t("setting.tagRestoreDesc"))
					.addButton((button) =>
						button.setButtonText(t("setting.tagRestoreButton")).onClick(async () => {
							await this.plugin.updateTagDefinition(definition.id, { archived: false });
							this.tagDefinitionFilter = "active";
							this.render();
					})
				);
		} else {
			new Setting(containerEl)
				.setName(t("setting.tagArchive"))
				.setDesc(
					inFilename
						? t("setting.tagArchiveInFilename")
						: t("setting.tagArchiveDesc")
				)
				.addButton((button) =>
					button
						.setButtonText(t("setting.tagArchiveButton"))
						.setDisabled(inFilename)
						.onClick(async () => {
							await this.plugin.updateTagDefinition(definition.id, {
								archived: true,
							});
							this.tagDefinitionFilter = "archived";
							this.render();
						})
				);
		}

		new Setting(containerEl)
			.setName(t("setting.tagRemove"))
			.setDesc(t("setting.tagRemoveDesc"))
			.addButton((button) =>
				button
					.setButtonText(t("setting.tagRemoveButton"))
					.setClass("trellis-destructive")
					.setDisabled(
						this.filenameUsesTagDefinition(definition.id) ||
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
						this.render();
					})
			);
	}

	private renderGeneralSettings(containerEl: HTMLElement) {
		new Setting(containerEl).setName(t("setting.section.general")).setHeading();
		this.renderFilenameSyncSetting(containerEl);
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
		const result = containerEl.createDiv({ cls: "trellis-filename-result" });
		const resultCopy = result.createDiv({ cls: "trellis-filename-result-copy" });
		resultCopy.createSpan({
			cls: "trellis-filename-result-label",
			text: t("setting.filenamePreview"),
		});
		resultCopy.createSpan({
			cls: "trellis-filename-result-hint",
			text: t("setting.filenamePreviewHint"),
		});
		result.createEl("code", {
			text: assembleBasenameMulti(exampleParts, schema) || "—",
		});

		const usedDefinitions = new Set(
			schema.slots
				.filter((slot) => slot.role === "tag")
				.map((slot) => slot.tagDefinitionId)
		);
		const available = schemaTagDefinitions(schema).find(
			(definition) => !definition.archived && !usedDefinitions.has(definition.id)
		);
		const hasName = schema.slots.some((slot) => slot.role === "name");
		const composer = containerEl.createDiv({ cls: "trellis-filename-composer" });
		const composerHeader = composer.createDiv({
			cls: "trellis-filename-composer-header",
		});
		const composerCopy = composerHeader.createDiv({
			cls: "trellis-filename-composer-copy",
		});
		composerCopy.createSpan({
			cls: "trellis-filename-composer-title",
			text: t("setting.filenameComposerTitle"),
		});
		composerCopy.createSpan({
			cls: "trellis-filename-composer-hint",
			text: t("setting.filenameComposerHint"),
		});
		const addActions = composerHeader.createDiv({
			cls: "trellis-filename-add-actions",
		});
		const addTag = addActions.createEl("button", {
			cls: "mod-muted",
			attr: { type: "button" },
		});
		const addTagIcon = addTag.createSpan({ cls: "trellis-button-icon" });
		setIcon(addTagIcon, "plus");
		addTag.createSpan({ text: t("setting.addTagSlot") });
		addTag.disabled = !available;
		addTag.setAttribute(
			"aria-label",
			!available ? t("setting.addTagSlotUnavailable") : t("setting.addTagSlot")
		);
		addTag.addEventListener("click", () => {
			if (!available) return;
			const id = nextSlotId(schema);
			schema.slots.push({ id, role: "tag", tagDefinitionId: available.id });
			this.filenameSelection = { kind: "slot", index: schema.slots.length - 1 };
			this.ensureSeparators(schema);
			this.render();
		});
		const addName = addActions.createEl("button", {
			cls: "mod-muted",
			attr: { type: "button" },
		});
		const addNameIcon = addName.createSpan({ cls: "trellis-button-icon" });
		setIcon(addNameIcon, "plus");
		addName.createSpan({ text: t("setting.addNameSlot") });
		addName.disabled = hasName;
		addName.setAttribute(
			"aria-label",
			hasName ? t("setting.addNameSlotUnavailable") : t("setting.addNameSlot")
		);
		addName.addEventListener("click", () => {
			if (hasName) return;
			const id = nextSlotId(schema);
			schema.slots.push({ id, role: "name" });
			this.filenameSelection = { kind: "slot", index: schema.slots.length - 1 };
			this.ensureSeparators(schema);
			this.render();
		});

		const rail = composer.createDiv({ cls: "trellis-filename-rail" });
		if (schema.slots.length === 0) {
			rail.createDiv({
				cls: "trellis-filename-rail-empty",
				text: t("setting.filenameComposerEmpty"),
			});
		}
		schema.slots.forEach((slot, index) => {
			this.renderFilenameComposerSlot(rail, schema, slot, index, selection);
			if (index < schema.slots.length - 1) {
				this.renderFilenameComposerGap(rail, schema, index, selection);
			}
		});

		const editor = containerEl.createDiv({ cls: "trellis-filename-editor" });
		if (selection?.kind === "slot") {
			const index = selection.index;
			if (index >= 0) {
				this.renderFilenameSlotEditor(editor, schema, schema.slots[index], index);
			}
		} else if (selection?.kind === "gap") {
			this.renderGapEditor(editor, schema, selection.index);
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

	private ensureFilenameSelection(schema: TrellisSchema): FilenameSelection | null {
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
		this.filenameSelection = schema.slots[0] ? { kind: "slot", index: 0 } : null;
		return this.filenameSelection;
	}

	private renderFilenameSyncSetting(containerEl: HTMLElement) {
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

	private renderFilenameComposerSlot(
		containerEl: HTMLElement,
		schema: TrellisSchema,
		slot: KeySlot,
		index: number,
		selection: FilenameSelection | null
	) {
		const label = this.filenamePartLabel(schema, slot, index);
		const definition = tagDefinitionById(schema, slot.tagDefinitionId);
		const card = containerEl.createDiv({ cls: "trellis-filename-slot-card" });
		card.draggable = true;
		card.setAttribute("aria-label", `${label.title}. ${t("setting.slotDrag")}`);
		card.classList.toggle(
			"is-selected",
			selection?.kind === "slot" && selection.index === index
		);

		const select = card.createEl("button", {
			cls: "trellis-filename-slot-select",
			attr: { type: "button" },
		});
		select.setAttribute(
			"aria-pressed",
			String(selection?.kind === "slot" && selection.index === index)
		);
		const top = select.createSpan({ cls: "trellis-filename-slot-top" });
		top.createSpan({
			cls: "trellis-filename-slot-index",
			text: String(index + 1),
		});
		top.createSpan({
			cls: "trellis-filename-slot-kind",
			text: slot.role === "tag" ? t("setting.slotKindTag") : t("setting.slotKindName"),
		});
		select.createSpan({
			cls: "trellis-filename-slot-name",
			text:
				slot.role === "tag"
					? definition?.name || definition?.namespace || t("setting.slotMissingTag")
					: t("setting.filenameExampleName"),
		});
		if (slot.role === "tag" && definition) {
			select.createSpan({
				cls: "trellis-filename-slot-meta",
				text: `#${nsPath(schema, definition.namespace)}/…`,
			});
		}
		select.addEventListener("click", () => {
			this.filenameSelection = { kind: "slot", index };
			this.render();
		});

		const remove = card.createEl("button", {
			cls: "clickable-icon trellis-filename-slot-remove",
			attr: {
				type: "button",
				"aria-label": t("setting.partRemove"),
			},
		});
		setIcon(remove, "x");
		remove.addEventListener("click", () => {
			this.removeSlot(schema, index);
			const next = schema.slots[Math.min(index, schema.slots.length - 1)];
			this.filenameSelection = next
				? { kind: "slot", index: Math.min(index, schema.slots.length - 1) }
				: null;
			this.render();
		});

		card.addEventListener("dragstart", (event) => {
			this.draggedSlotIndex = index;
			card.classList.add("is-dragging");
			if (event.dataTransfer) {
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData("text/plain", slot.id ?? String(index));
			}
		});
		card.addEventListener("dragover", (event) => {
			if (this.draggedSlotIndex === null) return;
			event.preventDefault();
			const after = event.clientX > card.getBoundingClientRect().left + card.clientWidth / 2;
			card.classList.toggle("drop-before", !after);
			card.classList.toggle("drop-after", after);
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		});
		card.addEventListener("dragleave", () => {
			card.classList.remove("drop-before", "drop-after");
		});
		card.addEventListener("drop", (event) => {
			event.preventDefault();
			const from = this.draggedSlotIndex;
			if (from === null) return;
			const after = event.clientX > card.getBoundingClientRect().left + card.clientWidth / 2;
			this.moveFilenameSlot(schema, from, index + (after ? 1 : 0));
			this.draggedSlotIndex = null;
			this.render();
		});
		card.addEventListener("dragend", () => {
			this.draggedSlotIndex = null;
			for (const item of Array.from(
				containerEl.querySelectorAll<HTMLElement>(".trellis-filename-slot-card")
			)) {
				item.classList.remove("is-dragging", "drop-before", "drop-after");
			}
		});
	}

	private renderFilenameComposerGap(
		containerEl: HTMLElement,
		schema: TrellisSchema,
		index: number,
		selection: FilenameSelection | null
	) {
		const button = containerEl.createEl("button", {
			cls: "trellis-filename-gap-button",
			attr: {
				type: "button",
				"aria-label": t("setting.gapName", { a: index + 1, b: index + 2 }),
			},
		});
		button.createEl("code", {
			text: renderSeparator(
				schema.separators[index] ?? "-",
				separatorSpacingAt(schema, index)
			),
		});
		button.classList.toggle(
			"is-selected",
			selection?.kind === "gap" && selection.index === index
		);
		button.addEventListener("click", () => {
			this.filenameSelection = { kind: "gap", index };
			this.render();
		});
	}

	private moveFilenameSlot(schema: TrellisSchema, from: number, insertion: number) {
		if (from < 0 || from >= schema.slots.length) return;
		const [slot] = schema.slots.splice(from, 1);
		if (!slot) return;
		const target = Math.max(
			0,
			Math.min(schema.slots.length, from < insertion ? insertion - 1 : insertion)
		);
		schema.slots.splice(target, 0, slot);
		this.filenameSelection = { kind: "slot", index: target };
		this.ensureSeparators(schema);
	}


	private renderFilenameSlotEditor(
		containerEl: HTMLElement,
		schema: TrellisSchema,
		slot: KeySlot,
		index: number
	) {
		const definition = tagDefinitionById(schema, slot.tagDefinitionId);
		const label = this.filenamePartLabel(schema, slot, index);
		const partEl = containerEl;
		partEl.addClass("trellis-filename-slot-editor");
		const heading = new Setting(partEl).setName(label.title);
		heading.settingEl.addClass("trellis-filename-part-title");
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
						const next = schema.slots[Math.min(index, schema.slots.length - 1)];
						this.filenameSelection = next
							? { kind: "slot", index: Math.min(index, schema.slots.length - 1) }
							: null;
						this.render();
					})
			);

		const definitions = schemaTagDefinitions(schema).filter(
			(candidate) => !candidate.archived || candidate.id === slot.tagDefinitionId
		);
		if (slot.role === "tag" && (definitions.length > 1 || !definition)) {
			new Setting(partEl)
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
		if (slot.role === "tag") this.renderHierarchySetting(partEl, slot);
		this.renderWrapperSetting(partEl, slot);
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
		const setting = new Setting(containerEl)
			.setName(t("setting.gapName", { a: index + 1, b: index + 2 }))
			.setDesc(t("setting.gapDesc"))
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
		setting.settingEl.addClass("trellis-filename-gap-setting");
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

		if (!this.plugin.settings.treeViewEnabled) return;
		const options = containerEl.createDiv({ cls: "trellis-sidebar-options" });
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
			new Setting(options)
				.setName(t("setting.treeDisplayOptions"))
				.setDesc(t("setting.treeDisplayOptionsDesc"))
				.setHeading();
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

	private updateInventoryFile(file: TFile) {
		if (file.extension !== "md" || !this.tagInventory) return;
		this.tagInventory.upsertFile(this.inventoryFile(file));
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
			if (file instanceof TFile) this.tagInventory?.removeFile(file.path);
		});
		this.statsCleanups.push(() => this.app.vault.offref(deleted));
		const renamed = this.app.vault.on("rename", (file, oldPath) => {
			if (file instanceof TFile && file.extension === "md") {
				this.tagInventory?.renameFile(oldPath, this.inventoryFile(file));
			}
		});
		this.statsCleanups.push(() => this.app.vault.offref(renamed));
	}

	private stopStatsWatch() {
		for (const cleanup of this.statsCleanups.splice(0)) cleanup();
		this.tagInventory = null;
		this.inventorySchemaFingerprint = "";
	}
}
