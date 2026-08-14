import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrellisSchema } from "../src/tagkey.ts";
import {
	DEFAULT_SCHEMA,
	schemaFromLegacy,
	tagToTagkey,
	pickTagkey,
	tagNamespaces,
	matchTagKey,
	duplicateLocationGroups,
	assembleBasename,
	syncedBasename,
	separatorMigratedName,
	extractTitleForSeparatorMigration,
	extractTagkey,
	extractTitle,
	renameTagPath,
	normalizeTagList,
	expandTagPrefixes,
	filterTagSuggestions,
	buildTagTree,
	buildNoteTree,
	sortNoteTree,
	tagkeyToTagPath,
	looksLikeTagkey,
	isMultiKey,
	tagToTagkeyNs,
	pickTagkeyNs,
	slotTagkeys,
	assembleBasenameMulti,
	extractNameMulti,
	syncedBasenameMulti,
	tagChangeProjectedName,
	isValidNamespace,
	isValidSeparator,
	isValidTagSegment,
	isValidTagSegmentForSlot,
	isValidTagPath,
	renderSeparator,
	boundarySeparator,
	primarySeparatorSymbol,
	separatorConflicts,
	schemaMigratedName,
	portableBasenameIssue,
	normalizeSchemaModel,
	renderSlotValue,
	unwrapSlotValue,
	isValidHierarchySeparator,
	isValidSlotWrapper,
	sameTagPath,
	tagPathInNamespace,
	tagPathRelativeToNamespace,
} from "../src/tagkey.ts";

const cfg: TrellisSchema = schemaFromLegacy("trel", "-", "prefix");
const cfgSuffix: TrellisSchema = schemaFromLegacy("trel", "-", "suffix");

test("tagToTagkey strips namespace and slashes", () => {
	assert.equal(tagToTagkey("#trel/S88/B07", cfg), "S88B07");
	assert.equal(tagToTagkey("#trel/P/07/M/01", cfg), "P07M01");
});

test("tagToTagkey ignores foreign namespaces and empties", () => {
	assert.equal(tagToTagkey("#project/work", cfg), null);
	assert.equal(tagToTagkey("#trel", cfg), null); // no trailing path
	assert.equal(tagToTagkey("#trel/", cfg), null); // empty path
});

test("tagkeyToTagPath decomposes a tagkey at character-class boundaries", () => {
	assert.equal(tagkeyToTagPath("S88", cfg), "trel/S/88"); // letter · digits
	assert.equal(tagkeyToTagPath("S88A", cfg), "trel/S/88/A");
	assert.equal(tagkeyToTagPath("S88B07", cfg), "trel/S/88/B/07");
	assert.equal(tagkeyToTagPath("PROJ123", cfg), "trel/PROJ/123"); // scheme-agnostic
	assert.equal(tagkeyToTagPath("A1B2", cfg), "trel/A/1/B/2");
	assert.equal(tagkeyToTagPath("88B07", cfg), "trel/88/B/07"); // no leading letter needed
});

test("tagkeyToTagPath keeps consecutive same-class characters in one segment", () => {
	// A general split does not recover fixed-width inner boundaries; the run stays whole.
	assert.equal(tagkeyToTagPath("S04001", cfg), "trel/S/04001");
	assert.equal(tagkeyToTagPath("P00001", cfg), "trel/P/00001");
	assert.equal(tagkeyToTagPath("S00M", cfg), "trel/S/00/M");
	assert.equal(tagkeyToTagPath("S00L", cfg), "trel/S/00/L");
});

test("tagkeyToTagPath round-trips with tagToTagkey", () => {
	for (const tk of ["S88", "S88A", "S88B07", "PROJ123", "A1B2", "S04001", "88B07"]) {
		const tag = tagkeyToTagPath(tk, cfg);
		assert.equal(tagToTagkey("#" + tag, cfg), tk, `round-trip failed for ${tk}`);
	}
});

test("tagkeyToTagPath rejects tagkeys with no recoverable hierarchy", () => {
	assert.equal(tagkeyToTagPath("S", cfg), null); // single run, no transition
	assert.equal(tagkeyToTagPath("hello", cfg), null); // plain word
	assert.equal(tagkeyToTagPath("12345", cfg), null); // plain number
	assert.equal(tagkeyToTagPath("my-note", cfg), null); // not round-trip-safe (drops "-")
	assert.equal(tagkeyToTagPath("12.03", cfg), null); // not round-trip-safe (drops ".")
});

test("pickTagkey returns the first location tag, ignoring others", () => {
	assert.equal(pickTagkey(["#status/wip", "#trel/S88/B07"], cfg), "S88B07");
	assert.equal(pickTagkey(["#status/wip", "#area/sys"], cfg), null);
	assert.equal(pickTagkey([], cfg), null);
});

test("pickTagkey stays deterministic with multiple location tags (first wins)", () => {
	// One note = one location; if a note carries two location tags the plugin
	// warns (see syncFile) but still resolves to the first for a stable filename.
	assert.equal(pickTagkey(["#trel/S88/B07", "#trel/P02/C03"], cfg), "S88B07");
	assert.equal(pickTagkey(["#trel/P02/C03", "#trel/S88/B07"], cfg), "P02C03");
});

test("tagNamespaces lists distinct tag-slot namespaces in order", () => {
	assert.deepEqual(tagNamespaces(cfg), ["trel"]);
	const multi: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "trel" },
			{ role: "name" },
			{ role: "tag", namespace: "proj" },
		],
		separators: ["-"],
	};
	assert.deepEqual(tagNamespaces(multi), ["trel", "proj"]);
});

test("matchTagKey separates ordinary tags and identifies the owning tag-key", () => {
	const multi: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "bp" },
			{ role: "name" },
			{ role: "tag", namespace: "title" },
		],
		separators: ["-", "-"],
	};
	assert.deepEqual(matchTagKey("#title/policy/edit", multi), {
		slotIndex: 2,
		tagDefinitionId: "legacy-title",
		namespace: "title",
		fullNamespace: "title",
		tagPath: "title/policy/edit",
		keyPath: "policy/edit",
	});
	assert.equal(matchTagKey("#status/wip", multi), null);
	assert.equal(matchTagKey("#titlecase/policy", multi), null);
	assert.equal(matchTagKey("#title", multi)?.keyPath, "");
});

test("matchTagKey applies the optional owner root before classifying", () => {
	const rooted: TrellisSchema = {
		rootNamespace: "trellis",
		slots: [
			{ role: "tag", namespace: "bp" },
			{ role: "tag", namespace: "title" },
		],
		separators: ["-"],
	};
	assert.equal(matchTagKey("#trellis/bp/system", rooted)?.slotIndex, 0);
	assert.equal(matchTagKey("#trellis/title/policy", rooted)?.slotIndex, 1);
	assert.equal(matchTagKey("#bp/system", rooted), null);
});

test("managed tag identity follows Obsidian's case-insensitive tag rules", () => {
	const rooted: TrellisSchema = {
		rootNamespace: "Trellis",
		tagDefinitions: [
			{ id: "bp", name: "Blueprint", namespace: "BP", sidebarVisible: true },
		],
		slots: [
			{ id: "slot-bp", role: "tag", tagDefinitionId: "bp" },
			{ id: "slot-name", role: "name" },
		],
		separators: ["-"],
	};
	const match = matchTagKey("#trellis/bp/N/e/03", rooted);
	assert.equal(match?.tagDefinitionId, "bp");
	assert.equal(match?.fullNamespace, "Trellis/BP");
	assert.equal(match?.keyPath, "N/e/03");
	assert.equal(tagToTagkey("#TRELLIS/BP/N/E/03", rooted), "NE03");
	assert.equal(sameTagPath("#Trellis/BP", "trellis/bp"), true);
	assert.equal(tagPathInNamespace("TRELLIS/bp/N/03", "trellis/BP"), true);
	assert.equal(
		tagPathRelativeToNamespace("TRELLIS/bp/N/03", "trellis/BP"),
		"N/03"
	);
});

