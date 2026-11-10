import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  cpSync,
  rmSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";
import {
  runBatch,
  parseBatchOptions,
} from "../lib/workflow/batch-extraction.mjs";

import { runCompanyReviews } from "../lib/workflow/company-review-runner.mjs";

const root = resolve(import.meta.dirname, ".."),
  options = parseBatchOptions(process.argv.slice(2));
process.env.FUNDAMENTAL_ROOT = root;
const port = process.env.FUNDAMENTAL_PORT || "5173";
try {
  const running = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(1500),
  });
  if (running.ok && (await running.json()).runtime === "local-node")
    throw new Error("APP_RUNNING");
} catch (e) {
  if (e.message === "APP_RUNNING")
    throw new Error(
      "Stop the app with Ctrl+C before running this batch script.",
    );
}
const dataDir = resolve(root, ".local-data"),
  lock = resolve(dataDir, "batch-extraction.lock");
mkdirSync(dataDir, { recursive: true });
try {
  mkdirSync(lock);
} catch {
  let owner;
  try {
    owner = Number(readFileSync(resolve(lock, "pid"), "utf8"));
  } catch {}
  if (!Number.isInteger(owner) || owner < 1)
    throw new Error(
      "A batch lock exists without an owner. Check no batch is active before removing .local-data/batch-extraction.lock.",
    );
  let alive = true;
  try {
    process.kill(owner, 0);
  } catch (e) {
    if (e.code === "ESRCH") alive = false;
  }
  if (alive)
    throw new Error("Another batch is running. Wait for it to finish.");
  rmSync(lock, { recursive: true, force: true });
  mkdirSync(lock);
}
writeFileSync(resolve(lock, "pid"), String(process.pid));
let app;
try {
  if (!options.dryRun) {
    const folder = resolve(
      root,
      ".backups",
      `before-${options.applySavedReview || options.recoverReview ? "saved-review-recovery" : options.reviewOnly ? "company-review" : "whole-pdf"}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );
    mkdirSync(folder, { recursive: true });
    const source = resolve(dataDir, "research.sqlite");
    if (existsSync(source)) {
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        await backup(db, resolve(folder, "research.sqlite"));
      } finally {
        db.close();
      }
    }
    if (existsSync(resolve(dataDir, "files")))
      cpSync(resolve(dataDir, "files"), resolve(folder, "files"), {
        recursive: true,
      });
    console.log("Backup created:", folder);
  }
  app = await import(
    pathToFileURL(resolve(root, ".local-build/server.mjs")).href
  );
  const call = async (path, body) => {
    const response = await app.dispatch(
      new Request(
        `http://127.0.0.1:${port}${path}`,
        body
          ? {
              method: "POST",
              headers: {
                Origin: `http://127.0.0.1:${port}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            }
          : undefined,
      ),
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Batch request failed.");
    return data;
  };
  const ws = await call("/api/workspace"),
    config = await call("/api/config");
  const docs = [...ws.documents].sort(
    (a, b) =>
      a.companyId.localeCompare(b.companyId) ||
      a.publishedAt.localeCompare(b.publishedAt),
  );
  console.log(
    options.applySavedReview || options.recoverReview
      ? "Applying a saved company response locally. Paid model calls: 0."
      : `${docs.length} documents. Model: ${config.model}. Daily AI request limit: ${config.dailyCallLimit}.${options.reviewOnly ? " Reusing saved extractions." : ` Parallel extractions: ${options.concurrency}.`}`,
  );
  if (options.applySavedReview || options.recoverReview) {
    const result = await call("/api/company-review", {
      action: options.applySavedReview ? "apply_saved" : "recover",
      jobId: options.applySavedReview || options.recoverReview,
    });
    const job = result.job || result;
    if (job.status !== "completed")
      throw new Error(
        "Saved review application did not complete. No model call was made.",
      );
    console.log(
      `${job.companyId}: ${result.status || job.status}; paid model calls: 0.`,
    );
    console.log(
      "Saved company response applied locally. Existing extractions and other companies were preserved.",
    );
  } else if (options.dryRun) {
    for (const d of docs) console.log(`${d.id}: ${d.title}`);
  } else {
    if (!config.configured)
      throw new Error("Configure the API key in the app's API settings first.");
    if (!/^typed-report-v\d+$/.test(ws.contractVersion))
      throw new Error("Unsupported workspace contract.");
    const checkpointName =
      ws.contractVersion.replace("typed-report-", "typed-report-batch-") +
      ".json";
    const file = resolve(dataDir, checkpointName);
    if (options.fresh && !options.reviewOnly && existsSync(file))
      renameSync(file, file + "." + Date.now() + ".bak");
    const checkpoint = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { version: ws.contractVersion, documents: {} };
    if (checkpoint.version !== ws.contractVersion || !checkpoint.documents)
      throw new Error("Unsupported checkpoint format.");
    if (!options.reviewOnly)
      await runBatch({
        documents: docs,
        checkpoint,
        call,
        retryFailed: options.retryFailed,
        concurrency: options.concurrency,
        validateFirstRequest: true,
        progress: console.log,
        save: async (state) => {
          writeFileSync(file + ".tmp", JSON.stringify(state, null, 2));
          renameSync(file + ".tmp", file);
        },
      });
    const completed = docs.filter(
      (d) => checkpoint.documents[d.id]?.status === "completed",
    ).length;
    if (!options.reviewOnly) {
      console.log(
        `Finished: ${completed}/${docs.length} documents. Detailed results: .local-data/${checkpointName}`,
      );
      console.log(
        `${completed} typed reports accepted. Dashboard publication requires the company review and explicit source selections below.`,
      );
    }
    {
      const companies = ws.companies.filter(
        (c) =>
          docs.some((d) => d.companyId === c.id) &&
          (options.reviewOnly ||
            docs
              .filter((d) => d.companyId === c.id)
              .every(
                (d) =>
                  checkpoint.documents[d.id]?.status === "completed" &&
                  checkpoint.documents[d.id]?.sha256 === d.sha256,
              )),
      );
      console.log(
        `Reconciling ${companies.length} companies. Model: ${config.reviewModel || config.model}. Reasoning: ${config.reviewReasoningEffort}. One paid company call with all original PDFs and typed reports; no per-PDF second review.`,
      );
      const reviews = await runCompanyReviews({
        companies,
        call,
        concurrency: options.concurrency,
        retryFailed: options.retryFailed,
        fresh: options.fresh,
        progress: console.log,
      });
      if (
        reviews.length !== companies.length ||
        reviews.some((j) => j.status !== "completed")
      ) {
        console.log(
          "Some reviews are incomplete. Resume normally; use -RetryFailed (or --retry-failed) only after checking provider usage. Review progress is saved in the app database.",
        );
        process.exitCode = 1;
      }
    }
    if (!options.reviewOnly && completed < docs.length) {
      console.log(
        "Rerun to resume unattempted reports and saved proposals. Failed/uncertain paid calls are skipped; -RetryFailed (or --retry-failed) explicitly authorizes new requests.",
      );
      process.exitCode = 1;
    }
  }
} finally {
  try {
    app?.closeStorage();
  } finally {
    if (
      existsSync(resolve(lock, "pid")) &&
      readFileSync(resolve(lock, "pid"), "utf8") === String(process.pid)
    ) {
      unlinkSync(resolve(lock, "pid"));
      rmdirSync(lock);
    }
  }
}
