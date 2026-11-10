import { resolve } from "node:path";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/postcss";
import { build as bundle } from "esbuild";
const root = resolve(import.meta.dirname, "..");
// Compile static request schemas before building. The company request schema
// depends on actual reports and is compiled before reserving its model call.
const contractCheck = await bundle({
  stdin: {
    contents:
      'import { checkModelContracts } from "./lib/model-contracts.ts"; checkModelContracts();',
    resolveDir: root,
  },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  write: false,
});
await import(
  `data:text/javascript;base64,${Buffer.from(contractCheck.outputFiles[0].contents).toString("base64")}`
);
// Remove artifacts from older releases, including previously copied public assets.
rmSync(resolve(root, ".local-build/web"), { recursive: true, force: true });
await viteBuild({
  configFile: false,
  root: resolve(root, "local/web"),
  publicDir: false,
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss()] } },
  build: { outDir: resolve(root, ".local-build/web"), emptyOutDir: true },
});
await bundle({
  entryPoints: [resolve(root, "local/server.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: resolve(root, ".local-build/server.mjs"),
  logLevel: "info",
});
// No runtime dependency on Cloudflare/Workerd or a global Node/Python installation.
mkdirSync(resolve(root, ".local-build"), { recursive: true });
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(resolve(directory, e.name))
      : [resolve(directory, e.name)],
  );
}
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const mapping = (paths) =>
  Object.fromEntries(
    paths.map((path) => [
      relative(root, path).replaceAll("\\", "/"),
      hash(path),
    ]),
  );
const sourceFiles = mapping(
  ["app", "lib", "local", "migrations", "public"]
    .flatMap((d) => walk(resolve(root, d)))
    .concat(
      [
        "package.json",
        "package-lock.json",
        "data/seed.json",
        "data/review-recovery-cases.json",
        "scripts/build-local.mjs",
        "scripts/run-workflow.mjs",
        "scripts/windows/run.ps1",
        "scripts/windows/runtime-versions.json",
      ].map((p) => resolve(root, p)),
    ),
);
const files = mapping(
  walk(resolve(root, ".local-build/web")).concat(
    resolve(root, ".local-build/server.mjs"),
  ),
);
writeFileSync(
  resolve(root, ".local-build/build.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      nodeMajor: 24,
      runtime: "local-node",
      sourceFiles,
      files,
    },
    null,
    2,
  ),
);