test("schema normalization merges case-only duplicate tag definitions by stable id", () => {
	const duplicate: TrellisSchema = {
		tagDefinitions: [
			{ id: "bp-lower", name: "Blueprint", namespace: "bp", sidebarVisible: true },
			{ id: "bp-upper", name: "Duplicate", namespace: "BP", sidebarVisible: true },
		],
		slots: [
			{ id: "slot-1", role: "tag", tagDefinitionId: "bp-upper" },
			{ id: "slot-2", role: "name" },
		],
		separators: ["-"],
	};
	const normalized = normalizeSchemaModel(duplicate);
	assert.deepEqual(normalized.tagDefinitions?.map((definition) => definition.id), ["bp-lower"]);
	assert.equal(normalized.slots[0].tagDefinitionId, "bp-lower");
});

test("duplicateLocationGroups flags a namespace carrying 2+ location tags", () => {
	// one location tag (plus unrelated) → clean
	assert.deepEqual(duplicateLocationGroups(["#trel/S88/B07", "#status/wip"], cfg), []);
	// the same tag repeated (frontmatter + inline) → not a duplicate
	assert.deepEqual(duplicateLocationGroups(["#trel/S88/B07", "#trel/S88/B07"], cfg), []);
	// two distinct location tags in one namespace → flagged
	const groups = duplicateLocationGroups(["#trel/S88/B07", "#trel/P02/C03"], cfg);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].namespace, "trel");
	assert.deepEqual(groups[0].tags, ["#trel/S88/B07", "#trel/P02/C03"]);
});

test("extractTagkey (prefix) takes everything before the first separator", () => {
	assert.equal(extractTagkey("S88B07-tree-idea", cfg), "S88B07");
	assert.equal(extractTagkey("S88B07", cfg), "S88B07"); // tagkey-only
	assert.equal(extractTagkey("S88B07-a-b-c", cfg), "S88B07"); // first only
});

test("extractTagkey (suffix) takes everything after the last separator", () => {
	assert.equal(extractTagkey("tree-idea-S88B07", cfgSuffix), "S88B07");
	assert.equal(extractTagkey("S88B07", cfgSuffix), "S88B07"); // tagkey-only
	assert.equal(extractTagkey("a-b-S88B07", cfgSuffix), "S88B07"); // last only
});

test("syncedBasename (prefix) replaces prefix, preserves the rest", () => {
	assert.equal(syncedBasename("S88B07-tree-idea", "S88B99", cfg), "S88B99-tree-idea");
	assert.equal(syncedBasename("S88B07", "S88B99", cfg), "S88B99"); // tagkey-only
});

test("syncedBasename (suffix) replaces suffix, preserves the head", () => {
	assert.equal(syncedBasename("tree-idea-S88B07", "S88B99", cfgSuffix), "tree-idea-S88B99");
	assert.equal(syncedBasename("S88B07", "S88B99", cfgSuffix), "S88B99"); // tagkey-only
});

test("extractTitle (prefix) recovers the title even if separator was deleted", () => {
	assert.equal(extractTitle("S99B07-tree-idea", "S99B07", cfg), "tree-idea");
	assert.equal(extractTitle("S99B07tree-idea", "S99B07", cfg), "tree-idea"); // sep deleted
	assert.equal(extractTitle("S99B07", "S99B07", cfg), ""); // tagkey-only
	assert.equal(extractTitle("XXXX-tree-idea", "S99B07", cfg), "tree-idea"); // tagkey altered
});

test("extractTitle (suffix) recovers the title from the head", () => {
	assert.equal(extractTitle("tree-idea-S99B07", "S99B07", cfgSuffix), "tree-idea");
	assert.equal(extractTitle("tree-ideaS99B07", "S99B07", cfgSuffix), "tree-idea"); // sep deleted
	assert.equal(extractTitle("S99B07", "S99B07", cfgSuffix), ""); // tagkey-only
});

test("syncedBasename restores tagkey AND separator, keeps only the title free", () => {
	// separator deleted → title preserved, separator restored
	assert.equal(syncedBasename("S99B07tree-idea", "S99B07", cfg), "S99B07-tree-idea");
	// no separator, not tagkey-like → treated as a free title, tagkey PREPENDED
	// (0.2.0 data-safety change: never overwrite a real title)
	assert.equal(syncedBasename("ZZZZ", "S99B07", cfg), "S99B07-ZZZZ");
	// already correct → no change
	assert.equal(syncedBasename("S99B07-tree-idea", "S99B07", cfg), null);
	// title with multiple separators is preserved whole
	assert.equal(syncedBasename("S99B07-multi-word-title", "S99B07", cfg), null);
	// suffix: separator deleted → restored
	assert.equal(syncedBasename("tree-ideaS99B07", "S99B07", cfgSuffix), "tree-idea-S99B07");
});

test("syncedBasename returns null when already in sync", () => {
	assert.equal(syncedBasename("S88B07-tree-idea", "S88B07", cfg), null);
	assert.equal(syncedBasename("S88B07", "S88B07", cfg), null);
});

test("syncedBasename preserves trailing date/session segments", () => {
	// session-log style: tagkey + date + session code after the title
	assert.equal(
		syncedBasename("S88L04-0611-S88-04-dashboard", "S88L99", cfg),
		"S88L99-0611-S88-04-dashboard"
	);
});

test("assembleBasename joins tagkey + title by slot order and separator", () => {
	assert.equal(assembleBasename("S88B07", "tree-idea", cfg), "S88B07-tree-idea");
	assert.equal(assembleBasename("S88B07", "", cfg), "S88B07"); // no title → tagkey only
	assert.equal(assembleBasename("S88B07", "tree-idea", cfgSuffix), "tree-idea-S88B07");
});

// --- Separator migration (v0.0.7 batch separator change) -------------------

test("separatorMigratedName swaps the boundary separator, preserves the title", () => {
	const oldS = schemaFromLegacy("trel", "_", "prefix");
	const newS = schemaFromLegacy("trel", "-", "prefix");
	// boundary "_" → "-"; title has none, simple swap
	assert.equal(separatorMigratedName("S88B07_tree", "S88B07", oldS, newS), "S88B07-tree");
	// tagkey-only file: nothing to change
	assert.equal(separatorMigratedName("S88B07", "S88B07", oldS, newS), null);
});

test("separatorMigratedName repairs mixed prefix boundaries from partial migrations", () => {
	const hyphen = schemaFromLegacy("trel", "-", "prefix");
	const underscore = schemaFromLegacy("trel", "_", "prefix");
	assert.equal(
		extractTitleForSeparatorMigration("S88-TRELLIS", "S88", hyphen, underscore),
		"TRELLIS"
	);
	assert.equal(separatorMigratedName("S88-TRELLIS", "S88", hyphen, underscore), "S88_TRELLIS");
	assert.equal(
		separatorMigratedName("S88_-TRELLIS", "S88", hyphen, underscore),
		"S88_TRELLIS"
	);
	assert.equal(
		separatorMigratedName("S88_-_TRELLIS", "S88", hyphen, underscore),
		"S88_TRELLIS"
	);
	for (const name of [
		"S88-_TRELLIS",
		"S88-_-TRELLIS",
		"S88__--__TRELLIS",
		"S88--TRELLIS",
		"S88__TRELLIS",
	]) {
		assert.equal(separatorMigratedName(name, "S88", hyphen, underscore), "S88_TRELLIS");
	}
});

