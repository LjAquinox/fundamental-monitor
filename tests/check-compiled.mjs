import "./register.mjs";
import {
  mkdtempSync,
  cpSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { runBatch } from "../lib/workflow/batch-extraction.mjs";
import { runCompanyReviews } from "../lib/workflow/company-review-runner.mjs";
const { companyResponseContract } =
  await import("../lib/company-response-contract.ts");
const { report, value, review, investment, wireReview } =
  await import("./fixtures.mjs");
const { companySnapshot, selectedSeries, displayedNetIncome } =
  await import("../lib/selections.ts");
const { CONTRACT_VERSION, publicationSlots, getPath } =
  await import("../lib/report-contract.ts");
const root = resolve(import.meta.dirname, ".."),
  directory = mkdtempSync(resolve(root, "tests/.compiled-"));
let app;
const fetchOriginal = globalThis.fetch;
try {
  for (const folder of ["migrations", "public", ".local-build"])
    cpSync(resolve(root, folder), resolve(directory, folder), {
      recursive: true,
    });
  writeFileSync(
    resolve(directory, ".dev.vars"),
    "OPENAI_API_KEY=fake-never-live\nLLM_MODEL=gpt-6-luna\nAI_DAILY_CALL_LIMIT=200\n",
  );
  process.env.FUNDAMENTAL_ROOT = directory;
  app = await import(
    pathToFileURL(resolve(root, ".local-build/server.mjs")).href
  );
  const call = async (path, body, method = "POST") => {
    const r = await app.dispatch(
      new Request(
        "http://127.0.0.1:5173" + path,
        body === undefined
          ? {}
          : {
              method,
              headers: {
                Origin: "http://127.0.0.1:5173",
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            },
      ),
    );
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    return data;
  };
  let ws = await call("/api/workspace");
  assert.equal(ws.documents.length, 29);
  assert.equal(ws.reports.length, 0);
  assert.equal("observations" in ws, false);
  for (const d of ws.documents) {
    const bytes = readFileSync(resolve(directory, "public", d.pdfUrl.slice(1)));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), d.sha256);
    const source = await call("/api/documents?id=" + d.id);
    assert.ok(source.pages.length);
  }
  const manifests = JSON.parse(
    readFileSync(resolve(root, ".local-build/build.json"), "utf8"),
  );
  for (const group of [manifests.sourceFiles, manifests.files])
    for (const [file, hash] of Object.entries(group))
      assert.equal(
        createHash("sha256")
          .update(readFileSync(resolve(root, file)))
          .digest("hex"),
        hash,
        `Manifest mismatch: ${file}`,
      );
  let refusedCalls = 0;
  globalThis.fetch = async () => {
    refusedCalls++;
    return Response.json(
      {
        error: {
          code: "invalid_json_schema",
          param: "text.format.schema",
          message: "Invalid schema: identical first keys.",
        },
      },
      {
        status: 400,
        headers: { "x-request-id": "req_compiled_schema_refusal" },
      },
    );
  };
  const refusedCheckpoint = { version: "typed-report-v3", documents: {} };
  await runBatch({
    documents: ws.documents,
    checkpoint: refusedCheckpoint,
    call,
    concurrency: 16,
    validateFirstRequest: true,
    save: async () => {},
  });
  assert.equal(
    refusedCalls,
    1,
    "One rejected first request must stop the parallel batch.",
  );
  assert.equal(Object.keys(refusedCheckpoint.documents).length, 1);
  assert.match(
    Object.values(refusedCheckpoint.documents)[0].error,
    /invalid_json_schema.*text.format.schema.*identical first keys.*req_compiled_schema_refusal/,
  );
  const failedRuns = await call(
    `/api/extractions?documentId=${encodeURIComponent(ws.documents[0].id)}`,
  );
  assert.ok(
    failedRuns.some(
      (r) =>
        r.status === "failed" &&
        r.error.includes("req_compiled_schema_refusal"),
    ),
  );
  let extractionCalls = 0,
    companyCalls = 0,
    active = 0,
    peak = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    const b = JSON.parse(init.body);
    assert.equal(b.text.format.strict, true);
    assert.equal(b.store, false);
    assert.equal(b.stream, true);
    let data;
    if (b.text.format.name === "financial_report_v3") {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setImmediate(r));
      const input = JSON.parse(b.input[0].content.at(-1).text),
        d = ws.documents.find(
          (d) =>
            d.quarter === input.reportingPeriod.label &&
            d.periodStart === input.reportingPeriod.start &&
            d.periodEnd === input.reportingPeriod.end &&
            ws.companies.find((c) => c.id === d.companyId)?.name ===
              input.subject,
        );
      assert.ok(d);
      data = report(d);
      data.currentQuarter.incomeStatement.gaap.operatingIncome = value(
        300,
        "Operating income",
      );
      data.currentQuarter.incomeStatement.gaap.netIncome = {
        ...value(200, "Net income"),
        attribution: "Unspecified",
      };
      if (d.companyId === ws.companies.find((c) => c.name === "Intel")?.id) {
        data.currentQuarter.incomeStatement.gaap.operatingMargin = value(
          30,
          "Operating margin",
          "percent",
        );
        data.currentQuarter.incomeStatement.gaap.netIncomeAttributableToParent =
          value(180, "Net income attributable to parent");
        data.events = [investment()];
      }
      extractionCalls++;
      active--;
    } else if (b.text.format.name === "company_report_reconciliation_v3") {
      const input = JSON.parse(b.input[0].content.at(-1).text);
      assert.equal(b.reasoning.effort, "high");
      assert.equal(
        b.input[0].content.filter((c) => c.type === "input_file").length,
        input.documents.length,
      );
      data = review(
        input.documents,
        input.documents.map((d) => ({ documentId: d.id, report: d.report })),
      );
      for (const selection of data.selections)
        for (const [m, slot] of Object.entries(publicationSlots)) {
          const candidate = input.documents.find(
            (d) =>
              d.quarter === selection.quarter && getPath(d.report, slot.path),
          );
          selection.choices[m] = {
            documentId: candidate?.id || null,
            reason: candidate
              ? "Original current-quarter statement line."
              : "Unavailable in supplied reports.",
          };
        }
      data = wireReview(
        companyResponseContract(
          input.documents.map((d) => ({
            documentId: d.id,
            quarter: d.quarter,
            report: d.report,
          })),
        ),
        data,
      );
      companyCalls++;
    } else throw new Error("Unexpected paid request");
    return Response.json({
      id: "mock",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(data) }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  };
  const checkpoint = refusedCheckpoint;
  await runBatch({
    documents: ws.documents,
    checkpoint,
    call,
    concurrency: 16,
    validateFirstRequest: true,
    retryFailed: true,
    save: async () => {},
  });
  assert.equal(extractionCalls, 29);
  assert.ok(peak >= 2 && peak <= 16);
  assert.ok(
    Object.values(checkpoint.documents).every((d) => d.status === "completed"),
  );
  const jobs = await runCompanyReviews({
    companies: ws.companies,
    call,
    concurrency: 16,
  });
  assert.ok(jobs.every((j) => j.status === "completed"));
  assert.equal(companyCalls, 2);
  ws = await call("/api/workspace");
  assert.equal(ws.reports.length, 29);
  assert.ok(ws.reports.every((r) => r.reviewId));
  assert.equal(ws.publications.length, 2);
  assert.ok(
    ws.publications.every((p) =>
      p.selections.every(
        (s) =>
          s.choices.revenue.source &&
          s.choices.operatingIncome.source &&
          s.choices.netIncome.source,
      ),
    ),
  );
  for (const company of ws.companies) {
    const rows = selectedSeries(ws, company.id);
    assert(rows.every((r) => r.metrics.operatingMargin.value === 30));
    if (company.name === "NVIDIA") {
      assert(
        rows.every(
          (r) =>
            r.metrics.operatingMargin.origin === "calculated" &&
            r.metrics.operatingMargin.sources.length === 2,
        ),
      );
      assert(
        rows.every(
          (r) =>
            displayedNetIncome(r.metrics).value === 200 &&
            displayedNetIncome(r.metrics).label === "Net income (reported)",
        ),
      );
      assert(
        ws.publications
          .find((p) => p.companyId === company.id)
          .selections.every((s) => s.choices.operatingMargin.source === null),
      );
    } else {
      assert(
        rows.every((r) => r.metrics.operatingMargin.origin === "reported"),
      );
      assert(
        rows.every(
          (r) =>
            displayedNetIncome(r.metrics).value === 180 &&
            r.metrics.netIncome.value === 200,
        ),
      );
    }
  }
  const previous = extractionCalls + companyCalls;
  await runBatch({
    documents: ws.documents,
    checkpoint,
    call,
    concurrency: 16,
    save: async () => {},
  });
  await runCompanyReviews({ companies: ws.companies, call });
  assert.equal(extractionCalls + companyCalls, previous);
  const html = await app.dispatch(new Request("http://127.0.0.1:5173/"));
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<div id="root">/);
  const bad = await app.dispatch(
    new Request("http://untrusted.example:5173/api/workspace"),
  );
  assert.equal(bad.status, 403);
  const nvidia = ws.companies.find((c) => c.name === "NVIDIA");
  const localJob = await call("/api/company-review", {
    action: "start",
    companyId: nvidia.id,
    fresh: true,
  });
  const companyDocs = ws.documents.filter((d) => d.companyId === nvidia.id),
    companyReports = ws.reports.filter((r) => r.companyId === nvidia.id);
  const savedResult = review(companyDocs, companyReports);
  const selected =
    savedResult.selections.find((s) => s.quarter === "2024-Q1") ||
    savedResult.selections[0];
  selected.choices.dividendsPaid = {
    documentId: companyDocs.find((d) => d.quarter === selected.quarter).id,
    reason: "Simulated unavailable quarterly dividends choice.",
  };
  const localRunId = crypto.randomUUID();
  const savedPayload = JSON.stringify({
    kind: "company_review",
    status: "completed",
    contractVersion: CONTRACT_VERSION,
    snapshots: companySnapshot(ws, nvidia.id),
    result: savedResult,
    rawOutput: JSON.stringify(savedResult),
    usage: { inputTokens: 1, outputTokens: 1, estimatedCost: null },
  });
  localJob.consistency = {
    status: "failed",
    runId: localRunId,
    error: "Invalid source selection for 2024-Q1 dividendsPaid",
  };
  app.closeStorage();
  app = null;
  const databaseFile = resolve(directory, ".local-data/research.sqlite");
  const db = new DatabaseSync(databaseFile);
  db.prepare("INSERT INTO runs(id,at,payload) VALUES(?,?,?)").run(
    localRunId,
    new Date().toISOString(),
    savedPayload,
  );
  db.prepare("UPDATE company_reviews SET payload=? WHERE id=?").run(
    JSON.stringify(localJob),
    localJob.id,
  );
  const originalRuns = db
    .prepare("SELECT id,payload FROM runs ORDER BY id")
    .all();
  const originalReports = db
    .prepare("SELECT id,payload FROM reports ORDER BY id")
    .all();
  const intelJobs = db
    .prepare(
      "SELECT id,payload FROM company_reviews WHERE company_id<>? ORDER BY id",
    )
    .all(nvidia.id);
  db.close();
  for (const folder of ["scripts", "lib/workflow"])
    cpSync(resolve(root, folder), resolve(directory, folder), {
      recursive: true,
    });
  // Run the shipped CLI against an isolated saved-failure database with no key,
  // and forbid fetch so the local recovery cannot mask a paid fallback.
  writeFileSync(resolve(directory, ".dev.vars"), "LLM_MODEL=gpt-6-luna\n");
  const denyNetwork = resolve(directory, "deny-network.mjs");
  writeFileSync(
    denyNetwork,
    'globalThis.fetch=async()=>{throw new Error("Network forbidden in local-only CLI test");};',
  );
  const localArgs = [
    "--import",
    pathToFileURL(denyNetwork).href,
    resolve(directory, "scripts/run-workflow.mjs"),
    "-ApplySavedReview",
    localJob.id,
  ];
  for (let i = 0; i < 2; i++) {
    const out = spawnSync(process.execPath, localArgs, {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, FUNDAMENTAL_ROOT: directory, OPENAI_API_KEY: "" },
    });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /paid model calls: 0/);
    assert.equal(
      existsSync(resolve(directory, ".local-data/batch-extraction.lock")),
      false,
    );
  }
  const recoveredDb = new DatabaseSync(databaseFile, { readOnly: true });
  assert.deepEqual(
    recoveredDb.prepare("SELECT id,payload FROM runs ORDER BY id").all(),
    originalRuns,
  );
  assert.deepEqual(
    recoveredDb
      .prepare(
        "SELECT id,payload FROM company_reviews WHERE company_id<>? ORDER BY id",
      )
      .all(nvidia.id),
    intelJobs,
  );
  for (const r of originalReports)
    assert.equal(
      recoveredDb.prepare("SELECT payload FROM reports WHERE id=?").get(r.id)
        .payload,
      r.payload,
    );
  const recoveredJob = JSON.parse(
    recoveredDb
      .prepare("SELECT payload FROM company_reviews WHERE id=?")
      .get(localJob.id).payload,
  );
  assert.equal(recoveredJob.status, "completed");
  assert.equal(recoveredJob.consistency.error, undefined);
  const publication = JSON.parse(
    recoveredDb
      .prepare(
        "SELECT payload FROM publications WHERE json_extract(payload,'$.reviewId')=?",
      )
      .get(localJob.id).payload,
  );
  const recoveredChoice = publication.selections.find(
    (s) => s.quarter === selected.quarter,
  ).choices;
  assert.equal(recoveredChoice.dividendsPaid.source, null);
  assert.match(recoveredChoice.dividendsPaid.reason, /no value/);
  assert.ok(recoveredChoice.revenue.source);
  const backupFolders = (await import("node:fs")).readdirSync(
    resolve(directory, ".backups"),
  );
  assert.ok(
    backupFolders.some((name) =>
      name.startsWith("before-saved-review-recovery-"),
    ),
  );
  recoveredDb.close();
  const failed = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(denyNetwork).href,
      resolve(directory, "scripts/run-workflow.mjs"),
      "-ApplySavedReview",
      crypto.randomUUID(),
    ],
    {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, FUNDAMENTAL_ROOT: directory, OPENAI_API_KEY: "" },
    },
  );
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Company review not found/);
  assert.equal(
    existsSync(resolve(directory, ".local-data/batch-extraction.lock")),
    false,
  );
  writeFileSync(
    resolve(directory, ".dev.vars"),
    "OPENAI_API_KEY=fake-never-live\nLLM_MODEL=gpt-6-luna\nAI_DAILY_CALL_LIMIT=200\n",
  );
  for (const args of [["-DryRun"], ["-ReviewOnly", "-Concurrency", "8"]]) {
    const result = spawnSync(
      process.execPath,
      [resolve(directory, "scripts/run-workflow.mjs"), ...args],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, FUNDAMENTAL_ROOT: directory },
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(
      existsSync(resolve(directory, ".local-data/batch-extraction.lock")),
      false,
      "Batch lock must release after successful CLI exit.",
    );
  }
  console.log(
    `Compiled clean-install check: 29 PDFs/hash checks, 29 parallel extractions (peak ${peak}), 2 complete company reviews, NVIDIA calculated margins/reported net income, Intel reported margins/parent income, selected GAAP sources, single-request refusal handling, explicit retry, free resume, static assets, local host guard manifest integrity and keyless local-only saved-review CLI recovery/idempotency/refusal passed. No paid calls.`,
  );
} finally {
  globalThis.fetch = fetchOriginal;
  app?.closeStorage();
  delete process.env.FUNDAMENTAL_ROOT;
  rmSync(directory, { recursive: true, force: true });
}
