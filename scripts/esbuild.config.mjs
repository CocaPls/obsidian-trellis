import esbuild from "esbuild";
import process from "process";
import { buildOptions } from "./build-options.mjs";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context(buildOptions(prod));

if (prod) {
	await ctx.rebuild();
	process.exit(0);
} else {
	await ctx.watch();
}
