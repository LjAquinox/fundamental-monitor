/** Run saved review jobs with bounded source calls and no implicit paid retries. */
export async function runCompanyReviews({
  companies,
  call,
  concurrency = 4,
  retryFailed = false,
  progress = (_message) => {},
  shouldStop = () => false,
  workflow = "reconcile",
  fresh = false,
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error("Concurrency must be a whole number between 1 and 16.");
  const results = [];
  let limited = false;
  for (const company of companies) {
    if (limited || shouldStop()) break;
    let job = await call("/api/company-review", {
      action: "start",
      companyId: company.id,
      workflow,
      fresh,
    });
    progress(`${company.name}: review ${job.id}`);
    const pending = Object.entries(job.documents).filter(
      ([, entry]) =>
        job.workflow === "extract_reconcile" && entry.status !== "completed",
    );
    let next = 0;
    async function worker() {
      while (!limited && !shouldStop() && next < pending.length) {
        const [documentId, entry] = pending[next++];
        if (["running", "failed"].includes(entry.status) && !retryFailed) {
          progress(
            `${company.name} / ${documentId}: saved ${entry.status}; use -RetryFailed (or --retry-failed) for explicit retry/recovery`,
          );
          continue;
        }
        try {
          const result = await call("/api/company-review", {
            action: "extract",
            jobId: job.id,
            documentId,
            retry: retryFailed,
          });
          progress(
            `${company.name} / ${documentId}: ${JSON.stringify(result.extractionSummary || result.summary)}`,
          );
        } catch (error) {
          if (
            /daily AI call limit|quota|HTTP (400|401|403|404|413|415|422|429)/i.test(
              error.message,
            )
          )
            limited = true;
          progress(`${company.name} / ${documentId}: ${error.message}`);
        }
      }
    }
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, pending.length) }, worker),
    );
    const rejected = settled.find((r) => r.status === "rejected");
    if (rejected) throw rejected.reason;
    job = await call(`/api/company-review?jobId=${encodeURIComponent(job.id)}`);
    if (
      !limited &&
      !shouldStop() &&
      (job.workflow === "reconcile" ||
        Object.values(job.documents).every((d) => d.status === "completed")) &&
      (job.consistency.status === "pending" ||
        (retryFailed && job.consistency.status !== "completed"))
    ) {
      try {
        job = await call("/api/company-review", {
          action: "consistency",
          jobId: job.id,
          retry: retryFailed,
        });
      } catch (error) {
        if (
          /daily AI call limit|quota|HTTP (400|401|403|404|413|415|422|429)/i.test(
            error.message,
          )
        )
          limited = true;
        progress(
          `${company.name}: consistency review failed: ${error.message}`,
        );
        job = await call(
          `/api/company-review?jobId=${encodeURIComponent(job.id)}`,
        );
      }
    }
    results.push(job);
    if (
      job.consistency.status === "completed" &&
      job.consistency.reusedSavedResponse
    )
      progress(
        `${company.name}: reused saved company decisions; no new company model request was made.`,
      );
    progress(
      `${company.name}: ${job.consistency.status === "failed" ? "needs attention" : job.status}; ${job.consistency.status === "completed" ? `${(job.consistency.findings || []).filter((f) => !f.resolvedAt).length} consistency findings` : `company consistency ${job.consistency.status}`}`,
    );
  }
  return results;
}
