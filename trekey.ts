/**
 * TRELLIS — pure conversion logic (no Obsidian dependency, unit-testable).
 *
 * The "trekey" is the filename prefix identifier. TRELLIS is *format-agnostic*:
 * it does not define what a trekey means (that is TUP's job). It only mirrors a
 * hierarchical location tag (the source of truth) into the filename prefix.
 */

/** Plugin config knobs that affect conversion. */
export interface TrellisConfig {
	/** Tag namespace treated as the location source of truth, e.g. "trel". */
	namespace: string;
	/** Separator between the trekey and the title key, e.g. "-". */
	separator: string;
	/** Where the trekey sits in the filename: at the start or the end. */
	keyPosition: "prefix" | "suffix";
}

/**
 * Convert a location tag into a trekey.
 *   "#trel/S88/B07"  (namespace "trel")  ->  "S88B07"
 * The namespace segment and all "/" hierarchy separators are stripped.
 * Returns null when the tag does not belong to the configured namespace.
 *
 * @param tag  Tag including the leading "#", as Obsidian's getAllTags() yields.
 */
export function tagToTrekey(tag: string, cfg: TrellisConfig): string | null {
	const prefix = `#${cfg.namespace}/`;
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
 * Bootstrap helper — the INVERSE of tagToTrekey. Decompose a filename trekey
 * ("S88B07") into a hierarchical location-tag path ("trel/S88/B/07") so an
 * existing vault (trekey prefixes, no tags) can be onboarded.
 *
 * This is the ONE place that must know the trekey *scheme* (SPARK: a tier
 * letter + 2-digit package as the first segment, then alternating module
 * letter (1) + atom digits (2)). Placeholder slots ("0"/"00") are KEPT as
 * segments — dropping them would break the round-trip with tagToTrekey (the
 * tag is the source of truth, so the synced filename must rebuild the same
 * 6-char trekey). Empty/segment-only levels are made transparent by the tree
 * view, so kept placeholders don't clutter the UI.
 *
 * Best-effort: returns null when the trekey doesn't fit the scheme; the
 * bootstrap dry-run shows every result (and every null) for human review
 * before anything is written.
 */
export function trekeyToTagPath(trekey: string, cfg: TrellisConfig): string | null {
	const m = trekey.match(/^([A-Z])(\d{2})([A-Z0])?(\d{2})?$/);
	if (!m) return null;
	const [, tier, pkg, mod, atom] = m;
	const segs: string[] = [tier + pkg]; // tier + package (placeholder "00" kept)
	if (mod !== undefined) segs.push(mod); // module letter (placeholder "0" kept)
	if (atom !== undefined) segs.push(atom); // atom digits (placeholder "00" kept)
	return `${cfg.namespace}/${segs.join("/")}`;
}

/**
 * Pick the first location tag (by config namespace) from a list of tags and
 * return its trekey, or null if none. TRELLIS treats one note as having one
 * location (note-to-tag 1:1) — first match wins.
 */
export function pickTrekey(tags: string[], cfg: TrellisConfig): string | null {
	for (const t of tags) {
		const k = tagToTrekey(t, cfg);
		if (k !== null) return k;
	}
	return null;
}

/**
 * Extract the current trekey slot from a filename's basename.
 * - prefix mode: everything before the first separator.
 * - suffix mode: everything after the last separator.
 * If there is no separator, the whole basename is the trekey (e.g. an index
 * note that is trekey-only).
 */
export function extractTrekey(basename: string, cfg: TrellisConfig): string {
	if (cfg.keyPosition === "suffix") {
		const i = basename.lastIndexOf(cfg.separator);
		return i === -1 ? basename : basename.slice(i + cfg.separator.length);
	}
	const i = basename.indexOf(cfg.separator);
	return i === -1 ? basename : basename.slice(0, i);
}

/**
 * Extract the title-key from a basename, given the authoritative trekey.
 * The title-key is whatever remains once the trekey slot is removed. We trust
 * the *known* trekey: if the basename starts (prefix) / ends (suffix) with the
 * trekey, the remainder is the title — even when the user deleted the separator
 * (e.g. "S99B07tree-idea" → title "tree-idea"). Otherwise the trekey slot was
 * itself altered, so fall back to the separator-delimited slot. One boundary
 * separator is stripped.
 */
export function extractTitle(
	basename: string,
	trekey: string,
	cfg: TrellisConfig
): string {
	const sep = cfg.separator;
	if (cfg.keyPosition === "suffix") {
		let head: string;
		if (basename.endsWith(trekey)) {
			head = basename.slice(0, basename.length - trekey.length);
		} else {
			const i = basename.lastIndexOf(sep);
			head = i === -1 ? "" : basename.slice(0, i + sep.length);
		}
		return head.endsWith(sep) ? head.slice(0, head.length - sep.length) : head;
	}
	let rest: string;
	if (basename.startsWith(trekey)) {
		rest = basename.slice(trekey.length);
	} else {
		const i = basename.indexOf(sep);
		rest = i === -1 ? "" : basename.slice(i);
	}
	return rest.startsWith(sep) ? rest.slice(sep.length) : rest;
}

/**
 * Rebuild the basename from the authoritative trekey + preserved title-key:
 * `{trekey}{sep}{title}` (prefix) or `{title}{sep}{trekey}` (suffix); just
 * `{trekey}` when there is no title. This restores the trekey AND the separator
 * if the user damaged either, keeping only the title-key free. Returns null
 * when no change is needed (already in sync).
 */
export function syncedBasename(
	basename: string,
	trekey: string,
	cfg: TrellisConfig
): string | null {
	const title = extractTitle(basename, trekey, cfg);
	let rebuilt: string;
	if (title === "") {
		rebuilt = trekey;
	} else if (cfg.keyPosition === "suffix") {
		rebuilt = title + cfg.separator + trekey;
	} else {
		rebuilt = trekey + cfg.separator + title;
	}
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