test("separatorMigratedName repairs mixed suffix boundaries from partial migrations", () => {
	const hyphen = schemaFromLegacy("trel", "-", "suffix");
	const underscore = schemaFromLegacy("trel", "_", "suffix");
	assert.equal(
		extractTitleForSeparatorMigration("TRELLIS-S88", "S88", hyphen, underscore),
		"TRELLIS"
	);
	assert.equal(separatorMigratedName("TRELLIS-S88", "S88", hyphen, underscore), "TRELLIS_S88");
	assert.equal(
		separatorMigratedName("TRELLIS_-S88", "S88", hyphen, underscore),
		"TRELLIS_S88"
	);
	assert.equal(
		separatorMigratedName("TRELLIS_-_S88", "S88", hyphen, underscore),
		"TRELLIS_S88"
	);
	for (const name of [
		"TRELLIS-_S88",
		"TRELLIS-_-S88",
		"TRELLIS__--__S88",
		"TRELLIS--S88",
		"TRELLIS__S88",
	]) {
		assert.equal(separatorMigratedName(name, "S88", hyphen, underscore), "TRELLIS_S88");
	}
});

test("separatorMigratedName preserves the NEW separator already inside the title", () => {
	const oldS = schemaFromLegacy("trel", "_", "prefix");
	const newS = schemaFromLegacy("trel", "-", "prefix");
	// title "tree-idea" keeps its hyphens; only the tagkey boundary "_" becomes "-"
	assert.equal(
		separatorMigratedName("S88B07_tree-idea", "S88B07", oldS, newS),
		"S88B07-tree-idea"
	);
	// title "a_b" (old sep inside title) is preserved verbatim — only the FIRST
	// boundary is the tagkey delimiter; the rest belongs to the title.
	assert.equal(
		separatorMigratedName("S88B07_a_b", "S88B07", oldS, newS),
		"S88B07-a_b"
	);
});

test("separatorMigratedName handles suffix slot order", () => {
	const oldS = schemaFromLegacy("trel", "_", "suffix");
	const newS = schemaFromLegacy("trel", "-", "suffix");
	assert.equal(
		separatorMigratedName("tree-idea_S88B07", "S88B07", oldS, newS),
		"tree-idea-S88B07"
	);
});

test("separatorMigratedName returns null when old and new separators match", () => {
	const same = schemaFromLegacy("trel", "-", "prefix");
	assert.equal(separatorMigratedName("S88B07-tree", "S88B07", same, same), null);
});

test("renameTagPath rewrites the path and everything under it", () => {
	assert.equal(renameTagPath("trel/S88", "trel/S88", "trel/S99"), "trel/S99");
	assert.equal(renameTagPath("trel/S88/A01", "trel/S88", "trel/S99"), "trel/S99/A01");
	assert.equal(renameTagPath("trel/S88/B/07", "trel/S88", "trel/S99"), "trel/S99/B/07");
});

test("renameTagPath respects boundaries (no partial-segment match)", () => {
	assert.equal(renameTagPath("trel/S889", "trel/S88", "trel/S99"), null);
	assert.equal(renameTagPath("trel/S77/A01", "trel/S88", "trel/S99"), null);
	assert.equal(renameTagPath("other", "trel/S88", "trel/S99"), null);
});

test("normalizeTagList handles string, array, and junk", () => {
	assert.deepEqual(normalizeTagList(["trel/S88", "x"]), ["trel/S88", "x"]);
	assert.deepEqual(normalizeTagList(["trel/S88", "x", "trel/S88"]), ["trel/S88", "x"]);
	assert.deepEqual(normalizeTagList("trel/S88, x"), ["trel/S88", "x"]);
	assert.deepEqual(normalizeTagList("trel/S88, x trel/S88"), ["trel/S88", "x"]);
	assert.deepEqual(normalizeTagList("trel/S88"), ["trel/S88"]);
	assert.deepEqual(normalizeTagList(undefined), []);
	assert.deepEqual(normalizeTagList([1, "ok", null]), ["ok"]);
});

test("normalizeTagList deduplicates case-only variants while preserving first casing", () => {
	assert.deepEqual(normalizeTagList(["BP/N/03", "bp/n/03", "status/open"]), [
		"BP/N/03",
		"status/open",
	]);
});

test("expandTagPrefixes yields every level, deduped and sorted", () => {
	assert.deepEqual(expandTagPrefixes(["trel/S99/A01", "trel/S77/A01"]), [
		"trel",
		"trel/S77",
		"trel/S77/A01",
		"trel/S99",
		"trel/S99/A01",
	]);
	// strips leading '#' (as metadataCache.getTags yields)
	assert.deepEqual(expandTagPrefixes(["#trel/S88"]), ["trel", "trel/S88"]);
});

test("filterTagSuggestions is case-insensitive substring, order-preserving", () => {
	const all = ["trel", "trel/S77", "trel/S99", "trel/S99/A01"];
	assert.deepEqual(filterTagSuggestions(all, "s99"), ["trel/S99", "trel/S99/A01"]);
	assert.deepEqual(filterTagSuggestions(all, ""), all);
	assert.deepEqual(filterTagSuggestions(all, "zzz"), []);
});

test("buildTagTree nests by tag path and hangs notes on exact-match nodes", () => {
	const root = buildTagTree([
		{ tagPath: "trel/S88/L/04", notePath: "S88L04.md" },
		{ tagPath: "trel/S88/L/01", notePath: "S88L01.md" },
		{ tagPath: "trel/S88", notePath: "S88.md" },
		{ tagPath: "trel/S77/A01", notePath: "S77A01.md" },
	]);

	// root → trel
	assert.equal(root.children.length, 1);
	const trel = root.children[0];
	assert.equal(trel.segment, "trel");
	assert.equal(trel.path, "trel");

	// trel → S77, S88 (sorted)
	assert.deepEqual(trel.children.map((c) => c.segment), ["S77", "S88"]);

	const s88 = trel.children[1];
	assert.equal(s88.path, "trel/S88");
	assert.deepEqual(s88.notePaths, ["S88.md"]); // index note hangs here
	assert.deepEqual(s88.children.map((c) => c.segment), ["L"]);

	// L → 01, 04 (sorted), each carrying its note
	const l = s88.children[0];
	assert.deepEqual(l.children.map((c) => c.segment), ["01", "04"]);
	assert.deepEqual(l.children[0].notePaths, ["S88L01.md"]);
	assert.deepEqual(l.children[1].notePaths, ["S88L04.md"]);
});

test("buildNoteTree shows only notes; segment-only levels are transparent", () => {
	const roots = buildNoteTree([
		{ tagPath: "trel/S88", notePath: "S88-trellis.md" },
		{ tagPath: "trel/S88/A", notePath: "S88A-defs.md" },
		{ tagPath: "trel/S88/A/01", notePath: "S88A01-def.md" },
		{ tagPath: "trel/S77/A/01", notePath: "S77A01-other.md" }, // no S77/S77A index
	]);

	// Top level: S77A01 (no noted ancestor → bubbles to root) + S88-trellis.
	assert.deepEqual(
		roots.map((n) => n.notePath),
		["S77A01-other.md", "S88-trellis.md"]
	);

	// S88-trellis heads its branch; A index nests under it; the segment levels
	// "trel" / "S88" (as raw segments) never appear.
	const s88 = roots[1];
	assert.deepEqual(s88.children.map((n) => n.notePath), ["S88A-defs.md"]);
	assert.deepEqual(s88.children[0].children.map((n) => n.notePath), ["S88A01-def.md"]);

	// S77A01 had no S77/S77A index note, so it sits at root with no children.
	assert.deepEqual(roots[0].children, []);
});

test("sortNoteTree sorts siblings recursively by the comparator", () => {
	const roots = [
		{
			notePath: "S88.md",
			tagPath: "trel/S88",
			children: [
				{ notePath: "S88L.md", tagPath: "trel/S88/L", children: [] },
				{ notePath: "S88A.md", tagPath: "trel/S88/A", children: [] },
			],
		},
		{ notePath: "S77.md", tagPath: "trel/S77", children: [] },
	];
	const asc = sortNoteTree(roots, (a, b) => a.notePath.localeCompare(b.notePath));
	assert.deepEqual(asc.map((n) => n.notePath), ["S77.md", "S88.md"]);
	assert.deepEqual(asc[1].children.map((n) => n.notePath), ["S88A.md", "S88L.md"]);

	// reverse comparator → descending
	const desc = sortNoteTree(roots, (a, b) => b.notePath.localeCompare(a.notePath));
	assert.deepEqual(desc.map((n) => n.notePath), ["S88.md", "S77.md"]);
});

