import { CONTRACT_VERSION, publicationSlots, getPath } from "./report-contract";
import { blocksPath, precision, normalizationMessage } from "./report-checks";
import { publicationCurrent } from "./selections";
import type { Workspace } from "./types";

/** Recheck an explicit saved source choice after a parser fix, without replaying
 * financial corrections, choosing a replacement source or writing any history. */
export async function refreshParserBlockedSelections(
  ws: Workspace,
  loadRun: (id: string) => Promise<any>,
) {
  for (const pub of ws.publications) {
    if (!publicationCurrent(ws, pub)) continue;
    const candidates = pub.selections.flatMap((s) =>
      Object.entries(s.choices)
        .filter(
          ([, c]) =>
            !c.source &&
            c.reason.startsWith("Blocked by source/context checks: ") &&
            c.reason.includes(normalizationMessage),
        )
        .map(([metric, choice]) => ({ selection: s, metric, choice })),
    );
    if (!candidates.length) continue;
    const job = ws.companyReviews.find(
      (j) =>
        j.id === pub.reviewId &&
        j.companyId === pub.companyId &&
        j.consistency.status === "completed",
    );
    if (!job?.consistency.runId) continue;
    let saved: any;
    try {
      saved = await loadRun(job.consistency.runId);
    } catch {
      continue;
    }
    const ids = Object.keys(pub.snapshots),
      reviewed = saved?.result?.reviewedDocumentIds;
    if (
      saved?.kind !== "company_review" ||
      saved.status !== "completed" ||
      saved.contractVersion !== CONTRACT_VERSION ||
      !Array.isArray(reviewed) ||
      reviewed.length !== ids.length ||
      new Set(reviewed).size !== ids.length ||
      ids.some(
        (id) =>
          !reviewed.includes(id) ||
          saved.snapshots?.[id]?.hash !== pub.snapshots[id].hash ||
          saved.snapshots?.[id]?.revision + 1 !== pub.snapshots[id].revision,
      )
    )
      continue;
    if (!Array.isArray(saved.result.selections)) continue;
    for (const { selection, metric, choice } of candidates) {
      const path = publicationSlots[metric]?.path;
      if (!path) continue;
      const matching = saved.result.selections.filter(
        (s: any) => s.quarter === selection.quarter,
      );
      const decision =
        matching.length === 1 ? matching[0].choices?.[metric] : null;
      // A reviewer-chosen null is never turned into a source automatically.
      if (!decision?.documentId || typeof decision.reason !== "string")
        continue;
      const doc = ws.documents.find(
        (d) =>
          d.id === decision.documentId &&
          d.companyId === pub.companyId &&
          d.quarter === selection.quarter,
      );
      const revision = ws.reports.find(
        (r) =>
          r.documentId === decision.documentId && r.reviewId === pub.reviewId,
      );
      if (
        !doc ||
        !revision ||
        revision.revision !== pub.snapshots[doc.id]?.revision ||
        revision.sourceHash !== doc.sha256
      )
        continue;
      const value = getPath(revision.report, path);
      if (value?.type !== "Value" || !Number.isFinite(value.value)) continue;
      if (blocksPath(revision.issues, path)) {
        choice.reason =
          "Blocked by source/context checks: " +
          revision.issues
            .filter((i) => blocksPath([i], path))
            .map((i) => i.reason)
            .join(" ");
        continue;
      }
      const conflict = ws.reports
        .filter((r) => r.companyId === pub.companyId && r.documentId !== doc.id)
        .some((other) => {
          const d = ws.documents.find((d) => d.id === other.documentId),
            v = getPath(other.report, path);
          return (
            d?.quarter === selection.quarter &&
            d.publishedAt >= doc.publishedAt &&
            v &&
            !blocksPath(other.issues, path) &&
            Math.abs(v.value - value.value) >
              precision(v) + precision(value) + 1e-8
          );
        });
      if (conflict) {
        choice.reason =
          "Unresolved contradictory current-quarter sources. Correct or explicitly resolve the underlying reports before publication.";
        continue;
      }
      choice.source = { documentId: doc.id, revision: revision.revision, path };
      choice.reason =
        decision.reason +
        " (Saved source choice rechecked locally after the parser update.)";
    }
  }
}
