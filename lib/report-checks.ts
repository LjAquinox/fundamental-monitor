import {
  parsePrintedAmount,
  normalizePrintedAmount,
  printedUnitPrecision,
  printedUnitScale,
} from "./printed-amount";
import {
  reportSchema,
  type Report,
  type ValueEvidence,
  getPath,
} from "./report-contract";
import { overlappingPaths } from "./review-state";
import type { Document, Finding } from "./types";
export const REPORT_CHECK_VERSION = "report-checks-v5";

export const normalizationMessage =
  "Stored amount does not equal deterministic normalization of the literal printed number and unit.";
export function printedNumber(value: string): number | null {
  const parsed = parsePrintedAmount(value);
  return parsed.error ? null : parsed.number;
}
export function normalizedPrinted(v: ValueEvidence): number | null {
  return normalizePrintedAmount(v);
}
export function isPaymentMagnitudePath(path: string) {
  return /(?:^|\.)(?:purchasesOfPropertyAndEquipment|purchasesOfIntangibles|combinedPropertyEquipmentAndIntangiblePurchases|shareRepurchases|dividendsPaid)$/.test(
    path,
  );
}
/** The UI and blocking check use the same arithmetic, never two conversions. */
export function normalizationDetails(v: ValueEvidence, path: string) {
  const parsed = parsePrintedAmount(v.reportedValue, v.reportedUnit),
    converted = normalizedPrinted(v),
    magnitude = isPaymentMagnitudePath(path);
  const expected =
    converted === null ? null : magnitude ? Math.abs(converted) : converted;
  const scale = printedUnitScale(v.unit, v.reportedUnit) ?? 1,
    tolerance = Math.max(1e-8, Math.abs(expected || 0) * 1e-9);
  const matches =
    expected !== null &&
    Number.isFinite(v.value) &&
    Math.abs(v.value - expected) <= tolerance;
  const problem =
    parsed.error ||
    (converted === null
      ? "The printed unit cannot be converted to the stored unit without an unsupported conversion."
      : matches
        ? null
        : normalizationMessage);
  return {
    literal: v.reportedValue,
    reportedUnit: v.reportedUnit,
    stored: v.value,
    unit: v.unit,
    parsed: parsed.error ? null : parsed.number,
    scale,
    expected,
    magnitude,
    tolerance,
    matches,
    problem,
    approximate: !!parsed.approximate,
    blocking: !parsed.error || parsed.errorKind === "unit_mismatch",
  };
}
export function normalizationFindings(report: Report): Finding[] {
  const issues: (Finding & {
    code: "printed_normalization";
    normalization: ReturnType<typeof normalizationDetails>;
  })[] = [];
  walkEvidence(report, (node, path) => {
    if (node.type !== "Value") return;
    const details = normalizationDetails(node, path);
    if (!details.matches)
      issues.push({
        path,
        effect: details.blocking ? "block" : "warning",
        code: "printed_normalization",
        reason:
          details.expected === null && !details.blocking
            ? "Could not validate the printed notation. The stored value has not been cleared. " +
              details.problem
            : details.problem || normalizationMessage,
        normalization: details,
      });
  });
  return issues;
}
export function refreshNormalizationFindings(
  report: Report,
  issues: Finding[],
): Finding[] {
  return [
    ...issues.filter(
      (i) =>
        i.code !== "printed_normalization" && i.reason !== normalizationMessage,
    ),
    ...normalizationFindings(report),
  ];
}
/** A broad blocking path can point the editor at the specific metadata field. */
export function reviewFieldPath(finding: Finding) {
  if (
    finding.path === "currentQuarter" &&
    finding.reason ===
      "The current quarter must match the source document's exact fiscal metadata."
  )
    return "currentQuarter.period";
  if (
    finding.path === "currentQuarter.balanceSheet" &&
    finding.reason ===
      "Current balances require an explicit as-of date matching quarter end."
  )
    return "currentQuarter.balanceSheet.asOf";
  if (
    finding.path === "currentQuarter.cashFlow.yearToDate" &&
    finding.reason ===
      "Current YTD cash flow must end at the current quarter end."
  )
    return "currentQuarter.cashFlow.yearToDate.period";
  return finding.path;
}
/** Locate the cited evidence for a field, parent section or source subfield. */
export function evidenceForPath(report: Report, path: string): any {
  let target: any;
  try {
    target = getPath(report, path);
  } catch {
    return undefined;
  }
  if (target?.source?.page) return target;
  let first: any;
  walkEvidence(target, (node) => {
    first ||= node;
  });
  if (first) return first;
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  while (parts.length > 1) {
    parts.pop();
    const node = getPath(report, parts.join("."));
    if (node?.source?.page) return node;
  }
  return undefined;
}
export function precision(v: ValueEvidence): number {
  return printedUnitPrecision(v);
}
export function walkEvidence(
  value: any,
  visit: (node: any, path: string) => void,
  path = "",
) {
  if (!value || typeof value !== "object") return;
  if (value.type === "Value" || value.type === "Statement") {
    visit(value, path);
    return;
  }
  for (const [key, child] of Object.entries(value))
    walkEvidence(child, visit, path ? `${path}.${key}` : key);
}
export function reportIssues(report: Report, doc: Document): Finding[] {
  reportSchema.parse(report);
  const issues: Finding[] = normalizationFindings(report);
  const add = (
    path: string,
    reason: string,
    effect: Finding["effect"] = "block",
  ) => issues.push({ path, reason, effect });
  const period = report.currentQuarter.period;
  if (
    period.label !== doc.quarter ||
    period.start !== doc.periodStart ||
    period.end !== doc.periodEnd
  )
    add(
      "currentQuarter",
      "The current quarter must match the source document's exact fiscal metadata.",
    );
  walkEvidence(report, (node, path) => {
    const source = node.source;
    if (
      [source.page, ...source.location.contextPages].some(
        (n) => !doc.pages.some((p) => p.page === n),
      )
    )
      add(path, "Evidence cites a physical PDF page that does not exist.");
    if (node.type === "Statement") return;
    const loc = source.location;
    const label =
      loc.type === "Table"
        ? `${loc.tableTitle || ""} ${loc.rowLabel} ${loc.columnLabel}`
        : loc.section;
    if (
      /^currentQuarter\.(?:incomeStatement|cashFlow\.quarter)\./.test(path) &&
      /\b(year[- ]to[- ]date|YTD|full[- ]year|year ended|twelve months|six months|nine months)\b/i.test(
        label,
      )
    )
      add(
        path,
        "Quarterly actual cites an annual/YTD column or statement. Use the explicit quarterly source, or leave the quarterly slot null.",
      );
    if (
      /(?:^|\.)revenue$/.test(path) &&
      /\b(investment|invest(?:s|ed|ing)?\s+in|equity\s+(?:subscription|contribution)|capital\s+contribution|stock\s+(?:purchase|subscription)|financing\s+proceeds|loan\s+proceeds)\b/i.test(
        label,
      )
    )
      add(
        path,
        "The cited revenue source describes an investment/funding transaction; route the transaction to events and cite an actual sales line for revenue.",
      );
    // Locator-based checks do not establish visual source correctness.
    if (
      loc.type === "Narrative" &&
      !doc.pages.find((p) => p.page === source.page)?.text?.trim()
    )
      add(
        path,
        "No selectable source text is available; the PDF image still needs source review.",
        "warning",
      );
  });
  function periods(value: any, path: string) {
    if (!value || typeof value !== "object") return;
    if (["Quarter", "YearToDate", "Annual"].includes(value.type)) {
      if (value.start && value.end && value.start > value.end)
        add(path, "Reporting period is reversed.");
      if (
        value.end &&
        value.end > doc.publishedAt &&
        !path.startsWith("guidance")
      )
        add(path, "An actual reporting period ends after publication.");
    }
    if (
      value.type === "Range" &&
      value.target.lower.value > value.target.upper.value
    )
      add(path, "Guidance range bounds are reversed.");
    if (value.type === "CenterAndTolerance" && value.target.tolerance.value < 0)
      add(path, "Guidance tolerance cannot be negative.");
    for (const [k, v] of Object.entries(value))
      periods(v, path ? `${path}.${k}` : k);
  }
  periods(report, "");
  const bs = report.currentQuarter.balanceSheet;
  if (Object.values(bs.values).some(Boolean) && bs.asOf !== doc.periodEnd)
    add(
      "currentQuarter.balanceSheet",
      "Current balances require an explicit as-of date matching quarter end.",
    );
  if (
    report.currentQuarter.cashFlow.yearToDate?.period.end !== undefined &&
    report.currentQuarter.cashFlow.yearToDate?.period.end !== doc.periodEnd
  )
    add(
      "currentQuarter.cashFlow.yearToDate",
      "Current YTD cash flow must end at the current quarter end.",
    );
  for (const [i, c] of report.comparativePeriods.entries()) {
    if (
      c.type === "IncomeStatement" &&
      c.period.type === "Quarter" &&
      c.period.start === doc.periodStart &&
      c.period.end === doc.periodEnd
    )
      add(
        `comparativePeriods.${i}`,
        "Current-quarter consolidated results belong only in currentQuarter.",
      );
  }
  const seen = new Set<string>();
  for (const [i, e] of report.events.entries()) {
    const key = [e.transactionKey, e.status, e.date].join("|");
    if (seen.has(key))
      add(
        `events.${i}`,
        "Repeated transaction stage; consolidate repeated mentions rather than counting another event.",
      );
    seen.add(key);
    if (
      e.type === "Investment" &&
      /\b(acqui(?:re|red|sition)\s+(?:of\s+)?control|business combination)\b/i.test(
        e.terms.text,
      )
    )
      add(
        `events.${i}`,
        "An explicitly identified acquisition of control belongs in Acquisition.",
      );
  }
  // Only use directly reported identities whose line definitions support them.
  for (const basis of ["gaap", "nonGaap"] as const) {
    const p = `currentQuarter.incomeStatement.${basis}`,
      income = getPath(report, p);
    if (
      income.revenue &&
      income.grossProfit &&
      income.grossMargin &&
      income.revenue.value !== 0
    ) {
      const calculated =
        (100 * income.grossProfit.value) / income.revenue.value;
      const tolerance =
        precision(income.grossMargin) +
        100 *
          (precision(income.grossProfit) / Math.abs(income.revenue.value) +
            (Math.abs(income.grossProfit.value) * precision(income.revenue)) /
              income.revenue.value ** 2);
      if (Math.abs(calculated - income.grossMargin.value) > tolerance + 1e-6)
        add(
          p + ".grossMargin",
          "Reported gross margin does not reconcile with same-basis gross profit/revenue within printed precision.",
          "warning",
        );
    }
  }
  if (
    !report.currentQuarter.incomeStatement.gaap.revenue &&
    !report.coverage.some(
      (c) => c.path === "currentQuarter.incomeStatement.gaap.revenue",
    )
  )
    add(
      "currentQuarter.incomeStatement.gaap.revenue",
      "Revenue is unavailable; add a source-grounded coverage explanation.",
      "warning",
    );
  return issues;
}
export function blocksPath(issues: Finding[], path: string): boolean {
  return issues.some(
    (i) =>
      i.effect === "block" &&
      (i.path === path ||
        path.startsWith(i.path + ".") ||
        i.path.startsWith(path + ".")),
  );
}

/** Convert only an unambiguous printed number plus its declared unit. The
 * original literal/unit remain evidence; model arithmetic is never authoritative. */
export function normalizeReportAmounts(
  input: Report,
  protectedPaths: string[] = [],
) {
  const report = structuredClone(input);
  const adjustments: { path: string; previous: number; value: number }[] = [];
  walkEvidence(report, (node, path) => {
    if (
      node.type !== "Value" ||
      protectedPaths.some((p) => overlappingPaths(p, path))
    )
      return;
    const n = normalizedPrinted(node);
    if (n === null) return;
    const expected = isPaymentMagnitudePath(path) ? Math.abs(n) : n;
    if (node.value !== expected) {
      adjustments.push({ path, previous: node.value, value: expected });
      node.value = expected;
    }
  });
  return { report: reportSchema.parse(report), adjustments };
}