// --- Multi-key data model (B09 "path B": filename = positional slot array) ---

test("DEFAULT_SCHEMA reproduces the single-key prefix behaviour", () => {
	assert.equal(tagToTagkey("#trel/S88/B07", DEFAULT_SCHEMA), "S88B07");
	assert.equal(extractTagkey("S88B07-tree-idea", DEFAULT_SCHEMA), "S88B07");
	assert.equal(syncedBasename("S88B07-old", "S88B99", DEFAULT_SCHEMA), "S88B99-old");
});

test("schemaFromLegacy maps keyPosition onto slot ORDER", () => {
	assert.deepEqual(schemaFromLegacy("trel", "-", "prefix").slots.map((s) => s.role), ["tag", "name"]);
	assert.deepEqual(schemaFromLegacy("trel", "-", "suffix").slots.map((s) => s.role), ["name", "tag"]);
	assert.deepEqual(schemaFromLegacy("trel", "-", "prefix").separators, ["-"]);
	assert.equal(schemaFromLegacy("trel", "-", "prefix").separatorSpacing, undefined);
});

test("boundary symbol and spacing are stored and rendered independently", () => {
	assert.equal(renderSeparator("-", "none"), "-");
	assert.equal(renderSeparator("-", "before"), " -");
	assert.equal(renderSeparator("-", "after"), "- ");
	assert.equal(renderSeparator("-", "both"), " - ");
	const schema: TrellisSchema = {
		slots: [{ role: "tag", namespace: "trel" }, { role: "name" }],
		separators: ["-"],
		separatorSpacing: ["both"],
	};
	assert.equal(primarySeparatorSymbol(schema), "-");
	assert.equal(boundarySeparator(schema, 0), " - ");
	assert.equal(assembleBasename("S88", "사과", schema), "S88 - 사과");
	assert.equal(extractTitle("S88 - 사과", "S88", schema), "사과");
	assert.equal(syncedBasename("S99 - 사과", "S88", schema), "S88 - 사과");
	assert.equal(
		separatorMigratedName("S88-사과", "S88", cfg, schema),
		"S88 - 사과"
	);
});

test("tag-slot segment separators preserve hierarchy visibly and Bootstrap reverses it", () => {
	const schema: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "trel", segmentSeparator: "." },
			{ role: "name" },
		],
		separators: ["-"],
	};
	assert.equal(tagToTagkey("#trel/S/88/B/07", schema), "S.88.B.07");
	assert.equal(tagkeyToTagPath("S.88.B.07", schema), "trel/S/88/B/07");
	assert.equal(tagkeyToTagPath("S..88", schema), null);
	assert.equal(tagkeyToTagPath("S88", schema), "trel/S88");
});

test("each tag slot uses its own internal segment separator", () => {
	const schema: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "trel", segmentSeparator: "." },
			{ role: "name" },
			{ role: "tag", namespace: "proj", segmentSeparator: "_" },
		],
		separators: ["-", "-"],
	};
	assert.deepEqual(slotTagkeys(["#trel/S/88", "#proj/P/02"], schema), [
		"S.88",
		null,
		"P_02",
	]);
	assert.equal(
		syncedBasenameMulti("old", ["#trel/S/88", "#proj/P/02"], schema),
		"S.88-old-P_02"
	);
});

test("an internal separator cannot be ambiguous with an adjacent unspaced boundary", () => {
	const conflicting: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "trel", segmentSeparator: "-" },
			{ role: "name" },
		],
		separators: ["-"],
	};
	assert.deepEqual(separatorConflicts(conflicting), [{ slotIndex: 0, gapIndex: 0 }]);
	assert.deepEqual(
		separatorConflicts({ ...conflicting, separatorSpacing: ["after"] }),
		[]
	);
	assert.equal(
		isValidTagSegmentForSlot("A-B", conflicting.slots[0]),
		false
	);
	assert.equal(isValidTagSegmentForSlot("AB", conflicting.slots[0]), true);
});

test("name schemas reject boundary separators with a prefix relationship", () => {
	const ambiguous: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "trel" },
			{ role: "name" },
			{ role: "tag", namespace: "proj" },
		],
		separators: ["-", "--"],
	};
	assert.deepEqual(separatorConflicts(ambiguous), [
		{ slotIndex: 1, gapIndex: 0, otherGapIndex: 1 },
	]);
	// This is the concrete lossy case the validation prevents: the title's
	// leading "-" would otherwise be consumed as part of the longer separator.
	assert.equal(
		extractNameMulti("AA01--idea--BB02", ["AA01", null, "BB02"], ambiguous),
		"idea"
	);

	assert.deepEqual(
		separatorConflicts({ ...ambiguous, separatorSpacing: ["after", "none"] }),
		[]
	);
	assert.deepEqual(
		separatorConflicts({ ...ambiguous, separators: ["-", "-"] }),
		[]
	);
});

test("separator conflict validation covers the supported punctuation matrix", () => {
	const symbols = ["-", "--", ".", "..", "_", "__", "·"];
	for (const left of symbols) {
		for (const right of symbols) {
			const schema: TrellisSchema = {
				slots: [
					{ role: "tag", namespace: "trel" },
					{ role: "name" },
					{ role: "tag", namespace: "proj" },
				],
				separators: [left, right],
			};
			const expected = left !== right && (left.startsWith(right) || right.startsWith(left));
			assert.equal(
				separatorConflicts(schema).length > 0,
				expected,
				`${JSON.stringify(left)} vs ${JSON.stringify(right)}`
			);
		}
	}
});

test("schema migration changes boundary formatting and internal joiner in one dry-run", () => {
	const next: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "trel", segmentSeparator: "." },
			{ role: "name" },
		],
		separators: ["-"],
		separatorSpacing: ["both"],
	};
	assert.equal(
		schemaMigratedName("S88B07-사과", ["#trel/S/88/B/07"], cfg, next),
		"S.88.B.07 - 사과"
	);
	assert.equal(
		schemaMigratedName("S88B07", ["#trel/S/88/B/07"], cfg, next),
		"S.88.B.07"
	);
	assert.equal(schemaMigratedName("사과", ["#other/A/1"], cfg, next), null);
});

test("removing the final tag slot can clean its filename projection", () => {
	const nameOnly: TrellisSchema = {
		slots: [{ role: "name" }],
		separators: [],
	};
	assert.equal(
		schemaMigratedName("S88B07-사과", ["#trel/S/88/B/07"], cfg, nameOnly),
		"사과"
	);
	assert.equal(schemaMigratedName("사과", ["#other/A"], cfg, nameOnly), null);
});

test("namespace/separator/position are read from the slot array (custom schema)", () => {
	// hand-built schema: different namespace ("tree") + separator ("_")
	const schema: TrellisSchema = {
		slots: [{ role: "tag", namespace: "tree" }, { role: "name" }],
		separators: ["_"],
	};
	assert.equal(tagToTagkey("#tree/S88/B07", schema), "S88B07");
	assert.equal(tagToTagkey("#trel/S88/B07", schema), null); // wrong namespace
	assert.equal(extractTagkey("S88B07_my_note", schema), "S88B07");
	assert.equal(syncedBasename("S88B07_old", "S88B99", schema), "S88B99_old");
});

