import { readFileSync, writeFileSync } from "fs";

// Run by `npm version <patch|minor|major>` via the package.json "version" hook.
// Syncs manifest.json's version to the new package version and records the
// version → minAppVersion mapping in versions.json.

const targetVersion = process.env.npm_package_version;

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

console.log(`version-bump: manifest + versions set to ${targetVersion} (minApp ${minAppVersion})`);
