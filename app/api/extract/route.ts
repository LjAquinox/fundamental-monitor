import { z } from "zod/v4";
import {
  runtime,
  getDocument,
  getPdfBytes,
  base64Pdf,
  readWorkspace,
  json,
  errorResponse,
  writeGuard,
} from "../../../lib/server";
import {
  CONTRACT_VERSION,
  reportSchema,
  extractionInstructions,
} from "../../../lib/report-contract";
import {
  reportIssues,
  normalizeReportAmounts,
} from "../../../lib/report-checks";
import { ResponsesProvider, providerConfig } from "../../../lib/provider";
import { reserveRun, finishRun } from "../../../lib/model-workflow";
export async function POST(request: Request) {
  let runId: string | undefined;
  let context:
    | { documentId: string; sourceHash: string; baselineRevision: number }
    | undefined;
  try {
    writeGuard(request);
    const { documentId } = z
      .object({ documentId: z.string().min(1) })
      .strict()
      .parse(await request.json());
    const ws = await readWorkspace(),
      doc = await getDocument(documentId),
      config = providerConfig(runtime()),
      bytes = await getPdfBytes(doc, request.url);
    const baselineRevision =
      ws.reports.find((r) => r.documentId === documentId)?.revision || 0;
    context = { documentId, sourceHash: doc.sha256, baselineRevision };
    runId = await reserveRun("extraction");
    const result = await new ResponsesProvider(config).generate({
      system: extractionInstructions,
      input: JSON.stringify({
        subject: ws.companies.find((c) => c.id === doc.companyId)?.name,
        reportingPeriod: {
          label: doc.quarter,
          start: doc.periodStart,
          end: doc.periodEnd,
        },
        publishedAt: doc.publishedAt,
        totalPages: doc.pages.length,
      }),
      pdf: { filename: "source.pdf", base64: base64Pdf(bytes) },
      name: "financial_report_v3",
      schema: reportSchema,
      maxOutputTokens: 64000,
      timeoutMs: 900000,
    });
    const normalized = normalizeReportAmounts(result.data);
    const payload = {
      kind: "extraction",
      status: "completed",
      contractVersion: CONTRACT_VERSION,
      documentId,
      sourceHash: doc.sha256,
      baselineRevision,
      model: config.model,
      provider: config.provider,
      report: normalized.report,
      normalizations: normalized.adjustments,
      rawOutput: result.rawOutput,
      usage: result.usage,
      issues: reportIssues(normalized.report, doc),
    };
    await finishRun(runId, payload);
    return json({ extractionId: runId, ...payload });
  } catch (error) {
    if (runId)
      await finishRun(runId, {
        ...context,
        kind: "extraction",
        status: "failed",
        contractVersion: CONTRACT_VERSION,
        error: (error as Error).message,
      }).catch(() => {});
    return errorResponse(error);
  }
}
