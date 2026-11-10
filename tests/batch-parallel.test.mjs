import test from "node:test";
import assert from "node:assert/strict";
import {
  runBatch,
  parseBatchOptions,
} from "../lib/workflow/batch-extraction.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const documents = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `d${i}`,
    title: `Report ${i}`,
    sha256: `hash${i}`,
  }));
const accepted = { accepted: 1, needsReview: 0, conflicts: 0 };

test("batch CLI defaults to four workers and rejects invalid concurrency before starting work", () => {
  assert.deepEqual(parseBatchOptions([]), {
    concurrency: 4,
    applySavedReview: null,
    recoverReview: null,
    dryRun: false,
    reviewOnly: false,
    fresh: false,
    retryFailed: false,
  });
  assert.deepEqual(
    parseBatchOptions(["--concurrency", "8", "--dry-run", "--retry-failed"]),
    {
      concurrency: 8,
      applySavedReview: null,
      recoverReview: null,
      dryRun: true,
      retryFailed: true,
      reviewOnly: false,
      fresh: false,
    },
  );
  assert.equal(parseBatchOptions(["--concurrency=1"]).concurrency, 1);
  for (const value of ["0", "17", "1.5", "NaN", "-1", ""])
    assert.throws(() => parseBatchOptions(["--concurrency", value]));
  assert.throws(() => parseBatchOptions(["--concurreny", "8"]));
});

test("model calls overlap up to the chosen bound while database acceptance stays serialized", async () => {
  const docs = documents(5),
    gates = docs.map(deferred),
    firstPair = deferred(),
    nextPair = deferred();
  const checkpoint = { documents: {} },
    calls = [],
    snapshots = [];
  let modelActive = 0,
    modelPeak = 0,
    acceptActive = 0,
    acceptPeak = 0;
  const batch = runBatch({
    documents: docs,
    checkpoint,
    concurrency: 2,
    save: async (state) => {
      snapshots.push(state);
    },
    call: async (path, body) => {
      if (path === "/api/extract") {
        const index = Number(body.documentId.slice(1));
        calls.push(index);
        modelPeak = Math.max(modelPeak, ++modelActive);
        if (calls.length === 2) firstPair.resolve();
        if (calls.length === 4) nextPair.resolve();
        await gates[index].promise;
        modelActive--;
        return { extractionId: `run${index}` };
      }
      acceptPeak = Math.max(acceptPeak, ++acceptActive);
      await Promise.resolve();
      await Promise.resolve();
      acceptActive--;
      return accepted;
    },
  });
  await firstPair.promise;
  assert.deepEqual(calls, [0, 1]);
  assert.equal(modelActive, 2);
  // Complete out of order; idle slots must take the next PDF immediately.
  gates[1].resolve();
  gates[0].resolve();
  await nextPair.promise;
  gates[2].resolve();
  gates[3].resolve();
  gates[4].resolve();
  await batch;
  assert.equal(modelPeak, 2);
  assert.equal(acceptPeak, 1);
  assert.equal(
    Object.values(checkpoint.documents).filter((e) => e.status === "completed")
      .length,
    5,
  );
  assert.notEqual(snapshots[0], checkpoint);
  assert.ok(
    Object.values(snapshots[0].documents).every((e) => e.status === "started"),
  );
  assert.ok(
    Object.values(snapshots.at(-1).documents).every(
      (e) => e.status === "completed",
    ),
  );
});

test("async checkpoint writes never overlap or lose a completed document", async () => {
  let saving = 0,
    peak = 0;
  const snapshots = [],
    firstWrite = deferred(),
    release = deferred(),
    checkpoint = { documents: {} };
  const batch = runBatch({
    documents: documents(3),
    checkpoint,
    concurrency: 3,
    save: async (state) => {
      peak = Math.max(peak, ++saving);
      if (!snapshots.length) {
        firstWrite.resolve();
        await release.promise;
      }
      snapshots.push(state);
      saving--;
    },
    call: async (path) =>
      path === "/api/extract"
        ? { extractionId: crypto.randomUUID() }
        : accepted,
  });
  await firstWrite.promise;
  release.resolve();
  await batch;
  assert.equal(peak, 1);
  assert.equal(Object.keys(snapshots[0].documents).length, 1);
  assert.equal(
    Object.values(snapshots.at(-1).documents).filter(
      (e) => e.status === "completed",
    ).length,
    3,
  );
});

test("provider limits stop new model calls, but the batch waits for in-flight results and accepts them", async () => {
  const gates = [deferred(), deferred()],
    started = deferred(),
    calls = [],
    checkpoint = { documents: {} };
  let finished = false;
  const batch = runBatch({
    documents: documents(5),
    checkpoint,
    concurrency: 2,
    save: async () => {},
    call: async (path, body) => {
      if (path !== "/api/extract") return accepted;
      const i = Number(body.documentId.slice(1));
      calls.push(i);
      if (calls.length === 2) started.resolve();
      await gates[i].promise;
      return { extractionId: `run${i}` };
    },
  }).then(() => {
    finished = true;
  });
  await started.promise;
  gates[0].reject(new Error("Model provider returned HTTP 429"));
  // Yield until the first worker has recorded the error; do not use timer-based timing assertions.
  while (checkpoint.documents.d0.status !== "failed") await Promise.resolve();
  assert.equal(finished, false);
  gates[1].resolve();
  await batch;
  assert.deepEqual(calls, [0, 1]);
  assert.equal(checkpoint.documents.d1.status, "completed");
  assert.equal(checkpoint.documents.d2, undefined);
});

