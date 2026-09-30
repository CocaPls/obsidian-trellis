import { builtinModules } from "node:module";

export function buildOptions(prod) {
	return {
		entryPoints: ["src/main.ts"],
		bundle: true,
		external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
		format: "cjs",
		target: "es2018",
		logLevel: "info",
		sourcemap: prod ? false : "inline",
		minify: prod,
		treeShaking: true,
		outfile: "main.js",
	};
}