test("suffix slot order ([name, tag]) syncs the trailing tagkey", () => {
	const schema: TrellisSchema = {
		slots: [{ role: "name" }, { role: "tag", namespace: "trel" }],
		separators: ["-"],
	};
	assert.equal(extractTagkey("tree-idea-S88B07", schema), "S88B07");
	assert.equal(syncedBasename("tree-idea-S88B07", "S88B99", schema), "tree-idea-S88B99");
});

test("tagkey/title survive date + session codes after the tagkey", () => {
	// Session-log style filename: tagkey, then a date and a session code, then the
	// title — all joined by the same separator. The tagkey is the FIRST segment;
	// everything after the first boundary is the title and must be preserved.
	const us: TrellisSchema = schemaFromLegacy("tree", "_", "prefix");
	const name = "S88L11_0629_S88-11_세션대시보드";

	assert.equal(extractTagkey(name, us), "S88L11");
	assert.equal(extractTitle(name, "S88L11", us), "0629_S88-11_세션대시보드");
	// Already in sync — no rename churn for a correct filename.
	assert.equal(syncedBasename(name, "S88L11", us), null);
	// Changing the tagkey keeps the date/session code verbatim.
	const title = extractTitle(name, "S88L11", us);
	assert.equal(assembleBasename("S89L11", title, us), "S89L11_0629_S88-11_세션대시보드");
	// The tagkey still decomposes into its hierarchical tag.
	assert.equal(tagkeyToTagPath("S88L11", us), "tree/S/88/L/11");
});

// --- No-separator title protection (0.2.0 data safety) ---------------------

test("looksLikeTagkey accepts multi-run tagkeys, rejects plain words/numbers", () => {
	assert.equal(looksLikeTagkey("S88"), true); // letter + digits
	assert.equal(looksLikeTagkey("S88B07"), true);
	assert.equal(looksLikeTagkey("A1B2"), true);
	assert.equal(looksLikeTagkey("S"), false); // single run
	assert.equal(looksLikeTagkey("ZZ"), false); // single letter run
	assert.equal(looksLikeTagkey("trellisupgradecheck"), false); // plain word
	assert.equal(looksLikeTagkey("12345"), false); // plain number
	assert.equal(looksLikeTagkey("my-note"), false); // not round-trip-safe (has '-')
	assert.equal(looksLikeTagkey("무제노트"), false); // no ASCII class runs
});

test("extractTitle: no-separator free title is preserved (not overwritten)", () => {
	// The file "trellisupgradecheck" has no separator and does NOT look like a
	// tagkey, so its whole name is the title — the tagkey is prepended, not swapped.
	assert.equal(extractTitle("trellisupgradecheck", "ZZ99", cfg), "trellisupgradecheck");
	assert.equal(syncedBasename("trellisupgradecheck", "ZZ99", cfg), "ZZ99-trellisupgradecheck");
	// A Korean free title likewise survives.
	assert.equal(syncedBasename("무제노트", "S88B07", cfg), "S88B07-무제노트");
});

test("extractTitle: a bare tagkey-only index note is still replaced", () => {
	// "S88" looks like a tagkey (letter+digits), so it's a stale index-note prefix
	// to replace, not a title to keep.
	assert.equal(extractTitle("S88", "S99", cfg), "");
	assert.equal(syncedBasename("S88", "S99", cfg), "S99");
});

test("extractTitle: suffix mode preserves a no-separator free title", () => {
	assert.equal(extractTitle("freetitle", "S88B07", cfgSuffix), "freetitle");
	assert.equal(syncedBasename("freetitle", "S88B07", cfgSuffix), "freetitle-S88B07");
	// tagkey-like bare name is replaced in suffix mode too
	assert.equal(syncedBasename("A1B2", "S88B07", cfgSuffix), "S88B07");
});

// --- Multi-key data model (0.2.0 advanced mode) ----------------------------

const twoTag: TrellisSchema = {
	slots: [
		{ role: "tag", namespace: "trel" },
		{ role: "name" },
		{ role: "tag", namespace: "proj" },
	],
	separators: ["-", "-"],
};

test("isMultiKey is true only for non-default slot shapes", () => {
	assert.equal(isMultiKey(cfg), false); // [tag, name]
	assert.equal(isMultiKey(cfgSuffix), false); // [name, tag]
	assert.equal(isMultiKey(twoTag), true); // two tag slots
	assert.equal(
		isMultiKey({ slots: [{ role: "tag", namespace: "trel" }], separators: [] }),
		true // single slot, no name
	);
});

test("tagToTagkeyNs / pickTagkeyNs resolve per-namespace", () => {
	assert.equal(tagToTagkeyNs("#trel/S88/B07", "trel"), "S88B07");
	assert.equal(tagToTagkeyNs("#proj/P02/C03", "trel"), null);
	assert.equal(pickTagkeyNs(["#x/y", "#proj/P02/C03"], "proj"), "P02C03");
	assert.equal(pickTagkeyNs(["#x/y"], "proj"), null);
});

test("slotTagkeys aligns each tag slot to its own namespace", () => {
	const tags = ["#trel/S88/B07", "#proj/P02/C03", "#status/wip"];
	assert.deepEqual(slotTagkeys(tags, twoTag), ["S88B07", null, "P02C03"]);
	// missing proj tag → that slot is null (omitted from the filename)
	assert.deepEqual(slotTagkeys(["#trel/S88/B07"], twoTag), ["S88B07", null, null]);
});

test("assembleBasenameMulti joins present slots, dropping omitted ones + their sep", () => {
	assert.equal(assembleBasenameMulti(["S88B07", "idea", "P02C03"], twoTag), "S88B07-idea-P02C03");
	// omitted trailing tag slot → its separator drops with it
	assert.equal(assembleBasenameMulti(["S88B07", "idea", null], twoTag), "S88B07-idea");
	// omitted middle name slot
	assert.equal(assembleBasenameMulti(["S88B07", "", "P02C03"], twoTag), "S88B07-P02C03");
	// only first slot present
	assert.equal(assembleBasenameMulti(["S88B07", null, null], twoTag), "S88B07");
});

test("no-name sparse schema keeps global order and only joins present tag-keys", () => {
	const sparse: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "a" },
			{ role: "tag", namespace: "b" },
			{ role: "tag", namespace: "c" },
		],
		separators: ["-", "-"],
	};
	assert.equal(assembleBasenameMulti(["A01", null, null], sparse), "A01");
	assert.equal(assembleBasenameMulti([null, "B02", null], sparse), "B02");
	assert.equal(assembleBasenameMulti([null, null, "C03"], sparse), "C03");
	assert.equal(assembleBasenameMulti(["A01", "B02", null], sparse), "A01-B02");
	assert.equal(assembleBasenameMulti(["A01", null, "C03"], sparse), "A01-C03");
	assert.equal(assembleBasenameMulti([null, "B02", "C03"], sparse), "B02-C03");
	assert.equal(
		assembleBasenameMulti(["A01", "B02", "C03"], sparse),
		"A01-B02-C03"
	);
	assert.equal(
		syncedBasenameMulti(
			"A01-B02-C03",
			["#a/A/01", "#c/C/03"],
			sparse
		),
		"A01-C03"
	);
	assert.equal(syncedBasenameMulti("A01", ["#ordinary/x"], sparse), null);
});

test("extractNameMulti anchors the name between known tag slots", () => {
	assert.equal(extractNameMulti("S88B07-idea-P02C03", ["S88B07", null, "P02C03"], twoTag), "idea");
	// multi-word title between the two tag slots is preserved whole
	assert.equal(
		extractNameMulti("S88B07-multi-word-P02C03", ["S88B07", null, "P02C03"], twoTag),
		"multi-word"
	);
	// trailing tag slot omitted → name runs to the end
	assert.equal(extractNameMulti("S88B07-idea", ["S88B07", null, null], twoTag), "idea");
});

