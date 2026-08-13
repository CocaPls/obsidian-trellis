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
export type SegmentSeparator = "" | "." | "-" | "_";
export type SeparatorSpacing = "none" | "before" | "after" | "both";

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
export type SchemeId = "spark" | "zettel" | "date" | "seq";

/** All scheme ids, in dropdown order. */
export const SCHEME_IDS: SchemeId[] = ["spark", "zettel", "date", "seq"];

/**
 * One slot in the filename schema. A tag-key carries the location-tag
 * namespace it mirrors; a name-key is free user text TRELLIS never rewrites.
 */
export interface KeySlot {
	role: KeyRole;
	/** Location-tag namespace for a tag slot, e.g. "trel". Absent on name slots. */
	namespace?: string;
	/** Optional ID scheme preset (0.3.0). Absent = format-agnostic. */
	scheme?: SchemeId;
	/** Visible joiner for hierarchy segments in this tagkey. Absent = hidden. */
	segmentSeparator?: SegmentSeparator;
}

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
	slots: KeySlot[];
	separators: string[];
	/** Whitespace rendered around each separator symbol. Absent = no spaces. */
	separatorSpacing?: SeparatorSpacing[];
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
		const full = nsPath(schema, ns); // root-aware match prefix
		const matched = [
			...new Set(tags.filter((t) => t === `#${full}` || t.startsWith(`#${full}/`))),
		];
		if (matched.length > 1) groups.push({ namespace: full, tags: matched });
	}
	return groups;
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
	const prefix = `#${primaryNsPath(schema)}/`;
	if (!tag.startsWith(prefix)) return null;
	const path = tag.slice(prefix.length);
	if (path.length === 0) return null;
	const slot = schema.slots.find((s) => s.role === "tag");
	return path.split("/").join(slot?.segmentSeparator ?? "");
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
	const segmentSeparator = slot?.segmentSeparator ?? "";
	if (segmentSeparator) {
		const segs = tagkey.split(segmentSeparator);
		if (
			segs.some((segment) => !isValidTagSegment(segment)) ||
			segs.join(segmentSeparator) !== tagkey
		) {
			return null;
		}
		return `${primaryNsPath(schema)}/${segs.join("/")}`;
	}
	// A scheme on the primary slot parses first (it may accept single-run IDs
	// the generic guard rejects — a Zettel timestamp is ONE digit run); when the
	// scheme doesn't recognise the tagkey, fall back to the generic run split so
	// mixed vaults still onboard.
	const scheme = schema.slots.find((s) => s.role === "tag")?.scheme;
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
export function looksLikeTagkey(s: string): boolean {
	const segs = s.match(/[A-Za-z]+|[0-9]+/g);
	return segs !== null && segs.length >= 2 && segs.join("") === s;
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
	return tagCount !== 1 || schema.slots.length !== 2;
}

/**
 * Whether a tag namespace is safe to use: a non-empty run of letters, digits,
 * hyphen or underscore. This excludes "/", whitespace, control characters and
 * tag/YAML metacharacters (",", "[", "]", "#", quotes, newlines), so a namespace
 * can never break tag matching (`#ns/…`) or inject into the `tags: [ns/…]`
 * frontmatter that new-note creation writes. Namespaces are the tag ROOT only
 * (the hierarchy comes from the tag path), so this allowlist is not restrictive
 * in practice (e.g. "trel", "tree", "proj").
 */
export function isValidNamespace(ns: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(ns);
}

/**
 * Whether a string is usable as a filename separator. It is inserted between
 * the tagkey and the title in the actual filename, so it must be non-empty and
 * must avoid: letters/digits (they'd blur the tagkey↔title boundary), the
 * filesystem-illegal set (`\ / : * ? " < > |`), the Obsidian/wikilink-hostile
 * set (`# ^ [ ]`), and any whitespace or control character. Other punctuation
 * (`-`, `_`, `.`, `~`, `=`, `+`, …) is allowed, so uncommon parse-safe symbols
 * stay available. Mirrors the reject set the settings UI used inline, made a
 * pure, tested function shared by simple- and advanced-mode validation.
 */
