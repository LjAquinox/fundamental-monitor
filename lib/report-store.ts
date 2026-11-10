import { runtime, readWorkspace, getDocument } from "./server";
import { CONTRACT_VERSION, reportSchema } from "./report-contract";
import {
  recordManualCorrections,
  overlappingPaths,
  contextualizeFinding,
} from "./review-state";
import { reportIssues, normalizeReportAmounts } from "./report-checks";
import type { ReportRevision, Workspace } from "./types";
export async function readRun(id?: string): Promise<any> {
  if (!id) return null;
  const row = await runtime()
    .DB.prepare("SELECT payload FROM runs WHERE id=?")
    .bind(id)
    .first<{ payload: string }>();
  return row ? JSON.parse(row.payload) : null;
}
export async function commitState(
  ws: Workspace,
  statements: { sql: string; values: unknown[] }[],
  reason: string,
) {
  const DB = runtime().DB,
    token = crypto.randomUUID();
  const guard = " EXISTS (SELECT 1 FROM state_revision WHERE id=1 AND token=?)";
  const results = await DB.batch([
    DB.prepare(
      "UPDATE state_revision SET token=? WHERE id=1 AND token=? RETURNING id",
    ).bind(token, ws.token),
    ...statements.map((s) =>
      DB.prepare(s.sql.replaceAll("$GUARD", guard)).bind(...s.values, token),
    ),
    DB.prepare(
      "INSERT INTO audit(id,at,payload) SELECT ?,?,? WHERE" + guard,
    ).bind(
      crypto.randomUUID(),
      new Date().toISOString(),
      JSON.stringify({ reason, contractVersion: CONTRACT_VERSION }),
      token,
    ),
  ]);
  if (!results[0].results?.length)
    throw new Error(
      "Edit conflict: data changed during this operation. Reload and apply the saved result again; no model retry is needed.",
    );
}
export function revisionStatements(r: ReportRevision) {
  return [
    {
      sql: "INSERT INTO reports(id,document_id,revision,payload) SELECT ?,?,?,? WHERE $GUARD",
      values: [r.id, r.documentId, r.revision, JSON.stringify(r)],
    },
    {
      sql: "INSERT INTO report_heads(document_id,revision) SELECT ?,? WHERE $GUARD ON CONFLICT(document_id) DO UPDATE SET revision=excluded.revision",
      values: [r.documentId, r.revision],
    },
  ];
}
export async function acceptExtraction(extractionId: string) {
  const run = await readRun(extractionId);
  if (
    !run ||
    run.kind !== "extraction" ||
    run.status !== "completed" ||
    run.contractVersion !== CONTRACT_VERSION
  )
    throw new Error("Completed typed extraction not found.");
  const ws = await readWorkspace(),
    old = ws.reports.find((r) => r.documentId === run.documentId),
    doc = await getDocument(run.documentId);
  if (old?.runId === extractionId)
    return {
      revision: old,
      accepted: countValues(old.report),
      needsReview: old.issues.filter((i) => i.effect === "block").length,
      conflicts: 0,
    };
  if (
    doc.sha256 !== run.sourceHash ||
    (old?.revision || 0) !== run.baselineRevision
  )
    throw new Error(
      "Source/revision conflict: a newer report revision exists. This saved extraction cannot replace it.",
    );
  const normalized = normalizeReportAmounts(reportSchema.parse(run.report)),
    report = normalized.report,
    revision: ReportRevision = {
      contractVersion: CONTRACT_VERSION,
      id: crypto.randomUUID(),
      documentId: doc.id,
      companyId: doc.companyId,
      revision: (old?.revision || 0) + 1,
      sourceHash: doc.sha256,
      runId: extractionId,
      reviewId: null,
      at: new Date().toISOString(),
      reason: "Accepted whole-PDF extraction; pending company review.",
      normalizations: [
        ...(run.normalizations || []),
        ...normalized.adjustments,
      ],
      manualCorrections: [],
      report,
      issues: reportIssues(report, doc),
    };
  await commitState(ws, revisionStatements(revision), revision.reason);
  return {
    revision,
    accepted: countValues(report),
    needsReview: revision.issues.filter((i) => i.effect === "block").length,
    conflicts: 0,
  };
}
export function countValues(value: any): number {
  if (!value || typeof value !== "object") return 0;
  if (value.type === "Value" || value.type === "Statement") return 1;
  return Object.values(value).reduce<number>(
    (sum, v) => sum + countValues(v),
    0,
  );
}
export async function editReport(
  documentId: string,
  expectedRevision: number,
  input: unknown,
  reason: string,
) {
  const report = reportSchema.parse(input),
    ws = await readWorkspace(),
    doc = await getDocument(documentId),
    old = ws.reports.find((r) => r.documentId === documentId);
  if ((old?.revision || 0) !== expectedRevision)
    throw new Error("Revision conflict: reload before editing.");
  const at = new Date().toISOString();
  const edits = old
    ? recordManualCorrections(old.report, report, [], at, reason)
    : [];
  const oldChecks = old ? reportIssues(old.report, doc) : [];
  const retained = (old?.issues || []).filter(
    (i) =>
      !oldChecks.some(
        (check) => check.path === i.path && check.reason === i.reason,
      ) &&
      i.code !== "printed_normalization" &&
      !edits.some((e) => overlappingPaths(e.path, i.path)),
  );
  const revision: ReportRevision = {
    contractVersion: CONTRACT_VERSION,
    id: crypto.randomUUID(),
    documentId,
    companyId: doc.companyId,
    revision: expectedRevision + 1,
    sourceHash: doc.sha256,
    runId: null,
    reviewId: null,
    at: new Date().toISOString(),
    reason,
    manualCorrections: old
      ? recordManualCorrections(
          old.report,
          report,
          old.manualCorrections || [],
          new Date().toISOString(),
          reason,
        )
      : [],
    report,
    issues: [
      ...reportIssues(report, doc),
      ...retained.map((i) => contextualizeFinding(report, i)),
    ],
  };
  await commitState(ws, revisionStatements(revision), reason);
  return revision;
}
