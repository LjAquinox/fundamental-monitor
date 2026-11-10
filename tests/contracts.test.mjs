import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { z } from "zod/v4";
import { modelContracts, checkModelContracts } from "../lib/model-contracts.ts";
import {
  modelJsonSchema,
  assertModelBudget,
} from "../lib/structured-output.ts";
import { reportSchema, reconciliationSchema } from "../lib/report-contract.ts";
import { reportIssues } from "../lib/report-checks.ts";
import {
  doc,
  report,
  value,
  investment,
  review,
  wireReview,
} from "./fixtures.mjs";
const ajv = new Ajv({ strict: false });
addFormats(ajv);
function parity(schema, valid, invalid) {
  const check = ajv.compile(modelJsonSchema(schema));
  for (const data of valid) {
    assert.equal(schema.safeParse(data).success, true);
    assert.equal(check(data), true, JSON.stringify(check.errors));
  }
  for (const data of invalid) {
    assert.equal(schema.safeParse(data).success, false);
    assert.equal(check(data), false);
  }
}
test("static request contracts compile within provider budgets and retain routing descriptions", () => {
  assert.deepEqual(checkModelContracts(), [
    "extraction",
    "discovery",
    "forecast",
  ]);
  for (const s of Object.values(modelContracts))
    assert.ok(assertModelBudget(modelJsonSchema(s)).maxDepth <= 10);
  const json = JSON.stringify(modelJsonSchema(reportSchema));
  assert.ok(json.includes("$defs"));
  assert.ok(json.includes("NVIDIA/SoftBank"));
  assert.ok(json.includes("Never use investments"));
  assert.notDeepEqual(
    modelJsonSchema(reportSchema),
    modelJsonSchema(modelContracts.discovery),
  );
  assert.ok(Object.isFrozen(modelJsonSchema(reportSchema)));
});
test("report shape and enum restrictions agree between API JSON Schema and parser", () => {
  const r = report(doc);
  r.events = [investment()];
  const badUnits = structuredClone(r);
  badUnits.currentQuarter.incomeStatement.gaap.revenue.unit = "basis_points";
  const unknown = structuredClone(r);
  unknown.observations = [];
  const statementRevenue = structuredClone(r);
  statementRevenue.currentQuarter.incomeStatement.gaap.revenue =
    investment().terms;
  const wrongEvent = structuredClone(r);
  wrongEvent.events[0].type = "Revenue";
  const missing = structuredClone(r);
  delete missing.risks;
  parity(
    reportSchema,
    [r],
    [badUnits, unknown, statementRevenue, wrongEvent, missing],
  );
});
test("every evidence, breakdown, guidance and event variant has API/parser parity", () => {
  const r = report(doc);
  r.businessBreakdowns = [
    {
      type: "Segment",
      name: "Data Center",
      period: r.currentQuarter.period,
      accountingBasis: "GAAP",
      revenue: value(500),
      operatingIncome: null,
      assets: null,
      definition: null,
    },
    {
      type: "Geography",
      name: "US",
      geographyLevel: "Country",
      period: r.currentQuarter.period,
      accountingBasis: "GAAP",
      revenue: value(500),
    },
    {
      type: "Product",
      name: "Chip",
      period: r.currentQuarter.period,
      accountingBasis: "GAAP",
      revenue: value(100),
      unitsSold: null,
    },
  ];
  const terms = investment().terms,
    base = { date: null, status: "Agreed", terms, transactionKey: "deal" };
  r.events = [
    investment(),
    {
      type: "Financing",
      ...base,
      direction: "Inbound",
      lender: "Lender",
      borrower: "Issuer",
      instrument: "Convertible debt",
      amount: null,
    },
    {
      type: "Acquisition",
      ...base,
      acquirer: "Issuer",
      target: "Target",
      consideration: null,
    },
    {
      type: "Divestiture",
      ...base,
      seller: "Issuer",
      buyer: "Buyer",
      businessOrAssets: "Unit",
      proceeds: null,
    },
    { type: "Restructuring", ...base, affectedBusiness: "Unit", charge: null },
  ];
  r.events = r.events.map((e, i) => ({ ...e, transactionKey: `deal-${i}` }));
  r.guidance = [
    {
      type: "Point",
      horizon: r.currentQuarter.period,
      accountingBasis: "GAAP",
      target: { metric: "revenue", value: value() },
    },
    {
      type: "Range",
      horizon: r.currentQuarter.period,
      accountingBasis: "GAAP",
      target: { metric: "revenue", lower: value(900), upper: value(1100) },
    },
    {
      type: "CenterAndTolerance",
      horizon: r.currentQuarter.period,
      accountingBasis: "NonGAAP",
      target: {
        metric: "grossMargin",
        center: value(72, "Margin", "percent"),
        tolerance: {
          ...value(0.5, "Tolerance", "percentage_points", "basis_points"),
          reportedValue: "50",
        },
      },
    },
    {
      type: "Qualitative",
      topic: "Demand",
      horizon: r.currentQuarter.period,
      statement: terms,
    },
  ];
  r.risks = [
    {
      category: "Supply",
      affectedBusiness: null,
      change: "Unspecified",
      statement: terms,
    },
  ];
  parity(reportSchema, [r], []);
  assert.equal(
    reportIssues(r, doc).filter((i) => i.effect === "block").length,
    0,
  );
});
test("typed corrections derive financial slots and array items; cannot smuggle unsupported fields", () => {
  const result = review([doc], [{ documentId: doc.id }]);
  result.corrections = [
    {
      documentId: doc.id,
      reason: "Add the omitted equity transaction.",
      path: "events",
      index: null,
      value: investment(),
    },
    {
      documentId: doc.id,
      reason: "Remove the misplaced funding amount.",
      path: "currentQuarter.incomeStatement.gaap.revenue",
      value: null,
    },
  ];
  const invalid = structuredClone(result);
  invalid.corrections[1].value = investment();
  const badPath = structuredClone(result);
  badPath.corrections[0].path = "observations";
  parity(reconciliationSchema, [result], [invalid, badPath]);
});
test("unrepresentable schema behavior fails locally, never silently weakens the API contract", () => {
  for (const s of [
    z.object({ x: z.string().optional() }).strict(),
    z.object({ x: z.string().default("x") }).strict(),
    z.object({ x: z.string().transform((v) => v) }).strict(),
    z.object({ x: z.number().refine((v) => v > 0) }).strict(),
  ])
    assert.throws(() => modelJsonSchema(s));
  let s = z.string();
  for (let i = 0; i < 12; i++) s = z.object({ x: s }).strict();
  assert.throws(() => modelJsonSchema(s), /budgets/);
});
test("funding-source revenue is blocked while equal genuine sales and independent investments remain valid", () => {
  const r = report(doc);
  r.events = [investment("NVIDIA", 5000), investment("SoftBank", 2000)];
  r.currentQuarter.incomeStatement.gaap.revenue = value(5000);
  assert.equal(
    reportIssues(r, doc).filter((i) => i.effect === "block").length,
    0,
  );
  r.currentQuarter.incomeStatement.gaap.revenue.source.location.rowLabel =
    "NVIDIA equity subscription investment";
  assert.ok(
    reportIssues(r, doc).some(
      (i) => i.path.endsWith(".revenue") && i.effect === "block",
    ),
  );
});
test("units normalize basis points, scaled shares and printed parentheses without invented numbers", () => {
  const r = report(doc);
  r.currentQuarter.incomeStatement.gaap.dilutedWeightedAverageShares = {
    ...value(1e6, "Shares", "count", "count_millions"),
    reportedValue: "1",
  };
  r.currentQuarter.cashFlow.quarter.purchasesOfPropertyAndEquipment = {
    ...value(40, "Payments"),
    reportedValue: "(40)",
  };
  assert.equal(
    reportIssues(r, doc).filter((i) => i.effect === "block").length,
    0,
  );
  r.currentQuarter.incomeStatement.gaap.revenue.value = 1001;
  assert.ok(
    reportIssues(r, doc).some((i) => i.reason.includes("normalization")),
  );
});
test("period mismatch and nonexistent source pages cannot pass publication checks", () => {
  const r = report(doc);
  r.currentQuarter.period.end = "2024-03-31";
  r.currentQuarter.incomeStatement.gaap.revenue.source.page = 9;
  const issues = reportIssues(r, doc);
  assert.ok(issues.some((i) => i.path === "currentQuarter"));
  assert.ok(issues.some((i) => i.reason.includes("does not exist")));
});
test("forecast outcomes use frozen baselines and later selected same-quarter comparisons", async () => {
  const { forecastOutcomes } = await import("../lib/selections.ts");
  const { publicationSlots, publicationMetrics, CONTRACT_VERSION } =
    await import("../lib/report-contract.ts");
  const documents = [
    { ...doc, id: "previous", quarter: "2024-Q2" },
    { ...doc, id: "next", quarter: "2025-Q2" },
  ];
  const reports = documents.map((d, i) => {
    const r = report(d);
    r.currentQuarter.incomeStatement.gaap.revenue = value(i ? 1200 : 1000);
    r.currentQuarter.incomeStatement.gaap.operatingMargin = value(
      30,
      "Margin",
      "percent",
    );
    return {
      id: d.id,
      documentId: d.id,
      companyId: "c1",
      contractVersion: CONTRACT_VERSION,
      revision: 1,
      report: r,
      issues: [],
      sourceHash: d.sha256,
    };
  });
  const publication = {
    id: "p",
    companyId: "c1",
    contractVersion: CONTRACT_VERSION,
    snapshots: Object.fromEntries(
      documents.map((d) => [d.id, { hash: d.sha256, revision: 1 }]),
    ),
    selections: documents.map((d) => ({
      quarter: d.quarter,
      choices: Object.fromEntries(
        publicationMetrics.map((m) => [
          m,
          {
            source: ["revenue", "operatingMargin"].includes(m)
              ? {
                  documentId: d.id,
                  revision: 1,
                  path: publicationSlots[m].path,
                }
              : null,
            reason: "Supported current-quarter source.",
          },
        ]),
      ),
    })),
  };
  const ws = { documents, reports, publications: [publication] };
  const forecast = {
    companyId: "c1",
    quarter: "2025-Q1",
    inputSnapshot: JSON.stringify({
      financial: [
        { quarter: "2025-Q1", metrics: { operatingMargin: { value: 25 } } },
      ],
      calculated: [{ quarter: "2025-Q1", revenueYoY: 10 }],
    }),
    predictions: [
      { metric: "revenue_growth", direction: "increase" },
      { metric: "operating_margin", direction: "increase" },
    ],
  };
  const outcomes = forecastOutcomes(ws, forecast);
  assert.deepEqual(
    outcomes.map((v) => v.status),
    ["Correct", "Correct"],
  );
  assert.equal(outcomes[0].baseline, 10);
  assert.equal(outcomes[1].baseline, 25);
  assert.ok(Math.abs(outcomes[0].actual - 20) < 1e-8);
});

