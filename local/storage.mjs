import { DatabaseSync } from "node:sqlite";
import { CONTRACT_VERSION } from "../lib/report-contract.ts";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";

export function createLocalStorage(
  root,
  dataDirectory = resolve(root, ".local-data"),
) {
  mkdirSync(dataDirectory, { recursive: true });
  const sqlite = new DatabaseSync(resolve(dataDirectory, "research.sqlite"));
  const legacy = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observations'",
    )
    .get();
  if (legacy) {
    sqlite.close();
    throw new Error(
      "This release requires a clean data directory. Stop the app and move .local-data to a backup location before starting. No existing data was deleted.",
    );
  }
  const tables = new Set(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name),
  );
  const version = tables.has("app_meta")
    ? sqlite
        .prepare("SELECT value FROM app_meta WHERE key='contract_version'")
        .get()?.value
    : null;
  if (
    (tables.has("reports") || tables.has("app_meta")) &&
    version !== CONTRACT_VERSION
  ) {
    sqlite.close();
    throw new Error(
      "Incompatible financial contract. Start with a clean data directory; existing data was not migrated or deleted.",
    );
  }
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY NOT NULL)",
  );
  for (const name of readdirSync(resolve(root, "migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    if (
      sqlite
        .prepare("SELECT name FROM _local_migrations WHERE name=?")
        .get(name)
    )
      continue;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.exec(readFileSync(resolve(root, "migrations", name), "utf8"));
      sqlite.prepare("INSERT INTO _local_migrations(name) VALUES(?)").run(name);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      sqlite.close();
      throw error;
    }
  }
  sqlite
    .prepare(
      "INSERT INTO app_meta(key,value) VALUES('contract_version',?) ON CONFLICT(key) DO NOTHING",
    )
    .run(CONTRACT_VERSION);
  class Statement {
    constructor(sql, values = []) {
      this.sql = sql;
      this.values = values;
    }
    bind(...values) {
      return new Statement(this.sql, values);
    }
    all() {
      return {
        results: sqlite.prepare(this.sql).all(...this.values),
        success: true,
      };
    }
    first() {
      return sqlite.prepare(this.sql).get(...this.values) ?? null;
    }
    run() {
      const result = sqlite.prepare(this.sql).run(...this.values);
      return { success: true, meta: { changes: Number(result.changes) } };
    }
  }
  const files = resolve(dataDirectory, "files");
  mkdirSync(files, { recursive: true });
  function filePath(key) {
    const target = resolve(files, key);
    if (!target.startsWith(files + sep))
      throw new Error("Invalid storage key.");
    return target;
  }
  return {
    DB: {
      prepare: (sql) => new Statement(sql),
      batch(statements) {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const results = statements.map((s) => s.all());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    },
    BUCKET: {
      async put(key, value) {
        const target = filePath(key);
        mkdirSync(dirname(target), { recursive: true });
        const temp = target + "." + crypto.randomUUID() + ".tmp";
        writeFileSync(
          temp,
          typeof value === "string" ? value : new Uint8Array(value),
        );
        renameSync(temp, target);
      },
      async get(key) {
        const target = filePath(key);
        if (!existsSync(target)) return null;
        const bytes = readFileSync(target);
        return {
          body: new Uint8Array(bytes),
          arrayBuffer: async () =>
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
          json: async () => JSON.parse(bytes.toString("utf8")),
        };
      },
    },
    close: () => sqlite.close(),
    dataDirectory,
  };
}