test("syncedBasameMulti syncs both tag slots, preserving the free name", () => {
	// rename proj tag P02C03 → P09Z01, keep the name
	assert.equal(
		syncedBasenameMulti("S88B07-idea-P02C03", ["#trel/S88/B07", "#proj/P09/Z01"], twoTag),
		"S88B07-idea-P09Z01"
	);
	// already in sync → null
	assert.equal(
		syncedBasenameMulti("S88B07-idea-P02C03", ["#trel/S88/B07", "#proj/P02/C03"], twoTag),
		null
	);
	// no tag in any slot's namespace → never touch the file
	assert.equal(syncedBasenameMulti("whatever", ["#status/wip"], twoTag), null);
	// only the first tag present, the proj slot's tag is gone: we cannot tell if
	// the filename's "P02C03" is a stale tagkey to drop or part of the free name,
	// so the conservative rule ("a slot with no managed tag is left alone") wins —
	// the segment is absorbed into the name and nothing is deleted (null = no change).
	assert.equal(
		syncedBasenameMulti("S88B07-idea-P02C03", ["#trel/S88/B07"], twoTag),
		null
	);
});

test("syncedBasenameMulti with a leading name slot (name, tag, tag)", () => {
	const schema: TrellisSchema = {
		slots: [
			{ role: "name" },
			{ role: "tag", namespace: "trel" },
			{ role: "tag", namespace: "proj" },
		],
		separators: ["-", "-"],
	};
	assert.equal(
		syncedBasenameMulti("idea-S88B07-P02C03", ["#trel/S88/B99", "#proj/P02/C03"], schema),
		"idea-S88B99-P02C03"
	);
});

test("cross-definition tag moves preserve the old free name and reproject slots", () => {
	const cross: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "area" },
			{ role: "name" },
			{ role: "tag", namespace: "state" },
		],
		separators: ["-", "-"],
	};
	assert.equal(
		tagChangeProjectedName(
			"A01-apple",
			["#area/A/01"],
			["#state/done"],
			cross
		),
		"apple-done"
	);
	assert.equal(
		tagChangeProjectedName(
			"A01-apple-done",
			["#area/A/01", "#state/done"],
			["#area/A/01"],
			cross
		),
		"A01-apple"
	);
});

test("extractNameMulti never truncates a title that ends with the tagkey text sans separator", () => {
	// Regression (Codex B/C review): a bare endsWith would strip "P09Z01" from the
	// title "ideaP09Z01" because it coincidentally matches the trailing tagkey. With
	// the boundary rule, no clean "-P09Z01" boundary exists, so the title is kept
	// whole and the proj tagkey is appended (data preserved, never silently lost).
	assert.equal(
		extractNameMulti("S88B07-ideaP09Z01", ["S88B07", null, "P09Z01"], twoTag),
		"ideaP09Z01"
	);
	assert.equal(
		syncedBasenameMulti("S88B07-ideaP09Z01", ["#trel/S88/B07", "#proj/P09/Z01"], twoTag),
		"S88B07-ideaP09Z01-P09Z01"
	);
	// Symmetric on the left: a title that starts with a leading tagkey's text.
	const leadTag: TrellisSchema = {
		slots: [{ role: "name" }, { role: "tag", namespace: "trel" }],
		separators: ["-"],
	};
	// name slot first, tag slot last: "S88B07idea" title ending — no boundary, kept.
	assert.equal(
		syncedBasenameMulti("titleS88B07", ["#trel/S88/B07"], leadTag),
		"titleS88B07-S88B07"
	);
});

test("extractNameMulti keeps a tagkey-only filename name-empty (no BT01→BT01-BT01)", () => {
	// Regression (boss's dummy-vault test): bootstrapping a bare index note "BT01"
	// (tag tree/BT/01, no separator, no title) under a MULTI-KEY schema must not
	// fold the tagkey into the name slot and duplicate it.
	const oneTag: TrellisSchema = {
		slots: [{ role: "tag", namespace: "tree" }, { role: "name" }, { role: "tag", namespace: "trel" }],
		separators: ["-", "-"],
	};
	assert.equal(extractNameMulti("BT01", ["BT01", null, null], oneTag), "");
	assert.equal(syncedBasenameMulti("BT01", ["#tree/BT/01"], oneTag), null); // already in sync
	// Suffix-style: tagkey-only with a trailing tag slot.
	const nameThenTag: TrellisSchema = {
		slots: [{ role: "name" }, { role: "tag", namespace: "tree" }],
		separators: ["-"],
	};
	assert.equal(extractNameMulti("S88B07", [null, "S88B07"], nameThenTag), "");
	assert.equal(syncedBasenameMulti("S88B07", ["#tree/S88/B07"], nameThenTag), null);
});

test("extractNameMulti still consumes tagkeys that DO sit on a separator boundary", () => {
	// The boundary rule must not over-preserve: a proper "-P02C03" boundary is
	// still consumed so a normal rename works.
	assert.equal(
		extractNameMulti("S88B07-idea-P02C03", ["S88B07", null, "P02C03"], twoTag),
		"idea"
	);
});

test("isValidNamespace allows plain names, rejects path/traversal/control/YAML chars", () => {
	assert.equal(isValidNamespace("trel"), true);
	assert.equal(isValidNamespace("tree"), true);
	assert.equal(isValidNamespace("proj-2"), true);
	assert.equal(isValidNamespace("key_2"), true);
	assert.equal(isValidNamespace("청사진-2"), true);
	assert.equal(isValidNamespace(""), false);
	assert.equal(isValidNamespace("a/b"), false); // path separator
	assert.equal(isValidNamespace("../x"), false); // traversal
	assert.equal(isValidNamespace("a b"), false); // whitespace
	assert.equal(isValidNamespace("x]\ntags: [evil"), false); // YAML/newline injection
	assert.equal(isValidNamespace("a,b"), false); // tag list separator
	assert.equal(isValidNamespace("#trel"), false); // hash
	assert.equal(isValidNamespace("bp.name"), false); // punctuation is not namespace identity
	assert.equal(isValidNamespace("name!"), false);
	assert.equal(isValidNamespace("１２３"), false); // numeric-only in any script
});

test("isValidSeparator accepts parse-safe symbols, rejects filename-hostile ones", () => {
	assert.equal(isValidSeparator("-"), true); // the default
	assert.equal(isValidSeparator("--"), true);
	assert.equal(isValidSeparator("_"), true);
	assert.equal(isValidSeparator("."), true);
	assert.equal(isValidSeparator("·"), true);
	assert.equal(isValidSeparator("~"), true);
	assert.equal(isValidSeparator("=="), true);
	assert.equal(isValidSeparator("🙂"), true); // portable Unicode symbol
	assert.equal(isValidSeparator(""), false); // empty
	assert.equal(isValidSeparator("a"), false); // letter blurs the boundary
	assert.equal(isValidSeparator("1"), false); // digit
	assert.equal(isValidSeparator("가"), false); // letters in any script
	assert.equal(isValidSeparator("é"), false);
	assert.equal(isValidSeparator("１"), false); // full-width digit
	assert.equal(isValidSeparator("١"), false); // Arabic-Indic digit
	assert.equal(isValidSeparator("-----"), false); // custom symbols stay compact
	assert.equal(isValidSeparator("/"), false); // path separator
	assert.equal(isValidSeparator("\\"), false); // backslash
	assert.equal(isValidSeparator(":"), false); // filesystem-illegal
	assert.equal(isValidSeparator("*"), false);
	assert.equal(isValidSeparator("?"), false);
	assert.equal(isValidSeparator("<"), false);
	assert.equal(isValidSeparator("#"), false); // Obsidian tag/wikilink-hostile
	assert.equal(isValidSeparator("^"), false);
	assert.equal(isValidSeparator("["), false);
	assert.equal(isValidSeparator("]"), false);
	assert.equal(isValidSeparator("- "), false); // whitespace
	assert.equal(isValidSeparator(" "), false);
});

