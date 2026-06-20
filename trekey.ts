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
