import {
	CURRENT_SETTINGS_VERSION,
	defaultSchema,
	isValidHierarchySeparator,
	isValidSlotWrapper,
	isValidTagPath,
	normalizeSchemaModel,
	sameTagPath,
	schemaFromLegacy,
	schemaTagDefinitions,
	type SeparatorSpacing,
	type TrellisSchema,
} from "./tagkey.ts";
import {
	interruptedReport,
	type TrellisOperationReport,
} from "./operation-state.ts";
import type { LangSetting } from "./i18n.ts";
import type { HeaderButtonVisibility } from "./tree-view.ts";

export type SortKey = "tagkey" | "mtime" | "ctime";
export type TreeViewMode = "notes" | "tags";
export type TreeLabelMode = "filename" | "tag";
export type PropertyTagDisplayMode =
	| "full"
	| "name"
	| "name-terminal"
	| "terminal";

export interface BootstrapRecord {
	path: string;
	tag: string;
}

export interface SeparatorRename {
	path: string;
	oldBasename: string;
}

export interface SeparatorChangeRecord {
	oldSchema?: TrellisSchema;
	newSchema?: TrellisSchema;
	oldSep?: string;
	newSep?: string;
	renames: SeparatorRename[];
}

export interface DedupRecord {
	path: string;
	removed: string[];
}

export interface CascadeRecord {
	originalPath: string;
	currentPath: string;
	beforeTags: string[];
	afterTags: string[];
}

export interface RootChangeRecord {
	oldRoot: string;
	newRoot: string;
}

export interface NamespaceChangeRecord {
	oldSchema: TrellisSchema;
	newSchema: TrellisSchema;
	changes: CascadeRecord[];
}

export interface HiddenTagBranch {
	tagDefinitionId: string;
	relativePath: string;
}

export interface TrellisSettings {
	settingsVersion: number;
	schema: TrellisSchema;
	filenameSyncEnabled: boolean;
	treeViewEnabled: boolean;
	treeViewName: string;
	headerButtons: HeaderButtonVisibility;
	sortKey: SortKey;
	sortAsc: boolean;
	treeViewMode: TreeViewMode;
	treeShowRoot: boolean;
	treeShowUntagged: boolean;
	treeLabelMode: TreeLabelMode;
	treeTagDefinitionId: string;
	treeTagKeyNamespace?: string;
	hiddenTagBranches: HiddenTagBranch[];
	propertyTagDisplay: PropertyTagDisplayMode;
	language: LangSetting;
	lastBootstrap?: BootstrapRecord[];
	lastSeparatorChange?: SeparatorChangeRecord;
	lastDedup?: DedupRecord[];
	lastCascade?: CascadeRecord[];
	lastRootChange?: RootChangeRecord;
	lastNamespaceChange?: NamespaceChangeRecord;
	lastOperation?: TrellisOperationReport;
	operationAttention?: TrellisOperationReport;
}

export const DEFAULT_SETTINGS: TrellisSettings = {
	settingsVersion: CURRENT_SETTINGS_VERSION,
	schema: defaultSchema(),
	filenameSyncEnabled: true,
	treeViewEnabled: true,
	treeViewName: "",
	headerButtons: {
		newNote: true,
		viewMode: true,
		sort: true,
		collapseAll: true,
		showCurrent: true,
		bootstrap: true,
		cascade: true,
		undo: true,
	},
	sortKey: "tagkey",
	sortAsc: true,
	treeViewMode: "notes",
	treeShowRoot: true,
	treeShowUntagged: true,
	treeLabelMode: "filename",
	treeTagDefinitionId: "",
	hiddenTagBranches: [],
	propertyTagDisplay: "full",
	language: "auto",
};

interface LegacyConfig {
	namespace?: string;
	separator?: string;
	keyPosition?: "prefix" | "suffix";
}

