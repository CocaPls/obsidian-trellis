import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectionIndex } from "../src/projection-index.ts";
import { defaultSchema } from "../src/tagkey.ts";

test("projection index summarizes notes without vault I/O", () => {
	const index = new ProjectionIndex(defaultSchema());
	index.upsert({ path: "Plain.md", basename: "Plain", frontmatterTags: [] });
	index.upsert({
		path: "Drift.md",
		basename: "Research",
		frontmatterTags: ["#trel/P/17"],
	});
	assert.deepEqual(index.summary(), {
		totalNotes: 2,
		titleOnly: 1,
		consistent: 0,
		drift: 1,
		blocked: 0,
		virtualNames: 1,
		issueCounts: {
			"duplicate-metadata": 0,
			"reverse-mode-not-ready": 0,
			"unsafe-filename": 0,
		},
	});
});

test("unchanged upserts preserve the cached projection", () => {
	const index = new ProjectionIndex(defaultSchema());
	const file = { path: "Note.md", basename: "Note", frontmatterTags: [] };
	assert.equal(index.upsert(file), true);
	const first = index.get(file.path)?.projection;
	assert.equal(index.upsert(file), false);
	assert.equal(index.get(file.path)?.projection, first);
});

test("incremental tag removal preserves the parsed title", () => {
	const index = new ProjectionIndex(defaultSchema());
	index.upsert({
		path: "P17-Research.md",
		basename: "P17-Research",
		frontmatterTags: ["#trel/P/17"],
	});
	index.upsert({
		path: "P17-Research.md",
		basename: "P17-Research",
		frontmatterTags: [],
	});
	const projection = index.get("P17-Research.md")?.projection;
	assert.equal(projection?.title, "Research");
	assert.equal(projection?.physicalBasename, "Research");
});

test("rename and remove update only the addressed records", () => {
	const index = new ProjectionIndex(defaultSchema());
	index.upsert({ path: "A.md", basename: "A", frontmatterTags: [] });
	index.upsert({ path: "B.md", basename: "B", frontmatterTags: [] });
	const untouched = index.get("B.md")?.projection;
	index.rename("A.md", { path: "Folder/A.md", basename: "A", frontmatterTags: [] });
	assert.equal(index.get("A.md"), undefined);
	assert.ok(index.get("Folder/A.md"));
	assert.equal(index.get("B.md")?.projection, untouched);
	assert.equal(index.remove("Folder/A.md"), true);
	assert.equal(index.size, 1);
});

test("schema replacement recomputes cached projections", () => {
	const index = new ProjectionIndex(defaultSchema());
	index.upsert({
		path: "Research.md",
		basename: "Research",
		frontmatterTags: ["#trel/P/17"],
	});
	const schema = defaultSchema();
	schema.slots[0].syncMode = "display-only";
	index.replaceSchema(schema);
	const projection = index.get("Research.md")?.projection;
	assert.equal(projection?.physicalBasename, "Research");
	assert.equal(projection?.virtualBasename, "P17-Research");
});

test("rename retains indexed tags while metadata at the new path is unavailable", () => {
	const schema = defaultSchema();
	schema.tagDefinitions!.push({
		id: "tag-label", name: "label", namespace: "label", sidebarVisible: true,
	});
	schema.slots = [
		schema.slots[0],
		{ id: "label-slot", role: "tag", tagDefinitionId: "tag-label", syncMode: "display-only" },
	];
	schema.separators = ["-"];
	schema.separatorSpacing = ["none"];
	const index = new ProjectionIndex(schema);
	// The metadata change arrives at the old path before live sync renames it.
	index.upsert({
		path: "P17.md", basename: "P17", frontmatterTags: ["trel/P/18", "label/A"],
	});
	index.rename("P17.md", { path: "P18.md", basename: "P18", frontmatterTags: undefined });
	const record = index.get("P18.md");
	assert.equal(index.get("P17.md"), undefined);
	assert.deepEqual(record?.file.frontmatterTags, ["trel/P/18", "label/A"]);
	assert.equal(record?.projection.physicalBasename, "P18");
	assert.equal(record?.projection.virtualBasename, "P18-A");
	assert.equal(record?.projection.status, "consistent");
});

test("rename respects known empty metadata and handles an unindexed file", () => {
	const index = new ProjectionIndex(defaultSchema());
	index.upsert({
		path: "P17-Note.md", basename: "P17-Note", frontmatterTags: ["trel/P/17"],
	});
	index.rename("P17-Note.md", { path: "Note.md", basename: "Note", frontmatterTags: [] });
	assert.deepEqual(index.get("Note.md")?.file.frontmatterTags, []);
	assert.equal(index.get("Note.md")?.projection.hasManagedMetadata, false);
	index.rename("Unknown.md", {
		path: "Renamed.md", basename: "Renamed", frontmatterTags: undefined,
	});
	assert.deepEqual(index.get("Renamed.md")?.file.frontmatterTags, []);
	assert.equal(index.get("Renamed.md")?.projection.virtualBasename, "Renamed");
});
