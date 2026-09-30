import { test } from "node:test";
import assert from "node:assert/strict";
import { projectFilename, projectKnownTitle } from "../src/filename-projection.ts";
import { defaultSchema, syncedBasenameMulti } from "../src/tagkey.ts";

test("every untagged filename is represented as a title-only projection", () => {
	const projection = projectFilename("Research notes", [], defaultSchema());
	assert.equal(projection.title, "Research notes");
	assert.equal(projection.physicalBasename, "Research notes");
	assert.equal(projection.virtualBasename, "Research notes");
	assert.equal(projection.status, "title-only");
});

test("untagged notes are outside physical filename portability checks", () => {
	const projection = projectFilename("Legacy note ", [], defaultSchema());
	assert.equal(projection.physicalBasename, "Legacy note ");
	assert.equal(projection.status, "title-only");
	assert.deepEqual(projection.issues, []);
});

test("physical managed metadata still enforces portable filenames", () => {
	const projection = projectFilename(
		"Research notes ",
		["#trel/P/17"],
		defaultSchema()
	);
	assert.equal(projection.physicalBasename, null);
	assert.equal(projection.status, "blocked");
	assert.equal(projection.issues[0]?.code, "unsafe-filename");
});

test("display-only metadata does not make the physical filename managed", () => {
	const schema = defaultSchema();
	schema.slots[0].syncMode = "display-only";
	const projection = projectFilename("Legacy note ", ["#trel/P/17"], schema);
	assert.equal(projection.physicalBasename, "Legacy note ");
	assert.equal(projection.status, "consistent");
	assert.deepEqual(projection.issues, []);
});

test("metadata-to-filename computes physical and virtual names without writing", () => {
	const projection = projectFilename(
		"Research notes",
		["#trel/P/17"],
		defaultSchema()
	);
	assert.equal(projection.title, "Research notes");
	assert.equal(projection.physicalBasename, "P17-Research notes");
	assert.equal(projection.virtualBasename, "P17-Research notes");
	assert.equal(projection.status, "drift");
});

test("display-only metadata changes the virtual name but not the physical target", () => {
	const schema = defaultSchema();
	schema.slots[0].syncMode = "display-only";
	const projection = projectFilename("Research notes", ["#trel/P/17"], schema);
	assert.equal(projection.physicalBasename, "Research notes");
	assert.equal(projection.virtualBasename, "P17-Research notes");
	assert.equal(projection.status, "consistent");
});

test("a known title survives removal of the final metadata value", () => {
	assert.equal(
		projectKnownTitle("Research notes", [], defaultSchema(), "physical"),
		"Research notes"
	);
});

test("filename-to-metadata stays blocked until reverse parsing is explicit", () => {
	const schema = defaultSchema();
	schema.slots[0].syncMode = "filename-to-metadata";
	const projection = projectFilename("P17-Research notes", ["#trel/P/17"], schema);
	assert.equal(projection.status, "blocked");
	assert.equal(projection.physicalBasename, null);
	assert.deepEqual(projection.issues.map((issue) => issue.code), [
		"reverse-mode-not-ready",
	]);
});

test("sidebar-only tag duplicates do not block filename projection", () => {
	const schema = defaultSchema();
	schema.tagDefinitions?.push({
		id: "tag-reference",
		name: "References",
		namespace: "reference",
		sidebarVisible: true,
	});
	const projection = projectFilename(
		"Research notes",
		["#reference/book", "#reference/paper"],
		schema
	);
	assert.equal(projection.status, "title-only");
	assert.deepEqual(projection.issues, []);
});

test("display-only duplicates block virtual interpretation but not the physical title", () => {
	const schema = defaultSchema();
	schema.slots[0].syncMode = "display-only";
	const projection = projectFilename(
		"Research notes",
		["#trel/P/17", "#trel/P/18"],
		schema
	);
	assert.equal(projection.status, "blocked");
	assert.equal(projection.physicalBasename, "Research notes");
	assert.equal(projection.issues[0]?.code, "duplicate-metadata");
	assert.equal(
		projection.issues[0]?.code === "duplicate-metadata" &&
			projection.issues[0].affectsPhysical,
		false
	);
});

test("physical projection preserves 0.5 rename targets", () => {
	const schema = defaultSchema();
	for (const [basename, tags] of [
		["Research notes", ["#trel/P/17"]],
		["P17-Research notes", ["#trel/P/17"]],
		["P16-Research notes", ["#trel/P/17"]],
		["P17", ["#trel/P/17"]],
	] as const) {
		const legacyTarget = syncedBasenameMulti(basename, [...tags], schema) ?? basename;
		assert.equal(
			projectFilename(basename, [...tags], schema).physicalBasename,
			legacyTarget
		);
	}
});
