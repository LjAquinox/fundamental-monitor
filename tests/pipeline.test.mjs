import { companyResponseContract } from "../lib/company-response-contract.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createLocalStorage } from "../local/storage.mjs";
import { setRuntime } from "../local/runtime.ts";
import { readWorkspace } from "../lib/server.ts";
import {
  CONTRACT_VERSION,
  publicationMetrics,
} from "../lib/report-contract.ts";
import { finishRun } from "../lib/model-workflow.ts";
import { acceptExtraction, editReport, readRun } from "../lib/report-store.ts";
import { startCompanyReview, getCompanyReview } from "../lib/company-review.ts";
import {
  applyCompanyResult,
  reconcileCompany,
} from "../lib/company-reconciliation.ts";
import {
  activePublication,
  selectedSeries,
  companySnapshot,
  derivedMetrics,
} from "../lib/selections.ts";
import {
  doc,
  report,
  value,
  investment,
  review,
  wireReview,
} from "./fixtures.mjs";
import { POST as extract } from "../app/api/extract/route.ts";
import { POST as forecast } from "../app/api/forecast/route.ts";
const root = resolve(import.meta.dirname, "..");
async function fixture(run) {
  const dir = mkdtempSync(resolve(root, "tests/.tmp-")),
    storage = createLocalStorage(root, dir);
  setRuntime({
    ...storage,
    OPENAI_API_KEY: "fake-never-live",
    LLM_MODEL: "gpt-6-luna",
    PDF_ASSETS: {
      read: () => new Uint8Array(Buffer.from("%PDF-1.4\nfixture")),
    },
  });
  const bytes = Buffer.from("%PDF-1.4\nfixture"),
    d = { ...doc, sha256: createHash("sha256").update(bytes).digest("hex") };
  await storage.DB.prepare("INSERT INTO companies(id,payload) VALUES(?,?)")
    .bind(
      "c1",
      JSON.stringify({
        id: "c1",
        name: "Issuer",
        ticker: "ISS",
        color: "#000",
        sector: "Unknown",
        aliases: ["Issuer", "ISS"],
      }),
    )
    .run();
  await storage.DB.prepare("INSERT INTO documents(id,payload) VALUES(?,?)")
    .bind(d.id, JSON.stringify((({ pages, ...v }) => v)(d)))
    .run();
  await storage.BUCKET.put(`pages/${d.id}.json`, JSON.stringify(d.pages));
  try {
    await run(storage, d);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
async function accepted(storage, d, r = report(d)) {
  const id = crypto.randomUUID(),
    ws = await readWorkspace(),
    baselineRevision =
      ws.reports.find((r) => r.documentId === d.id)?.revision || 0;
  await storage.DB.prepare("INSERT INTO runs(id,at,payload) VALUES(?,?,?)")
    .bind(id, new Date().toISOString(), "{}")
    .run();
  await finishRun(id, {
    kind: "extraction",
    status: "completed",
    contractVersion: CONTRACT_VERSION,
    documentId: d.id,
    sourceHash: d.sha256,
    baselineRevision,
    report: r,
  });
  return { id, ...(await acceptExtraction(id)) };
}
async function savedReview(job, result) {
  const ws = await readWorkspace();
  return {
    kind: "company_review",
    status: "completed",
    contractVersion: CONTRACT_VERSION,
    snapshots: companySnapshot(ws, job.companyId),
    result,
    usage: { inputTokens: 1, outputTokens: 1, estimatedCost: null },
  };
}
const req = (body) =>
  new Request("http://127.0.0.1:5173/api", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:5173",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

test("forecast uses the same calculated GAAP margin as the dashboard and freezes both input references", () =>
  fixture(async (storage, d) => {
    const older = {
      ...d,
      id: "older",
      quarter: "2024-Q1",
      periodStart: "2024-01-01",
      periodEnd: "2024-03-31",
      publishedAt: "2024-04-28",
    };
    await storage.DB.prepare("INSERT INTO documents(id,payload) VALUES(?,?)")
      .bind(older.id, JSON.stringify(older))
      .run();
    await storage.BUCKET.put(
      `pages/${older.id}.json`,
      JSON.stringify(older.pages),
    );
    for (const [document, revenue, operatingIncome] of [
      [older, 30040, 18642],
      [d, 46743, 28440],
    ]) {
      const input = report(document);
      Object.assign(input.currentQuarter.incomeStatement.gaap, {
        revenue: value(revenue),
        operatingIncome: value(operatingIncome, "Operating income"),
        netIncome: {
          ...value(26422, "Net income"),
          attribution: "Unspecified",
        },
      });
      await accepted(storage, document, input);
    }
    const ws = await readWorkspace(),
      job = await startCompanyReview("c1"),
      result = review([older, d], ws.reports);
    for (const selection of result.selections)
      for (const metric of ["revenue", "operatingIncome", "netIncome"])
        selection.choices[metric] = {
          documentId: selection.quarter === d.quarter ? d.id : older.id,
          reason: "Reviewed GAAP source.",
        };
    await applyCompanyResult(job, await savedReview(job, result));
    const margin = selectedSeries(await readWorkspace(), "c1").at(-1).metrics
      .operatingMargin;
    assert.equal(margin.origin, "calculated");
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body),
        input = JSON.parse(body.input[0].content.at(-1).text);
      const current = input.financial.at(-1),
        f = current.metrics.operatingMargin;
      assert.equal(f.value, margin.value);
      assert.equal(f.origin, "calculated");
      assert.equal(f.id, null);
      assert.equal(f.evidenceIds.length, 2);
      assert.equal(f.operands.length, 2);
      assert(f.formula.includes("operatingIncome"));
      assert.match(current.metrics.netIncome.definition, /not specified/);
      assert.deepEqual(
        input.calculated.at(-1).operatingMarginSources,
        f.evidenceIds,
      );
      return providerResponse({
        assessment: "Current GAAP operating margin has both reviewed inputs.",
        predictions: [
          {
            metric: "revenue_growth",
            direction: "stable",
            rationale: "Reviewed revenue history.",
            evidenceIds: [current.metrics.revenue.id],
            uncertainty: "Fixture.",
          },
          {
            metric: "operating_margin",
            direction: "increase",
            rationale: "Reviewed GAAP calculation.",
            evidenceIds: f.evidenceIds,
            uncertainty: "Fixture.",
          },
        ],
      });
    };
    try {
      const response = await forecast(
          req({ companyId: "c1", quarter: d.quarter, asOf: d.publishedAt }),
        ),
        out = await response.json();
      assert.equal(response.status, 200, JSON.stringify(out));
      const snapshot = JSON.parse(out.forecast.inputSnapshot),
        f = snapshot.financial.at(-1).metrics.operatingMargin;
      const references = f.evidenceIds.map(
        (id) => out.forecast.evidenceMap[id],
      );
      assert(references.some((ref) => ref.endsWith("gaap.operatingIncome")));
      assert(references.some((ref) => ref.endsWith("gaap.revenue")));
      assert.equal(f.value, margin.value);
    } finally {
      globalThis.fetch = original;
    }
  }));
function providerResponse(data) {
  return Response.json({
    id: "mock_response",
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(data) }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}
test("clean install has only documents, no resurrected curated observations or published revenue", () =>
  fixture(async () => {
    const ws = await readWorkspace();
    assert.ok(ws.documents.length >= 29);
    assert.equal(ws.reports.length, 0);
    assert.equal("observations" in ws, false);
    assert.equal(selectedSeries(ws, "c1")[0].metrics.revenue.value, null);
  }));

test("a review can remove an array item while findings retain original identities", () =>
  fixture(async (storage, d) => {
    const input = report(d);
    input.events = [investment("A"), investment("B"), investment("C")];
    await accepted(storage, d, input);
    const job = await startCompanyReview("c1"),
      ws = await readWorkspace();
    const result = review([d], ws.reports, {
      corrections: [
        {
          documentId: d.id,
          path: "events",
          index: 0,
          value: null,
          reason: "Remove duplicate A.",
        },
      ],
      findings: [
        {
          documentId: d.id,
          path: "events.0.amount",
          effect: "block",
          reason: "Duplicate A was removed.",
        },
        {
          documentId: d.id,
          path: "events.2.amount",
          effect: "warning",
          reason: "Inspect the amount for C.",
        },
      ],
    });
    const c = companyResponseContract([{ documentId: d.id, report: input }]);
    await applyCompanyResult(
      job,
      await savedReview(job, c.normalize(wireReview(c, result))),
    );
    const after = await readWorkspace(),
      r = after.reports.find((r) => r.documentId === d.id);
    assert.equal(r.report.events[0].investor, "B");
    assert.equal(r.report.events[1].investor, "C");
    assert(!r.issues.some((f) => f.reason === "Duplicate A was removed."));
    const active = r.issues.find(
      (f) => f.reason === "Inspect the amount for C.",
    );
    assert.equal(active.path, "events.1.amount");
    assert.equal(active.reference.inputPath, "events.2.amount");
    const archived = after.publications[0].findings.find(
      (f) => f.reason === "Duplicate A was removed.",
    );
    assert.equal(archived.reference.status, "superseded_by_correction");
    assert(archived.resolvedAt);
    assert(activePublication(after, "c1"));
  }));

test("findings on children of a cleared nullable object become review history", () =>
  fixture(async (storage, d) => {
    const input = report(d);
    input.currentQuarter.cashFlow.yearToDate = {
      period: {
        type: "YearToDate",
        label: "Current YTD",
        start: d.periodStart,
        end: d.periodEnd,
      },
      values: {
        ...input.currentQuarter.cashFlow.quarter,
        operatingCashFlow: value(12, "Operating cash flow"),
      },
    };
    await accepted(storage, d, input);
    const job = await startCompanyReview("c1"),
      ws = await readWorkspace();
    const result = review([d], ws.reports, {
      corrections: [
        {
          documentId: d.id,
          path: "currentQuarter.cashFlow.yearToDate",
          value: null,
          reason: "Remove duplicate YTD.",
        },
      ],
      findings: [
        {
          documentId: d.id,
          path: "currentQuarter.cashFlow.yearToDate.values.operatingCashFlow",
          effect: "warning",
          reason: "Input duplicated quarterly cash flow.",
        },
      ],
    });
    const c = companyResponseContract([{ documentId: d.id, report: input }]);
    await applyCompanyResult(
      job,
      await savedReview(job, c.normalize(wireReview(c, result))),
    );
    const after = await readWorkspace();
    assert.equal(
      after.publications[0].findings[0].reference.status,
      "superseded_by_correction",
    );
    assert.equal(
      after.reports[0].report.currentQuarter.cashFlow.yearToDate,
      null,
    );
    assert(activePublication(after, "c1"));
  }));
test("acceptance is idempotent; fresh extraction replaces one active report and retains immutable history", () =>
  fixture(async (s, d) => {
    const a = await accepted(s, d);
    await acceptExtraction(a.id);
    assert.equal(
      (await readWorkspace()).reports.find((r) => r.documentId === d.id)
        .revision,
      1,
    );
    const initial = report(d);
    initial.events = [investment()];
    initial.guidance = [
      {
        type: "Point",
        horizon: {
          type: "Quarter",
          label: "2025-Q2",
          start: "2025-04-01",
          end: "2025-06-30",
        },
        accountingBasis: "GAAP",
        target: { metric: "revenue", value: value(10000, "Revenue outlook") },
      },
    ];
    await accepted(s, d, initial);
    const ws = await readWorkspace();
    assert.equal(ws.reports.filter((r) => r.documentId === d.id).length, 1);
    assert.equal(ws.reports.find((r) => r.documentId === d.id).revision, 2);
    assert.equal(
      (
        await s.DB.prepare("SELECT * FROM reports WHERE document_id=?")
          .bind(d.id)
          .all()
      ).results.length,
      2,
    );
    assert.equal(activePublication(ws, "c1"), null);
  }));
test("global review adds missing investment and fixes wrong revenue atomically; dashboard never selects a segment or investment", () =>
  fixture(async (s, d) => {
    const r = report(d);
    r.currentQuarter.incomeStatement.gaap.revenue = value(
      5000,
      "NVIDIA investment",
    );
    r.businessBreakdowns = [
      {
        type: "Segment",
        name: "Data Center",
        period: r.currentQuarter.period,
        accountingBasis: "GAAP",
        revenue: value(9000),
        operatingIncome: null,
        assets: null,
        definition: null,
      },
    ];
    await accepted(s, d, r);
    const job = await startCompanyReview("c1");
    const result = review([d], (await readWorkspace()).reports, {
      corrections: [
        {
          documentId: d.id,
          reason: "Use sales rather than equity proceeds.",
          path: "currentQuarter.incomeStatement.gaap.revenue",
          value: value(1000),
        },
        {
          documentId: d.id,
          reason: "Add omitted inbound investment.",
          path: "events",
          index: null,
          value: investment(),
        },
      ],
    });
    await applyCompanyResult(job, await savedReview(job, result));
    const ws = await readWorkspace();
    assert.equal(selectedSeries(ws, "c1")[0].metrics.revenue.value, 1000);
    assert.equal(
      ws.reports.find((r) => r.documentId === d.id).report.events[0].investor,
      "NVIDIA",
    );
    assert.equal((await getCompanyReview(job.id)).status, "completed");
    await applyCompanyResult(job, {});
    assert.equal(
      (await readWorkspace()).reports.find((r) => r.documentId === d.id)
        .revision,
      2,
    );
  }));
test("schema-valid funding revenue remains unpublished when global reviewer misses its semantic error", () =>
  fixture(async (s, d) => {
    const r = report(d);
    r.currentQuarter.incomeStatement.gaap.revenue = value(
      5000,
      "Equity investment contribution",
    );
    await accepted(s, d, r);
    const job = await startCompanyReview("c1");
    await applyCompanyResult(
      job,
      await savedReview(job, review([d], (await readWorkspace()).reports)),
    );
    assert.equal(
      selectedSeries(await readWorkspace(), "c1")[0].metrics.revenue.value,
      null,
    );
  }));
test("failed or stale review never partially applies decisions; manual edit invalidates selections", () =>
  fixture(async (s, d) => {
    await accepted(s, d);
    let job = await startCompanyReview("c1");
    let saved = await savedReview(
      job,
      review([d], (await readWorkspace()).reports),
    );
    saved.result.corrections = [
      {
        documentId: d.id,
        reason: "A valid correction.",
        path: "events",
        index: null,
        value: investment(),
      },
      {
        documentId: d.id,
        reason: "Invalid array index.",
        path: "events",
        index: 10,
        value: null,
      },
    ];
    await assert.rejects(() => applyCompanyResult(job, saved), /index/);
    assert.equal(
      (await readWorkspace()).reports.find((r) => r.documentId === d.id)
        .revision,
      1,
    );
    assert.equal(activePublication(await readWorkspace(), "c1"), null);
    saved = await savedReview(
      job,
      review([d], (await readWorkspace()).reports),
    );
    await applyCompanyResult(job, saved);
    await editReport(d.id, 2, report(d), "Source correction for test.");
    assert.equal(activePublication(await readWorkspace(), "c1"), null);
    await assert.rejects(
      () => applyCompanyResult({ ...job, id: "other" }, saved),
      /conflict/,
    );
  }));
test("array corrections use original indexes regardless of removal/append order and preserve independent transactions", () =>
  fixture(async (s, d) => {
    const r = report(d);
    r.events = [investment("A"), investment("B"), investment("C")];
    await accepted(s, d, r);
    const job = await startCompanyReview("c1"),
      result = review([d], (await readWorkspace()).reports, {
        corrections: [
          {
            documentId: d.id,
            reason: "Remove duplicate original item.",
            path: "events",
            index: 0,
            value: null,
          },
          {
            documentId: d.id,
            reason: "Correct original third item.",
            path: "events",
            index: 2,
            value: investment("SoftBank", 2000),
          },
          {
            documentId: d.id,
            reason: "Add missing original transaction.",
            path: "events",
            index: null,
            value: investment("NVIDIA", 5000),
          },
        ],
      });
    await applyCompanyResult(job, await savedReview(job, result));
    assert.deepEqual(
      (await readWorkspace()).reports
        .find((r) => r.documentId === d.id)
        .report.events.map((e) => e.investor),
      ["B", "SoftBank", "NVIDIA"],
    );
  }));
test("incomplete coverage aborts atomically; an unsupported source stays unavailable without a fallback", () =>
  fixture(async (s, d) => {
    await accepted(s, d);
    const job = await startCompanyReview("c1"),
      saved = await savedReview(
        job,
        review([d], (await readWorkspace()).reports),
      );
    saved.result.selections[0].choices.revenue.documentId = "unknown";
    saved.result.reviewedDocumentIds = [];
    await assert.rejects(
      () => applyCompanyResult(job, saved),
      /every supplied/,
    );
    assert.equal(
      (await readWorkspace()).reports.find((r) => r.documentId === d.id)
        .revision,
      1,
    );
    assert.equal((await readWorkspace()).publications.length, 0);
    saved.result.reviewedDocumentIds = [d.id];
    await applyCompanyResult(job, saved);
    const row = selectedSeries(await readWorkspace(), "c1")[0];
    assert.equal(row.metrics.revenue.source, null);
    assert.equal(row.metrics.revenue.value, null);
    assert.match(row.metrics.revenue.reason, /not supplied/);
  }));
test("saved complete company response recovers locally after an application failure, without another paid call", () =>
  fixture(async (s, d) => {
    await accepted(s, d);
    const job = await startCompanyReview("c1"),
      saved = await savedReview(
        job,
        review([d], (await readWorkspace()).reports),
      ),
      runId = crypto.randomUUID();
    await s.DB.prepare("INSERT INTO runs(id,at,payload) VALUES(?,?,?)")
      .bind(runId, new Date().toISOString(), JSON.stringify(saved))
      .run();
    job.consistency = {
      status: "failed",
      runId,
      error: "Interrupted before apply",
    };
    await s.DB.prepare("UPDATE company_reviews SET payload=? WHERE id=?")
      .bind(JSON.stringify(job), job.id)
      .run();
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("A paid request must not run");
    };
    try {
      const completed = await reconcileCompany(
        job.id,
        "http://127.0.0.1:5173",
        true,
      );
      assert.equal(completed.status, "completed");
      assert.equal(completed.consistency.reusedSavedResponse, true);
    } finally {
      globalThis.fetch = original;
    }
  }));
test("extract route sends whole PDF plus sole canonical schema and keeps output unpublished until acceptance and review", () =>
  fixture(async (s, d) => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      assert.equal(body.text.format.strict, true);
      assert.equal(body.text.format.name, "financial_report_v3");
      assert.ok(
        body.input[0].content[0].file_data.startsWith(
          "data:application/pdf;base64,",
        ),
      );
      assert.ok(body.instructions.includes("NVIDIA/SoftBank"));
      return providerResponse(report(d));
    };
    try {
      const response = await extract(req({ documentId: d.id })),
        out = await response.json();
      assert.equal(response.status, 200, JSON.stringify(out));
      assert.ok((await readRun(out.extractionId)).rawOutput);
      assert.equal((await readWorkspace()).reports.length, 0);
      await acceptExtraction(out.extractionId);
      assert.equal(
        selectedSeries(await readWorkspace(), "c1")[0].metrics.revenue.value,
        null,
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = original;
    }
  }));
