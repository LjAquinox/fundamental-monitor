import { CONTRACT_VERSION, getPath, publicationSlots } from "./report-contract";
import { blocksPath, REPORT_CHECK_VERSION } from "./report-checks";
import type {
  Workspace,
  Publication,
  ReportRevision,
  SourceRef,
} from "./types";
export const FINANCIAL_FORMULA_VERSION = "financial-formulas-v3";
export interface SelectedMetric {
  value: number | null;
  unit: string | null;
  source: SourceRef | null;
  sources: SourceRef[];
  origin: "reported" | "calculated" | "unavailable";
  label: string;
  definition: string;
  reason: string;
  formula: string | null;
  formulaVersion: string | null;
  operands: {
    metric: string;
    value: number;
    unit: string;
    source: SourceRef;
  }[];
}
export interface FinancialRow {
  quarter: string;
  metrics: Record<string, SelectedMetric>;
}
const title = (s: string) =>
  s.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
export function companySnapshot(ws: Workspace, companyId: string) {
  return Object.fromEntries(
    ws.documents
      .filter((d) => d.companyId === companyId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((d) => [
        d.id,
        {
          hash: d.sha256,
          revision:
            ws.reports.find((r) => r.documentId === d.id)?.revision || 0,
        },
      ]),
  );
}
export function companyFingerprint(ws: Workspace, companyId: string) {
  return JSON.stringify({
    checks: REPORT_CHECK_VERSION,
    formulas: FINANCIAL_FORMULA_VERSION,
    snapshot: companySnapshot(ws, companyId),
    publication:
      ws.publications.find((p) => p.companyId === companyId)?.id || null,
  });
}
export function publicationCurrent(
  ws: Workspace,
  pub: Publication,
  cutoff = "9999-12-31",
) {
  if (pub.contractVersion !== CONTRACT_VERSION) return false;
  const docs = ws.documents.filter((d) => d.companyId === pub.companyId);
  if (
    docs.length !== Object.keys(pub.snapshots).length ||
    docs.some((d) => d.publishedAt > cutoff)
  )
    return false;
  return docs.every(
    (d) =>
      pub.snapshots[d.id]?.hash === d.sha256 &&
      pub.snapshots[d.id]?.revision ===
        ws.reports.find((r) => r.documentId === d.id)?.revision,
  );
}
export function activePublication(
  ws: Workspace,
  companyId: string,
  cutoff = "9999-12-31",
) {
  return (
    ws.publications.find(
      (p) => p.companyId === companyId && publicationCurrent(ws, p, cutoff),
    ) || null
  );
}
/** Only reviewer-selected, current-quarter GAAP sources are calculation inputs.
 * Application ratios never become extracted Value evidence or source choices. */
export function selectedSeries(
  ws: Workspace,
  companyId: string,
  cutoff = "9999-12-31",
): FinancialRow[] {
  const pub = activePublication(ws, companyId, cutoff);
  const quarters = [
    ...new Set(
      ws.documents
        .filter((d) => d.companyId === companyId && d.publishedAt <= cutoff)
        .map((d) => d.quarter),
    ),
  ].sort();
  return quarters.map((quarter) => {
    const metrics: Record<string, SelectedMetric> = Object.fromEntries(
      Object.entries(publicationSlots).map(([metric, slot]) => {
        const choice = pub?.selections.find((s) => s.quarter === quarter)
            ?.choices[metric],
          ref = choice?.source;
        const doc = ref
          ? ws.documents.find(
              (d) =>
                d.id === ref.documentId &&
                d.companyId === companyId &&
                d.quarter === quarter &&
                d.publishedAt <= cutoff,
            )
          : null;
        const rev = ref
          ? ws.reports.find(
              (r) =>
                r.documentId === ref.documentId &&
                r.revision === ref.revision &&
                r.companyId === companyId &&
                r.contractVersion === CONTRACT_VERSION,
            )
          : null;
        const value =
          rev &&
          doc &&
          ref &&
          ref.path === slot.path &&
          rev.sourceHash === doc.sha256 &&
          !blocksPath(rev.issues, ref.path)
            ? getPath(rev.report, ref.path)
            : null;
        const usable = value?.type === "Value" && Number.isFinite(value.value);
        const label =
          metric === "netIncomeAttributableToParent"
            ? "Net income attributable to parent"
            : metric === "netIncome"
              ? value?.attribution === "Consolidated"
                ? "Net income (consolidated)"
                : "Net income (reported)"
              : title(metric);
        const definition =
          metric === "netIncomeAttributableToParent"
            ? "GAAP net income explicitly attributable to the parent, excluding income allocated to non-controlling interests."
            : metric === "netIncome"
              ? value?.attribution === "Consolidated"
                ? "Directly reported GAAP net income of the consolidated group, before any separately stated allocation to non-controlling interests."
                : "Directly reported GAAP net income; parent/consolidated attribution is not specified by the source."
              : metric === "operatingMargin"
                ? "Current-quarter GAAP operating income divided by revenue, expressed as a percentage."
                : `Current-quarter consolidated GAAP ${title(metric).toLowerCase()}.`;
        return [
          metric,
          {
            value: usable ? value.value : null,
            unit: usable ? value.unit : null,
            source: usable ? ref! : null,
            sources: usable ? [ref!] : [],
            origin: usable ? "reported" : "unavailable",
            label,
            definition,
            reason: usable
              ? choice!.reason
              : choice?.reason || "Company review/source selection required.",
            formula: null,
            formulaVersion: null,
            operands: [],
          } satisfies SelectedMetric,
        ];
      }),
    );
    const margin = metrics.operatingMargin,
      income = metrics.operatingIncome,
      revenue = metrics.revenue;
    if (margin.value === null) {
      let problem =
        "Calculation requires reviewed, selected GAAP operating income and revenue.";
      if (
        income.value !== null &&
        revenue.value !== null &&
        income.source &&
        revenue.source
      ) {
        if (revenue.value <= 0)
          problem =
            "Operating margin cannot be calculated with zero or negative revenue.";
        else if (
          income.unit !== "USD_millions" ||
          revenue.unit !== "USD_millions"
        )
          problem =
            "Operating-margin inputs must use the same supported monetary unit.";
        else if (
          income.source.documentId !== revenue.source.documentId ||
          income.source.revision !== revenue.source.revision
        )
          problem =
            "Calculation requires both selected inputs from the same report revision to avoid mixing presentations/restatements.";
        else {
          const r = ws.reports.find(
              (r) =>
                r.documentId === income.source!.documentId &&
                r.revision === income.source!.revision,
            )!,
            d = ws.documents.find((d) => d.id === r.documentId)!;
          const period = r.report.currentQuarter.period;
          if (
            period.label !== quarter ||
            period.start !== d.periodStart ||
            period.end !== d.periodEnd
          )
            problem =
              "Operating-margin inputs do not match the source quarter's exact reporting period.";
          else {
            const calculated = (100 * income.value) / revenue.value;
            if (Number.isFinite(calculated))
              metrics.operatingMargin = {
                ...margin,
                value: calculated,
                unit: "percent",
                origin: "calculated",
                source: null,
                sources: [income.source, revenue.source],
                formula: "100 × operatingIncome / revenue",
                formulaVersion: FINANCIAL_FORMULA_VERSION,
                operands: [
                  {
                    metric: "operatingIncome",
                    value: income.value,
                    unit: income.unit,
                    source: income.source,
                  },
                  {
                    metric: "revenue",
                    value: revenue.value,
                    unit: revenue.unit,
                    source: revenue.source,
                  },
                ],
                reason:
                  "Calculated from reviewed, selected current-quarter GAAP operating income and revenue in the same report revision. The percentage is not presented as a printed PDF value.",
              };
            else problem = "Operating-margin calculation is not finite.";
          }
        }
      }
      if (metrics.operatingMargin.value === null)
        metrics.operatingMargin = {
          ...margin,
          reason: margin.reason + " " + problem,
        };
    }
    return { quarter, metrics };
  });
}
/** A presentation preference, never a relabelling of the underlying facts.
 * Each row/card displays the chosen definition; exports keep both metrics. */
export function displayedNetIncome(
  metrics: Record<string, SelectedMetric>,
): SelectedMetric {
  return metrics.netIncomeAttributableToParent.value !== null
    ? metrics.netIncomeAttributableToParent
    : metrics.netIncome;
}
export function derivedMetrics(
  ws: Workspace,
  companyId: string,
  cutoff = "9999-12-31",
) {
  const series = selectedSeries(ws, companyId, cutoff);
  const index = (q: string) => Number(q.slice(0, 4)) * 4 + Number(q.at(-1)) - 1;
  return series.map((row) => {
    const prior = series.find(
        (r) => index(r.quarter) === index(row.quarter) - 4,
      ),
      a = row.metrics.revenue.value,
      b = prior?.metrics.revenue.value;
    const ocf = row.metrics.operatingCashFlow,
      capex = row.metrics.purchasesOfPropertyAndEquipment;
    return {
      quarter: row.quarter,
      revenueYoY: a !== null && b != null && b > 0 ? ((a - b) / b) * 100 : null,
      revenueYoYSources:
        prior && a !== null && b != null
          ? [row.metrics.revenue.source, prior.metrics.revenue.source]
          : [],
      calculatedFreeCashFlow:
        ocf.value !== null && capex.value !== null
          ? ocf.value - capex.value
          : null,
      freeCashFlowSources:
        ocf.value !== null && capex.value !== null
          ? [ocf.source, capex.source]
          : [],
      calculatedOperatingMargin:
        row.metrics.operatingMargin.origin === "calculated"
          ? row.metrics.operatingMargin.value
          : null,
      operatingMarginSources: row.metrics.operatingMargin.sources,
      operatingMarginMethod: row.metrics.operatingMargin.origin,
      operatingMarginFormula: row.metrics.operatingMargin.formula,
      formulaVersion: FINANCIAL_FORMULA_VERSION,
    };
  });
}
export function sourceReference(rev: ReportRevision, path: string) {
  return `${rev.documentId}@${rev.revision}:${path}`;
}

/** Score an observed target against the frozen forecast baseline, never revised history. */
export function forecastOutcomes(
  ws: Workspace,
  forecast: Workspace["forecasts"][number],
) {
  let snapshot: any;
  try {
    snapshot = JSON.parse(forecast.inputSnapshot);
  } catch {
    snapshot = {};
  }
  const q = Number(forecast.quarter.at(-1));
  const nextQuarter =
    q === 4
      ? `${Number(forecast.quarter.slice(0, 4)) + 1}-Q1`
      : `${forecast.quarter.slice(0, 4)}-Q${q + 1}`;
  const observed = selectedSeries(ws, forecast.companyId).find(
    (r) => r.quarter === nextQuarter,
  );
  const actualGrowth = derivedMetrics(ws, forecast.companyId).find(
    (r) => r.quarter === nextQuarter,
  );
  const frozen = snapshot.financial?.find(
    (r: any) => r.quarter === forecast.quarter,
  );
  const frozenGrowth = snapshot.calculated?.find(
    (r: any) => r.quarter === forecast.quarter,
  );
  return forecast.predictions.map((prediction) => {
    const growth = prediction.metric === "revenue_growth";
    const baseline = growth
      ? frozenGrowth?.revenueYoY
      : frozen?.metrics?.operatingMargin?.value;
    const actual = growth
      ? actualGrowth?.revenueYoY
      : observed?.metrics.operatingMargin.value;
    const threshold = growth ? 2 : 1;
    const actualDirection =
      baseline == null || actual == null
        ? null
        : actual - baseline > threshold
          ? "increase"
          : actual - baseline < -threshold
            ? "decrease"
            : "stable";
    return {
      metric: prediction.metric,
      quarter: nextQuarter,
      baseline: baseline ?? null,
      actual: actual ?? null,
      actualDirection,
      status:
        prediction.direction === "insufficient_evidence"
          ? "Abstained"
          : !actualDirection
            ? "Pending outcome"
            : actualDirection === prediction.direction
              ? "Correct"
              : "Incorrect",
      baselineOrigin: growth
        ? "calculated"
        : (frozen?.metrics?.operatingMargin?.origin ?? null),
      actualOrigin: growth
        ? "calculated"
        : (observed?.metrics.operatingMargin.origin ?? null),
      formulaVersion: "direction-outcomes-v3",
    };
  });
}
