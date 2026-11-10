import { contextualizeFinding, recordManualCorrections } from "./review-state";
import { refreshParserBlockedSelections } from "./parser-check-refresh";
import { getRuntime } from "../local/runtime";
import seed from "../data/seed.json";
import type {
  Workspace,
  Document,
  Company,
  ReportRevision,
  Publication,
  Forecast,
  CompanyReview,
} from "./types";
import { CONTRACT_VERSION, getPath as getReportPath } from "./report-contract";
import { companyFingerprint } from "./selections";

import { refreshNormalizationFindings } from "./report-checks";
export const runtime = getRuntime;
const seedData = seed as unknown as {
  companies: Company[];
  documents: Document[];
};
export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export function writeGuard(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw new Error("Cross-origin writes are not allowed.");
}
export async function readWorkspace(): Promise<Workspace> {
  const { DB } = runtime();
  const results = await DB.batch([
    DB.prepare("SELECT token FROM state_revision WHERE id=1"),
    DB.prepare("SELECT payload FROM documents"),
    DB.prepare("SELECT payload FROM companies"),
    DB.prepare(
      "SELECT r.payload FROM reports r JOIN report_heads h ON r.document_id=h.document_id AND r.revision=h.revision",
    ),
    DB.prepare("SELECT payload FROM publications ORDER BY at DESC, rowid DESC"),
    DB.prepare("SELECT payload FROM forecasts"),
    DB.prepare("SELECT payload FROM company_reviews ORDER BY at DESC"),
    DB.prepare("SELECT id,at,payload FROM audit ORDER BY at DESC LIMIT 300"),
    // Recover manual provenance from existing append-only history. Never replay
    // old values: these annotations protect the current report during review.
    DB.prepare(`SELECT m.document_id, m.payload, p.payload AS previous
      FROM reports m JOIN report_heads h ON h.document_id=m.document_id
      JOIN reports p ON p.document_id=m.document_id AND p.revision=m.revision-1
      WHERE m.revision<=h.revision
        AND json_extract(m.payload,'$.runId') IS NULL
        AND json_extract(m.payload,'$.reviewId') IS NULL
        AND NOT EXISTS (SELECT 1 FROM reports n WHERE n.document_id=m.document_id
          AND n.revision>m.revision AND n.revision<=h.revision
          AND json_extract(n.payload,'$.reviewId') IS NULL
          AND json_extract(n.payload,'$.runId') IS NOT NULL)
      ORDER BY m.document_id,m.revision`),
  ]);
  const rows = <T>(i: number): T[] =>
    ((results[i].results as { payload: string }[]) || []).map((r) =>
      JSON.parse(r.payload),
    );
  const merge = <T extends { id: string }>(a: T[], b: T[]) =>
    Array.from(new Map([...a, ...b].map((v) => [v.id, v])).values());
  const documents = merge(
    seedData.documents.map(({ pages, ...d }) => d),
    rows<Omit<Document, "pages">>(1),
  ).filter((d) => !d.deleted);
  const ws: Workspace = {
    contractVersion: CONTRACT_VERSION,
    token: (results[0].results![0] as any).token,
    companies: merge(seedData.companies, rows<Company>(2)),
    documents,
    reports: rows<ReportRevision>(3)
      .filter((r) => documents.some((d) => d.id === r.documentId))
      .map((r) => ({
        ...r,
        issues: refreshNormalizationFindings(r.report, r.issues).map((i) =>
          contextualizeFinding(r.report, i),
        ),
      })),
    publications: rows<Publication>(4),
    forecasts: rows<Forecast>(5),
    companyReviews: rows<CompanyReview>(6),
    audit: results[7].results as Workspace["audit"],
  };
  for (const r of ws.reports) {
    if (r.manualCorrections !== undefined) continue;
    let corrections: NonNullable<ReportRevision["manualCorrections"]> = [];
    for (const row of results[8].results as {
      document_id: string;
      payload: string;
      previous: string;
    }[]) {
      if (row.document_id !== r.documentId) continue;
      const manual: ReportRevision = JSON.parse(row.payload),
        before: ReportRevision = JSON.parse(row.previous);
      if (
        manual.sourceHash !== r.sourceHash ||
        before.sourceHash !== r.sourceHash
      )
        continue;
      corrections = recordManualCorrections(
        before.report,
        manual.report,
        corrections,
        manual.at,
        manual.reason,
      );
    }
    // Retain only pins that still agree with current data. Older model changes
    // are history, not an instruction to restore a value without user review.
    r.manualCorrections = corrections.filter(
      (c) =>
        JSON.stringify(c.value) ===
        JSON.stringify(getReportPath(r.report, c.path)),
    );
  }
  await refreshParserBlockedSelections(ws, async (id: string) => {
    const row = await DB.prepare("SELECT payload FROM runs WHERE id=?")
      .bind(id)
      .first<{ payload: string }>();
    return row ? JSON.parse(row.payload) : null;
  });
  ws.forecasts = ws.forecasts.map((f) => ({
    ...f,
    stale: f.stateFingerprint !== companyFingerprint(ws, f.companyId),
  }));
  return ws;
}
export async function getDocument(id: string): Promise<Document> {
  const { DB, BUCKET } = runtime();
  const row = await DB.prepare("SELECT payload FROM documents WHERE id=?")
    .bind(id)
    .first<{ payload: string }>();
  if (row) {
    const doc = JSON.parse(row.payload);
    if (doc.deleted) throw new Error("Document not found.");
    const pages = await BUCKET.get(`pages/${id}.json`);
    return { ...doc, pages: pages ? await pages.json() : [] };
  }
  const doc = seedData.documents.find((d) => d.id === id);
  if (!doc) throw new Error("Document not found.");
  return doc;
}
export async function getPdfBytes(
  doc: Document,
  requestUrl: string,
): Promise<Uint8Array> {
  const { BUCKET, PDF_ASSETS, ASSETS } = runtime();
  const uploaded = await BUCKET.get(`pdfs/${doc.id}.pdf`);
  let bytes: Uint8Array;
  if (uploaded) bytes = new Uint8Array(await uploaded.arrayBuffer());
  else if (PDF_ASSETS) bytes = await PDF_ASSETS.read(doc.pdfUrl);
  else {
    if (!/^\/pdfs\/[a-zA-Z0-9_.-]+\.pdf$/.test(doc.pdfUrl))
      throw new Error("Invalid bundled PDF path.");
    const req = new Request(new URL(doc.pdfUrl, requestUrl));
    const response = ASSETS ? await ASSETS.fetch(req) : await fetch(req);
    if (!response.ok) throw new Error("Original PDF not found.");
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (
    bytes.length >= 50000000 ||
    new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-"
  )
    throw new Error("PDF input must be a valid PDF smaller than 50 MB.");
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== doc.sha256)
    throw new Error(
      "Original PDF checksum mismatch. Re-import the document before extraction.",
    );
  return bytes;
}
export function base64Pdf(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
export function errorResponse(error: unknown) {
  const msg = error instanceof Error ? error.message : "Request failed";
  return json(
    { error: msg },
    /not found/i.test(msg)
      ? 404
      : /not configured|provider must have a configured|credential/i.test(msg)
        ? 503
        : /conflict/i.test(msg)
          ? 409
          : 400,
  );
}
