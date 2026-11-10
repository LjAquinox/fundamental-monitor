import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { modelJsonSchema } from "../lib/structured-output.ts";
import {
  CONTRACT_VERSION,
  reportSchema,
  publicationSlots,
  getPath,
} from "../lib/report-contract.ts";
import {
  selectedSeries,
  derivedMetrics,
  displayedNetIncome,
  forecastOutcomes,
} from "../lib/selections.ts";
import { doc, report, value } from "./fixtures.mjs";

function setup() {
  const document = { ...doc },
    input = report(document);
  Object.assign(input.currentQuarter.incomeStatement.gaap, {
    revenue: value(46743),
    operatingIncome: value(28440, "Operating income"),
    netIncome: { ...value(26422, "Net income"), attribution: "Unspecified" },
  });
  reportSchema.parse(input);
  const revision = {
    contractVersion: CONTRACT_VERSION,
    id: "revision",
    documentId: doc.id,
    companyId: doc.companyId,
    revision: 1,
    sourceHash: doc.sha256,
    runId: null,
    reviewId: "review",
    at: "2025-05-01",
    reason: "Fixture",
    report: input,
    issues: [],
  };
  const publication = {
    contractVersion: CONTRACT_VERSION,
    id: "pub",
    companyId: doc.companyId,
    reviewId: "review",
    at: "2025-05-01",
    snapshots: { [doc.id]: { revision: 1, hash: doc.sha256 } },
    selections: [
      {
        quarter: doc.quarter,
        choices: Object.fromEntries(
          Object.entries(publicationSlots).map(([metric, slot]) => [
            metric,
            {
              source:
                getPath(input, slot.path)?.type === "Value"
                  ? { documentId: doc.id, revision: 1, path: slot.path }
                  : null,
              reason: "Fixture source selection.",
            },
          ]),
        ),
      },
    ],
    findings: [],
    summary: "Fixture",
  };
  return {
    ws: {
      contractVersion: CONTRACT_VERSION,
      token: "",
      companies: [],
      documents: [document],
      reports: [revision],
      publications: [publication],
      forecasts: [],
      companyReviews: [],
      audit: [],
    },
    input,
    revision,
    publication,
  };
}
const row = (ws) => selectedSeries(ws, doc.companyId)[0];

test("the generated extraction schema and parser share the new net-income attribution constraints", () => {
  const { input } = setup(),
    ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(modelJsonSchema(reportSchema));
  assert(validate(input));
  assert(reportSchema.safeParse(input).success);
  for (const invalid of [
    {
      ...input.currentQuarter.incomeStatement.gaap.netIncome,
      attribution: "Parent",
    },
    {
      ...input.currentQuarter.incomeStatement.gaap.netIncome,
      attribution: undefined,
    },
  ]) {
    const draft = structuredClone(input);
    draft.currentQuarter.incomeStatement.gaap.netIncome = invalid;
    assert.equal(validate(draft), false);
    assert.equal(reportSchema.safeParse(draft).success, false);
  }
  const parent = structuredClone(input);
  parent.currentQuarter.incomeStatement.gaap.netIncomeAttributableToParent = {
    ...input.currentQuarter.incomeStatement.gaap.netIncome,
  };
  assert.equal(validate(parent), false);
  assert.equal(reportSchema.safeParse(parent).success, false);
});

