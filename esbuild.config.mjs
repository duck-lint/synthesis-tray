import esbuild from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

const production = process.argv[2] === "production";
const banner = `/* Obsidian Synthesis Tray ${JSON.parse(await readFile("./manifest.json", "utf8")).version} */`;

await mkdir("dist", { recursive: true });
await esbuild.build({
  banner: { js: banner },
  bundle: true,
  entryPoints: ["src/main.ts"],
  external: ["obsidian"],
  format: "cjs",
  legalComments: "none",
  minify: production,
  outfile: "dist/main.js",
  platform: "node",
  sourcemap: production ? false : "inline",
  treeShaking: true,
});
await cp("manifest.json", "dist/manifest.json");
await cp("styles.css", "dist/styles.css");
if (!production) {
  await writeFile("dist/.hotreload", String(Date.now()), "utf8");
}
await cp("node_modules/sql.js/dist/sql-wasm.wasm", "dist/sql-wasm.wasm");
