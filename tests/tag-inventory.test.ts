import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrellisSchema } from "../src/tagkey.ts";
import { TagInventory } from "../src/tag-inventory.ts";

const schema: TrellisSchema = {
	slots: [
		{ role: "tag", namespace: "bp" },
		{ role: "name" },
		{ role: "tag", namespace: "title" },
	],
	separators: ["-", "-"],
};

test("inventory separates general tags and reports each tag-key independently", () => {
	const inventory = new TagInventory(schema);
	inventory.upsertFile({
		path: "one.md",
		allTags: ["#bp/system", "#title/policy", "#status/wip"],
		frontmatterTags: ["bp/system", "title/policy", "status/wip"],
	});
	inventory.upsertFile({
		path: "two.md",
		allTags: ["#title/help", "#status/wip"],
		frontmatterTags: ["title/help", "status/wip"],
	});
	const snapshot = inventory.snapshot();
	assert.equal(snapshot.totalNotes, 2);
	assert.equal(snapshot.managedNotes, 2);
	assert.equal(snapshot.managedOccurrences, 3);
	assert.equal(snapshot.uniqueManagedPaths, 3);
	assert.equal(snapshot.generalOccurrences, 2);
	assert.equal(snapshot.uniqueGeneralTags, 1);
	assert.deepEqual(
		snapshot.tagKeys.map((key) => [key.namespace, key.notes, key.occurrences]),
		[
			["bp", 1, 1],
			["title", 2, 2],
		]
	);
});

test("inventory surfaces duplicates, inline-only values and namespace nodes", () => {
	const inventory = new TagInventory(schema);
	inventory.upsertFile({
		path: "issue.md",
		allTags: ["#bp/A", "#bp/B", "#title", "#title/inline"],
		frontmatterTags: ["bp/A", "bp/B", "title"],
	});
	const [bp, title] = inventory.snapshot().tagKeys;
	assert.equal(bp.duplicateNotes, 1);
	assert.equal(title.inlineOnlyNotes, 1);
	assert.equal(title.namespaceNodeNotes, 1);
});

test("inventory does not split case-only variants of one Obsidian tag", () => {
	const inventory = new TagInventory(schema);
	inventory.upsertFile({
		path: "case.md",
		allTags: ["#BP/A", "#bp/a", "#STATUS/WIP", "#status/wip"],
		frontmatterTags: ["BP/A", "bp/a", "STATUS/WIP", "status/wip"],
	});
	const snapshot = inventory.snapshot();
	assert.equal(snapshot.managedOccurrences, 1);
	assert.equal(snapshot.uniqueManagedPaths, 1);
	assert.equal(snapshot.tagKeys[0].duplicateNotes, 0);
	assert.equal(snapshot.generalOccurrences, 1);
	assert.equal(snapshot.uniqueGeneralTags, 1);
});

test("inventory updates and removes only the changed note snapshot", () => {
	const inventory = new TagInventory(schema);
	assert.equal(
		inventory.upsertFile({ path: "one.md", allTags: ["#bp/A"], frontmatterTags: ["bp/A"] }),
		true
	);
	assert.equal(
		inventory.upsertFile({ path: "one.md", allTags: ["bp/A"], frontmatterTags: ["#bp/A"] }),
		false
	);
	assert.equal(
		inventory.upsertFile({ path: "one.md", allTags: ["#title/B"], frontmatterTags: ["title/B"] }),
		true
	);
	assert.equal(inventory.snapshot().tagKeys[0].notes, 0);
	assert.equal(inventory.snapshot().tagKeys[1].notes, 1);
	assert.equal(inventory.removeFile("one.md"), true);
	assert.equal(inventory.snapshot().totalNotes, 0);
});