export function isValidSeparator(s: string): boolean {
	if (s === "") return false;
	return !/[A-Za-z0-9/\\:*?"<>|#^[\]]|\s/.test(s);
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
}

/** Adjacent tag-segment and slot-boundary separators that render identically
 * without spaces make the filename schema ambiguous to parse. */
export function separatorConflicts(schema: TrellisSchema): SeparatorConflict[] {
	const conflicts: SeparatorConflict[] = [];
	for (let slotIndex = 0; slotIndex < schema.slots.length; slotIndex++) {
		const slot = schema.slots[slotIndex];
		if (slot.role !== "tag" || !slot.segmentSeparator) continue;
		for (const gapIndex of [slotIndex - 1, slotIndex]) {
			if (
				gapIndex >= 0 &&
				gapIndex < schema.separators.length &&
				separatorSpacingAt(schema, gapIndex) === "none" &&
				schema.separators[gapIndex] === slot.segmentSeparator
			) {
				conflicts.push({ slotIndex, gapIndex });
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

/** tagToTagkey for an explicit namespace (multi-key: each tag slot has its own). */
export function tagToTagkeyNs(
	tag: string,
	namespace: string,
	segmentSeparator: SegmentSeparator = ""
): string | null {
	const prefix = `#${namespace}/`;
	if (!tag.startsWith(prefix)) return null;
	const path = tag.slice(prefix.length);
	if (path.length === 0) return null;
	return path.split("/").join(segmentSeparator);
}

/** First location tag under a namespace → its tagkey, or null. */
export function pickTagkeyNs(
	tags: string[],
	namespace: string,
	segmentSeparator: SegmentSeparator = ""
): string | null {
	for (const t of tags) {
		const k = tagToTagkeyNs(t, namespace, segmentSeparator);
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
	return schema.slots.map((s) =>
		s.role === "tag" && s.namespace
			? pickTagkeyNs(tags, nsPath(schema, s.namespace), s.segmentSeparator)
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
		if (any) out += boundarySeparator(schema, i - 1) || primarySeparator(schema);
		out += v;
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
		const v = tagkeys[i];
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
		const v = tagkeys[i];
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
	return rest;
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
	if (tag === oldPath) return newPath;
	if (tag.startsWith(oldPath + "/")) return newPath + tag.slice(oldPath.length);
	return null;
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
		if (!tag.startsWith(oldRoot + "/")) return null; // bare root or foreign tag
		rest = tag.slice(oldRoot.length + 1);
	}
	const managed = slotNamespaces.some(
		(ns) => ns && (rest === ns || rest.startsWith(ns + "/"))
	);
	if (!managed) return null;
	const next = newRoot ? `${newRoot}/${rest}` : rest;
	return next === tag ? null : next;
}

// --- ID scheme presets (0.3.0 experimental, B26) ----------------------------
// A scheme touches ONLY ① new-note segment suggestion and ② bootstrap parsing.
// Live sync stays format-agnostic: it mirrors whatever segments the tag holds.

/** The next letter run in alphabetical base-26: "A"→"B", "Z"→"AA", "AZ"→"BA". */
function nextLetterRun(s: string): string {
	const upper = s === s.toUpperCase();
	const chars = s.toUpperCase().split("");
	let i = chars.length - 1;
	while (i >= 0) {
		if (chars[i] !== "Z") {
			chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
			break;
		}
		chars[i] = "A";
		i--;
	}
	if (i < 0) chars.unshift("A");
	const out = chars.join("");
	return upper ? out : out.toLowerCase();
}

/** max+1 over numeric siblings, zero-padded to the widest sibling. */
function nextNumberRun(siblings: string[]): string {
	let max = 0;
	let width = 1;
	for (const s of siblings) {
		const n = parseInt(s, 10);
		if (n > max) max = n;
		if (s.length > width) width = s.length;
	}
	return String(max + 1).padStart(width, "0");
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Suggest the next child segment under a parent, per scheme. The suggestion is
 * exactly that — the new-note modal prefills it and the user can overtype, so
 * a wrong guess costs one edit, never a wrong file.
 *  - spark:  siblings all digits → next number (width kept); all letters →
 *            next letter run; none → alternate with the parent's class
 *            (letters → "01", digits → a letter); mixed/unknown → "01".
 *  - seq:    next number over numeric siblings ("1" when none).
 *  - zettel: YYYYMMDDHHMMSS of `now`.
 *  - date:   YYYYMMDD of `now`.
 */
export function suggestSegment(
	scheme: SchemeId,
	parentSegment: string,
	siblings: string[],
	now: Date
): string {
	if (scheme === "zettel") {
		return (
			`${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
			`${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
		);
	}
	if (scheme === "date") {
		return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
	}
	if (scheme === "seq") {
		const nums = siblings.filter((s) => /^[0-9]+$/.test(s));
		return nums.length ? nextNumberRun(nums) : "1";
	}
	// spark — alternating letter/digit layers.
	const digitSibs = siblings.filter((s) => /^[0-9]+$/.test(s));
	const letterSibs = siblings.filter((s) => /^[A-Za-z]+$/.test(s));
	if (siblings.length > 0) {
		if (digitSibs.length === siblings.length) return nextNumberRun(digitSibs);
		if (letterSibs.length === siblings.length) {
			// Base-26 order = length FIRST, then lexicographic — plain lexicographic
			// would rank "Z" above "AA" and re-suggest an existing "AA".
			const max = [...letterSibs].sort((a, b) => {
				if (a.length !== b.length) return a.length - b.length;
				return a.toUpperCase() < b.toUpperCase() ? -1 : 1;
			})[letterSibs.length - 1];
			return nextLetterRun(max);
		}
		return digitSibs.length ? nextNumberRun(digitSibs) : "01";
	}
	if (/^[A-Za-z]+$/.test(parentSegment)) return "01";
	if (/^[0-9]+$/.test(parentSegment)) return "A";
	return "01";
}

/**
 * Scheme-aware bootstrap segmentation of a flat tagkey. Returns the segments,
 * or null when the tagkey doesn't fit the scheme (caller falls back to the
 * generic character-class run split). Single-ID schemes accept ONE run the
 * generic guard would reject; spark is exactly the generic split.
 */
export function schemeSegments(scheme: SchemeId, tagkey: string): string[] | null {
	if (scheme === "zettel") return /^[0-9]{12,14}$/.test(tagkey) ? [tagkey] : null;
	if (scheme === "date") return /^[0-9]{8}$/.test(tagkey) ? [tagkey] : null;
	if (scheme === "seq") return /^[0-9]+$/.test(tagkey) ? [tagkey] : null;
	// spark — same alternating run split as the generic path, same guards.
	return looksLikeTagkey(tagkey) ? tagkey.match(/[A-Za-z]+|[0-9]+/g)! : null;
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
	return [...new Set(tags)];
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
