import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync(join(process.cwd(), "src/main.ts"), "utf8");

function occurrences(pattern: RegExp): number {
	return [...main.matchAll(pattern)].length;
}

test("every filename mutation uses the shared guarded rename path", () => {
	assert.equal(occurrences(/app\.fileManager\.renameFile/g), 1);
	assert.match(main, /private async performGuardedRename/);
});

test("bulk operation lifecycle is owned by one wrapper", () => {
	// One occurrence is each method declaration; the other is the wrapper call.
	assert.equal(occurrences(/beginBulkOperation\(/g), 2);
	assert.equal(occurrences(/endBulkOperation\(/g), 2);
	assert.match(main, /private async runBulkOperation/);
});
