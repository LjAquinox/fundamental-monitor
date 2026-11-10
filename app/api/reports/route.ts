import { z } from "zod/v4";
import { runtime, json, errorResponse, writeGuard } from "../../../lib/server";
import { reportSchema } from "../../../lib/report-contract";
import { editReport } from "../../../lib/report-store";
export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("documentId");
    const r = await runtime()
      .DB.prepare(
        "SELECT payload FROM reports WHERE document_id=? ORDER BY revision DESC",
      )
      .bind(id)
      .all();
    return json((r.results as any[]).map((v) => JSON.parse(v.payload)));
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    writeGuard(request);
    const b = z
      .object({
        documentId: z.string().min(1),
        expectedRevision: z.number().int().min(0),
        report: reportSchema,
        reason: z.string().min(3).max(2000),
      })
      .strict()
      .parse(await request.json());
    return json(
      await editReport(b.documentId, b.expectedRevision, b.report, b.reason),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
