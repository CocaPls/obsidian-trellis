import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const verifyAssets = args.includes("--assets");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
const tag = args.find(arg => !arg.startsWith("--")) ?? manifest.version;

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

if (verifyAssets) {
	for (const name of ["README.md", "LICENSE", "styles.css"]) {
		if (!readFileSync(name, "utf8").trim()) throw new Error(`Missing or empty ${name}`);
	}
	const { build } = await import("esbuild");
	const { buildOptions } = await import("./build-options.mjs");
	const rebuilt = await build({ ...buildOptions(true), write: false, metafile: true });
	const actual = readFileSync("main.js");
	if (!actual.equals(Buffer.from(rebuilt.outputFiles[0].contents))) {
		throw new Error("main.js differs from the current production source. Run npm run build.");
	}
	const externals = Object.values(rebuilt.metafile.outputs).flatMap(output => output.imports)
		.filter(item => item.external && item.path !== "obsidian");
	if (externals.length) throw new Error(`Unexpected runtime dependencies: ${externals.map(item => item.path).join(", ")}`);
	console.log("Release assets match the production source; no Node/Electron or unbundled runtime dependencies.");
}