test("provider compatibility rejects ambiguous object union prefixes even when ordinary JSON Schema would accept them", () => {
  const oldGuidance = z
    .object({
      guidance: z.array(
        z.union([
          z
            .object({
              type: z.literal("Point"),
              metric: z.literal("revenue"),
              value: z.number(),
            })
            .strict(),
          z
            .object({
              type: z.literal("Point"),
              metric: z.literal("grossMargin"),
              value: z.number(),
            })
            .strict(),
        ]),
      ),
    })
    .strict();
  const oldCorrections = z
    .object({
      corrections: z.array(
        z.discriminatedUnion("path", [
          z
            .object({
              documentId: z.string(),
              path: z.literal("revenue"),
              value: z.number(),
            })
            .strict(),
          z
            .object({
              documentId: z.string(),
              path: z.literal("events"),
              value: z.array(z.string()),
            })
            .strict(),
        ]),
      ),
    })
    .strict();
  assert.throws(
    () => modelJsonSchema(oldGuidance),
    /ambiguous first key 'type'/,
  );
  assert.throws(
    () => modelJsonSchema(oldCorrections),
    /ambiguous first key 'documentId'/,
  );
});
test("guidance form and target metric have independent unique leading tags and metric-specific units", () => {
  const r = report(doc);
  r.guidance = [
    {
      type: "CenterAndTolerance",
      horizon: r.currentQuarter.period,
      accountingBasis: "GAAP",
      target: {
        metric: "grossMargin",
        center: value(70, "Margin", "percent"),
        tolerance: {
          ...value(0.5, "Tolerance", "percentage_points", "basis_points"),
          reportedValue: "50",
        },
      },
    },
  ];
  const bad = structuredClone(r);
  bad.guidance[0].target.center = value(70);
  parity(reportSchema, [r], [bad]);
  r.guidance[0].target.tolerance.value = -0.5;
  assert.ok(
    reportIssues(r, doc).some((i) =>
      i.reason.includes("tolerance cannot be negative"),
    ),
  );
});

