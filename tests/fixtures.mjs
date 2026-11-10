import {
  gaapSchema,
  nonGaapSchema,
  cashFlowSchema,
  balanceSheetSchema,
  publicationMetrics,
  normalizeReportPath,
} from "../lib/report-contract.ts";
export const source = (row = "Revenue") => ({
  page: 1,
  location: {
    type: "Table",
    tableTitle: "Consolidated statements of operations",
    rowLabel: row,
    columnLabel: "Three months ended",
    contextPages: [],
  },
});
export const value = (
  n = 1000,
  row = "Revenue",
  unit = "USD_millions",
  reportedUnit = unit,
) => ({
  type: "Value",
  value: n,
  unit,
  reportedValue: String(n),
  reportedUnit,
  source: source(row),
});
export const statement = (text = "Agreed strategic equity investment") => ({
  type: "Statement",
  text,
  source: {
    page: 1,
    location: {
      type: "Narrative",
      section: "Investment agreement",
      contextPages: [],
    },
  },
});
export const investment = (investor = "NVIDIA", amount = 5000) => ({
  type: "Investment",
  transactionKey: `${investor} equity subscription in Intel`,
  date: null,
  status: "Agreed",
  terms: statement(),
  direction: "Inbound",
  investor,
  recipient: "Intel",
  instrument: "Common stock",
  amount: value(amount, "Equity subscription"),
});
const slots = (s) =>
  Object.fromEntries(Object.keys(s.shape).map((k) => [k, null]));
export function report(doc) {
  return {
    currentQuarter: {
      period: {
        type: "Quarter",
        label: doc.quarter,
        start: doc.periodStart,
        end: doc.periodEnd,
      },
      incomeStatement: {
        gaap: { ...slots(gaapSchema), revenue: value() },
        nonGaap: slots(nonGaapSchema),
      },
      cashFlow: { quarter: slots(cashFlowSchema), yearToDate: null },
      balanceSheet: { asOf: null, values: slots(balanceSheetSchema) },
    },
    businessBreakdowns: [],
    comparativePeriods: [],
    guidance: [],
    events: [],
    risks: [],
    coverage: [],
  };
}
export function review(documents, reports, overrides = {}) {
  return {
    reviewedDocumentIds: documents.map((d) => d.id),
    summary:
      "Checked supplied PDFs, typed classifications and quarterly source selections.",
    corrections: [],
    findings: [],
    selections: [...new Set(documents.map((d) => d.quarter))].map(
      (quarter) => ({
        quarter,
        choices: Object.fromEntries(
          publicationMetrics.map((metric) => {
            const r = reports.find(
              (r) =>
                r.documentId ===
                documents.find((d) => d.quarter === quarter)?.id,
            );
            return [
              metric,
              {
                documentId: metric === "revenue" ? r?.documentId || null : null,
                reason:
                  metric === "revenue"
                    ? "Source-supported current-quarter consolidated revenue."
                    : "Not directly reported in the source.",
              },
            ];
          }),
        ),
      }),
    ),
    ...overrides,
  };
}
export const doc = {
  id: "d1",
  companyId: "c1",
  title: "Issuer report",
  kind: "earnings_release",
  quarter: "2025-Q1",
  periodStart: "2025-01-01",
  periodEnd: "2025-03-31",
  publishedAt: "2025-04-28",
  sha256: "hash",
  url: "",
  pdfUrl: "/pdfs/test.pdf",
  pages: [
    {
      page: 1,
      text: "Revenue 1000. NVIDIA agrees to invest in Intel common stock.",
    },
  ],
};

/** Test-only encoding of an intended normalized result into the generated wire contract. */
export function wireReview(contract, result) {
  const output = {
    summary: result.summary,
    changes: Object.fromEntries(
      contract.targets.changes.map((t) => [t.target, null]),
    ),
    additions: [],
    documents: Object.fromEntries(
      Object.keys(contract.targets.findings).map((id) => [
        id,
        { findings: [] },
      ]),
    ),
    selections: Object.fromEntries(
      result.selections.map(({ quarter, ...s }) => [quarter, s]),
    ),
  };
  for (const correction of result.corrections) {
    const append = correction.index === null;
    const target = (
      append ? contract.targets.additions : contract.targets.changes
    ).find(
      (t) =>
        t.documentId === correction.documentId &&
        t.path === correction.path &&
        (append || t.index === correction.index),
    );
    if (!target)
      throw Error("Test requested an unavailable correction target.");
    const value = { reason: correction.reason, value: correction.value };
    if (append) output.additions.push({ target: target.target, ...value });
    else output.changes[target.target] = value;
  }
  for (const f of result.findings)
    output.documents[f.documentId].findings.push({
      target: contract.targets.findings[f.documentId].indexOf(
        normalizeReportPath(f.path),
      ),
      effect: f.effect,
      reason: f.reason,
    });
  return output;
}
