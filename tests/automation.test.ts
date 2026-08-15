import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrellisSchema } from "../src/tagkey.ts";
import {
	inspectNoteState,
	planNoteChange,
	validatePlanSnapshot,
	type TrellisNoteState,
} from "../src/automation.ts";

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

test("inspect reports filename drift and managed inline tags without using inline tags as state", () => {
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
		["filename-drift", "inline-managed-tag"]
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
	const windowsUnsafe = planNoteChange(state, schema, {
		path: state.path,
		nameChange: "배.",
	});
	assert.equal(windowsUnsafe.ok ? "ok" : windowsUnsafe.error.code, "invalid-name");
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

test("no-name schema requires explicit approval before removing the final tag-key", () => {
	const noName: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "tree" },
			{ role: "tag", namespace: "project" },
		],
		separators: ["-"],
	};
	const oneKey: TrellisNoteState = {
		path: "T01.md",
		basename: "T01",
		extension: "md",
		mtime: 1,
		allTags: ["#tree/T/01"],
		frontmatterTags: ["tree/T/01"],
	};
	const blocked = planNoteChange(oneKey, noName, {
		path: oneKey.path,
		tagChanges: [{ namespace: "tree", tagPath: null }],
	});
	assert.equal(blocked.ok ? "ok" : blocked.error.code, "would-unmanage-note");

	const allowed = planNoteChange(oneKey, noName, {
		path: oneKey.path,
		tagChanges: [{ namespace: "tree", tagPath: null }],
		allowUnmanaged: true,
	});
	assert.equal(allowed.ok, true);
	if (!allowed.ok) return;
	assert.equal(allowed.value.next.basename, "T01");
	assert.deepEqual(allowed.value.next.frontmatterTags, []);
	assert.deepEqual(allowed.value.changes, { frontmatter: true, rename: false });
});

test("no-name schema can remove one tag-key while another remains", () => {
	const noName: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "tree" },
			{ role: "tag", namespace: "project" },
		],
		separators: ["-"],
	};
	const twoKeys: TrellisNoteState = {
		path: "T01-P02.md",
		basename: "T01-P02",
		extension: "md",
		mtime: 1,
		allTags: ["#tree/T/01", "#project/P/02"],
		frontmatterTags: ["tree/T/01", "project/P/02"],
	};
	const result = planNoteChange(twoKeys, noName, {
		path: twoKeys.path,
		tagChanges: [{ namespace: "project", tagPath: null }],
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.next.path, "T01.md");
	assert.deepEqual(result.value.next.frontmatterTags, ["tree/T/01"]);
});

test("automation plans a three-tag filename projection without changing stored tags", () => {
	const wikiSchema: TrellisSchema = {
		slots: [
			{ role: "tag", namespace: "namespace" },
			{
				role: "tag",
				namespace: "title",
				segmentSeparator: "·",
				filenameTextTransform: "underscore-to-space",
			},
			{
				role: "tag",
				namespace: "disambiguator",
				filenameTextTransform: "underscore-to-space",
				wrapper: { kind: "round" },
			},
		],
		separators: ["-", ""],
		separatorSpacing: ["none", "none"],
	};
	const note: TrellisNoteState = {
		path: "Notes/old.md",
		basename: "old",
		extension: "md",
		mtime: 1,
		allTags: [
			"#namespace/PAW",
			"#title/Obsidian/플러그인_개발",
			"#disambiguator/개인용_도구",
		],
		frontmatterTags: [
			"namespace/PAW",
			"title/Obsidian/플러그인_개발",
			"disambiguator/개인용_도구",
		],
	};
	const result = planNoteChange(note, wikiSchema, { path: note.path });
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(
		result.value.next.path,
		"Notes/PAW-Obsidian·플러그인 개발(개인용 도구).md"
	);
	assert.deepEqual(result.value.next.frontmatterTags, note.frontmatterTags);
	assert.deepEqual(note.frontmatterTags, [
		"namespace/PAW",
		"title/Obsidian/플러그인_개발",
		"disambiguator/개인용_도구",
	]);
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

test("stable definition ids can change sidebar-only tags without renaming", () => {
	const normalized: TrellisSchema = {
		tagDefinitions: [
			{ id: "place", name: "Place", namespace: "place", sidebarVisible: true },
			{ id: "state", name: "State", namespace: "state", sidebarVisible: true },
		],
		slots: [
			{ id: "slot-place", role: "tag", tagDefinitionId: "place" },
			{ id: "slot-name", role: "name" },
		],
		separators: ["-"],
	};
	const note: TrellisNoteState = {
		path: "A01-note.md",
		basename: "A01-note",
		extension: "md",
		mtime: 1,
		allTags: ["#place/A/01", "#state/wip"],
		frontmatterTags: ["place/A/01", "state/wip"],
	};
	const inspected = inspectNoteState(note, normalized);
	assert.equal(inspected.slots[0].tagDefinitionId, "place");
	assert.equal(inspected.slots[0].namespace, "place");

	const planned = planNoteChange(note, normalized, {
		path: note.path,
		tagChanges: [{ tagDefinitionId: "state", tagPath: "state/done" }],
	});
	assert.equal(planned.ok, true);
	if (!planned.ok) return;
	assert.equal(planned.value.next.path, note.path);
	assert.deepEqual(planned.value.next.frontmatterTags, ["place/A/01", "state/done"]);
});

test("archived tags stay managed for removal but reject new values", () => {
	const withArchive: TrellisSchema = {
		tagDefinitions: [
			{ id: "place", name: "Place", namespace: "place", sidebarVisible: true },
			{
				id: "state",
				name: "State",
				namespace: "state",
				sidebarVisible: false,
				archived: true,
			},
		],
		slots: [
			{ id: "slot-place", role: "tag", tagDefinitionId: "place" },
			{ id: "slot-name", role: "name" },
		],
		separators: ["-"],
	};
	const note: TrellisNoteState = {
		path: "A01-note.md",
		basename: "A01-note",
		extension: "md",
		mtime: 1,
		allTags: ["#place/A/01", "#state/wip"],
		frontmatterTags: ["place/A/01", "state/wip"],
	};
	const add = planNoteChange(note, withArchive, {
		path: note.path,
		tagChanges: [{ tagDefinitionId: "state", tagPath: "state/done" }],
	});
	assert.equal(add.ok ? "ok" : add.error.code, "archived-namespace");

	const remove = planNoteChange(note, withArchive, {
		path: note.path,
		tagChanges: [{ tagDefinitionId: "state", tagPath: null }],
	});
	assert.equal(remove.ok, true);
	if (!remove.ok) return;
	assert.deepEqual(remove.value.next.frontmatterTags, ["place/A/01"]);
});

test("automation can explicitly change a filename-bearing tag without renaming", () => {
	const result = planNoteChange(state, schema, {
		path: state.path,
		tagChanges: [{ namespace: "trel", tagPath: "trel/S/99" }],
		syncFilename: false,
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.value.next.path, state.path);
	assert.deepEqual(result.value.changes, { frontmatter: true, rename: false });
});

test("automation treats namespace and stored tag casing as the same Obsidian tag", () => {
	const mixedCaseState: TrellisNoteState = {
		...state,
		allTags: ["#TREL/S/88/B/07"],
		frontmatterTags: ["TREL/S/88/B/07"],
	};
	const result = planNoteChange(mixedCaseState, schema, {
		path: mixedCaseState.path,
		tagChanges: [{ namespace: "TREL", tagPath: "trel/S/99" }],
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.value.next.frontmatterTags, ["trel/S/99"]);
	assert.equal(result.value.next.path, "notes/S.99- 사과.md");
});
