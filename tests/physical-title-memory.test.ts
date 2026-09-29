import { test } from "node:test";
import assert from "node:assert/strict";
import { PhysicalTitleMemory } from "../src/physical-title-memory.ts";
import type { TrellisSchema } from "../src/tagkey.ts";

const physicalSchema: TrellisSchema = {
	tagDefinitions: [
		{ id: "projects", name: "Projects", namespace: "projects", sidebarVisible: true },
	],
	slots: [
		{
			id: "project-slot",
			role: "tag",
			tagDefinitionId: "projects",
			syncMode: "metadata-to-filename",
		},
		{ id: "title-slot", role: "name" },
	],
	separators: ["-"],
};

test("physical title memory retains the free title across final-tag removal", () => {
	const memory = new PhysicalTitleMemory();
	memory.remember(
		{
			path: "A01-Design.md",
			basename: "A01-Design",
			frontmatterTags: ["projects/A/01"],
		},
		physicalSchema
	);
	assert.equal(memory.get("A01-Design.md"), "Design");
	memory.remember(
		{
			path: "A01-Design.md",
			basename: "A02-Design",
			frontmatterTags: ["projects/A/02"],
		},
		physicalSchema
	);
	assert.equal(memory.get("A01-Design.md"), "Design");

	memory.remember(
		{
			path: "A01-Design.md",
			basename: "A01-Design",
			frontmatterTags: [],
		},
		physicalSchema
	);
	assert.equal(memory.get("A01-Design.md"), "Design");
	memory.delete("A01-Design.md");
	assert.equal(memory.get("A01-Design.md"), undefined);
});

test("refresh drops stale paths and ignores display-only slots", () => {
	const memory = new PhysicalTitleMemory();
	memory.set("stale.md", "stale");
	const displayOnly: TrellisSchema = {
		...physicalSchema,
		slots: physicalSchema.slots.map((slot) =>
			slot.role === "tag" ? { ...slot, syncMode: "display-only" } : { ...slot }
		),
	};
	memory.refresh(
		[
			{
				path: "A01-Design.md",
				basename: "A01-Design",
				frontmatterTags: ["projects/A/01"],
			},
		],
		displayOnly
	);
	assert.equal(memory.get("stale.md"), undefined);
	assert.equal(memory.get("A01-Design.md"), undefined);
});

test("schema synchronization recomputes remembered titles only after a change", () => {
	const memory = new PhysicalTitleMemory();
	const files = [
		{
			path: "A01-Design.md",
			basename: "A01-Design",
			frontmatterTags: ["projects/A/01"],
		},
	];
	memory.syncSchema(files, physicalSchema);
	assert.equal(memory.get("A01-Design.md"), "Design");
	memory.set("A01-Design.md", "kept");
	memory.syncSchema(files, physicalSchema);
	assert.equal(memory.get("A01-Design.md"), "kept");
	memory.syncSchema(files, { ...physicalSchema, separators: ["_"] });
	assert.equal(memory.get("A01-Design.md"), "A01-Design");
});

test("reload remembers an empty title after an unspaced wrapped tag tail", () => {
	const schema: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "namespace" },
			{
				role: "tag",
				namespace: "title",
				filenameTextTransform: "underscore-to-space",
			},
			{
				role: "tag",
				namespace: "disambiguator",
				wrapper: { kind: "round" },
			},
			{ role: "name" },
		],
		separators: ["-", "", ""],
	};
	const memory = new PhysicalTitleMemory();
	memory.refresh(
		[
			{
				path: "QA-Link target(test).md",
				basename: "QA-Link target(test)",
				frontmatterTags: [
					"namespace/QA",
					"title/Link_target",
					"disambiguator/test",
				],
			},
		],
		schema
	);
	assert.equal(memory.get("QA-Link target(test).md"), "");
});