test("NVIDIA-style reported inputs produce a labelled GAAP margin with both sources, without creating extraction evidence", () => {
  const { ws, input } = setup(),
    margin = row(ws).metrics.operatingMargin;
  assert(Math.abs(margin.value - 60.84333483088377) < 1e-10);
  assert.equal(margin.origin, "calculated");
  assert.equal(margin.source, null);
  assert.equal(margin.sources.length, 2);
  assert.equal(margin.operands[0].metric, "operatingIncome");
  assert.equal(margin.operands[1].metric, "revenue");
  assert.equal(input.currentQuarter.incomeStatement.gaap.operatingMargin, null);
  assert.equal(
    ws.publications[0].selections[0].choices.operatingMargin.source,
    null,
  );
  assert.equal(
    derivedMetrics(ws, doc.companyId)[0].calculatedOperatingMargin,
    margin.value,
  );
});
test("direct margins take precedence including zero; zero/negative operating income remain valid calculations", () => {
  const { ws, input, publication } = setup();
  input.currentQuarter.incomeStatement.gaap.operatingMargin = value(
    0,
    "Operating margin",
    "percent",
  );
  publication.selections[0].choices.operatingMargin.source = {
    documentId: doc.id,
    revision: 1,
    path: publicationSlots.operatingMargin.path,
  };
  assert.equal(row(ws).metrics.operatingMargin.value, 0);
  assert.equal(row(ws).metrics.operatingMargin.origin, "reported");
  input.currentQuarter.incomeStatement.gaap.operatingMargin = null;
  publication.selections[0].choices.operatingMargin.source = null;
  input.currentQuarter.incomeStatement.gaap.operatingIncome.value = 0;
  assert.equal(row(ws).metrics.operatingMargin.value, 0);
  input.currentQuarter.incomeStatement.gaap.operatingIncome.value = -100;
  assert(row(ws).metrics.operatingMargin.value < 0);
});
test("unreviewed, blocked, wrong-quarter, zero-revenue and non-GAAP-only inputs cannot create a GAAP margin", () => {
  const mutate = [
    (x) => x.ws.publications.splice(0),
    (x) =>
      x.revision.issues.push({
        path: publicationSlots.operatingIncome.path,
        effect: "block",
        reason: "Unresolved source",
      }),
    (x) => (x.publication.selections[0].choices.operatingIncome.source = null),
    (x) => (x.input.currentQuarter.incomeStatement.gaap.revenue.value = 0),
    (x) => (x.input.currentQuarter.period.start = "2024-01-01"),
    (x) => {
      x.input.currentQuarter.incomeStatement.gaap.operatingIncome = null;
      x.input.currentQuarter.incomeStatement.nonGaap.operatingIncome =
        value(100);
    },
    (x) => (x.ws.documents[0].quarter = "2025-Q2"),
  ];
  for (const change of mutate) {
    const x = setup();
    change(x);
    assert(
      selectedSeries(x.ws, doc.companyId).every(
        (r) => r.metrics.operatingMargin.value === null,
      ),
    );
  }
  const x = setup();
  assert.equal(selectedSeries(x.ws, doc.companyId, "2025-01-01").length, 0);
});
test("operating-margin operands cannot silently mix report revisions or monetary units", () => {
  const { ws, input, publication } = setup(),
    other = { ...ws.documents[0], id: "other" };
  ws.documents.push(other);
  ws.reports.push({
    ...ws.reports[0],
    id: "other-revision",
    documentId: "other",
    report: structuredClone(input),
  });
  publication.snapshots.other = { revision: 1, hash: other.sha256 };
  publication.selections[0].choices.operatingIncome.source.documentId = "other";
  assert.equal(row(ws).metrics.operatingMargin.value, null);
  publication.selections[0].choices.operatingIncome.source.documentId = doc.id;
  input.currentQuarter.incomeStatement.gaap.operatingIncome.unit = "USD";
  assert.equal(row(ws).metrics.operatingMargin.value, null);
});
test("generic and parent-attributable net income stay distinct and the displayed definition is explicit", () => {
  const { ws, input, publication } = setup();
  let metrics = row(ws).metrics;
  assert.equal(metrics.netIncome.value, 26422);
  assert.equal(metrics.netIncomeAttributableToParent.value, null);
  assert.equal(displayedNetIncome(metrics).label, "Net income (reported)");
  input.currentQuarter.incomeStatement.gaap.netIncome.attribution =
    "Consolidated";
  input.currentQuarter.incomeStatement.gaap.netIncomeAttributableToParent =
    value(26000, "Net income attributable to parent");
  publication.selections[0].choices.netIncomeAttributableToParent.source = {
    documentId: doc.id,
    revision: 1,
    path: publicationSlots.netIncomeAttributableToParent.path,
  };
  metrics = row(ws).metrics;
  assert.equal(metrics.netIncome.label, "Net income (consolidated)");
  assert.equal(displayedNetIncome(metrics).value, 26000);
  assert.equal(metrics.netIncome.value, 26422);
  assert.match(displayedNetIncome(metrics).label, /attributable to parent/);
  const wrong = structuredClone(input);
  wrong.currentQuarter.incomeStatement.gaap.netIncome.attribution = "Parent";
  assert.equal(reportSchema.safeParse(wrong).success, false);
});
test("outcome comparisons accept calculated margin history and retain frozen baseline method", () => {
  const { ws } = setup();
  const forecast = {
    companyId: doc.companyId,
    quarter: "2024-Q4",
    inputSnapshot: JSON.stringify({
      financial: [
        {
          quarter: "2024-Q4",
          metrics: { operatingMargin: { value: 50, origin: "calculated" } },
        },
      ],
    }),
    predictions: [{ metric: "operating_margin", direction: "increase" }],
  };
  const outcome = forecastOutcomes(ws, forecast)[0];
  assert.equal(outcome.baseline, 50);
  assert.equal(outcome.status, "Correct");
  assert.equal(outcome.baselineOrigin, "calculated");
  assert.equal(outcome.actualOrigin, "calculated");
});
