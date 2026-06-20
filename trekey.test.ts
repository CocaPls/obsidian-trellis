import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrellisConfig } from "./trekey.ts";
import {
	tagToTrekey,
	pickTrekey,
	syncedBasename,
	extractTrekey,
	extractTitle,
	renameTagPath,
	normalizeTagList,
	expandTagPrefixes,
	filterTagSuggestions,
} from "./trekey.ts";

const cfg: TrellisConfig = { namespace: "trel", separator: "-", keyPosition: "prefix" };
const cfgSuffix: TrellisConfig = { namespace: "trel", separator: "-", keyPosition: "suffix" };

test("tagToTrekey strips namespace and slashes", () => {
	assert.equal(tagToTrekey("#trel/S88/B07", cfg), "S88B07");
	assert.equal(tagToTrekey("#trel/P/07/M/01", cfg), "P07M01");
});

test("tagToTrekey ignores foreign namespaces and empties", () => {
	assert.equal(tagToTrekey("#project/work", cfg), null);
	assert.equal(tagToTrekey("#trel", cfg), null); // no trailing path
	assert.equal(tagToTrekey("#trel/", cfg), null); // empty path
});

test("pickTrekey returns the first location tag, ignoring others", () => {
	assert.equal(pickTrekey(["#status/wip", "#trel/S88/B07"], cfg), "S88B07");
	assert.equal(pickTrekey(["#status/wip", "#area/sys"], cfg), null);
	assert.equal(pickTrekey([], cfg), null);
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