test("real company reconciliation request includes every original PDF, derives corrections and publishes reviewed selections", () =>
  fixture(async (s, d) => {
    await accepted(s, d);
    const job = await startCompanyReview("c1"),
      result = review([d], (await readWorkspace()).reports),
      original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      const b = JSON.parse(init.body);
      assert.equal(b.reasoning.effort, "high");
      assert.equal(
        b.input[0].content.filter((v) => v.type === "input_file").length,
        1,
      );
      const input = JSON.parse(b.input[0].content.at(-1).text);
      return providerResponse(
        wireReview(
          companyResponseContract(
            input.documents.map((d) => ({
              documentId: d.id,
              report: d.report,
              quarter: d.quarter,
            })),
          ),
          result,
        ),
      );
    };
    try {
      const completed = await reconcileCompany(job.id, "http://127.0.0.1:5173");
      assert.equal(completed.status, "completed");
      assert.equal(
        selectedSeries(await readWorkspace(), "c1")[0].metrics.revenue.value,
        1000,
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = original;
    }
  }));
test("historical cutoff rejects review that saw later PDFs and cannot issue a paid forecast", () =>
  fixture(async (s, d) => {
    await accepted(s, d);
    const job = await startCompanyReview("c1");
    await applyCompanyResult(
      job,
      await savedReview(job, review([d], (await readWorkspace()).reports)),
    );
    assert.equal(
      activePublication(await readWorkspace(), "c1", "2025-04-01"),
      null,
    );
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("No paid forecast should run");
    };
    try {
      const r = await forecast(
        req({ companyId: "c1", quarter: d.quarter, asOf: "2025-04-01" }),
      );
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, /cutoff/);
    } finally {
      globalThis.fetch = original;
    }
  }));
