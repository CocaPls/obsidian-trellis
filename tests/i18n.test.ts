import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const root = process.cwd();
const i18n = readFileSync(join(root, "src/i18n.ts"), "utf8");

function dictionaryKeys(name: "EN" | "KO"): Set<string> {
	const start = i18n.indexOf(`const ${name}:`);
	const end = name === "EN" ? i18n.indexOf("const KO:", start) : i18n.indexOf("const STRINGS:", start);
	assert.notEqual(start, -1, `${name} dictionary start`);
	assert.notEqual(end, -1, `${name} dictionary end`);
	return new Set(
		[...i18n.slice(start, end).matchAll(/^\s*"([^"]+)"\s*:/gm)].map((match) => match[1])
	);
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
	});
}

test("English and Korean dictionaries have identical, machine-safe keys", () => {
	const en = dictionaryKeys("EN");
	const ko = dictionaryKeys("KO");
	assert.deepEqual([...en].sort(), [...ko].sort());
	assert.deepEqual([...en].filter((key) => /\s/.test(key)), []);
});

test("every static translation lookup exists", () => {
	const keys = dictionaryKeys("EN");
	const missing = new Set<string>();
	for (const path of sourceFiles(join(root, "src"))) {
		if (basename(path) === "i18n.ts") continue;
		const source = readFileSync(path, "utf8");
		for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) {
			if (!keys.has(match[1])) missing.add(match[1]);
		}
	}
	assert.deepEqual([...missing].sort(), []);
});
