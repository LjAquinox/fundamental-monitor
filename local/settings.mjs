import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  lstatSync,
} from "node:fs";
import { resolve } from "node:path";

/** Only explicit local settings writes may touch the credential file. Never return its contents. */
export function saveLocalSettings(root, patch) {
  const path = resolve(root, ".dev.vars");
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw new Error("The settings file must not be a symbolic link.");
  const keys = Object.keys(patch);
  if (
    keys.some(
      (k) =>
        ![
          "OPENAI_API_KEY",
          "LLM_MODEL",
          "LLM_REVIEW_MODEL",
          "LLM_REVIEW_REASONING_EFFORT",
          "LLM_PROVIDER",
          "AI_DAILY_CALL_LIMIT",
        ].includes(k),
    )
  )
    throw new Error("Unsupported local setting.");
  if (keys.some((k) => process.env[k]))
    throw new Error(
      "This setting is controlled by a process environment variable. Update that variable before saving here.",
    );
  if (
    Object.values(patch).some(
      (v) => v !== null && /[\r\n\0"\\]/.test(String(v)),
    )
  )
    throw new Error("Invalid settings value.");
  const lines = (existsSync(path) ? readFileSync(path, "utf8") : "")
    .split(/\r?\n/)
    .filter(
      (line) => !keys.some((k) => new RegExp(`^\\s*${k}\\s*=`).test(line)),
    );
  for (const [key, value] of Object.entries(patch))
    if (value !== null) lines.push(`${key}="${value}"`);
  const temp = path + "." + crypto.randomUUID() + ".tmp";
  writeFileSync(
    temp,
    lines.filter((line, i) => line || i < lines.length - 1).join("\n") + "\n",
    { mode: 0o600 },
  );
  renameSync(temp, path);
}
