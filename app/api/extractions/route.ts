import { z } from "zod/v4";
import { runtime, json, errorResponse, writeGuard } from "../../../lib/server";
import { acceptExtraction } from "../../../lib/report-store";
export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("documentId");
    const rows = await runtime()
      .DB.prepare(
        "SELECT id,at,payload FROM runs WHERE json_extract(payload,'$.kind')='extraction' AND json_extract(payload,'$.documentId')=? ORDER BY at DESC",
      )
      .bind(id)
      .all();
    return json(
      (rows.results as any[]).map((r) => ({
        id: r.id,
        at: r.at,
        ...JSON.parse(r.payload),
      })),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    writeGuard(request);
    const body = z
      .object({ action: z.literal("replace"), extractionId: z.string().min(1) })
      .strict()
      .parse(await request.json());
    return json(await acceptExtraction(body.extractionId));
  } catch (e) {
    return errorResponse(e);
  }
}
