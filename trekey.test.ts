import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrellisSchema } from "./trekey.ts";
import {
	DEFAULT_SCHEMA,
	schemaFromLegacy,
	tagToTrekey,
	pickTrekey,
	tagNamespaces,
	duplicateLocationGroups,
	assembleBasename,
	syncedBasename,
	separatorMigratedName,
	extractTrekey,
	extractTitle,
	renameTagPath,
	normalizeTagList,
	expandTagPrefixes,
	filterTagSuggestions,
	buildTagTree,
	buildNoteTree,
	sortNoteTree,
	nextChildSegment,
	trekeyToTagPath,
} from "./trekey.ts";

const cfg: TrellisSchema = schemaFromLegacy("trel", "-", "prefix");
const cfgSuffix: TrellisSchema = schemaFromLegacy("trel", "-", "suffix");

test("tagToTrekey strips namespace and slashes", () => {
	assert.equal(tagToTrekey("#trel/S88/B07", cfg), "S88B07");
	assert.equal(tagToTrekey("#trel/P/07/M/01", cfg), "P07M01");
});

test("tagToTrekey ignores foreign namespaces and empties", () => {
	assert.equal(tagToTrekey("#project/work", cfg), null);
	assert.equal(tagToTrekey("#trel", cfg), null); // no trailing path
	assert.equal(tagToTrekey("#trel/", cfg), null); // empty path
});

test("trekeyToTagPath decomposes a trekey into a hierarchical tag", () => {
	assert.equal(trekeyToTagPath("S88", cfg), "trel/S/88"); // tier · package
	assert.equal(trekeyToTagPath("S88A", cfg), "trel/S/88/A"); // + module
	assert.equal(trekeyToTagPath("S88A01", cfg), "trel/S/88/A/01"); // + atom
	assert.equal(trekeyToTagPath("S88B07", cfg), "trel/S/88/B/07");
});

test("trekeyToTagPath keeps placeholder (0/00) slots for round-trip safety", () => {
	assert.equal(trekeyToTagPath("S04001", cfg), "trel/S/04/0/01"); // module "0" kept
	assert.equal(trekeyToTagPath("S00L", cfg), "trel/S/00/L"); // package "00" kept
	assert.equal(trekeyToTagPath("P00001", cfg), "trel/P/00/0/01"); // both kept
	assert.equal(trekeyToTagPath("S00M", cfg), "trel/S/00/M"); // master-log style
});

test("trekeyToTagPath round-trips with tagToTrekey (incl. placeholders)", () => {
	for (const tk of ["S88", "S88A", "S88B07", "S04001", "S00M", "P00001"]) {
		const tag = trekeyToTagPath(tk, cfg);
		assert.equal(tagToTrekey("#" + tag, cfg), tk, `round-trip failed for ${tk}`);
	}
});

test("trekeyToTagPath rejects trekeys that don't fit the scheme", () => {
	assert.equal(trekeyToTagPath("S", cfg), null); // tier only, no package digits
	assert.equal(trekeyToTagPath("hello", cfg), null);
	assert.equal(trekeyToTagPath("88B07", cfg), null); // no leading tier letter
});

test("pickTrekey returns the first location tag, ignoring others", () => {
	assert.equal(pickTrekey(["#status/wip", "#trel/S88/B07"], cfg), "S88B07");
	assert.equal(pickTrekey(["#status/wip", "#area/sys"], cfg), null);
	assert.equal(pickTrekey([], cfg), null);
});

