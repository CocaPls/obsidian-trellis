import { test } from "node:test";
import assert from "node:assert/strict";
import {
	addFrontmatterTag,
	hashedFrontmatterTags,
	removeFrontmatterTag,
	resolveDuplicateFrontmatterTags,
	restoreFrontmatterTags,
} from "../src/frontmatter-tags.ts";

test("frontmatter additions preserve an existing case-only tag", () => {
	assert.deepEqual(addFrontmatterTag(["BP/N/01"], "bp/n/01"), {
		tags: ["BP/N/01"],
		changed: false,
	});
	assert.deepEqual(addFrontmatterTag(["BP/N/01"], "status/open"), {
		tags: ["BP/N/01", "status/open"],
		changed: true,
	});
});

test("frontmatter removal follows Obsidian tag identity", () => {
	assert.deepEqual(removeFrontmatterTag(["BP/N/01", "status/open"], "bp/n/01"), {
		tags: ["status/open"],
		changed: true,
	});
});

test("frontmatter restoration does not recreate case-only duplicates", () => {
	assert.deepEqual(
		restoreFrontmatterTags(["BP/N/01"], ["bp/n/01", "status/open"]),
		{ tags: ["BP/N/01", "status/open"], changed: true }
	);
	assert.deepEqual(restoreFrontmatterTags(["BP/N/01"], ["bp/n/01"]), {
		tags: ["BP/N/01"],
		changed: false,
	});
});

test("duplicate resolution handles mixed-case namespaces and keep values", () => {
	assert.deepEqual(
		resolveDuplicateFrontmatterTags(
			["BP/N/01", "bp/N/02", "status/open"],
			{ bp: "#BP/n/02" }
		),
		{
			tags: ["bp/N/02", "status/open"],
			removed: ["BP/N/01"],
			changed: true,
		}
	);
});

test("hashed frontmatter tags preserve normalized display casing", () => {
	assert.deepEqual(hashedFrontmatterTags(["BP/N/01", "#status/open"]), [
		"#BP/N/01",
		"#status/open",
	]);
});