test("conflicting contemporaneous reports stay unresolved even when the reviewer chooses one", () =>
  fixture(async (s, d) => {
    await accepted(s, d);
    const other = { ...d, id: "d2" };
    await s.DB.prepare("INSERT INTO documents(id,payload) VALUES(?,?)")
      .bind(other.id, JSON.stringify(other))
      .run();
    await s.BUCKET.put("pages/d2.json", JSON.stringify(other.pages));
    const r = report(other);
    r.currentQuarter.incomeStatement.gaap.revenue = value(2000);
    await accepted(s, other, r);
    const job = await startCompanyReview("c1"),
      ws = await readWorkspace();
    await applyCompanyResult(
      job,
      await savedReview(job, review([d, other], ws.reports)),
    );
    assert.equal(
      selectedSeries(await readWorkspace(), "c1")[0].metrics.revenue.value,
      null,
    );
  }));
test("forecast consumes masked selected financial series and independent event context with frozen provenance", () =>
  fixture(async (s, d) => {
    const initial = report(d);
    initial.events = [investment()];
    initial.guidance = [
      {
        type: "Point",
        horizon: {
          type: "Quarter",
          label: "2025-Q2",
          start: "2025-04-01",
          end: "2025-06-30",
        },
        accountingBasis: "GAAP",
        target: { metric: "revenue", value: value(10000, "Revenue outlook") },
      },
    ];
    await accepted(s, d, initial);
    for (let q = 1; q <= 4; q++) {
      const other = {
        ...d,
        id: `h${q}`,
        quarter: `2024-Q${q}`,
        periodStart: `2024-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`,
        periodEnd: `2024-${String(q * 3).padStart(2, "0")}-${q === 1 || q === 4 ? "31" : "30"}`,
        publishedAt: `2024-${q === 4 ? "12" : String(q * 3 + 1).padStart(2, "0")}-${q === 4 ? "31" : "28"}`,
      };
      await s.DB.prepare("INSERT INTO documents(id,payload) VALUES(?,?)")
        .bind(other.id, JSON.stringify(other))
        .run();
      await s.BUCKET.put(`pages/${other.id}.json`, JSON.stringify(other.pages));
      await accepted(s, other);
    }
    const ws = await readWorkspace(),
      docs = ws.documents.filter((v) => v.companyId === "c1"),
      job = await startCompanyReview("c1");
    await applyCompanyResult(
      job,
      await savedReview(job, review(docs, ws.reports)),
    );
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      const b = JSON.parse(init.body),
        input = JSON.parse(b.input[0].content.at(-1).text);
      assert.equal(b.text.format.name, "fundamental_forecast");
      assert.equal(input.financial.length, 5);
      const guidance = input.context.flatMap((r) => r.guidance)[0];
      assert.equal(guidance.type, "Point");
      assert.equal(guidance.target.metric, "revenue");
      assert.equal(guidance.target.value.value, 10000);
      assert.equal(input.financial.at(-1).metrics.revenue.value, 1000);
      const event = input.context.flatMap((r) => r.events)[0];
      assert.equal(event.type, "Investment");
      assert.equal(event.direction, "Inbound");
      assert.equal(event.status, "Agreed");
      assert.ok(event.terms.id.startsWith("e"));
      assert.match(event.investor, /ENTITY/);
      assert.ok(!b.input[0].content.at(-1).text.includes("NVIDIA"));
      assert.equal(
        input.calculated.find((r) => r.quarter === "2025-Q1").revenueYoY,
        0,
      );
      const evidenceId = input.financial.at(-1).metrics.revenue.id;
      return providerResponse({
        assessment: "Stable selected actual revenue.",
        predictions: [
          {
            metric: "revenue_growth",
            direction: "stable",
            rationale: "Five supported quarters.",
            evidenceIds: [evidenceId],
            uncertainty: "Source-based inference.",
          },
          {
            metric: "operating_margin",
            direction: "insufficient_evidence",
            rationale: "No selected margin.",
            evidenceIds: [],
            uncertainty: "Margin history absent.",
          },
        ],
      });
    };
    try {
      const response = await forecast(
          req({ companyId: "c1", quarter: "2025-Q1", asOf: "2025-04-28" }),
        ),
        out = await response.json();
      assert.equal(response.status, 200, JSON.stringify(out));
      assert.ok(out.forecast.predictions[0].evidenceIds[0].includes("@"));
      assert.equal((await readWorkspace()).forecasts[0].stale, false);
      assert.equal(calls, 1);
      await editReport(
        d.id,
        2,
        report(d),
        "A new correction changes forecast provenance.",
      );
      assert.equal((await readWorkspace()).forecasts[0].stale, true);
    } finally {
      globalThis.fetch = original;
    }
  }));
