import { runtime, readWorkspace, getDocument } from "./server";
import { commitState, revisionStatements, readRun } from "./report-store";
import { CONTRACT_VERSION, getPath, publicationSlots } from "./report-contract";
import {
  blocksPath,
  normalizeReportAmounts,
  precision,
  reportIssues,
  normalizationMessage,
} from "./report-checks";
import { contextualizeFinding } from "./review-state";
import { companySnapshot } from "./selections";
import type { Publication, ReportRevision } from "./types";

/** Revalidate existing explicit source choices after local arithmetic/manual
 * corrections. Never select a new source or make a model request. */
export async function refreshCompanyPublication(companyId: string) {
  const ws = await readWorkspace();
  const docs = ws.documents.filter((d) => d.companyId === companyId);
  const base = ws.publications.find(
    (p) => p.companyId === companyId && p.contractVersion === CONTRACT_VERSION,
  );
  if (
    !base ||
    !docs.length ||
    docs.length !== Object.keys(base.snapshots).length ||
    docs.some((d) => base.snapshots[d.id]?.hash !== d.sha256)
  )
    throw Error(
      "A completed company review for the current PDF set is required. Local refresh cannot review new or replaced documents.",
    );
  const reports = ws.reports.filter((r) => r.companyId === companyId);
  if (reports.length !== docs.length)
    throw Error("Every PDF requires an accepted report.");
  for (const r of reports) {
    const baseline = base.snapshots[r.documentId].revision;
    if (r.revision < baseline)
      throw Error("Publication revision is newer than the active report.");
    if (r.revision === baseline) continue;
    const history = await runtime()
      .DB.prepare(
        "SELECT payload FROM reports WHERE document_id=? AND revision>? AND revision<=? ORDER BY revision",
      )
      .bind(r.documentId, baseline, r.revision)
      .all();
    const revisions = (history.results as { payload: string }[]).map(
      (row) => JSON.parse(row.payload) as ReportRevision,
    );
    if (
      revisions.length !== r.revision - baseline ||
      revisions.some(
        (v) =>
          v.sourceHash !== r.sourceHash ||
          v.runId !== null ||
          v.reviewId !== null,
      )
    )
      throw Error(
        "Reports changed through extraction or another review. Run company review; local refresh only accepts manual edits after the last publication.",
      );
  }
  const at = new Date().toISOString();
  const changed: ReportRevision[] = [];
  for (const r of reports) {
    const normalized = normalizeReportAmounts(
      r.report,
      r.manualCorrections?.map((c) => c.path),
    );
    if (!normalized.adjustments.length) continue;
    const doc = await getDocument(r.documentId);
    const oldChecks = reportIssues(r.report, doc);
    const retained = r.issues.filter(
      (i) =>
        !oldChecks.some(
          (old) => old.path === i.path && old.reason === i.reason,
        ) &&
        i.code !== "printed_normalization" &&
        i.reason !== normalizationMessage,
    );
    r.report = normalized.report;
    r.normalizations = normalized.adjustments;
    r.issues = [
      ...reportIssues(r.report, doc),
      ...retained.map((i) => contextualizeFinding(r.report, i)),
    ];
    r.revision++;
    r.id = crypto.randomUUID();
    r.at = at;
    // Local revisions follow the same resumable, manual-only lineage rule.
    r.runId = null;
    r.reviewId = null;
    r.reason =
      "Locally normalized printed amounts and revalidated existing company source choices; no AI call.";
    changed.push(r);
  }
  const selections = structuredClone(base.selections);
  const job = ws.companyReviews.find((j) => j.id === base.reviewId);
  const saved = job?.consistency.runId
    ? await readRun(job.consistency.runId)
    : null;
  for (const selection of selections)
    for (const [metric, choice] of Object.entries(selection.choices)) {
      const path = publicationSlots[metric]?.path;
      if (!path) throw Error("Publication contains an unsupported metric.");
      let documentId = choice.source?.documentId;
      // A blocked explicit choice can be rechecked; a reviewer-chosen null stays null.
      if (
        !documentId &&
        choice.reason.startsWith("Blocked by source/context checks: ") &&
        saved?.kind === "company_review" &&
        saved.status === "completed" &&
        saved.contractVersion === CONTRACT_VERSION
      ) {
        const candidates = saved.result?.selections?.filter(
          (s: any) => s.quarter === selection.quarter,
        );
        const decision =
          candidates?.length === 1 ? candidates[0].choices?.[metric] : null;
        if (
          decision?.documentId &&
          saved.snapshots?.[decision.documentId]?.hash ===
            base.snapshots[decision.documentId]?.hash &&
          saved.snapshots[decision.documentId].revision + 1 ===
            base.snapshots[decision.documentId].revision
        )
          documentId = decision.documentId;
      }
      if (!documentId) continue;
      const r = reports.find((r) => r.documentId === documentId),
        doc = docs.find((d) => d.id === documentId);
      const value = r && getPath(r.report, path);
      const problems: string[] = [];
      if (
        !r ||
        !doc ||
        doc.quarter !== selection.quarter ||
        value?.type !== "Value" ||
        !Number.isFinite(value.value)
      )
        problems.push(
          "The previously selected current-quarter value is unavailable.",
        );
      if (r && blocksPath(r.issues, path))
        problems.push(
          ...r.issues.filter((i) => blocksPath([i], path)).map((i) => i.reason),
        );
      if (
        !problems.length &&
        doc &&
        value &&
        reports.some((other) => {
          const otherDoc = docs.find((d) => d.id === other.documentId),
            v = getPath(other.report, path);
          return (
            other.documentId !== documentId &&
            otherDoc?.quarter === selection.quarter &&
            otherDoc.publishedAt >= doc.publishedAt &&
            v?.type === "Value" &&
            !blocksPath(other.issues, path) &&
            Math.abs(v.value - value.value) >
              precision(v) + precision(value) + 1e-8
          );
        })
      )
        problems.push("Unresolved contradictory current-quarter sources.");
      choice.source = problems.length
        ? null
        : { documentId, revision: r!.revision, path };
      choice.reason = problems.length
        ? "Blocked by source/context checks: " + problems.join(" ")
        : "Existing explicit company source choice revalidated against current reports locally; no AI call.";
    }
  const publication: Publication = {
    ...base,
    id: crypto.randomUUID(),
    at,
    snapshots: companySnapshot(ws, companyId),
    selections,
    findings: reports.flatMap((r) =>
      r.issues.map((i) => ({ ...i, documentId: r.documentId })),
    ),
    summary:
      "Existing company source choices revalidated after local corrections. No model review or new source selection was performed.",
  };
  await commitState(
    ws,
    [
      ...changed.flatMap(revisionStatements),
      {
        sql: "INSERT INTO publications(id,company_id,at,payload) SELECT ?,?,?,? WHERE $GUARD",
        values: [publication.id, companyId, at, JSON.stringify(publication)],
      },
    ],
    publication.summary,
  );
  return {
    publication,
    normalizedValues: changed.reduce(
      (n, r) => n + (r.normalizations?.length || 0),
      0,
    ),
    paidCalls: 0,
  };
}
