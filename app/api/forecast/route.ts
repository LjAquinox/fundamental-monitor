import { z } from "zod/v4";
import {
  runtime,
  readWorkspace,
  json,
  errorResponse,
  writeGuard,
} from "../../../lib/server";
import {
  ResponsesProvider,
  providerConfig,
  forecastSchema,
} from "../../../lib/provider";
import {
  reserveRun,
  finishRun,
  sourceRules,
} from "../../../lib/model-workflow";
import {
  activePublication,
  selectedSeries,
  derivedMetrics,
  companyFingerprint,
  sourceReference,
} from "../../../lib/selections";
import { CONTRACT_VERSION } from "../../../lib/report-contract";
import { blocksPath, walkEvidence } from "../../../lib/report-checks";
import { isReportingDate } from "../../../lib/reporting-dates";
function mask(text: string, aliases: string[]) {
  let result = text;
  for (const [i, a] of [...new Set(aliases)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .entries()) {
    const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(
      new RegExp("(?<![A-Za-z0-9])" + escaped + "(?![A-Za-z0-9])", "gi"),
      `[ENTITY_${i + 1}]`,
    );
  }
  return result;
}
/** Mask text values without rewriting JSON keys, reference IDs, dates or enums. */
function maskedInput(value: any, aliases: string[], key = ""): any {
  const structural = new Set([
    "id",
    "quarter",
    "asOf",
    "originQuarter",
    "publishedAt",
    "start",
    "end",
    "label",
    "type",
    "unit",
    "reportedUnit",
    "metric",
    "status",
    "accountingBasis",
    "direction",
    "category",
    "formulaVersion",
    "revenueYoYSources",
    "freeCashFlowSources",
    "operatingMarginSources",
    "origin",
    "definition",
    "formula",
    "evidenceIds",
  ]);
  if (typeof value === "string")
    return structural.has(key) ? value : mask(value, aliases);
  if (Array.isArray(value))
    return value.map((v) => maskedInput(v, aliases, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, maskedInput(v, aliases, k)]),
    );
  return value;
}
export async function POST(request: Request) {
  let runId: string | undefined;
  try {
    writeGuard(request);
    const b = z
      .object({
        companyId: z.string().min(1),
        quarter: z.string().regex(/^\d{4}-Q[1-4]$/),
        asOf: z.string(),
      })
      .strict()
      .parse(await request.json());
    if (
      !isReportingDate(b.asOf) ||
      b.asOf > new Date().toISOString().slice(0, 10)
    )
      throw new Error("Choose a real as-of date no later than today.");
    const ws = await readWorkspace(),
      company = ws.companies.find((c) => c.id === b.companyId),
      pub = activePublication(ws, b.companyId, b.asOf);
    if (!company) throw new Error("Company not found.");
    if (!pub)
      throw new Error(
        "A current company review using only PDFs published by the cutoff is required. A later-PDF review cannot be reused for historical forecasts.",
      );
    if (
      ws.documents.some(
        (d) =>
          d.companyId === b.companyId &&
          d.publishedAt <= b.asOf &&
          d.quarter > b.quarter,
      )
    )
      throw new Error(
        "The forecast origin must be the latest available fiscal quarter at the cutoff. Use a historical-cutoff review for an earlier origin.",
      );
    const series = selectedSeries(ws, b.companyId, b.asOf).filter(
        (r) => r.quarter <= b.quarter,
      ),
      latest = series.at(-1);
    if (!latest || latest.quarter !== b.quarter)
      throw new Error("Selected forecast origin quarter is unavailable.");
    if (series.filter((r) => r.metrics.revenue.value !== null).length < 2)
      throw new Error(
        "At least two reviewed selected quarterly revenues are required.",
      );
    const refs = new Map<string, string>(),
      reverse = new Map<string, string>();
    function id(ref: string) {
      if (!refs.has(ref)) {
        const key = `e${refs.size + 1}`;
        refs.set(ref, key);
        reverse.set(key, ref);
      }
      return refs.get(ref)!;
    }
    const financial = series.map((r) => ({
      quarter: r.quarter,
      metrics: Object.fromEntries(
        Object.entries(r.metrics)
          .filter(([, v]) => v.value !== null && v.sources.length > 0)
          .map(([metric, v]) => [
            metric,
            {
              id: v.source
                ? id(
                    `${v.source.documentId}@${v.source.revision}:${v.source.path}`,
                  )
                : null,
              value: v.value,
              unit: v.unit,
              origin: v.origin,
              definition: v.definition,
              evidenceIds: v.sources.map((ref) =>
                id(`${ref.documentId}@${ref.revision}:${ref.path}`),
              ),
              formula: v.formula,
              formulaVersion: v.formulaVersion,
              operands: v.operands.map((operand) => ({
                metric: operand.metric,
                value: operand.value,
                unit: operand.unit,
                id: id(
                  `${operand.source.documentId}@${operand.source.revision}:${operand.source.path}`,
                ),
              })),
            },
          ]),
      ),
    }));
    const context = ws.reports
      .filter(
        (r) =>
          r.companyId === b.companyId &&
          ws.documents.some(
            (d) =>
              d.id === r.documentId &&
              d.publishedAt <= b.asOf &&
              d.quarter <= b.quarter,
          ),
      )
      .map((r) => {
        const sections: any = structuredClone({
          events: r.report.events,
          guidance: r.report.guidance,
          risks: r.report.risks,
        });
        for (const section of ["events", "guidance", "risks"]) {
          sections[section] = sections[section]
            .map((item: any, index: number) => {
              if (blocksPath(r.issues, `${section}.${index}`)) return null;
              walkEvidence(item, (node, path) => {
                node.id = id(
                  sourceReference(
                    r,
                    path
                      ? `${section}.${index}.${path}`
                      : `${section}.${index}`,
                  ),
                );
              });
              return item;
            })
            .filter(Boolean);
        }
        const sourceDocument = ws.documents.find((d) => d.id === r.documentId)!;
        return {
          quarter: sourceDocument.quarter,
          publishedAt: sourceDocument.publishedAt,
          ...sections,
        };
      });
    const calculated = derivedMetrics(ws, b.companyId, b.asOf)
      .filter((r) => r.quarter <= b.quarter)
      .map((r) => ({
        ...r,
        revenueYoYSources: r.revenueYoYSources.map((ref) =>
          ref ? id(`${ref.documentId}@${ref.revision}:${ref.path}`) : null,
        ),
        operatingMarginSources: r.operatingMarginSources.map((ref) =>
          id(`${ref.documentId}@${ref.revision}:${ref.path}`),
        ),
        freeCashFlowSources: r.freeCashFlowSources.map((ref) =>
          ref ? id(`${ref.documentId}@${ref.revision}:${ref.path}`) : null,
        ),
      }));
    const aliases = [
      company.name,
      company.ticker,
      ...company.aliases,
      ...ws.companies
        .filter((c) => c.id !== company.id)
        .flatMap((c) => [c.name, c.ticker, ...c.aliases]),
      ...context.flatMap((c) =>
        c.events.flatMap((event: any) =>
          [
            "investor",
            "recipient",
            "lender",
            "borrower",
            "acquirer",
            "target",
            "seller",
            "buyer",
          ]
            .map((key) => event[key])
            .filter(
              (name: unknown): name is string => typeof name === "string",
            ),
        ),
      ),
    ];
    const input = JSON.stringify(
      maskedInput(
        {
          asOf: b.asOf,
          originQuarter: b.quarter,
          targets: {
            revenue_growth:
              "Next-quarter revenue YoY growth versus current-quarter YoY growth; stable within 2 percentage points. Missing same-period prior-year history requires insufficient_evidence.",
            operating_margin:
              "Next-quarter GAAP operating margin versus current quarter; stable within 1 percentage point. A margin may be directly reported or calculated from reviewed same-report GAAP operating income/revenue. Keep origin/formula and both source IDs. Missing comparable margin history requires insufficient_evidence.",
          },
          financial,
          calculated,
          context,
        },
        aliases,
      ),
    );
    if (input.length > 500000)
      throw new Error(
        "Forecast evidence exceeds the input budget. No subset was silently selected and no paid call made.",
      );
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
      ),
    )
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    const config = providerConfig(runtime());
    runId = await reserveRun("forecast");
    const result = await new ResponsesProvider(config).generate({
      system:
        sourceRules +
        " Forecast exactly one revenue_growth and one operating_margin direction for the next fiscal quarter. Only reviewed selected actual financial metrics and application-calculated ratios explicitly labelled by origin/formula are numerical history. A calculated operating margin is not a printed PDF assertion; cite its operating-income and revenue evidence IDs. Generic/consolidated netIncome and netIncomeAttributableToParent have different definitions; never equate or silently combine them. Events, risks and management guidance are contextual evidence, never revenue. Guidance is not your prediction or an actual result. Distinguish incomplete/ambiguous evidence. A non-abstaining direction requires known evidence IDs. Use insufficient_evidence for missing histories. Do not predict stock prices or claim analyst verification.",
      input,
      name: "fundamental_forecast",
      schema: forecastSchema,
    });
    if (new Set(result.data.predictions.map((p) => p.metric)).size !== 2)
      throw new Error("Forecast must include both distinct targets.");
    for (const p of result.data.predictions) {
      if (
        p.evidenceIds.some((ref) => !reverse.has(ref)) ||
        (p.direction !== "insufficient_evidence" && !p.evidenceIds.length)
      )
        throw new Error(
          "Forecast references unknown/missing supporting evidence.",
        );
      if (
        p.metric === "revenue_growth" &&
        calculated.find((r) => r.quarter === b.quarter)?.revenueYoY == null &&
        p.direction !== "insufficient_evidence"
      )
        throw new Error(
          "Revenue-growth forecast lacks current comparable YoY history.",
        );
      if (
        p.metric === "operating_margin" &&
        latest.metrics.operatingMargin.value === null &&
        p.direction !== "insufficient_evidence"
      )
        throw new Error(
          "Operating-margin forecast lacks a selected comparable GAAP margin.",
        );
    }
    const current = await readWorkspace();
    if (
      companyFingerprint(current, b.companyId) !==
      companyFingerprint(ws, b.companyId)
    )
      throw new Error(
        "Data conflict: research changed during forecast generation. Saved research was not overwritten.",
      );
    const forecast = {
      ...result.data,
      predictions: result.data.predictions.map((p) => ({
        ...p,
        evidenceIds: p.evidenceIds.map((ref) => reverse.get(ref)!),
      })),
      id: crypto.randomUUID(),
      companyId: b.companyId,
      quarter: b.quarter,
      asOf: b.asOf,
      createdAt: new Date().toISOString(),
      model: config.model,
      promptVersion: CONTRACT_VERSION,
      inputHash: hash,
      inputSnapshot: input,
      evidenceMap: Object.fromEntries(reverse),
      stateFingerprint: companyFingerprint(ws, b.companyId),
      stale: false,
      usage: result.usage,
    };
    await runtime()
      .DB.prepare("INSERT INTO forecasts(id,payload) VALUES(?,?)")
      .bind(forecast.id, JSON.stringify(forecast))
      .run();
    await finishRun(runId, {
      kind: "forecast",
      status: "completed",
      contractVersion: CONTRACT_VERSION,
      forecast,
      rawOutput: result.rawOutput,
      usage: result.usage,
    });
    return json({ forecast });
  } catch (e) {
    if (runId)
      await finishRun(runId, {
        kind: "forecast",
        status: "failed",
        contractVersion: CONTRACT_VERSION,
      }).catch(() => {});
    return errorResponse(e);
  }
}