test("pickTrekey stays deterministic with multiple location tags (first wins)", () => {
	// One note = one location; if a note carries two location tags the plugin
	// warns (see syncFile) but still resolves to the first for a stable filename.
	assert.equal(pickTrekey(["#trel/S88/B07", "#trel/P02/C03"], cfg), "S88B07");
	assert.equal(pickTrekey(["#trel/P02/C03", "#trel/S88/B07"], cfg), "P02C03");
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

test("extractTrekey (prefix) takes everything before the first separator", () => {
	assert.equal(extractTrekey("S88B07-tree-idea", cfg), "S88B07");
	assert.equal(extractTrekey("S88B07", cfg), "S88B07"); // trekey-only
	assert.equal(extractTrekey("S88B07-a-b-c", cfg), "S88B07"); // first only
});

test("extractTrekey (suffix) takes everything after the last separator", () => {
	assert.equal(extractTrekey("tree-idea-S88B07", cfgSuffix), "S88B07");
	assert.equal(extractTrekey("S88B07", cfgSuffix), "S88B07"); // trekey-only
	assert.equal(extractTrekey("a-b-S88B07", cfgSuffix), "S88B07"); // last only
});

test("syncedBasename (prefix) replaces prefix, preserves the rest", () => {
	assert.equal(syncedBasename("S88B07-tree-idea", "S88B99", cfg), "S88B99-tree-idea");
	assert.equal(syncedBasename("S88B07", "S88B99", cfg), "S88B99"); // trekey-only
});

test("syncedBasename (suffix) replaces suffix, preserves the head", () => {
	assert.equal(syncedBasename("tree-idea-S88B07", "S88B99", cfgSuffix), "tree-idea-S88B99");
	assert.equal(syncedBasename("S88B07", "S88B99", cfgSuffix), "S88B99"); // trekey-only
});

test("extractTitle (prefix) recovers the title even if separator was deleted", () => {
	assert.equal(extractTitle("S99B07-tree-idea", "S99B07", cfg), "tree-idea");
	assert.equal(extractTitle("S99B07tree-idea", "S99B07", cfg), "tree-idea"); // sep deleted
	assert.equal(extractTitle("S99B07", "S99B07", cfg), ""); // trekey-only
	assert.equal(extractTitle("XXXX-tree-idea", "S99B07", cfg), "tree-idea"); // trekey altered
});

test("extractTitle (suffix) recovers the title from the head", () => {
	assert.equal(extractTitle("tree-idea-S99B07", "S99B07", cfgSuffix), "tree-idea");
	assert.equal(extractTitle("tree-ideaS99B07", "S99B07", cfgSuffix), "tree-idea"); // sep deleted
	assert.equal(extractTitle("S99B07", "S99B07", cfgSuffix), ""); // trekey-only
});

test("syncedBasename restores trekey AND separator, keeps only the title free", () => {
	// separator deleted → title preserved, separator restored
	assert.equal(syncedBasename("S99B07tree-idea", "S99B07", cfg), "S99B07-tree-idea");
	// trekey damaged with no separator → title gone, trekey-only restore
	assert.equal(syncedBasename("ZZZZ", "S99B07", cfg), "S99B07");
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
	// session-log style: trekey + date + session code after the title
	assert.equal(
		syncedBasename("S88L04-0611-S88-04-dashboard", "S88L99", cfg),
		"S88L99-0611-S88-04-dashboard"
	);
});

test("assembleBasename joins trekey + title by slot order and separator", () => {
	assert.equal(assembleBasename("S88B07", "tree-idea", cfg), "S88B07-tree-idea");
	assert.equal(assembleBasename("S88B07", "", cfg), "S88B07"); // no title → trekey only
	assert.equal(assembleBasename("S88B07", "tree-idea", cfgSuffix), "tree-idea-S88B07");
});

// --- Separator migration (v0.0.7 batch separator change) -------------------

test("separatorMigratedName swaps the boundary separator, preserves the title", () => {
	const oldS = schemaFromLegacy("trel", "_", "prefix");
	const newS = schemaFromLegacy("trel", "-", "prefix");
	// boundary "_" → "-"; title has none, simple swap
	assert.equal(separatorMigratedName("S88B07_tree", "S88B07", oldS, newS), "S88B07-tree");
	// trekey-only file: nothing to change
	assert.equal(separatorMigratedName("S88B07", "S88B07", oldS, newS), null);
});

test("separatorMigratedName preserves the NEW separator already inside the title", () => {
	const oldS = schemaFromLegacy("trel", "_", "prefix");
	const newS = schemaFromLegacy("trel", "-", "prefix");
	// title "tree-idea" keeps its hyphens; only the trekey boundary "_" becomes "-"
	assert.equal(
		separatorMigratedName("S88B07_tree-idea", "S88B07", oldS, newS),
		"S88B07-tree-idea"
	);
	// title "a_b" (old sep inside title) is preserved verbatim — only the FIRST
	// boundary is the trekey delimiter; the rest belongs to the title.
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
	assert.deepEqual(normalizeTagList("trel/S88, x"), ["trel/S88", "x"]);
	assert.deepEqual(normalizeTagList("trel/S88"), ["trel/S88"]);
	assert.deepEqual(normalizeTagList(undefined), []);
	assert.deepEqual(normalizeTagList([1, "ok", null]), ["ok"]);
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

test("nextChildSegment suggests max+1 padded, or 01 when no numbers", () => {
	assert.equal(nextChildSegment(["01", "02", "04"]), "05");
	assert.equal(nextChildSegment(["09"]), "10");
	assert.equal(nextChildSegment([]), "01");
	assert.equal(nextChildSegment(["A", "B"]), "01"); // non-numeric → 01
	assert.equal(nextChildSegment(["01", "A"]), "02"); // ignores non-numeric
});

// --- Multi-key data model (B09 "path B": filename = positional slot array) ---

test("DEFAULT_SCHEMA reproduces the single-key prefix behaviour", () => {
	assert.equal(tagToTrekey("#trel/S88/B07", DEFAULT_SCHEMA), "S88B07");
	assert.equal(extractTrekey("S88B07-tree-idea", DEFAULT_SCHEMA), "S88B07");
	assert.equal(syncedBasename("S88B07-old", "S88B99", DEFAULT_SCHEMA), "S88B99-old");
});

test("schemaFromLegacy maps keyPosition onto slot ORDER", () => {
	assert.deepEqual(schemaFromLegacy("trel", "-", "prefix").slots.map((s) => s.role), ["tag", "name"]);
	assert.deepEqual(schemaFromLegacy("trel", "-", "suffix").slots.map((s) => s.role), ["name", "tag"]);
	assert.deepEqual(schemaFromLegacy("trel", "-", "prefix").separators, ["-"]);
});

test("namespace/separator/position are read from the slot array (custom schema)", () => {
	// hand-built schema: different namespace ("tree") + separator ("_")
	const schema: TrellisSchema = {
		slots: [{ role: "tag", namespace: "tree" }, { role: "name" }],
		separators: ["_"],
	};
	assert.equal(tagToTrekey("#tree/S88/B07", schema), "S88B07");
	assert.equal(tagToTrekey("#trel/S88/B07", schema), null); // wrong namespace
	assert.equal(extractTrekey("S88B07_my_note", schema), "S88B07");
	assert.equal(syncedBasename("S88B07_old", "S88B99", schema), "S88B99_old");
});

test("suffix slot order ([name, tag]) syncs the trailing trekey", () => {
	const schema: TrellisSchema = {
		slots: [{ role: "name" }, { role: "tag", namespace: "trel" }],
		separators: ["-"],
	};
	assert.equal(extractTrekey("tree-idea-S88B07", schema), "S88B07");
	assert.equal(syncedBasename("tree-idea-S88B07", "S88B99", schema), "tree-idea-S88B99");
});

test("trekey/title survive date + session codes after the trekey", () => {
	// Session-log style filename: trekey, then a date and a session code, then the
	// title — all joined by the same separator. The trekey is the FIRST segment;
	// everything after the first boundary is the title and must be preserved.
	const us: TrellisSchema = schemaFromLegacy("tree", "_", "prefix");
	const name = "S88L11_0629_S88-11_세션대시보드";

	assert.equal(extractTrekey(name, us), "S88L11");
	assert.equal(extractTitle(name, "S88L11", us), "0629_S88-11_세션대시보드");
	// Already in sync — no rename churn for a correct filename.
	assert.equal(syncedBasename(name, "S88L11", us), null);
	// Changing the trekey keeps the date/session code verbatim.
	const title = extractTitle(name, "S88L11", us);
	assert.equal(assembleBasename("S89L11", title, us), "S89L11_0629_S88-11_세션대시보드");
	// The trekey still decomposes into its hierarchical tag.
	assert.equal(trekeyToTagPath("S88L11", us), "tree/S/88/L/11");
});
