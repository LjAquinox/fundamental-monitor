import { setRuntime } from "./runtime.ts";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createLocalStorage } from "./storage.mjs";
import { saveLocalSettings } from "./settings.mjs";
import { downloadReport } from "./report-download.mjs";

export function parseDevVars(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    values[match[1]] = value;
  }
  return values;
}
const root = process.env.FUNDAMENTAL_ROOT || process.cwd();
const path = resolve(root, ".dev.vars");
const vars = existsSync(path) ? parseDevVars(readFileSync(path, "utf8")) : {};
const allowed = [
  "OPENAI_API_KEY",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_REVIEW_MODEL",
  "LLM_REVIEW_REASONING_EFFORT",
  "AI_DAILY_CALL_LIMIT",
];
for (const key of allowed) if (process.env[key]) vars[key] = process.env[key];
const storage = createLocalStorage(root);
export const env = {
  ...vars,
  DB: storage.DB,
  BUCKET: storage.BUCKET,
  REPORT_DOWNLOAD: downloadReport,
  LOCAL_SETTINGS: {
    save(patch) {
      saveLocalSettings(root, patch);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete env[key];
        else env[key] = String(value);
      }
    },
  },
  PDF_ASSETS: {
    read: (path) => {
      if (!/^\/pdfs\/[a-zA-Z0-9_.-]+\.pdf$/.test(path))
        throw new Error("Invalid bundled PDF path.");
      return new Uint8Array(
        readFileSync(resolve(root, "public", path.slice(1))),
      );
    },
  },
};
setRuntime(env);
export const closeStorage = storage.close;
