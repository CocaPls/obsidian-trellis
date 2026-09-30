/**
 * TRELLIS — pure conversion logic (no Obsidian dependency, unit-testable).
 *
 * The "tagkey" is the filename prefix identifier. The live sync is
 * *format-agnostic*: it does not define what a tagkey means — it only mirrors a
 * hierarchical location tag (the source of truth) into the filename prefix by
 * concatenating the tag's path segments, so any tag path works. (Bootstrap, the
 * reverse direction, must assume a prefix pattern — see tagkeyToTagPath.)
 *
 * DATA MODEL — a filename is a positional array of key SLOTS separated by
 * delimiters. Each slot is a tag-key (TRELLIS-managed, tag →
 * filename) or a name-key (user-free, untouched). The single-key default is
 * just the 2-slot special case `[tag] sep [name]`. Multi-key schemas use the
 * same model in advanced mode: each tag slot resolves from its own namespace,
 * while the name slot remains user-controlled.
 */

import {
	legacySchemeFromValueRule,
	looksLikeTagkey,
	schemeSegments,
	valueRuleFromLegacyScheme,
	type SchemeId,
	type TagValueRule,
} from "./value-rules.ts";

export {
	SCHEME_IDS,
	legacySchemeFromValueRule,
	looksLikeTagkey,
	schemeSegments,
	suggestSegment,
	suggestTagValue,
	valueRuleFromLegacyScheme,
	type SchemeId,
	type TagValueRule,
	type ValueRuleKind,
} from "./value-rules.ts";

/** The role of a filename slot. */
export type SlotType = "tag" | "name";
/** @deprecated Internal compatibility alias for pre-0.5 callers. */
export type KeyRole = SlotType;
/** Conceptual 0.6 slot kind. Serialized roles stay compatible with 0.5. */
export type SlotKind = "metadata" | "title";
/** One-way behavior of a metadata-backed slot. Properties other than `tags`
 * are intentionally not implemented yet. */
export type SlotSyncMode =
	| "metadata-to-filename"
	| "filename-to-metadata"
	| "display-only";
export const DEFAULT_SLOT_SYNC_MODE: SlotSyncMode = "metadata-to-filename";
/**
 * Visible hierarchy joiner in a filename. The empty string hides hierarchy.
 * 0.5 accepts validated custom safe punctuation instead of a closed preset
 * union; the actual Obsidian tag hierarchy always remains slash-delimited.
 */
export type SegmentSeparator = string;
export type SeparatorSpacing = "none" | "before" | "after" | "both";
export type BoundaryKind = "symbol" | "space" | "none";
export type FilenameTextTransform = "identity" | "underscore-to-space";

export type SlotWrapperKind = "none" | "round" | "custom";

/** Optional visual wrapper emitted around one non-empty filename slot. */
export interface SlotWrapper {
	kind: SlotWrapperKind;
	/** Used only by custom wrappers. */
	left?: string;
	/** Used only by custom wrappers. */
	right?: string;
}

/** A managed Obsidian tag branch, independent from filename projection. */
export interface TrellisTagDefinition {
	id: string;
	/** Human-facing label. Falls back to namespace when blank. */
	name: string;
	/** Relative branch below rootNamespace, e.g. "bp". */
	namespace: string;
	sidebarVisible: boolean;
	/** Retained for existing notes, but excluded from new-use settings and views. */
	archived?: boolean;
	color?: string;
	valueRule?: TagValueRule;
}

/**
 * ID scheme preset for a tag slot (0.3.0, experimental). Absent = the classic
 * format-agnostic behaviour. A scheme adds two capabilities and changes NOTHING
 * about live sync: ① new-note segment suggestion, ② bootstrap parse hints.
 *  - "spark":  alternating letter/digit runs (S/88/B/07); children alternate
 *              class with their parent, siblings increment.
 *  - "zettel": one 12–14 digit timestamp ID (Zettelkasten style).
 *  - "date":   one YYYYMMDD date ID.
 *  - "seq":    one plain increasing integer (width-preserving).
 */
/**
 * One slot in the filename schema. A tag-key carries the location-tag
 * namespace it mirrors; a name-key is free user text TRELLIS never rewrites.
 */
export interface KeySlot {
	/** Stable settings-only identity. Never written to notes or filenames. */
	id?: string;
	role: SlotType;
	/** Managed tag definition referenced by a tag slot. */
	tagDefinitionId?: string;
	/** Direction/effect of this metadata slot. Absent legacy values preserve the
	 * existing tag -> physical filename behavior. Ignored on the title slot. */
	syncMode?: SlotSyncMode;
	/**
	 * Pre-0.5 persisted namespace. Accepted only for migration/undo records; new
	 * active schemas resolve a tagDefinitionId instead.
	 */
	namespace?: string;
	/** Optional ID scheme preset (0.3.0). Absent = format-agnostic. */
	scheme?: SchemeId;
	/** Visible joiner for hierarchy segments in this tagkey. Absent = hidden. */
	segmentSeparator?: SegmentSeparator;
	/** Optional whitespace rendered around the hierarchy joiner. */
	segmentSeparatorSpacing?: SeparatorSpacing;
	/** Optional one-way text projection used only when rendering this tag slot
	 * into a filename. The stored Obsidian tag is never changed. */
	filenameTextTransform?: FilenameTextTransform;
	/** Optional visual wrapper for this slot. */
	wrapper?: SlotWrapper;
}

/** Preferred 0.5 name. KeySlot remains exported for source compatibility. */
export type FilenameSlot = KeySlot;

/**
 * The filename schema: slots in left-to-right order plus the separators
 * between them (slots.length - 1 of them). The default is
 *   slots = [{tag, "trel"}, {name}],  separators = ["-"]
 * which reproduces the old single-key behaviour. Slot ORDER encodes position:
 * a tag slot at index 0 is a prefix tagkey, a tag slot after the name slot is a
 * suffix tagkey (the old `keyPosition` flag, now absorbed into the array).
 *
 * ROOT NAMESPACE (0.3.0, experimental — B25 layer 1): when set, every managed
 * tag starts with this single owner root, so a tag is
 *   #{root}/{slot namespace}/{segments…}   e.g. #trellis/tree/S/88
 * instead of #{slot namespace}/{segments…}. Ownership then reduces to one
 * prefix check, and the root is the only name that must not collide with a
 * user's ordinary tags. ""/absent = classic rootless behaviour (0.2.x shape).
 * Terminology (A안): layer 1 = root namespace, layer 2 = slot namespace,
 * layers 3+ = segments.
 */
export interface TrellisSchema {
	/** Layer-1 owner root shared by every tag slot. ""/absent = no root. */
	rootNamespace?: string;
	/** Managed tag branches. Definitions need not appear in a filename slot. */
	tagDefinitions?: TrellisTagDefinition[];
	slots: KeySlot[];
	separators: string[];
	/** Whitespace rendered around each separator symbol. Absent = no spaces. */
	separatorSpacing?: SeparatorSpacing[];
}

/** Preferred 0.5 name. The serialized shape stays compatible with 0.4. */
export type FilenameSchema = TrellisSchema;

/** Current persisted settings model. Versioning lives at the plugin-settings level. */
export const CURRENT_SETTINGS_VERSION = 3;

export function slotKind(slot: KeySlot): SlotKind {
	return slot.role === "tag" ? "metadata" : "title";
}

export function slotSyncMode(slot: KeySlot): SlotSyncMode | null {
	return slot.role === "tag" ? slot.syncMode ?? DEFAULT_SLOT_SYNC_MODE : null;
}

export function isMetadataSlot(slot: KeySlot): boolean {
	return slotKind(slot) === "metadata";
}

export function isTitleSlot(slot: KeySlot): boolean {
	return slotKind(slot) === "title";
}

function idPart(value: string): string {
	const ascii = value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return ascii || "item";
}

function uniqueId(prefix: string, hint: string, used: Set<string>): string {
	const base = `${prefix}-${idPart(hint)}`;
	let value = base;
	let suffix = 2;
	while (used.has(value)) value = `${base}-${suffix++}`;
	used.add(value);
	return value;
}

/** Obsidian tag identity is case-insensitive. Keep the user's stored/display
 * casing, but compare normalized paths through this one canonical key. */
