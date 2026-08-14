import { readFileSync } from "node:fs";

const tag = process.argv[2];
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

if (!tag || !/^\d+\.\d+\.\d+$/.test(tag)) {
	throw new Error(`Release tag must be plain x.y.z semver, received: ${tag ?? "(missing)"}`);
}

if (manifest.version !== tag || pkg.version !== tag) {
	throw new Error(
		`Version mismatch: tag=${tag}, manifest=${manifest.version}, package=${pkg.version}`,
	);
}

if (versions[tag] !== manifest.minAppVersion) {
	throw new Error(
		`versions.json must map ${tag} to minAppVersion ${manifest.minAppVersion}`,
	);
}

console.log(`Release metadata verified for ${tag} (Obsidian ${manifest.minAppVersion}+).`);
