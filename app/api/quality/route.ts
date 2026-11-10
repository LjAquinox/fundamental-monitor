import { readWorkspace, json, errorResponse } from "../../../lib/server";
export async function GET() {
  try {
    const ws = await readWorkspace();
    return json({
      findings: ws.reports.flatMap((r) =>
        r.issues.map((i) => ({
          ...i,
          documentId: r.documentId,
          revision: r.revision,
        })),
      ),
      reviews: ws.companyReviews,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
