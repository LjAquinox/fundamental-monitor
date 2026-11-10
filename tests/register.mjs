import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Node-only test adapter. Production is bundled with esbuild.
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.startsWith(".") &&
      context.parentURL &&
      !/\.[a-z]+$/i.test(specifier)
    ) {
      const candidate = new URL(specifier + ".ts", context.parentURL);
      if (existsSync(fileURLToPath(candidate)))
        return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith("/data/seed.json"))
      return {
        format: "module",
        source:
          "export default " + readFileSync(fileURLToPath(url), "utf8") + ";",
        shortCircuit: true,
      };
    return next(url, context);
  },
});