test("extractNameMulti: empty name slot with prefix-colliding separators stays intact", () => {
	// Regression (self-review, confirmed by execution): with separators ["-", "--"]
	// an EMPTY name slot drops its own separator, so "AA01--BB02" carries the
	// LONGER gap separator. Shortest-first boundary matching half-consumed it
	// ("-" inside "--") and folded the leftover into the name, renaming the file
	// to "AA01--BB02--BB02" — permanently. Longest-first matching keeps it stable.
	const collide: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "trel" },
			{ role: "name" },
			{ role: "tag", namespace: "key2" },
		],
		separators: ["-", "--"],
	};
	const tags = ["#trel/AA/01", "#key2/BB/02"];
	assert.equal(extractNameMulti("AA01--BB02", ["AA01", null, "BB02"], collide), "");
	assert.equal(syncedBasenameMulti("AA01--BB02", tags, collide), null); // stable
	// The normal titled form keeps round-tripping too.
	assert.equal(syncedBasenameMulti("AA01-demo--BB02", tags, collide), null);
});

test("extractNameMulti: a title's own trailing separator characters are preserved", () => {
	// Regression (self-review, confirmed by execution): the right-side consume
	// removed separator+tagkey and then stripped ONE MORE trailing separator,
	// eating a title's genuine trailing "-" ("demo-" → "demo"). The exact
	// boundary consume needs no extra strip.
	const collide: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "trel" },
			{ role: "name" },
			{ role: "tag", namespace: "key2" },
		],
		separators: ["-", "--"],
	};
	const tags = ["#trel/AA/01", "#key2/BB/02"];
	assert.equal(
		extractNameMulti("AA01-demo---BB02", ["AA01", null, "BB02"], collide),
		"demo-"
	);
	assert.equal(syncedBasenameMulti("AA01-demo---BB02", tags, collide), null); // stable
});

// --- 0.3.0 experimental: root namespace (B25) --------------------------------

import {
	nsPath,
	primaryNsPath,
	rootMigratedTag,
	scaffoldingPaths,
	suggestSegment,
	suggestTagValue,
	schemeSegments,
} from "../src/tagkey.ts";

const ROOTED: TrellisSchema = {
	rootNamespace: "trellis",
	slots: [{ role: "tag", namespace: "tree" }, { role: "name" }],
	separators: ["-"],
};

test("nsPath: root prepends; empty root is transparent", () => {
	assert.equal(nsPath(ROOTED, "tree"), "trellis/tree");
	assert.equal(nsPath(DEFAULT_SCHEMA, "trel"), "trel");
	assert.equal(primaryNsPath(ROOTED), "trellis/tree");
});

test("tagToTagkey: rooted tags parse, rootless tags are foreign (and vice versa)", () => {
	assert.equal(tagToTagkey("#trellis/tree/S/88", ROOTED), "S88");
	assert.equal(tagToTagkey("#tree/S/88", ROOTED), null);
	assert.equal(tagToTagkey("#trellis/tree/S/88", DEFAULT_SCHEMA), null);
});

test("tagkeyToTagPath emits the rooted path", () => {
	assert.equal(tagkeyToTagPath("S88B07", ROOTED), "trellis/tree/S/88/B/07");
});

test("duplicateLocationGroups matches rooted namespaces (group key = full path)", () => {
	const groups = duplicateLocationGroups(
		["#trellis/tree/S/88", "#trellis/tree/S/99", "#daily/x"],
		ROOTED
	);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].namespace, "trellis/tree");
	assert.equal(groups[0].tags.length, 2);
});

test("rootMigratedTag: add, change, remove; foreign tags untouched", () => {
	const ns = ["tree"];
	assert.equal(rootMigratedTag("tree/S/88", "", "trellis", ns), "trellis/tree/S/88");
	assert.equal(rootMigratedTag("trellis/tree/S/88", "trellis", "", ns), "tree/S/88");
	assert.equal(rootMigratedTag("trellis/tree/S/88", "trellis", "own", ns), "own/tree/S/88");
	assert.equal(rootMigratedTag("daily/notes", "", "trellis", ns), null);
	assert.equal(rootMigratedTag("trellis", "trellis", "", ns), null); // bare root
	assert.equal(rootMigratedTag("treehouse/x", "", "trellis", ns), null); // boundary
	assert.equal(rootMigratedTag("tree/S/88", "", "", ns), null); // no-op
});

test("scaffoldingPaths: root + namespace layers; rootless = namespaces only", () => {
	assert.deepEqual([...scaffoldingPaths(ROOTED)].sort(), ["trellis", "trellis/tree"]);
	assert.deepEqual([...scaffoldingPaths(DEFAULT_SCHEMA)], ["trel"]);
});

// --- 0.3.0 experimental: ID scheme presets (B26) -----------------------------

const NOW = new Date(2026, 6, 7, 15, 4, 9); // 2026-07-07 15:04:09 local

test("suggestSegment spark: siblings increment within their class", () => {
	assert.equal(suggestSegment("spark", "B", ["01", "02", "07"], NOW), "08");
	assert.equal(suggestSegment("spark", "88", ["A", "B", "L"], NOW), "M");
	assert.equal(suggestSegment("spark", "88", ["Z"], NOW), "AA");
	assert.equal(suggestSegment("spark", "88", ["09"], NOW), "10");
});

test("suggestSegment spark: no siblings alternates with the parent's class", () => {
	assert.equal(suggestSegment("spark", "B", [], NOW), "01"); // letters → digits
	assert.equal(suggestSegment("spark", "88", [], NOW), "A"); // digits → letters
	assert.equal(suggestSegment("spark", "", [], NOW), "01");
});

test("suggestSegment seq: max+1, width preserved", () => {
	assert.equal(suggestSegment("seq", "x", ["1", "2"], NOW), "3");
	assert.equal(suggestSegment("seq", "x", ["001", "007"], NOW), "008");
	assert.equal(suggestSegment("seq", "x", [], NOW), "1");
});

test("suggestSegment zettel/date stamp from now", () => {
	assert.equal(suggestSegment("zettel", "", [], NOW), "20260707150409");
	assert.equal(suggestSegment("date", "", [], NOW), "20260707");
});

test("schemeSegments: single-ID schemes accept one run; mismatch falls back (null)", () => {
	assert.deepEqual(schemeSegments("zettel", "20260707150409"), ["20260707150409"]);
	assert.equal(schemeSegments("zettel", "S88B07"), null);
	assert.deepEqual(schemeSegments("date", "20260707"), ["20260707"]);
	assert.equal(schemeSegments("date", "2026077"), null);
	assert.deepEqual(schemeSegments("seq", "042"), ["042"]);
	assert.deepEqual(schemeSegments("spark", "S88B07"), ["S", "88", "B", "07"]);
	assert.equal(schemeSegments("spark", "justwords"), null);
});

test("tagkeyToTagPath with a zettel scheme accepts a single digit run", () => {
	const zettel: TrellisSchema = {
		slots: [{ role: "tag", namespace: "z", scheme: "zettel" }, { role: "name" }],
		separators: ["-"],
	};
	assert.equal(tagkeyToTagPath("20260707150409", zettel), "z/20260707150409");
	// Generic guard alone would reject it (single run):
	assert.equal(tagkeyToTagPath("20260707150409", DEFAULT_SCHEMA), null);
	// Non-matching tagkeys still fall back to the generic split:
	assert.equal(tagkeyToTagPath("S88B07", zettel), "z/S/88/B/07");
});

test("suggestSegment spark: base-26 length-first max — Z vs AA never re-suggests AA", () => {
	assert.equal(suggestSegment("spark", "88", ["Y", "Z", "AA"], NOW), "AB");
	assert.equal(suggestSegment("spark", "88", ["Z", "AA", "AB"], NOW), "AC");
});

