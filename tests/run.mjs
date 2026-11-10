import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const tests = readdirSync(new URL("../tests", import.meta.url))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => "tests/" + name);
const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--import",
    "./tests/register.mjs",
    "--test",
    ...tests,
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