test("clean-install storage rejects old observation database without changing it", () => {
  const dir = mkdtempSync(resolve(root, "tests/.tmp-"));
  let db;
  return import("node:sqlite").then(({ DatabaseSync }) => {
    db = new DatabaseSync(resolve(dir, "research.sqlite"));
    db.exec(
      "CREATE TABLE observations(id TEXT PRIMARY KEY); INSERT INTO observations VALUES('preserved');",
    );
    db.close();
    assert.throws(() => createLocalStorage(root, dir), /clean data directory/);
    db = new DatabaseSync(resolve(dir, "research.sqlite"));
    assert.equal(
      db.prepare("SELECT id FROM observations").get().id,
      "preserved",
    );
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

test("saved NVIDIA-style review with an unavailable dividendsPaid choice applies valid sources without another model request", () =>
  fixture(async (s, d) => {
    const source = {
      ...d,
      quarter: "2024-Q1",
      periodStart: "2024-01-01",
      periodEnd: "2024-03-31",
      publishedAt: "2024-04-28",
    };
    await s.DB.prepare("UPDATE documents SET payload=? WHERE id=?")
      .bind(JSON.stringify(source), source.id)
      .run();
    await accepted(s, source);
    const job = await startCompanyReview("c1"),
      out = review([source], (await readWorkspace()).reports);
    out.selections[0].choices.dividendsPaid = {
      documentId: source.id,
      reason: "Model selected a source without a quarterly dividends slot.",
    };
    const saved = await savedReview(job, out);
    saved.rawOutput = JSON.stringify(out);
    const runId = crypto.randomUUID();
    await s.DB.prepare("INSERT INTO runs(id,at,payload) VALUES(?,?,?)")
      .bind(runId, new Date().toISOString(), JSON.stringify(saved))
      .run();
    job.consistency = {
      status: "failed",
      runId,
      error:
        "Invalid source selection for 2024-Q1 dividendsPaid; select a supported current-quarter slot or null.",
    };
    await s.DB.prepare("UPDATE company_reviews SET payload=? WHERE id=?")
      .bind(JSON.stringify(job), job.id)
      .run();
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw Error("No model request permitted");
    };
    try {
      const complete = await reconcileCompany(
        job.id,
        "http://127.0.0.1:5173",
        true,
        true,
      );
      assert.equal(complete.status, "completed");
      assert.equal(complete.consistency.error, undefined);
      const ws = await readWorkspace(),
        row = selectedSeries(ws, "c1")[0];
      assert.equal(row.metrics.revenue.value, 1000);
      assert.equal(row.metrics.dividendsPaid.value, null);
      assert.equal(row.metrics.dividendsPaid.source, null);
      assert.match(row.metrics.dividendsPaid.reason, /unavailable|missing/i);
      assert.ok(
        ws.publications[0].findings.some((f) =>
          f.path.endsWith(".dividendsPaid"),
        ),
      );
      assert.deepEqual(await readRun(runId), saved);
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = original;
    }
  }));
test("a valid zero quarterly dividend remains publishable", () =>
  fixture(async (s, d) => {
    const r = report(d);
    r.currentQuarter.cashFlow.quarter.dividendsPaid = value(
      0,
      "Dividends paid",
    );
    await accepted(s, d, r);
    const job = await startCompanyReview("c1"),
      out = review([d], (await readWorkspace()).reports);
    out.selections[0].choices.dividendsPaid = {
      documentId: d.id,
      reason: "Explicit reported zero.",
    };
    await applyCompanyResult(job, await savedReview(job, out));
    assert.equal(
      selectedSeries(await readWorkspace(), "c1")[0].metrics.dividendsPaid
        .value,
      0,
    );
  }));

test("local-only saved application refuses a missing complete response before any mutation or network call", () =>
  fixture(async (s, d) => {
    await accepted(s, d);
    const job = await startCompanyReview("c1"),
      before = await readWorkspace(),
      original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw Error("Network forbidden");
    };
    try {
      await assert.rejects(
        () => reconcileCompany(job.id, "http://127.0.0.1:5173", true, true),
        /No completed saved/,
      );
      assert.deepEqual(await getCompanyReview(job.id), job);
      assert.deepEqual(await readWorkspace(), before);
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = original;
    }
  }));

test("a selected slot removed by a valid correction remains missing while other sources are published", () =>
  fixture(async (s, d) => {
    const r = report(d);
    r.currentQuarter.cashFlow.quarter.dividendsPaid = value(
      25,
      "Dividends paid",
    );
    await accepted(s, d, r);
    const job = await startCompanyReview("c1"),
      result = review([d], (await readWorkspace()).reports);
    result.selections[0].choices.dividendsPaid = {
      documentId: d.id,
      reason: "Originally selected quarterly line.",
    };
    result.corrections = [
      {
        documentId: d.id,
        path: "currentQuarter.cashFlow.quarter.dividendsPaid",
        reason: "Not a quarterly value; remove it.",
        value: null,
      },
    ];
    await applyCompanyResult(job, await savedReview(job, result));
    const row = selectedSeries(await readWorkspace(), "c1")[0];
    assert.equal(row.metrics.revenue.value, 1000);
    assert.equal(row.metrics.dividendsPaid.value, null);
    assert.match(row.metrics.dividendsPaid.reason, /after corrections/);
  }));

test("wrong-quarter selection cannot publish another quarter or block its valid source", () =>
  fixture(async (s, d) => {
    const other = {
      ...d,
      id: "d2",
      quarter: "2025-Q2",
      periodStart: "2025-04-01",
      periodEnd: "2025-06-30",
      publishedAt: "2025-07-20",
    };
    await s.DB.prepare("INSERT INTO documents(id,payload) VALUES(?,?)")
      .bind(other.id, JSON.stringify((({ pages, ...rest }) => rest)(other)))
      .run();
    await s.BUCKET.put(`pages/${other.id}.json`, JSON.stringify(other.pages));
    await accepted(s, d);
    await accepted(s, other);
    const job = await startCompanyReview("c1"),
      result = review([d, other], (await readWorkspace()).reports);
    result.selections.find(
      (v) => v.quarter === d.quarter,
    ).choices.revenue.documentId = other.id;
    await applyCompanyResult(job, await savedReview(job, result));
    const rows = selectedSeries(await readWorkspace(), "c1");
    assert.equal(
      rows.find((r) => r.quarter === d.quarter).metrics.revenue.value,
      null,
    );
    assert.match(
      rows.find((r) => r.quarter === d.quarter).metrics.revenue.reason,
      /belongs to 2025-Q2/,
    );
    assert.equal(
      rows.find((r) => r.quarter === other.quarter).metrics.revenue.value,
      1000,
    );
  }));

test("bracketed finding paths normalize safely and dangerous/unknown paths cannot enter storage", async () => {
  const { normalizeReportPath, getPath } =
    await import("../lib/report-contract.ts");
  assert.equal(
    normalizeReportPath("comparativePeriods[0].gaap.revenue"),
    "comparativePeriods.0.gaap.revenue",
  );
  assert.equal(getPath({ items: [{ x: 1 }] }, "items[0].x"), 1);
  for (const path of [
    "__proto__.x",
    "items.constructor",
    "items[-1]",
    "items[0]x",
    "items[9007199254740992]",
  ])
    assert.throws(() => normalizeReportPath(path));
  await fixture(async (s, d) => {
    const r = report(d);
    r.events = [investment()];
    await accepted(s, d, r);
    const job = await startCompanyReview("c1"),
      result = review([d], (await readWorkspace()).reports);
    result.findings = [
      {
        documentId: d.id,
        path: "events[0].amount",
        effect: "warning",
        reason: "Inspect transaction evidence.",
      },
    ];
    await applyCompanyResult(job, await savedReview(job, result));
    assert.equal(
      (await readWorkspace()).publications[0].findings[0].path,
      "events.0.amount",
    );
  });
});