test("detailed alternating suggestion follows depth, case and configured width", () => {
	const rule = {
		kind: "alternating" as const,
		firstLevel: "alphabet" as const,
		letterCase: "lower" as const,
		numberWidth: 3 as const,
	};
	assert.equal(suggestTagValue(rule, 0, [], new Date(0)), "a");
	assert.equal(suggestTagValue(rule, 0, ["a", "z", "aa"], new Date(0)), "ab");
	assert.equal(suggestTagValue(rule, 1, [], new Date(0)), "001");
	assert.equal(suggestTagValue(rule, 1, ["001", "009"], new Date(0)), "010");
	assert.equal(suggestTagValue(rule, 1, ["001", "x"], new Date(0)), null);
});

test("detailed sequence, date and UTC timestamp suggestions honor their formats", () => {
	const now = new Date("2026-08-14T05:06:07.089Z");
	assert.equal(
		suggestTagValue(
			{ kind: "sequence", start: 0, numberWidth: 2 },
			0,
			[],
			now
		),
		"00"
	);
	assert.equal(
		suggestTagValue({ kind: "date", dateFormat: "YYMMDD" }, 0, [], now),
		"260814"
	);
	assert.equal(
		suggestTagValue(
			{ kind: "timestamp", timestampPrecision: "millisecond", timezone: "utc" },
			0,
			[],
			now
		),
		"20260814050607089"
	);
});

test("isValidTagSegment: unicode-friendly deny-list for one hierarchy level", () => {
	assert.equal(isValidTagSegment("S88"), true);
	assert.equal(isValidTagSegment("07"), true);
	assert.equal(isValidTagSegment("my-note_v2"), true);
	assert.equal(isValidTagSegment("한글"), true); // unicode segments stay legal
	assert.equal(isValidTagSegment(""), false); // empty
	assert.equal(isValidTagSegment("a b"), false); // whitespace
	assert.equal(isValidTagSegment("a/b"), false); // '/' is the hierarchy sep
	assert.equal(isValidTagSegment("a,b"), false); // YAML flow metacharacters
	assert.equal(isValidTagSegment("a]b"), false);
	assert.equal(isValidTagSegment("a{b"), false);
	assert.equal(isValidTagSegment('a"b'), false);
	assert.equal(isValidTagSegment("a'b"), false);
	assert.equal(isValidTagSegment("a#b"), false); // tag-hostile
	assert.equal(isValidTagSegment("a:b"), false); // filename-illegal
	assert.equal(isValidTagSegment("a*b"), false);
	assert.equal(isValidTagSegment("a\\b"), false);
});

test("isValidTagPath: slash-joined valid segments, no empty levels", () => {
	assert.equal(isValidTagPath("trel/S/88/B/07"), true);
	assert.equal(isValidTagPath("trellis/trel/S88"), true); // root-aware paths too
	assert.equal(isValidTagPath("trel"), true); // single level
	assert.equal(isValidTagPath(""), false);
	assert.equal(isValidTagPath("/trel"), false); // leading slash = empty segment
	assert.equal(isValidTagPath("trel/"), false); // trailing slash
	assert.equal(isValidTagPath("trel//S88"), false); // empty middle level
	assert.equal(isValidTagPath("trel/S 88"), false); // bad char in a segment
	assert.equal(isValidTagPath("trel/S88]"), false);
});

test("portableBasenameIssue enforces the cross-platform filename subset", () => {
	for (const name of ["S88-사과", "S.88-note", "S88-CON", "COM10", "한글 문서"]) {
		assert.equal(portableBasenameIssue(name), null, name);
	}
	assert.equal(portableBasenameIssue(""), "empty");
	assert.equal(portableBasenameIssue("."), "empty");
	assert.equal(portableBasenameIssue("bad:name"), "reserved-character");
	assert.equal(portableBasenameIssue("bad\u0001name"), "reserved-character");
	assert.equal(portableBasenameIssue("note."), "trailing-dot-or-space");
	assert.equal(portableBasenameIssue("note "), "trailing-dot-or-space");
	for (const name of ["CON", "con.txt", "PRN", "AUX", "NUL", "COM1", "LPT9", "CONOUT$"]) {
		assert.equal(portableBasenameIssue(name), "reserved-name", name);
	}
});

test("0.5 schema migration assigns stable definition and slot ids without changing output", () => {
	const legacy: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "bp", scheme: "spark", segmentSeparator: "." },
			{ role: "name" },
		],
		separators: ["·"],
		separatorSpacing: ["after"],
	};
	const migrated = normalizeSchemaModel(legacy);
	assert.deepEqual(migrated.tagDefinitions, [
		{
			id: "tag-bp",
			name: "bp",
			namespace: "bp",
			sidebarVisible: true,
			valueRule: {
				kind: "alternating",
				firstLevel: "alphabet",
				letterCase: "upper",
				numberWidth: 2,
			},
		},
	]);
	assert.equal(migrated.slots[0].tagDefinitionId, "tag-bp");
	assert.equal(migrated.slots[0].namespace, undefined);
	assert.equal(migrated.slots[0].scheme, undefined);
	assert.deepEqual(migrated.slots.map((slot) => slot.id), ["slot-1", "slot-2"]);
	assert.equal(
		assembleBasenameMulti(["N.W.03", "나무위키"], migrated),
		"N.W.03· 나무위키"
	);
	assert.deepEqual(normalizeSchemaModel(migrated), migrated);
});

test("slot wrappers render, parse and disappear with empty sparse slots", () => {
	const wrapped: TrellisSchema = {
		tagDefinitions: [
			{ id: "tag-kind", name: "종류", namespace: "kind", sidebarVisible: true },
		],
		slots: [
			{
				id: "slot-kind",
				role: "tag",
				tagDefinitionId: "tag-kind",
				wrapper: { kind: "round" },
			},
			{ id: "slot-name", role: "name" },
		],
		separators: ["-"],
	};
	assert.equal(renderSlotValue("UI", wrapped.slots[0]), "(UI)");
	assert.equal(unwrapSlotValue("(UI)", wrapped.slots[0]), "UI");
	assert.equal(assembleBasenameMulti(["UI", "버튼"], wrapped), "(UI)-버튼");
	assert.equal(assembleBasenameMulti([null, "버튼"], wrapped), "버튼");
	assert.equal(
		extractNameMulti("(UI)-버튼", ["UI", null], wrapped),
		"버튼"
	);
});

test("bootstrap extraction removes the primary slot wrapper", () => {
	const prefix: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "ui", wrapper: { kind: "round" } },
			{ role: "name" },
		],
		separators: ["-"],
	};
	assert.equal(extractTagkey("(UI)-버튼", prefix), "UI");
	assert.equal(tagkeyToTagPath(extractTagkey("(UI01)-버튼", prefix), prefix), "ui/UI/01");

	const suffix: TrellisSchema = {
		slots: [
			{ role: "name" },
			{
				role: "tag",
				namespace: "ui",
				wrapper: { kind: "custom", left: "〈", right: "〉" },
			},
		],
		separators: ["-"],
	};
	assert.equal(extractTagkey("버튼-〈UI01〉", suffix), "UI01");
	assert.equal(
		extractTagkey("(UI01)", { ...prefix, slots: [prefix.slots[0]], separators: [] }),
		"UI01"
	);
});

test("custom hierarchy and wrapper characters use the portable safe subset", () => {
	for (const value of ["", ".", "·", "~", "++"]) {
		assert.equal(isValidHierarchySeparator(value), true, value);
	}
	for (const value of ["/", " ", "A", "1", "["]) {
		assert.equal(isValidHierarchySeparator(value), false, value);
	}
	assert.equal(isValidSlotWrapper({ kind: "round" }), true);
	assert.equal(isValidSlotWrapper({ kind: "custom", left: "〈", right: "〉" }), true);
	assert.equal(isValidSlotWrapper({ kind: "custom", left: "[", right: "]" }), false);
	assert.equal(isValidSlotWrapper({ kind: "custom", left: "", right: ")" }), false);
});
