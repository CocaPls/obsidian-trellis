import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_SETTINGS,
	cloneSchema,
	normalizeLoadedSettings,
} from "../src/settings-model.ts";
import {
	primaryNamespace,
	primarySeparatorSymbol,
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