type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneSchema(schema: TrellisSchema): TrellisSchema {
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

function isOperationReport(value: unknown): value is TrellisOperationReport {
	if (!isPlainObject(value)) return false;
	return (
		typeof value.id === "string" &&
		(value.kind === "live-sync" || value.kind === "automation" || value.kind === "bulk") &&
		typeof value.label === "string" &&
		(value.status === "running" ||
			value.status === "completed" ||
			value.status === "partial-failed" ||
			value.status === "failed" ||
			value.status === "cancelled" ||
			value.status === "rolled-back" ||
			value.status === "interrupted") &&
		typeof value.startedAt === "number" &&
		typeof value.total === "number" &&
		typeof value.processed === "number" &&
		Array.isArray(value.issues)
	);
}

function normalizeSchemaFormatting(schema: TrellisSchema): TrellisSchema {
	const normalized = cloneSchema(schema);
	normalized.slots = normalized.slots.map((slot) => {
		if (
			slot.role === "tag" &&
			slot.segmentSeparator !== undefined &&
			!isValidHierarchySeparator(slot.segmentSeparator)
		) return { ...slot, segmentSeparator: "" };
		if (!isValidSlotWrapper(slot.wrapper)) return { ...slot, wrapper: undefined };
		return slot;
	});
	const spacing: SeparatorSpacing[] = ["none", "before", "after", "both"];
	normalized.separatorSpacing = normalized.separators.map((raw, index) => {
		const saved = normalized.separatorSpacing?.[index];
		const before = /^\s/.test(raw);
		const after = /\s$/.test(raw);
		normalized.separators[index] = raw.trim();
		if (normalized.separators[index] === "") {
			return saved === "after" || before || after ? "after" : "none";
		}
		if (saved && spacing.includes(saved)) return saved;
		if (before && after) return "both";
		if (before) return "before";
		if (after) return "after";
		return "none";
	});
	return normalized;
}

export interface NormalizedSettings {
	settings: TrellisSettings;
	interruptedOperation: TrellisOperationReport | null;
	shouldSave: boolean;
}

/** Convert persisted data into one owned, current settings model without I/O. */
export function normalizeLoadedSettings(
	rawData: unknown,
	interruptedAt = Date.now()
): NormalizedSettings {
	const data = isPlainObject(rawData) ? rawData : {};
	const loaded = data as Partial<TrellisSettings> & Partial<LegacyConfig>;
	const settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
	let interruptedOperation: TrellisOperationReport | null = null;
	let operationRecovered = false;

	if (!isOperationReport(loaded.lastOperation)) {
		settings.lastOperation = undefined;
	} else if (loaded.lastOperation.status === "running") {
		settings.lastOperation = interruptedReport(loaded.lastOperation, interruptedAt);
		settings.operationAttention = settings.lastOperation;
		interruptedOperation = settings.lastOperation;
		operationRecovered = true;
	}
	if (!isOperationReport(loaded.operationAttention) && !operationRecovered) {
		settings.operationAttention = undefined;
	}

	if (!loaded.schema) {
		const legacy = loaded as LegacyConfig;
		const hasLegacy =
			legacy.namespace !== undefined ||
			legacy.separator !== undefined ||
			legacy.keyPosition !== undefined;
		settings.schema = hasLegacy
			? schemaFromLegacy(
					legacy.namespace ?? "trel",
					legacy.separator ?? "-",
					legacy.keyPosition ?? "prefix"
				)
			: defaultSchema();
		const migrated = settings;
		delete migrated.namespace;
		delete migrated.separator;
		delete migrated.keyPosition;
	}
	settings.schema = normalizeSchemaModel(normalizeSchemaFormatting(settings.schema));

	const definitions = schemaTagDefinitions(settings.schema);
	const legacyTreeNamespace = loaded.treeTagKeyNamespace ?? "";
	const selectedTreeDefinition =
		definitions.find(
			(definition) =>
				definition.id === loaded.treeTagDefinitionId &&
				definition.sidebarVisible &&
				!definition.archived
		) ??
		definitions.find(
			(definition) =>
				sameTagPath(definition.namespace, legacyTreeNamespace) &&
				definition.sidebarVisible &&
				!definition.archived
		) ??
		definitions.find(
			(definition) => definition.sidebarVisible && !definition.archived
		);
	settings.treeTagDefinitionId = selectedTreeDefinition?.id ?? "";
	delete settings.treeTagKeyNamespace;
	settings.settingsVersion = CURRENT_SETTINGS_VERSION;
	delete (settings as unknown as Record<string, unknown>).advancedMode;
	delete (settings as unknown as Record<string, unknown>).suppressSchemaConfirm;
	settings.headerButtons = {
		...DEFAULT_SETTINGS.headerButtons,
		...(isPlainObject(data.headerButtons)
			? (data.headerButtons as Partial<HeaderButtonVisibility>)
			: {}),
	};
	settings.hiddenTagBranches = Array.isArray(loaded.hiddenTagBranches)
		? loaded.hiddenTagBranches.filter(
				(value): value is HiddenTagBranch =>
					isPlainObject(value) &&
					typeof value.tagDefinitionId === "string" &&
					typeof value.relativePath === "string" &&
					isValidTagPath(value.relativePath)
			)
		: [];
	if (
		settings.propertyTagDisplay !== "full" &&
		settings.propertyTagDisplay !== "name" &&
		settings.propertyTagDisplay !== "name-terminal" &&
		settings.propertyTagDisplay !== "terminal"
	) settings.propertyTagDisplay = "full";

	const schemaChanged =
		JSON.stringify(loaded.schema ?? null) !== JSON.stringify(settings.schema);
	const shouldSave =
		loaded.settingsVersion !== CURRENT_SETTINGS_VERSION ||
		schemaChanged ||
		loaded.treeTagDefinitionId !== settings.treeTagDefinitionId ||
		"treeTagKeyNamespace" in data ||
		"advancedMode" in data ||
		"suppressSchemaConfirm" in data ||
		operationRecovered;

	return { settings, interruptedOperation, shouldSave };
}
