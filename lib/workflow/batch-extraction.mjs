import { parseArgs } from "node:util";

export function parseBatchOptions(args) {
  // Windows launchers forward arguments unchanged so PowerShell cannot silently
  // swallow GNU-style flags such as --retry-failed.
  const windowsOptions = new Map([
    ["-dryrun", "--dry-run"],
    ["-retryfailed", "--retry-failed"],
    ["-reviewonly", "--review-only"],
    ["-fresh", "--fresh"],
    ["-concurrency", "--concurrency"],
    ["-applysavedreview", "--apply-saved-review"],
    ["-recoverreview", "--recover-review"],
  ]);
  args = args.map((arg) => windowsOptions.get(arg.toLowerCase()) || arg);
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      "dry-run": { type: "boolean" },
      "review-only": { type: "boolean" },
      fresh: { type: "boolean" },
      "retry-failed": { type: "boolean" },
      concurrency: { type: "string", default: "4" },
      "apply-saved-review": { type: "string" },
      "recover-review": { type: "string" },
    },
  });
  if (
    !/^\d+$/.test(values.concurrency) ||
    Number(values.concurrency) < 1 ||
    Number(values.concurrency) > 16
  )
    throw new Error("Concurrency must be a whole number between 1 and 16.");
  const localReview = values["apply-saved-review"] ?? values["recover-review"];
  if (
    localReview !== undefined &&
    (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      localReview,
    ) ||
      values["fresh"] ||
      values["review-only"] ||
      values["retry-failed"] ||
      values["dry-run"] ||
      (values["apply-saved-review"] !== undefined &&
        values["recover-review"] !== undefined))
  )
    throw new Error(
      "Supply one review UUID for local application/recovery, without Fresh, ReviewOnly, RetryFailed or DryRun.",
    );
  return {
    applySavedReview: values["apply-saved-review"] || null,
    recoverReview: values["recover-review"] || null,
    dryRun: !!values["dry-run"],
    reviewOnly: !!values["review-only"],
    fresh: !!values.fresh,
    retryFailed: !!values["retry-failed"],
    concurrency: Number(values.concurrency),
  };
}

/** Parallel paid calls; serialized checkpoints and acceptance. Never implicitly retry a model request. */
export async function runBatch({
  documents,
  checkpoint,
  save,
  call,
  progress = () => {},
  retryFailed = false,
  concurrency = 4,
  validateFirstRequest = false,
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error("Concurrency must be a whole number between 1 and 16.");
  let next = 0,
    stopped = false,
    checkpointQueue = Promise.resolve(),
    acceptanceQueue = Promise.resolve();
  // Snapshot at enqueue time so a slower async write cannot persist a newer
  // state before an older state or read later mutations from a shared object.
  function persist() {
    const snapshot = structuredClone(checkpoint);
    checkpointQueue = checkpointQueue.then(() => save(snapshot));
    return checkpointQueue;
  }
  function accept(body) {
    const result = acceptanceQueue.then(() => call("/api/extractions", body));
    // A rejected acceptance must not block unrelated documents from saving.
    acceptanceQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function processDocument(document, index) {
    const previous = checkpoint.documents[document.id];
    if (
      previous?.sha256 === document.sha256 &&
      previous.status === "completed"
    ) {
      progress(
        `${index + 1}/${documents.length} ${document.title}: already completed`,
      );
      return;
    }
    if (
      previous?.sha256 === document.sha256 &&
      ["started", "failed"].includes(previous.status) &&
      !previous.extractionId &&
      !retryFailed
    ) {
      progress(
        `${index + 1}/${documents.length} ${document.title}: skipped uncertain/failed paid request; use --retry-failed only after checking provider usage`,
      );
      return;
    }
    const entry =
      previous?.sha256 === document.sha256 &&
      previous.extractionId &&
      previous.status !== "completed"
        ? previous
        : { sha256: document.sha256, status: "started", title: document.title };
    checkpoint.documents[document.id] = entry;
    await persist();
    try {
      progress(
        `${index + 1}/${documents.length} ${document.title}: ${entry.extractionId ? "accepting saved proposals" : "extracting whole PDF"}`,
      );
      if (!entry.extractionId) {
        if (stopped) {
          // This slot was reserved before another worker hit a provider limit;
          // no model request was started, so a normal resume may retry it.
          entry.status = "waiting_for_limit";
          await persist();
          return;
        }
        const result = await call("/api/extract", { documentId: document.id });
        entry.extractionId = result.extractionId;
        entry.usage = result.usage;
        entry.status = "acceptance_pending";
        await persist();
      }
      const accepted = await accept({
        action: "replace",
        extractionId: entry.extractionId,
      });
      entry.status = "completed";
      entry.result = accepted;
      delete entry.error;
      await persist();
      progress(
        `  ${index + 1}/${documents.length} ${document.title}: ${accepted.accepted} typed values/statements; ${accepted.needsReview} blocking checks; company review pending`,
      );
    } catch (error) {
      entry.status = entry.extractionId
        ? "acceptance_pending"
        : /daily AI call limit/i.test(error.message)
          ? "waiting_for_limit"
          : "failed";
      entry.error = error.message;
      if (
        /daily AI call limit|quota|HTTP (400|401|403|404|413|415|422|429)/i.test(
          error.message,
        )
      )
        stopped = true;
      await persist();
      progress(
        `  ${index + 1}/${documents.length} ${document.title}: failed: ${error.message}`,
      );
    }
  }
  let firstRequestIndex = -1;
  if (validateFirstRequest) {
    firstRequestIndex = documents.findIndex((document) => {
      const previous = checkpoint.documents[document.id];
      if (previous?.sha256 !== document.sha256) return true;
      if (previous.status === "completed" || previous.extractionId)
        return false;
      return !["started", "failed"].includes(previous.status) || retryFailed;
    });
    if (firstRequestIndex >= 0) {
      progress(
        "Validating the first pending PDF request before starting parallel extraction (this is the real extraction, not an extra paid call).",
      );
      await processDocument(documents[firstRequestIndex], firstRequestIndex);
      if (
        checkpoint.documents[documents[firstRequestIndex].id]?.status !==
        "completed"
      ) {
        stopped = true;
        progress(
          "First request did not complete. Remaining PDF calls were not started; inspect the exact error before retrying.",
        );
      }
    }
  }
  async function worker() {
    while (!stopped && next < documents.length) {
      const index = next++;
      if (index === firstRequestIndex) continue;
      await processDocument(documents[index], index);
    }
  }
  // Wait for every in-flight request, including when a checkpoint write fails.
  // The caller may close SQLite only after all workers have settled.
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, documents.length) }, worker),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return checkpoint;
}