export function tagPathIdentity(path: string): string {
	return path.replace(/^#/, "").normalize("NFC").toLowerCase();
}

export function sameTagPath(left: string, right: string): boolean {
	return tagPathIdentity(left) === tagPathIdentity(right);
}

/** Return the path below a namespace, "" for the namespace node itself, or
 * null when the path is outside it. Segment comparison is case-insensitive. */
export function tagPathRelativeToNamespace(
	path: string,
	namespace: string
): string | null {
	const pathSegments = path.replace(/^#/, "").split("/");
	const namespaceSegments = namespace.replace(/^#/, "").split("/");
	if (
		pathSegments.length < namespaceSegments.length ||
		namespaceSegments.some(
			(segment, index) => tagPathIdentity(pathSegments[index]) !== tagPathIdentity(segment)
		)
	) return null;
	return pathSegments.slice(namespaceSegments.length).join("/");
}

export function tagPathInNamespace(path: string, namespace: string): boolean {
	return tagPathRelativeToNamespace(path, namespace) !== null;
}

/** Effective definitions, including a read-only fallback for legacy schemas. */
export function schemaTagDefinitions(schema: TrellisSchema): TrellisTagDefinition[] {
	if (schema.tagDefinitions && schema.tagDefinitions.length > 0) {
		return schema.tagDefinitions;
	}
	const seen = new Set<string>();
	const definitions: TrellisTagDefinition[] = [];
	for (const slot of schema.slots) {
		if (slot.role !== "tag" || !slot.namespace) continue;
		const identity = tagPathIdentity(slot.namespace);
		if (seen.has(identity)) continue;
		seen.add(identity);
		definitions.push({
			id: `legacy-${slot.namespace}`,
			name: slot.namespace,
			namespace: slot.namespace,
			sidebarVisible: true,
			valueRule: valueRuleFromLegacyScheme(slot.scheme),
		});
	}
	return definitions;
}

export function tagDefinitionById(
	schema: TrellisSchema,
	id: string | undefined
): TrellisTagDefinition | undefined {
	if (!id) return undefined;
	return schemaTagDefinitions(schema).find((definition) => definition.id === id);
}

/** Resolve the managed branch projected by a filename tag slot. */
export function slotNamespace(schema: TrellisSchema, slot: KeySlot): string {
	return tagDefinitionById(schema, slot.tagDefinitionId)?.namespace ?? slot.namespace ?? "";
}

export function slotValueRule(
	schema: TrellisSchema,
	slot: KeySlot
): TagValueRule | undefined {
	return tagDefinitionById(schema, slot.tagDefinitionId)?.valueRule ??
		valueRuleFromLegacyScheme(slot.scheme);
}

/**
 * Upgrade one active schema to the 0.5 ID-based model without changing any
 * rendered filename or tag path. The function is pure and idempotent so it can
 * also normalize old schemas embedded in undo journals on demand.
 */
export function normalizeSchemaModel(schema: TrellisSchema): TrellisSchema {
	const next: TrellisSchema = {
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
		separatorSpacing: schema.separatorSpacing ? [...schema.separatorSpacing] : undefined,
	};

	const definitionIds = new Set<string>();
	const definitionAliases = new Map<string, string>();
	const definitions: TrellisTagDefinition[] = [];
	for (const definition of next.tagDefinitions ?? []) {
		const namespace = definition.namespace.trim();
		const duplicate = definitions.find((candidate) => sameTagPath(candidate.namespace, namespace));
		if (!namespace || duplicate) {
			if (duplicate && definition.id) definitionAliases.set(definition.id, duplicate.id);
			continue;
		}
		const id = definition.id && !definitionIds.has(definition.id)
			? definition.id
			: uniqueId("tag", namespace, definitionIds);
		definitionIds.add(id);
		const normalized: TrellisTagDefinition = {
			...definition,
			id,
			name: definition.name?.trim() || namespace,
			namespace,
			sidebarVisible: definition.archived ? false : definition.sidebarVisible !== false,
		};
		if (!definition.archived) delete normalized.archived;
		definitions.push(normalized);
	}

	for (const slot of next.slots) {
		if (slot.role !== "tag") continue;
		const legacyNamespace = slot.namespace?.trim() ?? "";
		const definitionId = slot.tagDefinitionId
			? definitionAliases.get(slot.tagDefinitionId) ?? slot.tagDefinitionId
			: undefined;
		let definition = definitions.find((candidate) => candidate.id === definitionId);
		if (!definition && legacyNamespace) {
			definition = definitions.find((candidate) => sameTagPath(candidate.namespace, legacyNamespace));
		}
		if (!definition && legacyNamespace) {
			const id = uniqueId("tag", legacyNamespace, definitionIds);
			definition = {
				id,
				name: legacyNamespace,
				namespace: legacyNamespace,
				sidebarVisible: true,
				valueRule: valueRuleFromLegacyScheme(slot.scheme),
			};
			definitions.push(definition);
		}
		if (definition) {
			slot.tagDefinitionId = definition.id;
			if (!definition.valueRule && slot.scheme) {
				definition.valueRule = valueRuleFromLegacyScheme(slot.scheme);
			}
		}
		delete slot.namespace;
		delete slot.scheme;
	}

	const slotIds = new Set<string>();
	for (let index = 0; index < next.slots.length; index++) {
		const slot = next.slots[index];
		if (!slot.id || slotIds.has(slot.id)) {
			slot.id = uniqueId("slot", String(index + 1), slotIds);
		} else {
			slotIds.add(slot.id);
		}
		if (!slot.wrapper || slot.wrapper.kind === "none") delete slot.wrapper;
		if (slot.role === "tag") {
			if (
				slot.syncMode !== "metadata-to-filename" &&
				slot.syncMode !== "filename-to-metadata" &&
				slot.syncMode !== "display-only"
			) slot.syncMode = DEFAULT_SLOT_SYNC_MODE;
		} else {
			delete slot.syncMode;
		}
	}

	// A filename may contain at most one free title, but tag-only structures are
	// first-class. Extra title slots were never valid in the UI; retain only the
	// first if malformed data is loaded.
	const firstTitleIndex = next.slots.findIndex((slot) => slot.role === "name");
	for (let index = next.slots.length - 1; index >= 0; index--) {
		if (next.slots[index].role !== "name" || index === firstTitleIndex) continue;
		next.slots.splice(index, 1);
		if (next.separators.length > 0) {
			const gap = Math.min(index, next.separators.length - 1);
			next.separators.splice(gap, 1);
			next.separatorSpacing?.splice(gap, 1);
		}
	}
	const neededGaps = Math.max(0, next.slots.length - 1);
	while (next.separators.length < neededGaps) next.separators.push("-");
	next.separators.length = neededGaps;
	if (next.separatorSpacing) {
		while (next.separatorSpacing.length < neededGaps) {
			next.separatorSpacing.push("none");
		}
		next.separatorSpacing.length = neededGaps;
	}

	next.tagDefinitions = definitions;
	return next;
}

/** Render a stored boundary symbol with its independently configured spacing. */
export function renderSeparator(
	symbol: string,
	spacing: SeparatorSpacing = "none"
): string {
	const before = spacing === "before" || spacing === "both" ? " " : "";
	const after = spacing === "after" || spacing === "both" ? " " : "";
	return before + symbol + after;
}

/** Spacing mode of one gap; missing legacy values mean no spaces. */
export function separatorSpacingAt(
	schema: TrellisSchema,
	index: number
): SeparatorSpacing {
	return schema.separatorSpacing?.[index] ?? "none";
}

/** The actual boundary text emitted into a filename for one schema gap. */
export function boundarySeparator(schema: TrellisSchema, index: number): string {
	return renderSeparator(schema.separators[index] ?? "", separatorSpacingAt(schema, index));
}

/** Spacing mode of one tag hierarchy joiner; legacy values mean no spaces. */
export function segmentSeparatorSpacingAt(slot: KeySlot): SeparatorSpacing {
	return slot.segmentSeparatorSpacing ?? "none";
}

/** The actual hierarchy joiner emitted into a filename for one tag slot. */
export function hierarchySeparator(slot: KeySlot): string {
	const symbol = slot.segmentSeparator ?? "";
	return symbol === "" ? "" : renderSeparator(symbol, segmentSeparatorSpacingAt(slot));
}

/** User-facing kind of one slot boundary. Empty symbol + `after` is the
 * canonical persisted representation of one plain space; empty + `none` means
 * no boundary at all. Existing non-empty symbols keep the legacy spacing model. */
export function boundaryKindAt(schema: TrellisSchema, index: number): BoundaryKind {
	const symbol = schema.separators[index] ?? "";
	if (symbol !== "") return "symbol";
	return separatorSpacingAt(schema, index) === "after" ? "space" : "none";
}

/** A boundary is either a safe symbol, one canonical space, or absent. */
export function isValidBoundary(schema: TrellisSchema, index: number): boolean {
	const symbol = schema.separators[index] ?? "";
	const spacing = separatorSpacingAt(schema, index);
	if (symbol === "") return spacing === "none" || spacing === "after";
	return isValidSeparator(symbol);
}

export function wrapperPair(wrapper?: SlotWrapper): { left: string; right: string } {
	if (!wrapper || wrapper.kind === "none") return { left: "", right: "" };
	if (wrapper.kind === "round") return { left: "(", right: ")" };
	return { left: wrapper.left ?? "", right: wrapper.right ?? "" };
}

/** Wrap only present values, so omitted slots never leave empty punctuation. */
export function renderSlotValue(value: string, slot: KeySlot): string {
	if (!value) return "";
	const { left, right } = wrapperPair(slot.wrapper);
	return `${left}${value}${right}`;
}

/** Remove exactly one configured visual wrapper from a parsed slot value. */
export function unwrapSlotValue(value: string, slot: KeySlot): string {
	const { left, right } = wrapperPair(slot.wrapper);
	if (!left && !right) return value;
	if (!value.startsWith(left) || !value.endsWith(right)) return value;
	if (value.length < left.length + right.length) return value;
	return value.slice(left.length, value.length - right.length);
}

/** Render one stored tag segment into a filename without mutating tag data. */
export function tagSegmentToFilename(segment: string, slot: KeySlot): string {
	return slot.role === "tag" && slot.filenameTextTransform === "underscore-to-space"
		? segment.replace(/_/g, " ")
		: segment;
}

/** Exact inverse used only by reviewed reverse paths such as Bootstrap. */
export function filenameSegmentToTag(segment: string, slot: KeySlot): string {
	return slot.role === "tag" && slot.filenameTextTransform === "underscore-to-space"
		? segment.replace(/ /g, "_")
		: segment;
}

/** Project a relative managed-tag path through one filename tag slot. */
export function tagPathToFilenameKey(path: string, slot: KeySlot): string {
	return path
		.split("/")
		.map((segment) => tagSegmentToFilename(segment, slot))
		.join(hierarchySeparator(slot));
}

/**
 * The full tag namespace path of a slot namespace under the schema's root:
 * "tree" → "trellis/tree" when rootNamespace is "trellis", else "tree".
 * This is the string every `#{ns}/…` match point uses, so the root layer
 * threads through matching, bootstrap and dedup from one place.
 */
export function nsPath(schema: TrellisSchema, ns: string): string {
	const root = (schema.rootNamespace ?? "").trim();
	return root && ns ? `${root}/${ns}` : ns;
}

/** nsPath of the primary (first) tag slot. */
export function primaryNsPath(schema: TrellisSchema): string {
	return nsPath(schema, primaryNamespace(schema));
}

/**
 * A FRESH default schema — single tag-key "trel" prefix, "-" separator, free
 * name. Returns a new object every call; use this (not the DEFAULT_SCHEMA
 * constant) whenever the result will be stored in mutable settings, so the
 * shared constant is never mutated in place.
 */
export function defaultSchema(): TrellisSchema {
	const definition: TrellisTagDefinition = {
		id: "tag-trel",
		name: "trel",
		namespace: "trel",
		sidebarVisible: true,
	};
	return {
		tagDefinitions: [definition],
		slots: [
			{ id: "slot-1", role: "tag", tagDefinitionId: definition.id },
			{ id: "slot-2", role: "name" },
		],
		separators: ["-"],
	};
}

/** Read-only default schema instance (for comparisons/tests). For anything
 *  that may be edited, call defaultSchema() to get an own copy. */
export const DEFAULT_SCHEMA: TrellisSchema = defaultSchema();

/**
 * Build a schema from the legacy scalar config (namespace / separator /
 * keyPosition) so existing user settings migrate without breaking. prefix →
 * [tag, name]; suffix → [name, tag].
 */
export function schemaFromLegacy(
	namespace: string,
	separator: string,
	keyPosition: "prefix" | "suffix"
): TrellisSchema {
	const definition: TrellisTagDefinition = {
		id: `tag-${idPart(namespace)}`,
		name: namespace,
		namespace,
		sidebarVisible: true,
	};
	const tag: KeySlot = {
		id: keyPosition === "suffix" ? "slot-2" : "slot-1",
		role: "tag",
		tagDefinitionId: definition.id,
	};
	const name: KeySlot = {
		id: keyPosition === "suffix" ? "slot-1" : "slot-2",
		role: "name",
	};
	return {
		tagDefinitions: [definition],
		slots: keyPosition === "suffix" ? [name, tag] : [tag, name],
		separators: [separator],
	};
}

// --- Derived accessors (single-key view over the general schema) -----------
// These helpers expose the primary tag slot for the legacy/default two-slot
// path and for intentionally primary-only operations such as reverse import.
// Multi-key filename sync uses the general slot-array helpers below.

/** Index of the first tag slot, or -1 if somehow none (schema requires ≥1). */
function firstTagSlotIndex(schema: TrellisSchema): number {
	return schema.slots.findIndex((s) => s.role === "tag");
}

/** The namespace of the primary (first) tag slot, e.g. "trel". */
export function primaryNamespace(schema: TrellisSchema): string {
	const i = firstTagSlotIndex(schema);
	return i >= 0 ? slotNamespace(schema, schema.slots[i]) : "";
}

/** Every distinct location-tag namespace in the schema (one per tag slot). */
export function tagNamespaces(schema: TrellisSchema): string[] {
	return schemaTagDefinitions(schema).map((definition) => definition.namespace);
}

/** The schema tag-key whose namespace owns one tag. `keyPath` is the part
 * below that namespace; an empty value means the tag is the namespace node
 * itself, not a filename value. Slot order remains a filename-layout concern —
 * namespace ownership is what classifies the tag. */
export interface TagKeyMatch {
	slotIndex: number;
	tagDefinitionId?: string;
	namespace: string;
	fullNamespace: string;
	tagPath: string;
	keyPath: string;
}

/** Classify one tag against every configured tag-key namespace. Returns null
 * for an ordinary (unmanaged) tag. Both rooted and rootless schemas pass
 * through the same root-aware namespace path. */
export function matchTagKey(
	tag: string,
	schema: TrellisSchema
): TagKeyMatch | null {
	const tagPath = tag.replace(/^#/, "");
	for (const definition of schemaTagDefinitions(schema)) {
		const slotIndex = schema.slots.findIndex(
			(slot) =>
				slot.role === "tag" &&
				(slot.tagDefinitionId === definition.id ||
					(!slot.tagDefinitionId &&
						sameTagPath(slot.namespace ?? "", definition.namespace)))
		);
		const fullNamespace = nsPath(schema, definition.namespace);
		const keyPath = tagPathRelativeToNamespace(tagPath, fullNamespace);
		if (keyPath === null) continue;
		if (keyPath === "") {
			return {
				slotIndex,
				tagDefinitionId: definition.id,
				namespace: definition.namespace,
				fullNamespace,
				tagPath,
				keyPath: "",
			};
		}
		return {
			slotIndex,
			tagDefinitionId: definition.id,
			namespace: definition.namespace,
			fullNamespace,
			tagPath,
			keyPath,
		};
	}
	return null;
}

/** A namespace carrying more than one distinct location tag on a single note. */
export interface DuplicateTagGroup {
	namespace: string;
	/** Distinct location tags in this namespace, each with a leading '#'. */
	tags: string[];
}

/** Namespaces that appear with 2+ distinct location tags on one note.
 *  One note = one location per namespace; extras are surfaced for the user to
 *  resolve. `tags` is the input as returned by getAllTags (leading '#'). */
export function duplicateLocationGroups(
	tags: string[],
	schema: TrellisSchema
): DuplicateTagGroup[] {
	const byNamespace = new Map<string, string[]>();
	for (const tag of tags) {
		const match = matchTagKey(tag, schema);
		if (!match) continue;
		const matched = byNamespace.get(match.fullNamespace) ?? [];
		if (!matched.some((candidate) => sameTagPath(candidate, tag))) matched.push(tag);
		byNamespace.set(match.fullNamespace, matched);
	}
	return [...byNamespace.entries()]
		.filter(([, matched]) => matched.length > 1)
		.map(([namespace, matched]) => ({ namespace, tags: matched }));
}

/** The primary rendered boundary separator, e.g. "-" or " - ". */
export function primarySeparator(schema: TrellisSchema): string {
	return boundarySeparator(schema, 0);
}

/** The primary stored separator symbol without surrounding spaces. */
export function primarySeparatorSymbol(schema: TrellisSchema): string {
	return schema.separators[0] ?? "";
}

/** Where the primary tag slot sits: at the start (prefix) or end (suffix). */
export function tagPosition(schema: TrellisSchema): "prefix" | "suffix" {
	return firstTagSlotIndex(schema) === 0 ? "prefix" : "suffix";
}

/**
 * Convert a location tag into a tagkey.
 *   "#trel/S88/B07"  (namespace "trel")  ->  "S88B07"
 * The namespace segment and all "/" hierarchy separators are stripped.
 * Returns null when the tag does not belong to the configured namespace.
 *
 * @param tag  Tag including the leading "#", as Obsidian's getAllTags() yields.
 */
export function tagToTagkey(tag: string, schema: TrellisSchema): string | null {
	const match = matchTagKey(tag, schema);
	if (!match || match.slotIndex !== firstTagSlotIndex(schema) || match.keyPath === "") {
		return null;
	}
	const slot = schema.slots.find((s) => s.role === "tag");
	return slot ? tagPathToFilenameKey(match.keyPath, slot) : null;
}

/**
 * Parent of a tag path — drop the last segment. "trel/S77/A/01" → "trel/S77/A".
 * A single-segment path (e.g. "trel") is returned unchanged. Used to place a
 * new note as a SIBLING of a leaf note (under the leaf's parent).
 */
export function parentTagPath(tagPath: string): string {
	const i = tagPath.lastIndexOf("/");
	return i > 0 ? tagPath.slice(0, i) : tagPath;
}

/**
 * Bootstrap helper — the INVERSE of tagToTagkey. Decompose a filename tagkey
 * ("S88B07") into a hierarchical location-tag path ("trel/S/88/B/07") so an
 * existing vault (tagkey prefixes, no tags) can be onboarded.
 *
 * Reversing a flat prefix is scheme-independent here: split it into maximal runs
 * of one character class — a run of letters or a run of digits is each its own
 * tag segment (S88B07 → S/88/B/07, PROJ123 → PROJ/123, A1B2 → A/1/B/2). This
 * is a general default; consecutive same-class characters stay together
 * (S04001 → S/04001), so a fixed-width scheme's inner boundaries are not
 * recovered — the dry-run shows every result for review, and undo is one step.
 *
 * Two guards keep it safe:
 *  - At least two segments (one class transition) — a single run (a plain word
 *    or number) has no hierarchy to recover, so it is skipped.
 *  - Round-trip exact — the segments, rejoined, must equal the original tagkey.
 *    This rejects prefixes carrying characters a tag can't hold (e.g. "12.03",
 *    "my-note"), which sync could not reproduce, so bootstrap never proposes a
 *    tag that would silently rename the file later.
 */
export function tagkeyToTagPath(tagkey: string, schema: TrellisSchema): string | null {
	const slot = schema.slots.find((s) => s.role === "tag");
	if (!slot) return null;
	const segmentSeparator = hierarchySeparator(slot);
	if (segmentSeparator) {
		const segs = tagkey
			.split(segmentSeparator)
			.map((segment) => filenameSegmentToTag(segment, slot));
		if (
			segs.some((segment) => !isValidTagSegment(segment)) ||
			tagPathToFilenameKey(segs.join("/"), slot) !== tagkey
		) {
			return null;
		}
		return `${primaryNsPath(schema)}/${segs.join("/")}`;
	}
	const decodedSingle = filenameSegmentToTag(tagkey, slot);
	if (
		slot.filenameTextTransform === "underscore-to-space" &&
		tagkey.includes(" ") &&
		isValidTagSegment(decodedSingle) &&
		tagPathToFilenameKey(decodedSingle, slot) === tagkey
	) {
		return `${primaryNsPath(schema)}/${decodedSingle}`;
	}
	// A scheme on the primary slot parses first (it may accept single-run IDs
	// the generic guard rejects — a Zettel timestamp is ONE digit run); when the
	// scheme doesn't recognise the tagkey, fall back to the generic run split so
	// mixed vaults still onboard.
	const scheme = slot ? legacySchemeFromValueRule(slotValueRule(schema, slot)) : undefined;
	const bySchema = scheme ? schemeSegments(scheme, tagkey) : null;
	const segs =
		bySchema ??
		(looksLikeTagkey(tagkey) ? tagkey.match(/[A-Za-z]+|[0-9]+/g)! : null);
	if (!segs) return null;
	return `${primaryNsPath(schema)}/${segs.join("/")}`;
}

/**
 * Whether a string plausibly IS a bare tagkey: it decomposes into 2+
 * character-class runs (letters/digits) that round-trip exactly — the same
 * guards bootstrap uses. Used to tell a tagkey-only index note ("S88") apart
 * from a free title ("trellisupgradecheck") when a filename has no separator,
 * so sync prepends the tagkey instead of overwriting a real title.
 */
/**
 * Pick the first location tag (by config namespace) from a list of tags and
 * return its tagkey, or null if none. TRELLIS treats one note as having one
 * location (note-to-tag 1:1) — first match wins.
 */
export function pickTagkey(tags: string[], schema: TrellisSchema): string | null {
	for (const t of tags) {
		const k = tagToTagkey(t, schema);
		if (k !== null) return k;
	}
	return null;
}

/**
 * Extract the current tagkey slot from a filename's basename.
 * - prefix mode: everything before the first separator.
 * - suffix mode: everything after the last separator.
 * If there is no separator, the whole basename is the tagkey (e.g. an index
 * note that is tagkey-only).
 */
export function extractTagkey(basename: string, schema: TrellisSchema): string {
	const sep = primarySeparator(schema);
	const slot = schema.slots.find((candidate) => candidate.role === "tag");
	let raw: string;
	if (!sep) {
		raw = basename;
	} else if (tagPosition(schema) === "suffix") {
		const i = basename.lastIndexOf(sep);
		raw = i === -1 ? basename : basename.slice(i + sep.length);
	} else {
		const i = basename.indexOf(sep);
		raw = i === -1 ? basename : basename.slice(0, i);
	}
	return slot ? unwrapSlotValue(raw, slot) : raw;
}

/**
 * Extract the title-key from a basename, given the authoritative tagkey.
 * The title-key is whatever remains once the tagkey slot is removed. We trust
 * the *known* tagkey: if the basename starts (prefix) / ends (suffix) with the
 * tagkey, the remainder is the title — even when the user deleted the separator
 * (e.g. "S99B07tree-idea" → title "tree-idea"). Otherwise the tagkey slot was
 * itself altered, so fall back to the separator-delimited slot. One boundary
 * separator is stripped.
 *
 * No-separator, no-tagkey-match basenames (0.2.0 data-safety rule): the whole
 * basename is either a stale tagkey (an index note — replace it) or a free
 * title (keep it — the tagkey is PREPENDED on reassembly, never overwriting a
 * real title). looksLikeTagkey() is the tiebreaker.
 */
export function extractTitle(
	basename: string,
	tagkey: string,
	schema: TrellisSchema
): string {
	const sep = primarySeparator(schema);
	if (tagPosition(schema) === "suffix") {
		let head: string;
		if (basename.endsWith(tagkey)) {
			head = basename.slice(0, basename.length - tagkey.length);
		} else {
			const i = basename.lastIndexOf(sep);
			if (i === -1) return looksLikeTagkey(basename) ? "" : basename;
			head = basename.slice(0, i + sep.length);
		}
		return head.endsWith(sep) ? head.slice(0, head.length - sep.length) : head;
	}
	let rest: string;
	if (basename.startsWith(tagkey)) {
		rest = basename.slice(tagkey.length);
	} else {
		const i = basename.indexOf(sep);
		if (i === -1) return looksLikeTagkey(basename) ? "" : basename;
		rest = basename.slice(i);
	}
	return rest.startsWith(sep) ? rest.slice(sep.length) : rest;
}

/**
 * Assemble a basename from an authoritative tagkey + a title-key, per the
 * schema's primary separator and tag position: `{tagkey}{sep}{title}` (prefix)
 * or `{title}{sep}{tagkey}` (suffix); just `{tagkey}` when the title is empty.
 * The single place that decides slot order + separator, shared by sync,
 * separator migration, and new-note creation.
 */
export function assembleBasename(
	tagkey: string,
	title: string,
	schema: TrellisSchema
): string {
	if (title === "") return tagkey;
	const sep = primarySeparator(schema);
	return tagPosition(schema) === "suffix"
		? title + sep + tagkey
		: tagkey + sep + title;
}

/**
 * Rebuild the basename from the authoritative tagkey + preserved title-key.
 * This restores the tagkey AND the separator if the user damaged either,
 * keeping only the title-key free. Returns null when no change is needed
 * (already in sync).
 */
export function syncedBasename(
	basename: string,
	tagkey: string,
	schema: TrellisSchema
): string | null {
	const title = extractTitle(basename, tagkey, schema);
	const rebuilt = assembleBasename(tagkey, title, schema);
	return rebuilt === basename ? null : rebuilt;
}

// --- Multi-key parsing (0.2.0 advanced mode, experimental) ------------------
// The general-form engine over the slot array: each tag slot syncs from its
// OWN namespace, at most one name slot holds the free title, and separators
// are consumed positionally (B09 §4). The 2-slot single-key path above stays
// the default; these run only when the schema is actually multi-key.

/** True when the schema needs the multi-key path: more than one tag slot, or
 *  any shape other than the battle-tested 2-slot [tag, name] pair. */
export function isMultiKey(schema: TrellisSchema): boolean {
	const tagCount = schema.slots.filter((s) => s.role === "tag").length;
	return (
		tagCount !== 1 ||
		schema.slots.length !== 2 ||
		schema.slots.some((slot) => wrapperPair(slot.wrapper).left !== "" || wrapperPair(slot.wrapper).right !== "")
	);
}

/**
 * Whether a tag namespace is safe to use: a non-empty run of Unicode letters,
 * marks, digits, hyphen or underscore, with at least one non-numeric character.
 * This excludes "/", whitespace, control characters and
 * tag/YAML metacharacters (",", "[", "]", "#", quotes, newlines), so a namespace
 * can never break tag matching (`#ns/…`) or inject into the `tags: [ns/…]`
 * frontmatter that new-note creation writes. Namespaces are the tag ROOT only
 * (the hierarchy comes from the tag path), so this allowlist is not restrictive
 * in practice (e.g. "trel", "tree", "proj").
 */
export function isValidNamespace(ns: string): boolean {
	return (
		ns !== "" &&
		/^[\p{L}\p{M}\p{N}_-]+$/u.test(ns) &&
		/[\p{L}\p{M}_-]/u.test(ns)
	);
}

/**
 * Whether a string is usable as a filename separator. It is inserted between
 * slots in the actual filename, so it must be 1–4 punctuation/symbol code
 * points and must avoid: letters/digits (in every script), the
 * filesystem-illegal set (`\ / : * ? " < > |`), the Obsidian/wikilink-hostile
 * set (`# ^ [ ]`), and any whitespace or control character. Other punctuation
 * (`-`, `_`, `.`, `~`, `=`, `+`, `·`, …) is allowed, so uncommon parse-safe symbols
 * stay available. Mirrors the reject set the settings UI used inline, made a
 * pure, tested function shared by simple- and advanced-mode validation.
 */
export function isValidSeparator(s: string): boolean {
	const characters = [...s];
	if (characters.length === 0 || characters.length > 4) return false;
	return characters.every(
		(character) =>
			/^[\p{P}\p{S}]$/u.test(character) &&
			!'/\\:*?"<>|#^[]'.includes(character)
	);
}

/** Hierarchy display may be hidden, otherwise it follows filename-separator safety. */
export function isValidHierarchySeparator(s: string): boolean {
	return s === "" || isValidSeparator(s);
}

/**
 * Validate a custom visual wrapper. Presets are always valid. A custom pair
 * requires one safe, non-whitespace punctuation string on each side. Keeping
 * the same conservative character rules as separators avoids cross-platform
 * filename and Obsidian link hazards.
 */
export function isValidSlotWrapper(wrapper?: SlotWrapper): boolean {
	if (!wrapper || wrapper.kind === "none" || wrapper.kind === "round") return true;
	if (wrapper.kind !== "custom") return false;
	const left = wrapper.left ?? "";
	const right = wrapper.right ?? "";
	return isValidSeparator(left) && isValidSeparator(right);
}

/** A segment is reversibly encodable for this tag slot. The configured joiner
 * cannot also occur inside a segment, or Bootstrap could not tell content from
 * hierarchy later. Existing tags still sync deterministically; creation and
 * configuration UIs can use this guard to prevent new ambiguity. */
export function isValidTagSegmentForSlot(seg: string, slot: KeySlot): boolean {
	return isValidTagSegment(seg) && !(slot.segmentSeparator && seg.includes(slot.segmentSeparator));
}

export interface SeparatorConflict {
	slotIndex: number;
	gapIndex: number;
	/** Present when two rendered slot boundaries have a prefix relationship. */
	otherGapIndex?: number;
}

/** Detect separator combinations that cannot round-trip without losing data.
 *
 * Three cases are ambiguous:
 * - a tag hierarchy joiner is identical to an adjacent unspaced boundary;
 * - a name slot touches an empty boundary, which the current filename parser
 *   cannot distinguish from arbitrary free text;
 * - with a name slot, one rendered boundary is a proper prefix of another.
 *   In the latter case a title beginning/ending with the extra punctuation can
 *   be mistaken for the longer boundary ("-" vs "--") and silently trimmed.
 */
export function separatorConflicts(schema: TrellisSchema): SeparatorConflict[] {
	const conflicts: SeparatorConflict[] = [];
	for (let slotIndex = 0; slotIndex < schema.slots.length; slotIndex++) {
		const slot = schema.slots[slotIndex];
		if (slot.role !== "tag" || !slot.segmentSeparator) continue;
		const internalSeparator = hierarchySeparator(slot);
		for (const gapIndex of [slotIndex - 1, slotIndex]) {
			if (
				gapIndex >= 0 &&
				gapIndex < schema.separators.length &&
				boundarySeparator(schema, gapIndex) === internalSeparator
			) {
				conflicts.push({ slotIndex, gapIndex });
			}
		}
	}

	const nameSlotIndex = schema.slots.findIndex((slot) => slot.role === "name");
	if (nameSlotIndex !== -1) {
		for (const gapIndex of [nameSlotIndex - 1, nameSlotIndex]) {
			if (
				gapIndex >= 0 &&
				gapIndex < schema.separators.length &&
				boundarySeparator(schema, gapIndex) === ""
			) {
				conflicts.push({ slotIndex: nameSlotIndex, gapIndex });
			}
		}
		const boundaries = schema.separators
			.map((_, gapIndex) => ({ gapIndex, rendered: boundarySeparator(schema, gapIndex) }))
			.filter(({ rendered }) => rendered !== "");
		for (let i = 0; i < boundaries.length; i++) {
			for (let j = i + 1; j < boundaries.length; j++) {
				const left = boundaries[i];
				const right = boundaries[j];
				if (
					left.rendered !== right.rendered &&
					(left.rendered.startsWith(right.rendered) ||
						right.rendered.startsWith(left.rendered))
				) {
					conflicts.push({
						slotIndex: nameSlotIndex,
						gapIndex: left.gapIndex,
						otherGapIndex: right.gapIndex,
					});
				}
			}
		}
	}
	return conflicts;
}

/**
 * Whether a string is safe as ONE tag path segment (a single hierarchy level).
 * Deny-list, not an ASCII allowlist, so unicode segments (e.g. Korean) stay
 * legal: rejects whitespace/control chars, "/" (that's the hierarchy separator,
 * not segment content), YAML flow/quote metacharacters (`, [ ] { } " ' # :`)
 * that could break the inline `tags: [...]` a new note writes, and
 * filename-illegal characters (`\ : * ? " < > |`) since the segment lands in
 * the filename tagkey. Empty is invalid.
 */
export function isValidTagSegment(seg: string): boolean {
	if (seg === "") return false;
	return !/[\s/\\:*?"<>|#^[\],{}'`]/.test(seg);
}

/** Whether a string is safe as a full tag path: one or more valid segments
 *  joined by single "/" (no empty segments, no leading/trailing slash). */
export function isValidTagPath(path: string): boolean {
	if (path === "") return false;
	const segs = path.split("/");
	return segs.every(isValidTagSegment);
}

export type PortableBasenameIssue =
	| "empty"
	| "reserved-character"
	| "trailing-dot-or-space"
	| "reserved-name";

/**
 * Cross-platform filename guard for basenames Trellis is about to create or
 * rename. Obsidian can run on filesystems with different rules, so accepting
 * what happens to work on the current device can create a vault that later
 * fails to sync to Windows. This intentionally uses the strict common subset:
 * Windows-illegal/control characters, terminal dots/spaces, and device names.
 */
export function portableBasenameIssue(basename: string): PortableBasenameIssue | null {
	if (basename === "" || basename === "." || basename === "..") return "empty";
	if ([...basename].some((char) => char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char)))
		return "reserved-character";
	if (/[. ]$/.test(basename)) return "trailing-dot-or-space";
	if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(\..*)?$/i.test(basename))
		return "reserved-name";
	return null;
}

/** Compare prospective paths conservatively across case-insensitive filesystems. */
export function portablePathKey(path: string): string {
	return path.normalize("NFC").toLowerCase();
}

/** tagToTagkey for an explicit namespace (multi-key: each tag slot has its own). */
export function tagToTagkeyNs(
	tag: string,
	namespace: string,
	segmentSeparator: SegmentSeparator = "",
	filenameTextTransform: FilenameTextTransform = "identity"
): string | null {
	const path = tagPathRelativeToNamespace(tag, namespace);
	if (!path) return null;
	return tagPathToFilenameKey(path, {
		role: "tag",
		segmentSeparator,
		filenameTextTransform,
	});
}

/** First location tag under a namespace → its tagkey, or null. */
export function pickTagkeyNs(
	tags: string[],
	namespace: string,
	segmentSeparator: SegmentSeparator = "",
	filenameTextTransform: FilenameTextTransform = "identity"
): string | null {
	for (const t of tags) {
		const k = tagToTagkeyNs(t, namespace, segmentSeparator, filenameTextTransform);
		if (k !== null) return k;
	}
	return null;
}

/**
 * Resolve each slot's tagkey from the note's tags: tag slots pick the first
 * tag under their own namespace (null when the note has none — that slot is
 * simply omitted from the filename); name slots are always null here (their
 * value comes from the basename, see extractNameMulti).
 */
export function slotTagkeys(
	tags: string[],
	schema: TrellisSchema
): (string | null)[] {
	const keys: (string | null)[] = schema.slots.map(() => null);
	for (const tag of tags) {
		const match = matchTagKey(tag, schema);
		if (!match || match.keyPath === "" || keys[match.slotIndex] !== null) continue;
		const slot = schema.slots[match.slotIndex];
		keys[match.slotIndex] = tagPathToFilenameKey(match.keyPath, slot);
	}
	return keys;
}

/** Tag-key values that are physically present in filenames. Display-only
 * values remain available through slotTagkeys(), but never participate in
 * parsing or assembling an on-disk basename. */
export function physicalSlotTagkeys(
	tags: string[],
	schema: TrellisSchema
): (string | null)[] {
	const keys = slotTagkeys(tags, schema);
	return schema.slots.map((slot, index) =>
		slot.role === "tag" && slotSyncMode(slot) === "metadata-to-filename"
			? keys[index]
			: null
	);
}

/**
 * Assemble a basename from per-slot values (null/"" = slot omitted). The
 * separator emitted before a slot is the one declared before it in the schema
 * (separators[i-1]); omitted slots drop their separator with them.
 */
export function assembleBasenameMulti(
	values: (string | null)[],
	schema: TrellisSchema
): string {
	let out = "";
	let any = false;
	for (let i = 0; i < schema.slots.length; i++) {
		const v = values[i];
		if (v === null || v === undefined || v === "") continue;
		if (any) out += boundarySeparator(schema, i - 1);
		out += renderSlotValue(v, schema.slots[i]);
		any = true;
	}
	return out;
}

/** The schema's distinct separators, longest first — so a boundary match never
 *  stops at a shorter separator that is a prefix of a longer one ("-" vs "--").
 *  Matching shortest-first is what let an omitted name slot's longer gap
 *  separator be half-consumed, duplicating a tagkey into the name. */
function sepsLongestFirst(schema: TrellisSchema): string[] {
	return [
		...new Set(schema.separators.map((_, i) => boundarySeparator(schema, i)).filter(Boolean)),
	].sort(
		(a, b) => b.length - a.length
	);
}

/** Strip ONE leading boundary separator (longest schema separator that matches). */
function stripOneLeadingSep(s: string, schema: TrellisSchema): string {
	for (const sep of sepsLongestFirst(schema)) {
		if (s.startsWith(sep)) return s.slice(sep.length);
	}
	return s;
}

/**
 * Extract the (single) name-slot value from a basename by anchoring on the
 * KNOWN tag-slot values: slots left of the name slot are consumed from the
 * left, slots right of it from the right; the remainder is the name. A tag
 * slot whose value doesn't match (user damaged it) falls back to the
 * positional separator, mirroring extractTitle — reassembly restores it.
 * Returns "" when the schema has no name slot.
 */
export function extractNameMulti(
	basename: string,
	tagkeys: (string | null)[],
	schema: TrellisSchema
): string {
	const nameIdx = schema.slots.findIndex((s) => s.role === "name");
	if (nameIdx === -1) return "";
	// A short-lived local migration appended an empty trailing title slot to
	// tag-only schemas. Keep those already-loaded shapes lossless until their
	// settings migration is saved: an unspaced wrapped tail such as `(test)` has
	// no boundary by which the directional parser could otherwise consume it.
	const tagOnlyValues = schema.slots.map((slot, index) =>
		slot.role === "name" ? null : tagkeys[index]
	);
	if (assembleBasenameMulti(tagOnlyValues, schema) === basename) return "";
	const seps = sepsLongestFirst(schema);
	let rest = basename;
	// Left side: slots 0 .. nameIdx-1, consumed left to right. A tag slot is
	// consumed ONLY when its value is followed by a separator boundary — a bare
	// `startsWith(v)` would strip a title that merely happens to begin with the
	// tagkey text. The boundary is tried against EVERY schema separator, longest
	// first: which gap separator actually follows this slot depends on which
	// later slots are omitted (an empty name slot drops its own separator), so
	// the declared positional one alone would half-match a longer neighbour
	// ("-" inside "--") and corrupt the name. Without any clean boundary, fall
	// back to the positional separator, else leave `rest` whole so a real title
	// is never truncated on a coincidental match.
	for (let i = 0; i < nameIdx; i++) {
		const raw = tagkeys[i];
		const v = raw ? renderSlotValue(raw, schema.slots[i]) : raw;
		if (!v) continue; // omitted slot — nothing in the filename for it
		if (rest === v) {
			// The tag value IS the entire remainder: a tagkey-only filename (an
			// index note, no title). Consume it so the name is empty — never fold
			// the tagkey into the name (which would duplicate it as "BT01-BT01").
			rest = "";
			continue;
		}
		let consumed = false;
		for (const sep of seps) {
			if (rest.startsWith(v + sep)) {
				rest = rest.slice(v.length + sep.length);
				consumed = true;
				break;
			}
		}
		if (consumed) continue;
		// Damaged tag slot: fall back to the declared positional separator.
		const sepAfter = boundarySeparator(schema, i);
		const j = sepAfter ? rest.indexOf(sepAfter) : -1;
		if (j !== -1) rest = stripOneLeadingSep(rest.slice(j), schema);
	}
	// Right side: slots nameIdx+1 .. end, consumed right to left. Symmetric
	// boundary rule: consume separator+tagkey EXACTLY (or the whole remainder —
	// a tagkey-only filename). No extra strip afterwards: the boundary consume
	// already took the separator, so stripping again would eat a title's own
	// trailing separator characters ("demo-" → "demo").
	for (let i = schema.slots.length - 1; i > nameIdx; i--) {
		const raw = tagkeys[i];
		const v = raw ? renderSlotValue(raw, schema.slots[i]) : raw;
		if (!v) continue;
		if (rest === v) {
			rest = "";
			continue;
		}
		let consumed = false;
		for (const sep of seps) {
			if (rest.endsWith(sep + v)) {
				rest = rest.slice(0, rest.length - sep.length - v.length);
				consumed = true;
				break;
			}
		}
		if (consumed) continue;
		const sepBefore = boundarySeparator(schema, i - 1);
		const j = sepBefore ? rest.lastIndexOf(sepBefore) : -1;
		if (j !== -1) rest = rest.slice(0, j);
	}
	return unwrapSlotValue(rest, schema.slots[nameIdx]);
}

/**
 * Multi-key counterpart of syncedBasename: resolve every tag slot from the
 * note's tags, keep the name slot from the current basename, reassemble, and
 * compare. Returns null when no tag slot resolved (never touch the file) or
 * when the basename is already in sync.
 */
export function syncedBasenameMulti(
	basename: string,
	tags: string[],
	schema: TrellisSchema
): string | null {
	const keys = slotTagkeys(tags, schema);
	const hasTag = schema.slots.some((s, i) => s.role === "tag" && keys[i]);
	if (!hasTag) return null;
	const name = extractNameMulti(basename, keys, schema);
	const values = schema.slots.map((s, i) => (s.role === "name" ? name : keys[i]));
	const rebuilt = assembleBasenameMulti(values, schema);
	if (rebuilt === "") return null;
	return rebuilt === basename ? null : rebuilt;
}

/** Reproject a filename after an explicit frontmatter tag change. The name is
 * parsed with BEFORE keys and emitted with AFTER keys, which is essential when
 * a branch moves between two managed tag definitions (split/merge). */
export function tagChangeProjectedName(
	basename: string,
	beforeTags: string[],
	afterTags: string[],
	schema: TrellisSchema
): string | null {
	const beforeKeys = physicalSlotTagkeys(beforeTags, schema);
	const afterKeys = physicalSlotTagkeys(afterTags, schema);
	if (
		!afterKeys.some(Boolean) &&
		!schema.slots.some((slot) => slot.role === "name")
	) return null;
	const name = extractNameMulti(basename, beforeKeys, schema);
	const values = schema.slots.map((slot, index) =>
		slot.role === "name" ? name : afterKeys[index]
	);
	const rebuilt = assembleBasenameMulti(values, schema);
	return !rebuilt || rebuilt === basename ? null : rebuilt;
}

/** Rebuild one managed basename under a new filename schema while preserving
 * its free name slot. Used by settings dry-runs for boundary formatting,
 * internal segment joiners, and advanced slot edits. Tags remain the source of
 * truth; a file with no tag resolved by the new schema is left untouched. */
export function schemaMigratedName(
	basename: string,
	tags: string[],
	oldSchema: TrellisSchema,
	newSchema: TrellisSchema
): string | null {
	const newKeys = physicalSlotTagkeys(tags, newSchema);
	const hasNewTag = newSchema.slots.some((slot, i) => slot.role === "tag" && newKeys[i]);
	const oldKeys = physicalSlotTagkeys(tags, oldSchema);
	const hasOldTag = oldSchema.slots.some((slot, i) => slot.role === "tag" && oldKeys[i]);
	if (!hasNewTag) {
		if (!hasOldTag || !newSchema.slots.some((slot) => slot.role === "name")) return null;
		const oldName = extractNameMulti(basename, oldKeys, oldSchema);
		const values = newSchema.slots.map((slot) =>
			slot.role === "name" ? oldName : null
		);
		const rebuilt = assembleBasenameMulti(values, newSchema);
		return !rebuilt || rebuilt === basename ? null : rebuilt;
	}

	const oldTagCount = oldSchema.slots.filter((slot) => slot.role === "tag").length;
	const newTagCount = newSchema.slots.filter((slot) => slot.role === "tag").length;
	let name: string;
	if (
		oldSchema.slots.length === 2 &&
		newSchema.slots.length === 2 &&
		oldTagCount === 1 &&
		newTagCount === 1
	) {
		const oldKey = oldKeys.find((value) => value !== null);
		if (oldKey) {
			name = extractTitleForSeparatorMigration(
				basename,
				oldKey,
				oldSchema,
				newSchema
			);
		} else {
			name = basename;
		}
	} else {
		name = extractNameMulti(basename, oldKeys, oldSchema);
	}
	const values = newSchema.slots.map((slot, i) =>
		slot.role === "name" ? name : newKeys[i]
	);
	const rebuilt = assembleBasenameMulti(values, newSchema);
	return rebuilt && rebuilt !== basename ? rebuilt : null;
}

/**
 * Extract the title for a separator migration. This path knows both the old and
 * new boundary separators, so it can repair a partial/mixed boundary like
 * `S88_-Title` while moving `-` → `_`.
 */
export function extractTitleForSeparatorMigration(
	basename: string,
	tagkey: string,
	oldSchema: TrellisSchema,
	newSchema: TrellisSchema
): string {
	const oldSep = primarySeparator(oldSchema);
	const newSep = primarySeparator(newSchema);
	const stripLeadingBoundary = (value: string): string => {
		let out = value;
		let changed = true;
		while (changed) {
			changed = false;
			for (const sep of [oldSep, newSep]) {
				if (sep && out.startsWith(sep)) {
					out = out.slice(sep.length);
					changed = true;
				}
			}
		}
		return out;
	};
	const stripTrailingBoundary = (value: string): string => {
		let out = value;
		let changed = true;
		while (changed) {
			changed = false;
			for (const sep of [oldSep, newSep]) {
				if (sep && out.endsWith(sep)) {
					out = out.slice(0, out.length - sep.length);
					changed = true;
				}
			}
		}
		return out;
	};

	if (tagPosition(oldSchema) === "suffix") {
		if (basename.endsWith(tagkey)) {
			const head = basename.slice(0, basename.length - tagkey.length);
			return stripTrailingBoundary(head);
		}
		let head: string;
		{
			const i = basename.lastIndexOf(oldSep);
			head = i === -1 ? "" : basename.slice(0, i);
		}
		return head;
	}

	if (basename.startsWith(tagkey)) {
		return stripLeadingBoundary(basename.slice(tagkey.length));
	}
	const i = basename.indexOf(oldSep);
	return i === -1 ? "" : basename.slice(i + oldSep.length);
}

/**
 * Separator migration: re-emit a basename with a NEW separator, preserving the
 * title verbatim (including any occurrences of the new OR old separator inside
 * it). The tagkey boundary is found with the OLD separator (oldSchema), then the
 * name is reassembled with the NEW separator (newSchema) — both are needed,
 * because once the setting flips, the old separator is the only way to locate
 * the old boundary. The two schemas share everything but the primary separator.
 * Returns null when nothing changes (no title, or old === new separator).
 */
export function separatorMigratedName(
	basename: string,
	tagkey: string,
	oldSchema: TrellisSchema,
	newSchema: TrellisSchema
): string | null {
	const title = extractTitleForSeparatorMigration(
		basename,
		tagkey,
		oldSchema,
		newSchema
	);
	const rebuilt = assembleBasename(tagkey, title, newSchema); // new-sep emit
	return rebuilt === basename ? null : rebuilt;
}

/**
 * Cascade tag rename. Rewrite a tag path and everything under it:
 *   tag "trel/S88"      , old "trel/S88" , new "trel/S99"  ->  "trel/S99"
 *   tag "trel/S88/A01"  , old "trel/S88" , new "trel/S99"  ->  "trel/S99/A01"
 *   tag "trel/S889"     , old "trel/S88" , new "trel/S99"  ->  null (boundary)
 * Tags written in frontmatter (no leading "#"). Returns null when unaffected.
 */
export function renameTagPath(
	tag: string,
	oldPath: string,
	newPath: string
): string | null {
	const relative = tagPathRelativeToNamespace(tag, oldPath);
	if (relative === null) return null;
	return relative ? `${newPath}/${relative}` : newPath;
}

// --- Root namespace migration (0.3.0 experimental, B25) ---------------------

/**
 * Rewrite ONE frontmatter tag (no leading '#') for a root-namespace change:
 * strip the old root (if any), require a slot-namespace match, then prepend the
 * new root (if any). Returns null when the tag is not a managed location tag
 * (or is already in the target shape) — callers keep those verbatim.
 *   ("tree/S/88", "", "trellis")        → "trellis/tree/S/88"
 *   ("trellis/tree/S/88", "trellis","") → "tree/S/88"
 *   ("daily/notes", …)                  → null (not managed)
 * Filenames never change here — the tagkey (post-namespace segments) is
 * identical in both shapes; only the tag's owner layer moves.
 */
export function rootMigratedTag(
	tag: string,
	oldRoot: string,
	newRoot: string,
	slotNamespaces: string[]
): string | null {
	if (oldRoot === newRoot) return null;
	let rest = tag;
	if (oldRoot) {
		const relative = tagPathRelativeToNamespace(tag, oldRoot);
		if (!relative) return null; // bare root or foreign tag
		rest = relative;
	}
	const managed = slotNamespaces.some(
		(ns) => ns && tagPathInNamespace(rest, ns)
	);
	if (!managed) return null;
	const next = newRoot ? `${newRoot}/${rest}` : rest;
	return next === tag ? null : next;
}

/**
 * Tag paths that are pure namespace scaffolding under the current schema — the
 * root layer and each slot-namespace layer (e.g. {"trellis", "trellis/tree"};
 * rootless: {"tree"}). The nested tag view can render these transparently when
 * "show root" is off: they carry structure, not user hierarchy.
 */
export function scaffoldingPaths(schema: TrellisSchema): Set<string> {
	const out = new Set<string>();
	const root = (schema.rootNamespace ?? "").trim();
	if (root) out.add(root);
	for (const ns of tagNamespaces(schema)) out.add(nsPath(schema, ns));
	return out;
}

/**
 * Normalize a frontmatter `tags` value (string | string[] | unknown) into a
 * clean string[]. A bare string may hold several whitespace/comma-separated
 * tags; non-strings are dropped.
 */
export function normalizeTagList(raw: unknown): string[] {
	const tags =
		typeof raw === "string"
			? raw.split(/[,\s]+/).filter(Boolean)
			: Array.isArray(raw)
				? raw.filter((t): t is string => typeof t === "string")
				: [];
	const seen = new Set<string>();
	return tags.filter((tag) => {
		const identity = tagPathIdentity(tag);
		if (seen.has(identity)) return false;
		seen.add(identity);
		return true;
	});
}

/**
 * Expand a list of tags into every level of every path, deduplicated & sorted.
 * Lets the rename suggester offer parent levels, not just leaf tags:
 *   ["trel/S99/A01", "trel/S77/A01"]
 *     -> ["trel", "trel/S77", "trel/S77/A01", "trel/S99", "trel/S99/A01"]
 * Leading "#" (as metadataCache.getTags yields) is stripped.
 */
export function expandTagPrefixes(tags: string[]): string[] {
	const paths = new Map<string, string>();
	for (const raw of tags) {
		const parts = raw.replace(/^#/, "").split("/").filter(Boolean);
		for (let i = 1; i <= parts.length; i++) {
			const path = parts.slice(0, i).join("/");
			if (!paths.has(tagPathIdentity(path))) paths.set(tagPathIdentity(path), path);
		}
	}
	return [...paths.values()].sort();
}

/** Case-insensitive substring filter, preserving order. */
export function filterTagSuggestions(all: string[], query: string): string[] {
	const q = query.toLowerCase();
	if (q === "") return all;
	return all.filter((t) => t.toLowerCase().includes(q));
}

/** A node in the location-tag tree used by the sidebar tree view. */
export interface TagTreeNode {
	/** This level's name, e.g. "S88". Empty string for the synthetic root. */
	segment: string;
	/** Full tag path to this node, e.g. "trel/S88". Empty for the root. */
	path: string;
	children: TagTreeNode[];
	/** Paths of notes whose location tag is *exactly* this node's path. */
	notePaths: string[];
}

/**
 * Build a nested tree from location-tag paths. The tag hierarchy ("trel/S88/L")
 * already encodes the levels, so we just split on "/" and nest. A note hangs on
 * the node whose path equals the note's full tag (so an index note tagged
 * "trel/S88" becomes the head of the S88 branch). Children and notes are sorted.
 */
export function buildTagTree(
	entries: { tagPath: string; notePath: string }[]
): TagTreeNode {
	const root: TagTreeNode = { segment: "", path: "", children: [], notePaths: [] };
	for (const { tagPath, notePath } of entries) {
		const segs = tagPath.split("/").filter(Boolean);
		let node = root;
		let acc = "";
		for (const seg of segs) {
			acc = acc ? `${acc}/${seg}` : seg;
			let child = node.children.find((candidate) => sameTagPath(candidate.segment, seg));
			if (!child) {
				child = { segment: seg, path: acc, children: [], notePaths: [] };
				node.children.push(child);
			}
			node = child;
		}
		node.notePaths.push(notePath);
	}
	sortTagTree(root);
	return root;
}

function sortTagTree(node: TagTreeNode): void {
	node.children.sort((a, b) => a.segment.localeCompare(b.segment));
	node.notePaths.sort();
	node.children.forEach(sortTagTree);
}

/** A node in the note-only tree: every node is a real note. Children are notes
 *  whose nearest tagged ancestor is this note. */
export interface NoteTreeNode {
	notePath: string;
	/** The note's full location-tag path, e.g. "trel/S88". */
	tagPath: string;
	children: NoteTreeNode[];
}

/**
 * Build a tree of NOTES (not tag segments). Pure grouping levels with no note
 * (e.g. "trel", "S77", "A" when no index note carries that exact tag) are made
 * transparent — their note descendants bubble up to the nearest noted ancestor.
 * So an index note tagged "trel/S88" becomes the parent of notes tagged
 * "trel/S88/…", folder-style, and segment-only levels vanish.
 */
export function buildNoteTree(
	entries: { tagPath: string; notePath: string }[]
): NoteTreeNode[] {
	return collapseToNotes(buildTagTree(entries));
}

/**
 * Sort a note tree by a comparator, recursively (children too). Returns a new
 * top-level array; the comparator is supplied by the caller (the plugin builds
 * it from the sort key + direction, since mtime/ctime need file stats).
 */
export function sortNoteTree(
	nodes: NoteTreeNode[],
	compare: (a: NoteTreeNode, b: NoteTreeNode) => number
): NoteTreeNode[] {
	const sorted = [...nodes].sort(compare);
	for (const node of sorted) {
		node.children = sortNoteTree(node.children, compare);
	}
	return sorted;
}

function collapseToNotes(node: TagTreeNode): NoteTreeNode[] {
	const out: NoteTreeNode[] = [];
	for (const child of node.children) {
		const descendants = collapseToNotes(child);
		if (child.notePaths.length > 0) {
			// First note at this exact tag heads the branch; extras (rare) are
			// siblings with no children of their own.
			out.push({
				notePath: child.notePaths[0],
				tagPath: child.path,
				children: descendants,
			});
			for (let i = 1; i < child.notePaths.length; i++) {
				out.push({ notePath: child.notePaths[i], tagPath: child.path, children: [] });
			}
		} else {
			// No note here → transparent level; lift its descendants up.
			out.push(...descendants);
		}
	}
	return out;
}
