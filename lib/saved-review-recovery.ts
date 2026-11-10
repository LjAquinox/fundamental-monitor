import cases from "../data/review-recovery-cases.json" with { type: "json" };
import { readWorkspace, getDocument, getPdfBytes } from "./server";
import { getCompanyReview } from "./company-review";
import { readRun } from "./report-store";
import { applyCompanyResult } from "./company-reconciliation";
import { normalizeReportPath } from "./report-contract";
async function hash(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
/** A verified, response-specific repair. Never guess how to retarget arbitrary corrections. */
export async function recoverSavedReview(jobId: string, requestUrl: string) {
  const recovery = (
    cases as Record<string, (typeof cases)[keyof typeof cases]>
  )[jobId];
  if (!recovery)
    throw Error(
      "No verified local recovery is registered for this review. No changes or model calls were made.",
    );
  const job = await getCompanyReview(jobId),
    ws = await readWorkspace();
  if (ws.publications.some((p) => p.reviewId === job.id))
    return { status: "already_applied", paidCalls: 0, job };
  if (
    job.consistency.status !== "failed" ||
    job.consistency.runId !== recovery.sourceRunId
  )
    throw Error(
      "Recovery conflict: the saved review state differs from the verified case.",
    );
  const saved = await readRun(recovery.sourceRunId);
  if (
    saved?.kind !== "company_review" ||
    saved.status !== "completed" ||
    (await hash(saved.result)) !== recovery.resultHash ||
    (await hash(saved.rawOutput)) !== recovery.rawOutputHash
  )
    throw Error(
      "Recovery conflict: original model response does not match the verified response.",
    );
  const correction = saved.result.corrections[recovery.correctionIndex];
  if (
    correction.documentId !== recovery.fromDocumentId ||
    correction.path !== recovery.path ||
    correction.index !== recovery.index ||
    correction.value?.transactionKey !== recovery.transactionKey
  )
    throw Error("Recovery correction does not match the verified case.");
  const incorrect = ws.reports.find(
      (r) => r.documentId === recovery.fromDocumentId,
    ),
    correct = ws.reports.find((r) => r.documentId === recovery.toDocumentId);
  if (
    incorrect?.report.events.length !== 0 ||
    correct?.report.events[recovery.index]?.transactionKey !==
      recovery.transactionKey ||
    correct.sourceHash !== recovery.sourceHash
  )
    throw Error(
      "Recovery conflict: original report event identities or revisions changed.",
    );
  const source = await getDocument(recovery.toDocumentId);
  if (
    source.sha256 !== recovery.sourceHash ||
    !source.pages
      .find((p) => p.page === recovery.sourcePage)
      ?.text.includes(recovery.sourceText)
  )
    throw Error("Recovery source proof does not match the original report.");
  await getPdfBytes(source, requestUrl);
  const repaired = structuredClone(saved);
  repaired.result.corrections[recovery.correctionIndex].documentId =
    recovery.toDocumentId;
  const audit = {
    id: crypto.randomUUID(),
    kind: "local_review_recovery",
    at: new Date().toISOString(),
    paidCalls: 0,
    originalRunId: recovery.sourceRunId,
    originalResultHash: recovery.resultHash,
    originalRawOutputHash: recovery.rawOutputHash,
    changes: [
      {
        correction: recovery.correctionIndex,
        field: "documentId",
        before: recovery.fromDocumentId,
        after: recovery.toDocumentId,
        reason:
          "Corrected report attribution using the original PDF and the existing transaction identity.",
        sourceHash: recovery.sourceHash,
        sourcePage: recovery.sourcePage,
      },
    ],
    normalizedFindingPaths: saved.result.findings
      .filter((f: any) => normalizeReportPath(f.path) !== f.path)
      .map((f: any) => ({
        before: f.path,
        after: normalizeReportPath(f.path),
      })),
  };
  await applyCompanyResult(
    {
      ...job,
      consistency: {
        ...job.consistency,
        error: undefined,
        reusedSavedResponse: true,
        recovery: {
          auditId: audit.id,
          sourceRunId: recovery.sourceRunId,
          paidCalls: 0,
        },
      },
    },
    { ...repaired, localRecovery: audit },
  );
  return {
    status: "recovered",
    paidCalls: 0,
    job: await getCompanyReview(jobId),
    notice:
      "Applied the saved company review locally. Original extraction/model responses and their hashes were preserved.",
  };
}
