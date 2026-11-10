import { runtime, readWorkspace } from "./server";
import { providerConfig } from "./provider";
import { CONTRACT_VERSION } from "./report-contract";
import { companySnapshot, activePublication } from "./selections";
import type { CompanyReview } from "./types";
export { readRun } from "./report-store";
export async function getCompanyReview(id: string): Promise<CompanyReview> {
  const row = await runtime()
    .DB.prepare("SELECT payload FROM company_reviews WHERE id=?")
    .bind(id)
    .first<{ payload: string }>();
  if (!row) throw new Error("Company review not found.");
  return JSON.parse(row.payload);
}
export async function latestCompanyReview(companyId: string) {
  const row = await runtime()
    .DB.prepare(
      "SELECT payload FROM company_reviews WHERE company_id=? ORDER BY at DESC LIMIT 1",
    )
    .bind(companyId)
    .first<{ payload: string }>();
  return row ? (JSON.parse(row.payload) as CompanyReview) : null;
}
export async function patchDocument(
  jobId: string,
  documentId: string,
  entry: CompanyReview["documents"][string],
  attempt: string,
) {
  const path = `$.documents.${JSON.stringify(documentId)}`;
  const result = await runtime()
    .DB.prepare(
      "UPDATE company_reviews SET payload=json_set(payload,?,json(?),'$.updatedAt',?) WHERE id=? AND json_extract(payload,?)=? RETURNING id",
    )
    .bind(
      path,
      JSON.stringify(entry),
      new Date().toISOString(),
      jobId,
      path + ".attempt",
      attempt,
    )
    .all();
  if (!result.results?.length)
    throw new Error("Extraction attempt conflict: job changed.");
}
export async function startCompanyReview(
  companyId: string,
  fresh = false,
  workflow: CompanyReview["workflow"] = "reconcile",
) {
  const ws = await readWorkspace(),
    existing = await latestCompanyReview(companyId),
    docs = ws.documents.filter((d) => d.companyId === companyId);
  if (!docs.length)
    throw new Error("Import at least one company report before review.");
  const snapshots = companySnapshot(ws, companyId),
    sameDocs =
      existing &&
      Object.keys(existing.documents).sort().join() ===
        docs
          .map((d) => d.id)
          .sort()
          .join() &&
      docs.every((d) => existing.documents[d.id].sourceHash === d.sha256);
  if (
    existing &&
    !fresh &&
    sameDocs &&
    existing.workflow === workflow &&
    (existing.status !== "completed" || activePublication(ws, companyId))
  )
    return existing;
  if (
    existing &&
    (existing.consistency.status === "running" ||
      Object.values(existing.documents).some((d) => d.status === "running"))
  )
    throw new Error(
      "A company workflow is already running. Resume it instead of starting duplicate paid calls.",
    );
  const config = providerConfig(
      runtime(),
      runtime().LLM_REVIEW_MODEL || undefined,
    ),
    at = new Date(
      Math.max(Date.now(), existing ? Date.parse(existing.at) + 1 : 0),
    ).toISOString();
  const job: CompanyReview = {
    id: crypto.randomUUID(),
    companyId,
    at,
    updatedAt: at,
    model: config.model,
    workflow,
    status: "running",
    contractVersion: CONTRACT_VERSION,
    reasoningEffort: runtime().LLM_REVIEW_REASONING_EFFORT || "high",
    documents: Object.fromEntries(
      docs.map((d) => [
        d.id,
        {
          status: workflow === "reconcile" ? "completed" : "pending",
          sourceHash: d.sha256,
        },
      ]),
    ),
    consistency: { status: "pending" },
    baseline: snapshots,
  };
  const result = await runtime()
    .DB.prepare(
      "INSERT INTO company_reviews(id,company_id,at,payload) SELECT ?,?,?,? WHERE COALESCE((SELECT id FROM company_reviews WHERE company_id=? ORDER BY at DESC LIMIT 1),'')=? RETURNING id",
    )
    .bind(
      job.id,
      companyId,
      at,
      JSON.stringify(job),
      companyId,
      existing?.id || "",
    )
    .all();
  return result.results?.length ? job : (await latestCompanyReview(companyId))!;
}
