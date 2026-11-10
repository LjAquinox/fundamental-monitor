import { refreshCompanyPublication } from "../../../lib/publication-refresh";
import { z } from "zod/v4";
import { json, errorResponse, writeGuard } from "../../../lib/server";
import {
  getCompanyReview,
  latestCompanyReview,
  startCompanyReview,
} from "../../../lib/company-review";
import { reconcileCompany } from "../../../lib/company-reconciliation";
import { recoverSavedReview } from "../../../lib/saved-review-recovery";
import { extractCompanyDocument } from "../../../lib/company-extraction";
const id = z.string().min(1);
const input = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("refresh_publication"), companyId: id })
    .strict(),
  z.object({ action: z.literal("apply_saved"), jobId: id }).strict(),
  z.object({ action: z.literal("recover"), jobId: id }).strict(),
  z
    .object({
      action: z.literal("start"),
      companyId: id,
      fresh: z.boolean().optional(),
      workflow: z.enum(["reconcile", "extract_reconcile"]).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("consistency"),
      jobId: id,
      retry: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("extract"),
      jobId: id,
      documentId: id,
      retry: z.boolean().optional(),
    })
    .strict(),
]);
export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams;
    return json(
      p.get("jobId")
        ? await getCompanyReview(p.get("jobId")!)
        : await latestCompanyReview(p.get("companyId") || ""),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    writeGuard(request);
    const b = input.parse(await request.json());
    if (b.action === "refresh_publication")
      return json(await refreshCompanyPublication(b.companyId));
    if (b.action === "apply_saved")
      return json(await reconcileCompany(b.jobId, request.url, true, true));
    if (b.action === "recover")
      return json(await recoverSavedReview(b.jobId, request.url));
    if (b.action === "start")
      return json(await startCompanyReview(b.companyId, b.fresh, b.workflow));
    if (b.action === "extract")
      return json(
        await extractCompanyDocument(
          b.jobId,
          b.documentId,
          request.url,
          b.retry,
        ),
      );
    return json(await reconcileCompany(b.jobId, request.url, b.retry));
  } catch (e) {
    return errorResponse(e);
  }
}
