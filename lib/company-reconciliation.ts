import { resolveFindingReference } from "./finding-reference";
import { modelJsonSchema } from "./structured-output";
import { companyResponseContract } from "./company-response-contract";
import {
  runtime,
  readWorkspace,
  getDocument,
  getPdfBytes,
  base64Pdf,
} from "./server";
import { getCompanyReview } from "./company-review";
import { readRun, commitState, revisionStatements } from "./report-store";
import { reserveRun, finishRun } from "./model-workflow";
import { ResponsesProvider, providerConfig } from "./provider";
import {
  CONTRACT_VERSION,
  reconciliationSchema,
  reportSchema,
  extractionInstructions,
  publicationSlots,
  publicationMetrics,
  setPath,
  getPath,
  normalizeReportPath,
} from "./report-contract";
import {
  contextualizeFinding,
  overlappingPaths,
  sameValue,
} from "./review-state";
import {
  reportIssues,
  blocksPath,
  precision,
  normalizeReportAmounts,
} from "./report-checks";
import { companySnapshot } from "./selections";
import type {
  CompanyReview,
  Publication,
  ReportRevision,
  Finding,
} from "./types";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export async function applyCompanyResult(job: CompanyReview, saved: any) {
  const ws = await readWorkspace();
  if (ws.publications.some((p) => p.reviewId === job.id)) return;
  if (
    saved.contractVersion !== CONTRACT_VERSION ||
    !same(companySnapshot(ws, job.companyId), saved.snapshots)
  )
    throw new Error(
      "Source/revision conflict: saved review no longer matches current company reports. Start a fresh review.",
    );
  const result = reconciliationSchema.parse(saved.result),
    docs = ws.documents.filter((d) => d.companyId === job.companyId),
    ids = docs.map((d) => d.id);
  if (
    new Set(result.reviewedDocumentIds).size !== ids.length ||
    result.reviewedDocumentIds.length !== ids.length ||
    ids.some((id) => !result.reviewedDocumentIds.includes(id))
  )
    throw new Error(
      "Review must cover every supplied company PDF exactly once.",
    );
  const reports = new Map<string, ReportRevision>(
    ws.reports
      .filter((r) => r.companyId === job.companyId)
      .map((r) => [r.documentId, structuredClone(r)]),
  );
  if (reports.size !== docs.length)
    throw new Error(
      "Every company PDF needs an accepted extraction before reconciliation.",
    );
  const changed = new Set<string>();
  const protectedFindings: Finding[] = [];
  const corrections = result.corrections as {
    documentId: string;
    reason: string;
    path: string;
    value: unknown;
    index?: number | null;
  }[];
  // Replace/remove original array indexes from highest to lowest; append after.
  const appliedCorrections: typeof corrections = [];
  const groups = new Map<string, typeof corrections>();
  for (const correction of corrections) {
    const key = `${correction.documentId}:${correction.path}`;
    groups.set(key, [...(groups.get(key) || []), correction]);
  }
  const ordered = [...groups.values()].flatMap((group) =>
    group.sort((a, b) => {
      if (a.index === null) return b.index === null ? 0 : 1;
      if (b.index === null) return -1;
      return (b.index ?? 0) - (a.index ?? 0);
    }),
  );
  for (const correction of ordered) {
    const r = reports.get(correction.documentId);
    if (!r) throw new Error("Review references an unknown report.");
    const key = `${r.documentId}:${correction.path}:${correction.index ?? "slot"}`;
    if (correction.index !== null && changed.has(key))
      throw new Error(
        "Review repeats a replacement target; no partial changes were applied.",
      );
    changed.add(key);
    const protectedPath = r.manualCorrections?.find((pin) =>
      overlappingPaths(pin.path, correction.path),
    );
    const targetPath =
      Object.hasOwn(correction, "index") && correction.index !== null
        ? `${correction.path}.${correction.index}`
        : correction.path;
    if (protectedPath) {
      const current = getPath(r.report, targetPath);
      if (!sameValue(current, correction.value) || correction.index === null)
        protectedFindings.push({
          documentId: r.documentId,
          path: protectedPath.path,
          effect: "warning",
          code: "manual_review_conflict",
          reason: `A model change was not applied because this section contains a manual correction. Model reason: ${correction.reason}`,
          proposedValue: correction.value,
        });
      continue;
    }
    if (Object.hasOwn(correction, "index")) {
      const list = getPath(r.report, correction.path);
      if (!Array.isArray(list))
        throw new Error("Array correction references a non-array section.");
      if (correction.index === null) {
        if (correction.value === null)
          throw new Error("Cannot append a null item.");
        list.push(correction.value);
      } else {
        const index = correction.index!;
        if (index >= list.length)
          throw new Error(
            `Array correction index ${index} is outside ${r.documentId} / ${correction.path} (input length ${getPath(ws.reports.find((original) => original.documentId === r.documentId)!.report, correction.path).length}). Saved model output retained; no corrections applied.`,
          );
        if (correction.value === null) list.splice(index, 1);
        else list[index] = correction.value;
      }
    } else setPath(r.report, correction.path, correction.value);
    appliedCorrections.push(correction);
    r.reason = correction.reason;
  }
  const at = new Date().toISOString();
  for (const r of reports.values()) {
    const normalized = normalizeReportAmounts(
      reportSchema.parse(r.report),
      r.manualCorrections?.map((c) => c.path),
    );
    r.report = normalized.report;
    r.normalizations = normalized.adjustments;
    r.revision++;
    r.id = crypto.randomUUID();
    r.reviewId = job.id;
    r.at = at;
    r.reason = corrections.some((c) => c.documentId === r.documentId)
      ? r.reason
      : "Company source and consistency review completed.";
    r.issues = reportIssues(r.report, await getDocument(r.documentId));
  }
  const normalizedFindings = [...result.findings, ...protectedFindings].map(
    (f) => ({
      ...f,
      path: normalizeReportPath(f.path),
    }),
  );
  const appliedFindings: Finding[] = [];
  for (const f of normalizedFindings) {
    const r = reports.get(f.documentId!);
    if (!r) throw new Error("Review finding references an unknown report.");
    const original = ws.reports.find(
      (original) => original.documentId === r.documentId,
    )!;
    const reference = {
      ...resolveFindingReference(
        original.report,
        r.report,
        f.path,
        appliedCorrections.filter((c) => c.documentId === r.documentId),
      ),
      inputRevision: original.revision,
    };
    if (reference.status === "superseded_by_correction") {
      appliedFindings.push({ ...f, reference, resolvedAt: at });
      continue;
    }
    const previousValue = getPath(original.report, f.path);
    const currentFinding = { ...f, path: reference.currentPath!, reference };
    const protectedSection = r.manualCorrections?.some((pin) =>
      overlappingPaths(pin.path, currentFinding.path),
    );
    const finding = contextualizeFinding(r.report, {
      ...currentFinding,
      ...(protectedSection
        ? {
            effect: "warning" as const,
            code: "manual_review_conflict" as const,
          }
        : {}),
      ...(previousValue != null &&
      getPath(r.report, currentFinding.path) === null
        ? { previousValue }
        : {}),
    });
    r.issues.push(finding);
    appliedFindings.push(finding);
  }
  const quarters = [...new Set(docs.map((d) => d.quarter))].sort();
  if (
    result.selections.length !== quarters.length ||
    new Set(result.selections.map((s) => s.quarter)).size !== quarters.length ||
    quarters.some((q) => !result.selections.some((s) => s.quarter === q))
  )
    throw new Error(
      "Review must select sources or give unresolved reasons for every company quarter.",
    );
  const selectionFindings: Finding[] = [];
  const selections = result.selections.map((s) => ({
    quarter: s.quarter,
    choices: Object.fromEntries(
      publicationMetrics.map((metric) => {
        const choice = s.choices[metric],
          path = publicationSlots[metric].path,
          r = choice.documentId ? reports.get(choice.documentId) : null;
        if (!choice.documentId)
          return [metric, { source: null, reason: choice.reason }];
        const doc = docs.find((d) => d.id === choice.documentId),
          value = r && getPath(r.report, path);
        if (!r || !doc || doc.quarter !== s.quarter || !value) {
          const problem =
            !r || !doc
              ? `report '${choice.documentId}' was not supplied for this company`
              : doc.quarter !== s.quarter
                ? `report '${choice.documentId}' belongs to ${doc.quarter}, not ${s.quarter}`
                : `the selected report has no value at ${path} after corrections`;
          const reason = `Source unavailable for ${s.quarter} ${metric}: ${problem}. Model selection reason: ${choice.reason}`;
          selectionFindings.push({
            path,
            effect: "block",
            reason,
            ...(r && doc ? { documentId: r.documentId } : {}),
          });
          return [metric, { source: null, reason }];
        }
        if (blocksPath(r.issues, path))
          return [
            metric,
            {
              source: null,
              reason:
                "Blocked by source/context checks: " +
                r.issues
                  .filter((i) => blocksPath([i], path))
                  .map((i) => i.reason)
                  .join(" "),
            },
          ];
        // A model cannot hide contradictory same-period published values by selecting one.
        // A later explicitly selected publication can supersede an earlier report;
        // conflicting contemporaneous sources require an unresolved choice.
        const conflicts = [...reports.values()]
          .filter((other) => other.documentId !== r.documentId)
          .some((other) => {
            const d = docs.find((d) => d.id === other.documentId)!,
              v = getPath(other.report, path);
            return (
              d.quarter === s.quarter &&
              d.publishedAt >= doc.publishedAt &&
              v &&
              !blocksPath(other.issues, path) &&
              Math.abs(v.value - value.value) >
                precision(v) + precision(value) + 1e-8
            );
          });
        return [
          metric,
          conflicts
            ? {
                source: null,
                reason:
                  "Unresolved contradictory current-quarter sources. Correct or explicitly resolve the underlying reports before publication.",
              }
            : {
                source: {
                  documentId: r.documentId,
                  revision: r.revision,
                  path,
                },
                reason: choice.reason,
              },
        ];
      }),
    ),
  }));
  const finalFindings = [...appliedFindings, ...selectionFindings];
  const publication: Publication = {
    id: crypto.randomUUID(),
    companyId: job.companyId,
    at,
    contractVersion: CONTRACT_VERSION,
    reviewId: job.id,
    snapshots: Object.fromEntries(
      [...reports].map(([id, r]) => [
        id,
        { revision: r.revision, hash: r.sourceHash },
      ]),
    ),
    selections,
    findings: finalFindings,
    summary: result.summary,
  };
  const completed = {
    ...job,
    status: "completed",
    updatedAt: at,
    consistency: {
      ...job.consistency,
      status: "completed",
      error: undefined,
      findings: finalFindings,
      summary: result.summary,
      usage: saved.usage,
    },
  };
  await commitState(
    ws,
    [
      ...[...reports.values()].flatMap(revisionStatements),
      {
        sql: "INSERT INTO publications(id,company_id,at,payload) SELECT ?,?,?,? WHERE $GUARD",
        values: [
          publication.id,
          job.companyId,
          at,
          JSON.stringify(publication),
        ],
      },
      ...(saved.localRecovery
        ? [
            {
              sql: "INSERT INTO audit(id,at,payload) SELECT ?,?,? WHERE $GUARD",
              values: [
                saved.localRecovery.id,
                at,
                JSON.stringify(saved.localRecovery),
              ],
            },
          ]
        : []),
      {
        sql: "UPDATE company_reviews SET payload=? WHERE id=? AND $GUARD",
        values: [JSON.stringify(completed), job.id],
      },
    ],
    "Applied typed company review and explicit quarterly source selections atomically.",
  );
}
export async function reconcileCompany(
  jobId: string,
  requestUrl: string,
  retry = false,
  savedOnly = false,
) {
  let job = await getCompanyReview(jobId);
  const existing = await readRun(job.consistency.runId);
  if (job.consistency.status === "completed") return job;
  if (
    savedOnly &&
    (existing?.kind !== "company_review" || existing.status !== "completed")
  )
    throw new Error(
      "No completed saved company response is available. No model call was made.",
    );
  if (
    job.consistency.status === "running" &&
    (!retry ||
      Date.now() - Date.parse(job.consistency.startedAt || job.at) < 1200000)
  )
    throw new Error(
      "Company review is already running. No duplicate paid call was made.",
    );
  if (job.consistency.status === "failed" && !retry)
    throw new Error(
      "Explicit retry/recovery required after checking provider usage.",
    );
  if (
    job.workflow === "extract_reconcile" &&
    Object.values(job.documents).some((d) => d.status !== "completed")
  )
    throw new Error("Finish every PDF extraction before company review.");
  const attempt = crypto.randomUUID(),
    oldAttempt = job.consistency.attempt || "";
  job = {
    ...job,
    consistency: {
      ...job.consistency,
      status: "running",
      attempt,
      startedAt: new Date().toISOString(),
      error: undefined,
    },
  };
  const claim = await runtime()
    .DB.prepare(
      "UPDATE company_reviews SET payload=? WHERE id=? AND COALESCE(json_extract(payload,'$.consistency.attempt'),'')=? RETURNING id",
    )
    .bind(JSON.stringify(job), job.id, oldAttempt)
    .all();
  if (!claim.results?.length) throw new Error("Company review claim conflict.");
  let runId = job.consistency.runId,
    saved =
      existing?.kind === "company_review" && existing.status === "completed"
        ? existing
        : null;
  try {
    if (!saved) {
      if (savedOnly)
        throw new Error(
          "No saved response available; local application never starts a model request.",
        );
      const ws = await readWorkspace(),
        docs = ws.documents
          .filter((d) => d.companyId === job.companyId)
          .sort((a, b) => a.id.localeCompare(b.id));
      if (
        !same(
          Object.keys(job.documents).sort(),
          docs.map((d) => d.id).sort(),
        ) ||
        docs.some((d) => d.sha256 !== job.documents[d.id]?.sourceHash)
      )
        throw new Error(
          "Source conflict: company document set changed. Start a fresh company workflow.",
        );
      const reports = ws.reports.filter((r) => r.companyId === job.companyId);
      if (reports.length !== docs.length)
        throw new Error(
          "All company reports must have accepted typed extractions before review.",
        );
      const pdfs = [];
      let size = 0;
      if (docs.length > 100)
        throw new Error(
          "Company review exceeds the 100-PDF input budget. No paid call made.",
        );
      for (const [i, d] of docs.entries()) {
        const bytes = await getPdfBytes(await getDocument(d.id), requestUrl);
        size += bytes.length;
        if (size > 48 * 1024 * 1024)
          throw new Error(
            "Company PDFs exceed the 48 MiB combined input budget. No paid call made.",
          );
        pdfs.push({
          filename: `report-${i + 1}.pdf`,
          base64: base64Pdf(bytes),
        });
      }
      const responseContract = companyResponseContract(
        reports.map((r) => ({
          ...r,
          quarter: docs.find((d) => d.id === r.documentId)!.quarter,
        })),
      );
      // Compile the exact request-specific parser before reserving a call.
      // No generic, less constrained company schema is sent to the model.
      modelJsonSchema(responseContract.schema);
      const input = JSON.stringify({
        subject: ws.companies.find((c) => c.id === job.companyId)?.name,
        documents: docs.map((d, i) => ({
          id: d.id,
          filename: `report-${i + 1}.pdf`,
          quarter: d.quarter,
          periodStart: d.periodStart,
          periodEnd: d.periodEnd,
          publishedAt: d.publishedAt,
          revision: reports.find((r) => r.documentId === d.id)!.revision,
          report: reports.find((r) => r.documentId === d.id)!.report,
          diagnostics: reports.find((r) => r.documentId === d.id)!.issues,
          manuallyProtectedSections: reports
            .find((r) => r.documentId === d.id)!
            .manualCorrections?.map((c) => ({
              path: c.path,
              reason: c.reason,
            })),
        })),
        reviewTargets: responseContract.targets,
        publicationSlots: Object.fromEntries(
          Object.entries(publicationSlots).map(([m, v]) => [m, v.path]),
        ),
      });
      if (input.length > 2400000)
        throw new Error(
          "Company structured input exceeds the 2.4M-character budget. No paid call made.",
        );
      const config = providerConfig(runtime(), job.model);
      runId = await reserveRun("company_review");
      job.consistency.runId = runId;
      await runtime()
        .DB.prepare(
          "UPDATE company_reviews SET payload=? WHERE id=? AND json_extract(payload,'$.consistency.attempt')=?",
        )
        .bind(JSON.stringify(job), job.id, attempt)
        .run();
      const result = await new ResponsesProvider(config).generate({
        system:
          extractionInstructions +
          "\nReview every original PDF and typed report. The response is keyed by the exact targets supplied in reviewTargets. Every changes key is required: null means keep unchanged; {reason,value} applies a change, and value=null clears a nullable slot or removes the referenced existing array item. additions contains typed non-null items with an allowed addition target. Do not write document IDs, paths or indexes in changes/additions; the target catalog binds them. Protected manual sections have no change/addition targets; disagreements belong in warning findings. Every documents key is required. Findings use ONLY a numeric target from reviewTargets.findings[documentId], never a path or a new category. The array position in that catalog is the target number. All findings and changes refer to the ORIGINAL input revision; never renumber targets after removals. For an unsupported concept such as guarantees or aggregate unnamed equity commitments, use the existing events or coverage finding target and explain the limitation in prose; never invent events.guarantees or events.equityInvestments. For a new or retyped item whose subfield has no input target, use its existing array/slot target. Null fields with coverage are unavailable information, not invalid populated values; use warnings. Known nominal literals are normalized by the application; do not clear them because of an old parser diagnostic. Correct source/meaning, period, unit, basis and routing errors. Generic Net income is a supported GAAP netIncome slot with its own attribution; keep it when reported and leave the parent-specific slot null if parent attribution is not explicit. Never copy the same source assertion into both net-income definitions. Operating-margin selections are for directly printed percentages only; when none is printed choose null for that slot and select valid current-quarter GAAP operatingIncome and revenue so the application can calculate a separately labelled margin. Preserve valid data and distinct transaction identities. Inbound investments are Investment events, never revenue. Every selections quarter is required exactly once; for each metric, choose a source document allowed by that quarter's schema or null with reason. Select only a current-quarter consolidated GAAP/direct reported slot present after changes. Comparative values, segment amounts and events cannot replace current-quarter sources. Equally credible contradictory sources require an unresolved null. Never claim absolute correctness or analyst verification.",
        input,
        pdfs,
        name: "company_report_reconciliation_v3",
        schema: responseContract.schema,
        reasoningEffort: job.reasoningEffort,
        maxOutputTokens: 64000,
        timeoutMs: 900000,
      });
      saved = {
        kind: "company_review",
        status: "completed",
        contractVersion: CONTRACT_VERSION,
        snapshots: companySnapshot(ws, job.companyId),
        result: responseContract.normalize(result.data),
        outputSchema: "keyed-company-review-v3",
        rawOutput: result.rawOutput,
        usage: result.usage,
      };
      await finishRun(runId, saved);
    } else job.consistency.reusedSavedResponse = true;
    await applyCompanyResult(job, saved);
    return await getCompanyReview(jobId);
  } catch (error) {
    const completedRun = await readRun(runId);
    if (runId && completedRun?.status !== "completed")
      await finishRun(runId, {
        kind: "company_review",
        status: "failed",
        contractVersion: CONTRACT_VERSION,
        error: (error as Error).message,
      });
    job.consistency = {
      ...job.consistency,
      status: "failed",
      runId,
      error: (error as Error).message,
    };
    await runtime()
      .DB.prepare(
        "UPDATE company_reviews SET payload=? WHERE id=? AND json_extract(payload,'$.consistency.attempt')=?",
      )
      .bind(JSON.stringify(job), job.id, attempt)
      .run();
    throw error;
  }
}
