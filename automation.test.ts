import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrellisSchema } from "./tagkey.ts";
import {
	inspectNoteState,
	planNoteChange,
	validatePlanSnapshot,
	type TrellisNoteState,
} from "./automation.ts";

const schema: TrellisSchema = {
	slots: [
		{ role: "tag", namespace: "trel", segmentSeparator: "." },
		{ role: "name" },
	],
	separators: ["-"],
	separatorSpacing: ["after"],
};

const state: TrellisNoteState = {
	path: "notes/S.88- 사과.md",
	basename: "S.88- 사과",
	extension: "md",
	mtime: 123,
	allTags: ["#trel/S/88", "#food/fruit"],
	frontmatterTags: ["trel/S/88", "food/fruit"],
};

test("inspect exposes managed slots, free name and immutable state", () => {
	const inspected = inspectNoteState(state, schema);
	assert.equal(inspected.managed, true);
	assert.equal(inspected.nameKey, "사과");
	assert.deepEqual(inspected.slots.map((slot) => slot.value), ["S.88", "사과"]);
	assert.equal(inspected.expectedBasename, state.basename);
	assert.deepEqual(inspected.issues, []);
});

test("inspect reports filename drift, duplicates and managed inline tags", () => {
	const inspected = inspectNoteState(
		{
			...state,
			basename: "wrong",
			allTags: ["#trel/S/88", "#trel/S/99"],
			frontmatterTags: ["trel/S/88"],
		},
		schema
	);
	assert.deepEqual(
		inspected.issues.map((issue) => issue.code),
		["filename-drift", "duplicate-location-tags", "inline-managed-tag"]
	);
});

test("plan changes a tag slot and free name without writing", () => {
	const result = planNoteChange(state, schema, {
		path: state.path,
		tagChanges: [{ namespace: "trel", tagPath: "trel/S/99/B/01" }],
		nameChange: "배",
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.status, "ready");
	assert.equal(result.value.next.path, "notes/S.99.B.01- 배.md");
	assert.deepEqual(result.value.next.frontmatterTags, ["food/fruit", "trel/S/99/B/01"]);
	assert.deepEqual(state.frontmatterTags, ["trel/S/88", "food/fruit"]);
});

test("plan rejects unknown namespaces, ambiguous segments and unsafe names", () => {
	const unknown = planNoteChange(state, schema, {
		path: state.path,
		tagChanges: [{ namespace: "other", tagPath: "other/A/1" }],
	});
	assert.equal(unknown.ok ? "ok" : unknown.error.code, "unknown-namespace");

	const ambiguous = planNoteChange(state, schema, {
		path: state.path,
		tagChanges: [{ namespace: "trel", tagPath: "trel/A.B/1" }],
	});
	assert.equal(ambiguous.ok ? "ok" : ambiguous.error.code, "invalid-tag-path");

	const badName = planNoteChange(state, schema, {
		path: state.path,
		nameChange: "bad/name",
	});
	assert.equal(badName.ok ? "ok" : badName.error.code, "invalid-name");
});

test("plan blocks a frontmatter change that conflicts with an inline managed tag", () => {
	const result = planNoteChange(
		{
			...state,
			allTags: [...state.allTags, "#trel/S/77"],
		},
		schema,
		{
			path: state.path,
			tagChanges: [{ namespace: "trel", tagPath: "trel/S/99" }],
		}
	);
	assert.equal(result.ok ? "ok" : result.error.code, "inline-tag-conflict");
});

test("plan snapshot becomes stale after a note or schema change", () => {
	const planned = planNoteChange(state, schema, { path: state.path, nameChange: "배" });
	assert.equal(planned.ok, true);
	if (!planned.ok) return;
	assert.equal(validatePlanSnapshot(state, schema, planned.value).ok, true);
	const changedState = { ...state, mtime: state.mtime + 1 };
	const staleNote = validatePlanSnapshot(changedState, schema, planned.value);
	assert.equal(staleNote.ok ? "ok" : staleNote.error.code, "stale-plan");
	const changedSchema = { ...schema, separators: ["_"] };
	const staleSchema = validatePlanSnapshot(state, changedSchema, planned.value);
	assert.equal(staleSchema.ok ? "ok" : staleSchema.error.code, "stale-plan");
});