test("inventory keeps unknown children under an owner root separate from general tags", () => {
	const rooted: TrellisSchema = { ...schema, rootNamespace: "trellis" };
	const inventory = new TagInventory(rooted);
	inventory.upsertFile({
		path: "rooted.md",
		allTags: ["#trellis/bp/A", "#trellis/unknown/B", "#ordinary"],
		frontmatterTags: ["trellis/bp/A", "trellis/unknown/B", "ordinary"],
	});
	const snapshot = inventory.snapshot();
	assert.equal(snapshot.managedOccurrences, 1);
	assert.equal(snapshot.rootOwnedUnmatchedOccurrences, 1);
	assert.equal(snapshot.generalOccurrences, 1);
});

test("inventory reports sparse tag-key combinations and exact filename collisions", () => {
	const noName: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "a" },
			{ role: "tag", namespace: "b" },
		],
		separators: ["-"],
	};
	const inventory = new TagInventory(noName);
	inventory.upsertFile({
		path: "notes/source.md",
		allTags: ["#a/A/01", "#b/B/02"],
		frontmatterTags: ["a/A/01", "b/B/02"],
	});
	inventory.upsertFile({
		path: "notes/A01-B02.md",
		allTags: ["#a/A/01", "#b/B/02"],
		frontmatterTags: ["a/A/01", "b/B/02"],
	});
	inventory.upsertFile({
		path: "notes/b-only.md",
		allTags: ["#b/B/03"],
		frontmatterTags: ["b/B/03"],
	});
	inventory.upsertFile({
		path: "notes/ordinary.md",
		allTags: ["#status/wip"],
		frontmatterTags: ["status/wip"],
	});

	const snapshot = inventory.snapshot();
	assert.deepEqual(
		snapshot.combinations.map((combination) => [
			combination.namespaces,
			combination.notes,
		]),
		[
			[["a", "b"], 2],
			[["b"], 1],
		]
	);
	assert.deepEqual(snapshot.filenameCollisions, [
		{
			targetPath: "notes/A01-B02.md",
			notePaths: ["notes/A01-B02.md", "notes/source.md"],
		},
	]);
});

test("registered sidebar-only tags are inventoried but never projected into filenames", () => {
	const definitions: TrellisSchema = {
		tagDefinitions: [
			{ id: "area", name: "Area", namespace: "area", sidebarVisible: true },
			{ id: "state", name: "State", namespace: "state", sidebarVisible: true },
		],
		slots: [
			{ id: "slot-area", role: "tag", tagDefinitionId: "area" },
			{ id: "slot-name", role: "name" },
		],
		separators: ["-"],
	};
	const inventory = new TagInventory(definitions);
	inventory.upsertFile({
		path: "wrong-title.md",
		allTags: ["#area/A/01", "#state/wip"],
		frontmatterTags: ["area/A/01", "state/wip"],
	});
	const snapshot = inventory.snapshot();
	assert.deepEqual(
		snapshot.tagKeys.map((row) => [row.tagDefinitionId, row.slotIndex, row.notes]),
		[
			["area", 0, 1],
			["state", -1, 1],
		]
	);
	assert.deepEqual(snapshot.filenameDrift, [
		{ path: "wrong-title.md", targetPath: "A01-title.md" },
	]);
});

test("display-only filename slots are inventoried without physical filename drift", () => {
	const displaySchema: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "state", syncMode: "display-only" },
			{ role: "name" },
		],
		separators: ["-"],
	};
	const inventory = new TagInventory(displaySchema);
	inventory.upsertFile({
		path: "Research notes.md",
		allTags: ["#state/wip"],
		frontmatterTags: ["state/wip"],
	});
	const snapshot = inventory.snapshot();
	assert.equal(snapshot.tagKeys[0].notes, 1);
	assert.deepEqual(snapshot.filenameDrift, []);
	assert.deepEqual(snapshot.filenameCollisions, []);
});

test("inline managed tags are reported but do not create filename drift", () => {
	const inventory = new TagInventory(schema);
	inventory.upsertFile({
		path: "plain.md",
		allTags: ["#bp/A/01"],
		frontmatterTags: [],
	});
	const snapshot = inventory.snapshot();
	assert.equal(snapshot.tagKeys[0].inlineOnlyNotes, 1);
	assert.deepEqual(snapshot.filenameDrift, []);
});
