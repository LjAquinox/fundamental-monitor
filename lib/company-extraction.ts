import { runtime, getDocument } from "./server";
import { getCompanyReview, patchDocument } from "./company-review";
import { POST as extract } from "../app/api/extract/route";
import { POST as accept } from "../app/api/extractions/route";
let acceptanceQueue: Promise<unknown> = Promise.resolve();
async function invoke(
  handler: (r: Request) => Promise<Response>,
  url: string,
  body: unknown,
) {
  const response = await handler(
    new Request(url, {
      method: "POST",
      headers: {
        Origin: new URL(url).origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  const data: any = await response.json();
  if (!response.ok) throw new Error(data.error || "Company extraction failed.");
  return data;
}
export async function extractCompanyDocument(
  jobId: string,
  documentId: string,
  requestUrl: string,
  retry = false,
) {
  const job = await getCompanyReview(jobId),
    old = job.documents[documentId];
  if (job.workflow !== "extract_reconcile" || !old)
    throw new Error("Document not found in this extraction workflow.");
  if (old.status === "completed") return old;
  if (
    old.status === "running" &&
    (!retry || Date.now() - Date.parse(old.startedAt || job.at) < 1200000)
  )
    throw new Error(
      "This PDF extraction is already running. No duplicate paid request was made.",
    );
  if (old.status === "failed" && !retry)
    throw new Error(
      "Retry the failed PDF extraction explicitly after checking provider usage.",
    );
  const doc = await getDocument(documentId);
  if (doc.companyId !== job.companyId || old.sourceHash !== doc.sha256)
    throw new Error(
      "Source conflict: company PDF changed. Start a new workflow.",
    );
  const attempt = crypto.randomUUID(),
    path = `$.documents.${JSON.stringify(documentId)}`,
    startedAt = new Date().toISOString();
  let entry = {
    ...old,
    status: "running" as const,
    attempt,
    startedAt,
    error: undefined,
  };
  const claim = await runtime()
    .DB.prepare(
      "UPDATE company_reviews SET payload=json_set(payload,?,json(?),'$.updatedAt',?) WHERE id=? AND json_extract(payload,?)=? AND COALESCE(json_extract(payload,?),'')=? RETURNING id",
    )
    .bind(
      path,
      JSON.stringify(entry),
      startedAt,
      jobId,
      path + ".status",
      old.status,
      path + ".attempt",
      old.attempt || "",
    )
    .all();
  if (!claim.results?.length)
    throw new Error("Another request claimed this PDF extraction.");
  try {
    if (!entry.extractionId) {
      const output = await invoke(
        extract,
        new URL("/api/extract", requestUrl).href,
        { documentId },
      );
      entry = {
        ...entry,
        extractionId: output.extractionId,
        usage: output.usage,
      };
      await patchDocument(jobId, documentId, entry, attempt);
    }
    const result = acceptanceQueue.then(async () => {
      for (let i = 0; i < 8; i++)
        try {
          return await invoke(
            accept,
            new URL("/api/extractions", requestUrl).href,
            { action: "replace", extractionId: entry.extractionId },
          );
        } catch (error) {
          if (
            !/data changed during (?:reconciliation|this operation)/i.test(
              (error as Error).message,
            ) ||
            i === 7
          )
            throw error;
        }
    });
    acceptanceQueue = result.then(
      () => {},
      () => {},
    );
    const output = await result;
    const completed = {
      ...entry,
      status: "completed" as const,
      extractionSummary: {
        accepted: output.accepted,
        needsReview: output.needsReview,
        conflicts: output.conflicts,
      },
    };
    await patchDocument(jobId, documentId, completed, attempt);
    return completed;
  } catch (error) {
    await patchDocument(
      jobId,
      documentId,
      { ...entry, status: "failed", error: (error as Error).message },
      attempt,
    );
    throw error;
  }
}