test("one acceptance failure cannot block other documents and saved proposals resume without a paid call", async () => {
  const checkpoint = {
      documents: {
        d0: {
          sha256: "hash0",
          extractionId: "saved0",
          status: "acceptance_pending",
        },
        d1: {
          sha256: "hash1",
          extractionId: "saved1",
          status: "acceptance_pending",
        },
      },
    },
    calls = [];
  await runBatch({
    documents: documents(2),
    checkpoint,
    concurrency: 2,
    save: async () => {},
    call: async (path, body) => {
      calls.push(path);
      if (body.extractionId === "saved0") throw new Error("Edit conflict");
      return accepted;
    },
  });
  assert.deepEqual(calls, ["/api/extractions", "/api/extractions"]);
  assert.equal(checkpoint.documents.d0.status, "acceptance_pending");
  assert.equal(checkpoint.documents.d1.status, "completed");
});

test("Windows and GNU-style batch flags can be mixed without silently losing retry", () => {
  const expected = {
    applySavedReview: null,
    recoverReview: null,
    concurrency: 8,
    dryRun: false,
    reviewOnly: true,
    fresh: false,
    retryFailed: true,
  };
  assert.deepEqual(
    parseBatchOptions(["-ReviewOnly", "-Concurrency", "8", "--retry-failed"]),
    expected,
  );
  assert.deepEqual(
    parseBatchOptions(["-reviewonly", "--concurrency=8", "-RETRYFAILED"]),
    expected,
  );
  assert.equal(parseBatchOptions(["-DryRun", "-Fresh"]).dryRun, true);
  assert.throws(() => parseBatchOptions(["--retry-faild"]));
  assert.throws(() => parseBatchOptions(["-Concurrency", "99"]));
});

test("first-request validation prevents a schema refusal from launching a parallel burst", async () => {
  const calls = [],
    checkpoint = { documents: {} };
  await runBatch({
    documents: documents(29),
    checkpoint,
    concurrency: 16,
    validateFirstRequest: true,
    retryFailed: true,
    save: async () => {},
    call: async (path, body) => {
      calls.push(body.documentId);
      throw Error(
        "Model provider returned HTTP 400 (invalid_json_schema). Parameter: text.format.schema. Request ID: req_failed.",
      );
    },
  });
  assert.deepEqual(calls, ["d0"]);
  assert.equal(checkpoint.documents.d0.status, "failed");
  assert.match(checkpoint.documents.d0.error, /req_failed/);
  assert.equal(Object.keys(checkpoint.documents).length, 1);
});
test("successful first-request validation is a real saved extraction, then remaining calls overlap without repeating it", async () => {
  const checkpoint = {
      documents: {
        d0: { sha256: "hash0", status: "completed" },
        d1: { sha256: "hash1", status: "failed" },
      },
    },
    calls = [];
  let active = 0,
    peak = 0,
    firstCompleted = false;
  await runBatch({
    documents: documents(8),
    checkpoint,
    concurrency: 4,
    retryFailed: true,
    validateFirstRequest: true,
    save: async () => {},
    call: async (path, body) => {
      if (path !== "/api/extract") {
        if (body.extractionId === "r-d1") firstCompleted = true;
        return accepted;
      }
      if (body.documentId !== "d1") assert.equal(firstCompleted, true);
      calls.push(body.documentId);
      peak = Math.max(peak, ++active);
      await new Promise((r) => setImmediate(r));
      active--;
      return { extractionId: "r-" + body.documentId };
    },
  });
  assert.deepEqual(calls.slice(0, 1), ["d1"]);
  assert.equal(calls.filter((id) => id === "d1").length, 1);
  assert.equal(calls.length, 7);
  assert.ok(peak > 1 && peak <= 4);
  assert.ok(
    Object.values(checkpoint.documents).every((d) => d.status === "completed"),
  );
});

test("local saved-review options preserve Windows arguments and cannot authorize generation", () => {
  const id = "300febff-e376-4e9e-8689-af9a8d58d278";
  assert.equal(
    parseBatchOptions(["-ApplySavedReview", id]).applySavedReview,
    id,
  );
  assert.equal(
    parseBatchOptions(["--apply-saved-review=" + id]).applySavedReview,
    id,
  );
  assert.equal(parseBatchOptions(["-RecoverReview", id]).recoverReview, id);
  for (const flag of ["-Fresh", "-ReviewOnly", "-RetryFailed", "-DryRun"])
    assert.throws(
      () => parseBatchOptions(["-ApplySavedReview", id, flag]),
      /local application/,
    );
  assert.throws(() =>
    parseBatchOptions(["-ApplySavedReview", id, "-RecoverReview", id]),
  );
  for (const bad of ["", "unknown", "../path"])
    assert.throws(() => parseBatchOptions(["-ApplySavedReview", bad]));
});