test("all provider references are bare and retain described enum constraints", () => {
  function visit(v) {
    if (!v || typeof v !== "object") return;
    if (v.$ref) assert.deepEqual(Object.keys(v), ["$ref"]);
    for (const c of Object.values(v)) visit(c);
  }
  for (const schema of Object.values(modelContracts))
    visit(modelJsonSchema(schema));
  const r = report(doc);
  r.events = [investment()];
  parity(reportSchema, [r], []);
});

test("company transport derives original array bounds and quarter-specific sources from canonical inputs", async () => {
  const { companyResponseContract } =
    await import("../lib/company-response-contract.ts");
  const d2 = { ...doc, id: "d2", quarter: "2025-Q2" },
    r = report(doc),
    r2 = report(d2);
  r.events = [investment()];
  const c = companyResponseContract([
    { documentId: doc.id, quarter: doc.quarter, report: r },
    { documentId: d2.id, quarter: d2.quarter, report: r2 },
  ]);
  const good = review(
    [doc, d2],
    [
      { documentId: doc.id, report: r },
      { documentId: d2.id, report: r2 },
    ],
  );
  good.corrections = [
    {
      path: "events",
      documentId: doc.id,
      reason: "Correct transaction.",
      index: 0,
      value: investment(),
    },
  ];
  const wire = wireReview(c, good),
    change = c.targets.changes.find(
      (t) => t.documentId === doc.id && t.path === "events" && t.index === 0,
    );
  const invalid = [];
  const unknownChange = structuredClone(wire);
  unknownChange.changes.unknown = { reason: "Invented", value: null };
  invalid.push(unknownChange);
  const missing = structuredClone(wire);
  delete missing.changes[change.target];
  invalid.push(missing);
  const otherQuarter = structuredClone(wire);
  otherQuarter.selections[doc.quarter].choices.revenue.documentId = d2.id;
  invalid.push(otherQuarter);
  const unknown = structuredClone(wire);
  unknown.selections[doc.quarter].choices.revenue.documentId = "unknown";
  invalid.push(unknown);
  parity(c.schema, [wire], invalid);
  const normalized = c.normalize(wire);
  assert.equal(Object.hasOwn(normalized.corrections[0], "target"), false);
  assert.ok(reconciliationSchema.safeParse(normalized).success);
  const append = structuredClone(wire),
    target = c.targets.additions.find(
      (t) => t.documentId === d2.id && t.path === "events",
    );
  append.additions = [
    {
      target: target.target,
      reason: "Missing transaction.",
      value: investment(),
    },
  ];
  parity(c.schema, [append], []);
  append.additions[0].value = null;
  parity(c.schema, [], [append]);
  const many = Array.from({ length: 15 }, (_, i) => ({
    documentId: `d${i}`,
    quarter: `${2023 + Math.floor(i / 4)}-Q${(i % 4) + 1}`,
    report: r,
  }));
  assert.ok(
    assertModelBudget(modelJsonSchema(companyResponseContract(many).schema))
      .maxDepth <= 10,
  );
});
