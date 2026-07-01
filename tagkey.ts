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
 * just the 2-slot special case `[tag] sep [name]`. Multi-key parsing (>1 tag
 * slot, multiple separators) is deferred to an advanced mode; the model is the
 * general-form foundation so the core never needs rewriting again.
 */

/** The role of a filename slot. */
export type KeyRole = "tag" | "name";

/**
 * One slot in the filename schema. A tag-key carries the location-tag
 * namespace it mirrors; a name-key is free user text TRELLIS never rewrites.
 */
export interface KeySlot {
	role: KeyRole;
	/** Location-tag namespace for a tag slot, e.g. "trel". Absent on name slots. */
	namespace?: string;
}

/**
 * The filename schema: slots in left-to-right order plus the separators
 * between them (slots.length - 1 of them). The default is
 *   slots = [{tag, "trel"}, {name}],  separators = ["-"]
 * which reproduces the old single-key behaviour. Slot ORDER encodes position:
 * a tag slot at index 0 is a prefix tagkey, a tag slot after the name slot is a
 * suffix tagkey (the old `keyPosition` flag, now absorbed into the array).
 */
export interface TrellisSchema {
	slots: KeySlot[];
	separators: string[];
}

/**
 * A FRESH default schema — single tag-key "trel" prefix, "-" separator, free
 * name. Returns a new object every call; use this (not the DEFAULT_SCHEMA
 * constant) whenever the result will be stored in mutable settings, so the
 * shared constant is never mutated in place.
 */
export function defaultSchema(): TrellisSchema {
	return {
		slots: [{ role: "tag", namespace: "trel" }, { role: "name" }],
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
	const tag: KeySlot = { role: "tag", namespace };
	const name: KeySlot = { role: "name" };
	return {
		slots: keyPosition === "suffix" ? [name, tag] : [tag, name],
		separators: [separator],
	};
}

// --- Derived accessors (single-key view over the general schema) -----------
// The current engine operates on ONE tag slot + ONE name slot. These helpers
// read that pair out of the schema so the conversion functions stay the same
// shape; multi-tag-slot parsing is a later (advanced-mode) concern.

/** Index of the first tag slot, or -1 if somehow none (schema requires ≥1). */
function firstTagSlotIndex(schema: TrellisSchema): number {
	return schema.slots.findIndex((s) => s.role === "tag");
}

/** The namespace of the primary (first) tag slot, e.g. "trel". */
export function primaryNamespace(schema: TrellisSchema): string {
	const i = firstTagSlotIndex(schema);
	return (i >= 0 ? schema.slots[i].namespace : undefined) ?? "";
}

/** Every distinct location-tag namespace in the schema (one per tag slot). */
export function tagNamespaces(schema: TrellisSchema): string[] {
	const out: string[] = [];
	for (const s of schema.slots) {
		if (s.role === "tag" && s.namespace && !out.includes(s.namespace)) {
			out.push(s.namespace);
		}
	}
	return out;
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
	const groups: DuplicateTagGroup[] = [];
	for (const ns of tagNamespaces(schema)) {
		const matched = [
			...new Set(tags.filter((t) => t === `#${ns}` || t.startsWith(`#${ns}/`))),
		];
		if (matched.length > 1) groups.push({ namespace: ns, tags: matched });
	}
	return groups;
}

/** The primary (first) separator, e.g. "-". */
export function primarySeparator(schema: TrellisSchema): string {
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
	const prefix = `#${primaryNamespace(schema)}/`;
	if (!tag.startsWith(prefix)) return null;
	const path = tag.slice(prefix.length);
	if (path.length === 0) return null;
	return path.split("/").join("");
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
	const segs = tagkey.match(/[A-Za-z]+|[0-9]+/g);
	if (!segs || segs.length < 2) return null; // need a class transition
	if (segs.join("") !== tagkey) return null; // must round-trip exactly
	return `${primaryNamespace(schema)}/${segs.join("/")}`;
}

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
	if (tagPosition(schema) === "suffix") {
		const i = basename.lastIndexOf(sep);
		return i === -1 ? basename : basename.slice(i + sep.length);
	}
	const i = basename.indexOf(sep);
	return i === -1 ? basename : basename.slice(0, i);
}

/**
 * Extract the title-key from a basename, given the authoritative tagkey.
 * The title-key is whatever remains once the tagkey slot is removed. We trust
 * the *known* tagkey: if the basename starts (prefix) / ends (suffix) with the
 * tagkey, the remainder is the title — even when the user deleted the separator
 * (e.g. "S99B07tree-idea" → title "tree-idea"). Otherwise the tagkey slot was
 * itself altered, so fall back to the separator-delimited slot. One boundary
 * separator is stripped.
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
			head = i === -1 ? "" : basename.slice(0, i + sep.length);
		}
		return head.endsWith(sep) ? head.slice(0, head.length - sep.length) : head;
	}
	let rest: string;
	if (basename.startsWith(tagkey)) {
		rest = basename.slice(tagkey.length);
	} else {
		const i = basename.indexOf(sep);
		rest = i === -1 ? "" : basename.slice(i);
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
	const title = extractTitle(basename, tagkey, oldSchema); // old-sep boundary
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
	if (tag === oldPath) return newPath;
	if (tag.startsWith(oldPath + "/")) return newPath + tag.slice(oldPath.length);
	return null;
}

/**
 * Normalize a frontmatter `tags` value (string | string[] | unknown) into a
 * clean string[]. A bare string may hold several whitespace/comma-separated
 * tags; non-strings are dropped.
 */
export function normalizeTagList(raw: unknown): string[] {
	if (typeof raw === "string") return raw.split(/[,\s]+/).filter(Boolean);
	if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string");
	return [];
}

/**
 * Expand a list of tags into every level of every path, deduplicated & sorted.
 * Lets the rename suggester offer parent levels, not just leaf tags:
 *   ["trel/S99/A01", "trel/S77/A01"]
 *     -> ["trel", "trel/S77", "trel/S77/A01", "trel/S99", "trel/S99/A01"]
 * Leading "#" (as metadataCache.getTags yields) is stripped.
 */
export function expandTagPrefixes(tags: string[]): string[] {
	const set = new Set<string>();
	for (const raw of tags) {
		const parts = raw.replace(/^#/, "").split("/").filter(Boolean);
		for (let i = 1; i <= parts.length; i++) {
			set.add(parts.slice(0, i).join("/"));
		}
	}
	return [...set].sort();
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
			let child = node.children.find((c) => c.segment === seg);
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

/**
 * Suggest the next child segment under a parent. If the existing direct-child
 * segments are numeric, return max+1 zero-padded to width 2 ("01","02",…,"10").
 * Otherwise (no numeric children) suggest "01". The user can overwrite it (e.g.
 * a letter key for a new index level).
 */
export function nextChildSegment(childSegments: string[]): string {
	const nums = childSegments
		.filter((s) => /^\d+$/.test(s))
		.map((s) => parseInt(s, 10));
	if (nums.length === 0) return "01";
	return String(Math.max(...nums) + 1).padStart(2, "0");
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
