import { z } from "zod/v4";
import {
  runtime,
  getDocument,
  readWorkspace,
  json,
  errorResponse,
  writeGuard,
} from "../../../lib/server";
import { isReportingDate } from "../../../lib/reporting-dates";
import { commitState } from "../../../lib/report-store";
export async function GET(request: Request) {
  try {
    const u = new URL(request.url),
      id = u.searchParams.get("id") || "";
    if (u.searchParams.get("format") === "pdf") {
      await getDocument(id);
      const obj = await runtime().BUCKET.get(`pdfs/${id}.pdf`);
      if (!obj) return json({ error: "Uploaded PDF not found." }, 404);
      return new Response(obj.body, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'inline; filename="source.pdf"',
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return json(await getDocument(id));
  } catch (e) {
    return errorResponse(e);
  }
}
const metaSchema = z
  .object({
    companyId: z.string().max(100),
    companyName: z.string().min(1).max(120),
    ticker: z.string().min(1).max(15),
    title: z.string().min(1).max(200),
    kind: z.enum([
      "filing",
      "earnings_release",
      "transcript",
      "credit_report",
      "internal_note",
    ]),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    quarter: z.string().regex(/^\d{4}-Q[1-4]$/),
    url: z.string().max(2000),
    aliases: z.array(z.string().max(100)).max(100),
    pages: z
      .array(
        z.object({
          page: z.number().int().positive(),
          text: z.string().max(60000),
        }),
      )
      .min(1)
      .max(1000),
  })
  .strict();
export async function POST(request: Request) {
  try {
    writeGuard(request);
    const form = await request.formData(),
      file = form.get("file");
    if (!(file instanceof File) || file.size >= 50000000)
      throw new Error("Choose a PDF smaller than 50 MB.");
    const bytes = await file.arrayBuffer();
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
      throw new Error("This file is not a valid PDF.");
    const meta = metaSchema.parse(JSON.parse(String(form.get("metadata"))));
    if (
      ![meta.periodStart, meta.periodEnd, meta.publishedAt].every(
        isReportingDate,
      )
    )
      throw new Error(
        "Reporting and publication dates must be real calendar dates.",
      );
    if (meta.periodStart > meta.periodEnd || meta.periodEnd > meta.publishedAt)
      throw new Error("Check reporting-period and publication dates.");
    if (meta.pages.some((p, i) => p.page !== i + 1))
      throw new Error("PDF pages must be consecutive and start at 1.");
    const ws = await readWorkspace();
    const matchingCompany = ws.companies.find(
      (c) =>
        c.ticker.toLowerCase() === meta.ticker.toLowerCase() ||
        c.name.toLowerCase() === meta.companyName.toLowerCase(),
    );
    const companyId =
      meta.companyId || matchingCompany?.id || `company_${crypto.randomUUID()}`;
    if (meta.companyId && !ws.companies.some((c) => c.id === meta.companyId))
      throw new Error("Company not found.");
    const { BUCKET } = runtime();
    const sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    if (
      ws.documents.some((d) => d.sha256 === sha256 && d.companyId === companyId)
    )
      throw new Error("This PDF is already in the company library.");
    const id = `doc_${crypto.randomUUID()}`,
      { pages, companyName, ticker, aliases, ...rest } = meta;
    const doc = {
      ...rest,
      companyId,
      id,
      pdfUrl: `/api/documents?id=${id}&format=pdf`,
      sha256,
    };
    await BUCKET.put(`pdfs/${id}.pdf`, bytes, {
      httpMetadata: { contentType: "application/pdf" },
    });
    await BUCKET.put(`pages/${id}.json`, JSON.stringify(pages), {
      httpMetadata: { contentType: "application/json" },
    });
    const existing = ws.companies.find((c) => c.id === companyId);
    const company = existing
      ? {
          ...existing,
          aliases: [...new Set([...existing.aliases, ...aliases])],
        }
      : {
          id: companyId,
          name: companyName,
          ticker,
          color: "#779797",
          sector: "Unspecified",
          aliases: [companyName, ticker, ...aliases],
        };
    await commitState(
      ws,
      [
        {
          sql: "INSERT INTO documents(id,payload) SELECT ?,? WHERE $GUARD",
          values: [id, JSON.stringify(doc)],
        },
        {
          sql: "INSERT INTO companies(id,payload) SELECT ?,? WHERE $GUARD ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
          values: [companyId, JSON.stringify(company)],
        },
      ],
      "Imported original company PDF and fiscal metadata.",
    );
    return json({ document: doc }, 201);
  } catch (e) {
    return errorResponse(e);
  }
}
export async function DELETE(request: Request) {
  try {
    writeGuard(request);
    const { id } = z
      .object({ id: z.string().min(1).max(180) })
      .strict()
      .parse(await request.json());
    const doc = await getDocument(id);
    const ws = await readWorkspace();
    const { pages, ...metadata } = doc;
    await commitState(
      ws,
      [
        {
          sql: "INSERT INTO documents(id,payload) SELECT ?,? WHERE $GUARD ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
          values: [id, JSON.stringify({ ...metadata, deleted: true })],
        },
      ],
      "Removed source report from active research; preserved source and report history.",
    );
    return json({
      removed: true,
      notice:
        "Report and its typed revisions removed from active research. Stored source files and audit history are retained.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
