import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_SETTINGS,
	cloneSchema,
	normalizeLoadedSettings,
} from "../src/settings-model.ts";
import {
	DEFAULT_SLOT_SYNC_MODE,
	primaryNamespace,
	primarySeparatorSymbol,
	slotKind,
	slotSyncMode,
	tagPosition,
} from "../src/tagkey.ts";
import type { TrellisOperationReport } from "../src/operation-state.ts";

test("fresh settings own their mutable schema and header state", () => {
	const first = normalizeLoadedSettings({}, 100).settings;
	const second = normalizeLoadedSettings({}, 100).settings;
	first.schema.slots[0].id = "changed";
	first.headerButtons.newNote = false;
	assert.notEqual(second.schema.slots[0].id, "changed");
	assert.equal(second.headerButtons.newNote, true);
});

test("legacy scalar settings migrate without changing filename placement", () => {
	const result = normalizeLoadedSettings({
		settingsVersion: 0,
		namespace: "legacy",
		separator: "_",
		keyPosition: "suffix",
	});
	assert.equal(primaryNamespace(result.settings.schema), "legacy");
	assert.equal(primarySeparatorSymbol(result.settings.schema), "_");
	assert.equal(tagPosition(result.settings.schema), "suffix");
	assert.equal("namespace" in result.settings, false);
	assert.equal(result.shouldSave, true);
});

test("a persisted running write becomes an explicit interruption", () => {
	const running: TrellisOperationReport = {
		id: "op-1",
		kind: "bulk",
		label: "Rename notes",
		status: "running",
		startedAt: 10,
		total: 4,
		processed: 0,
		issues: [],
	};
	const result = normalizeLoadedSettings(
		{
			...DEFAULT_SETTINGS,
			schema: cloneSchema(DEFAULT_SETTINGS.schema),
			lastOperation: running,
		},
		50
	);
	assert.equal(result.settings.lastOperation?.status, "interrupted");
	assert.equal(result.settings.lastOperation?.finishedAt, 50);
	assert.equal(result.settings.operationAttention?.id, "op-1");
	assert.equal(result.interruptedOperation?.id, "op-1");
	assert.equal(result.shouldSave, true);
});

test("manual whitespace boundaries normalize to one filename space", () => {
	const schema = cloneSchema(DEFAULT_SETTINGS.schema);
	schema.separators = ["  "];
	schema.separatorSpacing = undefined;
	const result = normalizeLoadedSettings({
		...DEFAULT_SETTINGS,
		schema,
		treeTagDefinitionId: schema.tagDefinitions?.[0]?.id ?? "",
	});
	assert.deepEqual(result.settings.schema.separators, [""]);
	assert.deepEqual(result.settings.schema.separatorSpacing, ["after"]);
});

test("hierarchy separator spacing is preserved and invalid values are removed", () => {
	const validSchema = cloneSchema(DEFAULT_SETTINGS.schema);
	const validTagSlot = validSchema.slots.find((slot) => slot.role === "tag");
	assert.ok(validTagSlot);
	validTagSlot.segmentSeparator = "·";
	validTagSlot.segmentSeparatorSpacing = "both";
	const valid = normalizeLoadedSettings({
		...DEFAULT_SETTINGS,
		schema: validSchema,
	}).settings.schema.slots.find((slot) => slot.role === "tag");
	assert.equal(valid?.segmentSeparatorSpacing, "both");

	const invalidSchema = cloneSchema(validSchema);
	const invalidTagSlot = invalidSchema.slots.find((slot) => slot.role === "tag");
	assert.ok(invalidTagSlot);
	invalidTagSlot.segmentSeparatorSpacing = "around" as never;
	const invalid = normalizeLoadedSettings({
		...DEFAULT_SETTINGS,
		schema: invalidSchema,
	}).settings.schema.slots.find((slot) => slot.role === "tag");
	assert.equal(invalid?.segmentSeparatorSpacing, undefined);
});

test("current settings expose one title slot and explicit metadata direction", () => {
	const schema = normalizeLoadedSettings({}).settings.schema;
	const titleSlots = schema.slots.filter((slot) => slotKind(slot) === "title");
	const metadataSlots = schema.slots.filter((slot) => slotKind(slot) === "metadata");
	assert.equal(titleSlots.length, 1);
	assert.equal(slotSyncMode(titleSlots[0]), null);
	assert.equal(metadataSlots.length, 1);
	assert.equal(slotSyncMode(metadataSlots[0]), DEFAULT_SLOT_SYNC_MODE);
});

test("a persisted no-title schema remains tag-only", () => {
	const schema = cloneSchema(DEFAULT_SETTINGS.schema);
	schema.slots = schema.slots.filter((slot) => slot.role === "tag");
	schema.separators = [];
	schema.separatorSpacing = [];
	const result = normalizeLoadedSettings({
		...DEFAULT_SETTINGS,
		settingsVersion: 2,
		schema,
	});
	assert.deepEqual(
		result.settings.schema.slots.map((slot) => slotKind(slot)),
		["metadata"]
	);
	assert.deepEqual(result.settings.schema.separators, []);
	assert.equal(result.shouldSave, true);
});

test("the unreleased v3 synthetic title migration is removed", () => {
	const schema = cloneSchema(DEFAULT_SETTINGS.schema);
	schema.slots = [
		{ ...schema.slots[0], syncMode: "metadata-to-filename" },
		{ id: "slot-title-2", role: "name" },
	];
	schema.separators = [""];
	schema.separatorSpacing = ["none"];
	const result = normalizeLoadedSettings({
		...DEFAULT_SETTINGS,
		settingsVersion: 3,
		schema,
		lastSeparatorChange: {
			oldSchema: schema,
			newSchema: schema,
			renames: [],
		},
		lastNamespaceChange: {
			oldSchema: schema,
			newSchema: schema,
			changes: [],
		},
	});
	assert.deepEqual(
		result.settings.schema.slots.map((slot) => slotKind(slot)),
		["metadata"]
	);
	assert.deepEqual(result.settings.schema.separators, []);
	assert.equal(result.settings.lastSeparatorChange, undefined);
	assert.equal(result.settings.lastNamespaceChange, undefined);
	assert.equal(result.shouldSave, true);
});

test("legacy title slots cannot retain a metadata synchronization mode", () => {
	const schema = cloneSchema(DEFAULT_SETTINGS.schema);
	const title = schema.slots.find((slot) => slot.role === "name");
	assert.ok(title);
	title.syncMode = "display-only";
	const normalized = normalizeLoadedSettings({
		...DEFAULT_SETTINGS,
		schema,
	}).settings.schema;
	assert.equal(normalized.slots.find((slot) => slot.role === "name")?.syncMode, undefined);
});
