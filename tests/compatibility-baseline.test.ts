import { test } from "node:test";
import assert from "node:assert/strict";
import {
	defaultSchema,
	schemaMigratedName,
	syncedBasenameMulti,
	tagChangeProjectedName,
} from "../src/tagkey.ts";

test("0.5 compatibility: a managed tag prefixes the existing free title", () => {
	const schema = defaultSchema();
	assert.equal(
		syncedBasenameMulti("Research notes", ["#trel/P/17"], schema),
		"P17-Research notes"
	);
});

test("0.5 compatibility: a note without a filename-bearing tag stays untouched", () => {
	const schema = defaultSchema();
	assert.equal(syncedBasenameMulti("Research notes", [], schema), null);
});

test("0.5 compatibility: an explicit final-tag removal preserves the free title", () => {
	const schema = defaultSchema();
	assert.equal(
		tagChangeProjectedName(
			"P17-Research notes",
			["#trel/P/17"],
			[],
			schema
		),
		"Research notes"
	);
});

test("0.5 compatibility: sparse tag slots collapse their unused boundaries", () => {
	const schema = defaultSchema();
	const second = {
		id: "tag-area",
		name: "area",
		namespace: "area",
		sidebarVisible: true,
	};
	schema.tagDefinitions?.push(second);
	schema.slots.splice(1, 0, {
		id: "slot-area",
		role: "tag",
		tagDefinitionId: second.id,
	});
	schema.separators = ["-", "-"];

	assert.equal(
		syncedBasenameMulti("Research notes", ["#area/ENG/02"], schema),
		"ENG02-Research notes"
	);
});

test("display-only transition removes only the old physical tag slot", () => {
	const oldSchema = defaultSchema();
	const newSchema = defaultSchema();
	newSchema.slots[0].syncMode = "display-only";
	assert.equal(
		schemaMigratedName(
			"P17-Research notes",
			["#trel/P/17"],
			oldSchema,
			newSchema
		),
		"Research notes"
	);
});

test("physical transition adds a previously virtual tag slot", () => {
	const oldSchema = defaultSchema();
	oldSchema.slots[0].syncMode = "display-only";
	const newSchema = defaultSchema();
	assert.equal(
		schemaMigratedName(
			"Research notes",
			["#trel/P/17"],
			oldSchema,
			newSchema
		),
		"P17-Research notes"
	);
});

test("display-only tag changes never rename the physical file", () => {
	const schema = defaultSchema();
	schema.slots[0].syncMode = "display-only";
	assert.equal(
		tagChangeProjectedName(
			"Research notes",
			["#trel/P/17"],
			["#trel/P/18"],
			schema
		),
		null
	);
});
