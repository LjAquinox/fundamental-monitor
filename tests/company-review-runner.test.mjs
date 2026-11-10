import test from "node:test";
import assert from "node:assert/strict";
import { runCompanyReviews } from "../lib/workflow/company-review-runner.mjs";
import { parseBatchOptions } from "../lib/workflow/batch-extraction.mjs";
const company = { id: "c", name: "Issuer" };
function fixture(statuses = ["pending", "pending", "pending"]) {
  const job = {
      id: "j",
      status: "running",
      workflow: "extract_reconcile",
      documents: Object.fromEntries(
        statuses.map((status, i) => [`d${i}`, { status }]),
      ),
      consistency: { status: "pending" },
    },
    calls = [];
  return {
    job,
    calls,
    call: async (path, body) => {
      if (!body) return structuredClone(job);
      calls.push(body);
      if (body.action === "start") return structuredClone(job);
      if (body.action === "extract") {
        job.documents[body.documentId].status = "completed";
        return { summary: { confirmed: 1 } };
      }
      if (body.action === "consistency") {
        job.consistency.status = "completed";
        job.status = "completed";
        return structuredClone(job);
      }
    },
  };
}
test("review-only and fresh flags preserve extraction defaults", () => {
  assert.equal(parseBatchOptions([]).fresh, false);
  assert.equal(parseBatchOptions(["--review-only"]).reviewOnly, true);
  assert.equal(parseBatchOptions(["--fresh"]).fresh, true);
});
test("extraction runner overlaps calls with a bound and waits before company consistency", async () => {
  const f = fixture();
  let active = 0,
    peak = 0;
  const call = async (path, body) => {
    if (body?.action === "extract") {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      const result = await f.call(path, body);
      active--;
      return result;
    }
    if (body?.action === "consistency") {
      assert.equal(active, 0);
      assert.ok(
        Object.values(f.job.documents).every((d) => d.status === "completed"),
      );
    }
    return f.call(path, body);
  };
  const [job] = await runCompanyReviews({
    companies: [company],
    call,
    concurrency: 2,
  });
  assert.equal(peak, 2);
  assert.equal(job.status, "completed");
  assert.equal(f.calls.filter((c) => c.action === "consistency").length, 1);
});
test("failed/uncertain calls are skipped on resume and explicitly recoverable", async () => {
  const f = fixture(["completed", "failed", "running"]);
  await runCompanyReviews({ companies: [company], call: f.call });
  assert.equal(f.calls.length, 1);
  await runCompanyReviews({
    companies: [company],
    call: f.call,
    retryFailed: true,
  });
  assert.deepEqual(
    f.calls.filter((c) => c.action === "extract").map((c) => c.documentId),
    ["d1", "d2"],
  );
  assert.equal(f.job.status, "completed");
});
test("quota stops new paid calls, awaits in-flight work, and never runs consistency on partial data", async () => {
  const f = fixture();
  let done = false;
  const call = async (path, body) => {
    if (body?.action === "extract" && body.documentId === "d0")
      throw new Error("HTTP 429 quota exhausted");
    if (body?.action === "extract") {
      await new Promise((resolve) => setImmediate(resolve));
      done = true;
    }
    return f.call(path, body);
  };
  await runCompanyReviews({ companies: [company], call, concurrency: 2 });
  assert.equal(done, true);
  assert.equal(f.job.documents.d2.status, "pending");
  assert.equal(f.job.consistency.status, "pending");
});

test("review-only retry keeps NVIDIA completed and retries only Intel's failed company call", async () => {
  const jobs = {
    nvda: {
      id: "nvda-job",
      workflow: "reconcile",
      status: "completed",
      documents: {},
      consistency: { status: "completed", findings: [] },
    },
    intc: {
      id: "intc-job",
      workflow: "reconcile",
      status: "running",
      documents: {},
      consistency: {
        status: "failed",
        error: "The model request did not finish.",
      },
    },
  };
  const calls = [];
  const result = await runCompanyReviews({
    companies: [
      { id: "nvda", name: "NVIDIA" },
      { id: "intc", name: "Intel" },
    ],
    retryFailed: true,
    call: async (path, body) => {
      if (!body)
        return structuredClone(
          path.includes("nvda-job") ? jobs.nvda : jobs.intc,
        );
      calls.push(body);
      if (body.action === "start") {
        assert.equal(body.fresh, false);
        return structuredClone(jobs[body.companyId]);
      }
      assert.equal(body.action, "consistency");
      assert.equal(body.jobId, "intc-job");
      assert.equal(body.retry, true);
      jobs.intc.status = "completed";
      jobs.intc.consistency.status = "completed";
      return structuredClone(jobs.intc);
    },
  });
  assert.equal(
    result.every((job) => job.status === "completed"),
    true,
  );
  assert.deepEqual(
    calls.map((body) => body.action),
    ["start", "start", "consistency"],
  );
});
