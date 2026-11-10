import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { companyResponseContract } from "../lib/company-response-contract.ts";
import { modelContracts } from "../lib/model-contracts.ts";
import {
  modelJsonSchema,
  assertModelBudget,
} from "../lib/structured-output.ts";
import { normalizeReportPath, getPath } from "../lib/report-contract.ts";
import { doc, report, review, investment, wireReview } from "./fixtures.mjs";
function setup() {
  const a = { ...doc, id: "intc-2024-Q1" },
    b = { ...doc, id: "intc-2023-Q4" };
  const ra = report(a),
    rb = report(b);
  rb.events = [investment()];
  const contract = companyResponseContract([
    { documentId: a.id, report: ra },
    { documentId: b.id, report: rb },
  ]);
  const output = review([a, b], [{ documentId: a.id }, { documentId: b.id }]);
  return { a, b, contract, output };
}
function accepts(contract, value) {
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(modelJsonSchema(contract.schema));
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(contract.schema.safeParse(value).success, true);
}
function rejects(contract, value) {
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(modelJsonSchema(contract.schema));
  assert.equal(validate(value), false);
  assert.equal(contract.schema.safeParse(value).success, false);
}
test("finding targets reject the observed invented event paths in both JSON Schema and parser", () => {
  const { a, contract, output } = setup(),
    wire = wireReview(contract, output);
  for (const path of ["events.guarantees", "events.equityInvestments"]) {
    const invalid = structuredClone(wire);
    invalid.documents[a.id].findings = [
      { target: path, effect: "warning", reason: "Unsupported concept." },
    ];
    rejects(contract, invalid);
    invalid.documents[a.id].findings = [
      { target: 0, path, effect: "warning", reason: "Extra path field." },
    ];
    rejects(contract, invalid);
  }
  const target = contract.targets.findings[a.id].indexOf("events");
  wire.documents[a.id].findings = [
    {
      target,
      effect: "warning",
      reason: "Guarantees are outside the event categories.",
    },
  ];
  accepts(contract, wire);
  assert.equal(contract.normalize(wire).findings[0].path, "events");
  for (const target of [-1, contract.targets.findings[a.id].length, 0.5]) {
    const invalid = structuredClone(wire);
    invalid.documents[a.id].findings[0].target = target;
    rejects(contract, invalid);
  }
});
test("report, quarter and edit coverage are required keyed objects, never duplicate-prone arrays", () => {
  const { a, contract, output } = setup(),
    wire = wireReview(contract, output);
  accepts(contract, wire);
  for (const remove of [
    (v) => delete v.documents[a.id],
    (v) => delete v.selections[doc.quarter],
    (v) => delete v.changes[Object.keys(v.changes)[0]],
  ]) {
    const invalid = structuredClone(wire);
    remove(invalid);
    rejects(contract, invalid);
  }
  const extra = structuredClone(wire);
  extra.documents.unknown = { findings: [] };
  rejects(contract, extra);
  const missing = structuredClone(wire);
  missing.selections = [];
  rejects(contract, missing);
});
test("changes bind document, canonical slot and original item exactly once", () => {
  const { a, b, contract, output } = setup(),
    wire = wireReview(contract, output);
  assert(
    !contract.targets.changes.some(
      (t) => t.documentId === a.id && t.path === "events",
    ),
  );
  const t = contract.targets.changes.find(
    (t) => t.documentId === b.id && t.path === "events" && t.index === 0,
  );
  wire.changes[t.target] = {
    reason: "Correct transaction.",
    value: investment(),
  };
  accepts(contract, wire);
  assert.deepEqual(contract.normalize(wire).corrections[0], {
    documentId: b.id,
    path: "events",
    index: 0,
    reason: "Correct transaction.",
    value: investment(),
  });
  for (const extra of [{ index: 1 }, { documentId: a.id }, { path: "risks" }]) {
    const invalid = structuredClone(wire);
    Object.assign(invalid.changes[t.target], extra);
    rejects(contract, invalid);
  }
  const unknown = structuredClone(wire);
  unknown.changes["edit:missing-item"] = {
    reason: "Unknown target",
    value: null,
  };
  rejects(contract, unknown);
});
test("keep, clear, remove and append have distinct schema-enforced meanings", () => {
  const { a, b, contract, output } = setup(),
    wire = wireReview(contract, output);
  assert.equal(contract.normalize(wire).corrections.length, 0);
  const edit = contract.targets.changes.find(
    (t) => t.documentId === b.id && t.path === "events" && t.index === 0,
  );
  wire.changes[edit.target] = { reason: "Remove a duplicate.", value: null };
  accepts(contract, wire);
  assert.equal(contract.normalize(wire).corrections[0].value, null);
  const append = contract.targets.additions.find(
    (t) => t.documentId === a.id && t.path === "events",
  );
  wire.additions = [
    {
      target: append.target,
      reason: "Add a missing transaction.",
      value: investment(),
    },
  ];
  accepts(contract, wire);
  assert.equal(contract.normalize(wire).corrections[1].index, null);
  wire.additions[0].value = null;
  rejects(contract, wire);
});
test("protected manual sections have no generated model mutation targets", () => {
  const input = report(doc);
  input.events = [investment()];
  const c = companyResponseContract([
    {
      documentId: doc.id,
      report: input,
      manualCorrections: [
        { path: "events.0.amount" },
        { path: "currentQuarter.incomeStatement.gaap.revenue" },
      ],
    },
  ]);
  assert(
    !c.targets.changes.some(
      (t) =>
        t.path === "events" ||
        t.path === "currentQuarter.incomeStatement.gaap.revenue",
    ),
  );
  assert(!c.targets.additions.some((t) => t.path === "events"));
  assert(c.targets.findings[doc.id].includes("events.0.amount"));
});
test("findings track original item identities through removal, index shifts and nullable replacements", async () => {
  const { resolveFindingReference } =
    await import("../lib/finding-reference.ts");
  const input = report(doc);
  input.events = [investment("A"), investment("B"), investment("C")];
  const current = structuredClone(input);
  current.events.splice(0, 1);
  const edits = [{ path: "events", index: 0, value: null }];
  assert.deepEqual(
    resolveFindingReference(input, current, "events.1.amount", edits),
    {
      inputPath: "events.1.amount",
      currentPath: "events.0.amount",
      status: "active",
    },
  );
  assert.equal(
    resolveFindingReference(input, current, "events.0.amount", edits).status,
    "superseded_by_correction",
  );
  const replaced = structuredClone(input);
  replaced.events[1].amount = null;
  assert.equal(
    resolveFindingReference(input, replaced, "events.1.amount", [
      { path: "events", index: 1, value: replaced.events[1] },
    ]).currentPath,
    "events.1.amount",
  );
  assert.throws(
    () => resolveFindingReference(input, current, "events.guarantees", edits),
    /generated input-revision catalog/,
  );
});
test("bracketed and dotted source paths resolve to the same item without evaluating paths or accessing prototypes", () => {
  const input = {
    comparativePeriods: [
      { gaap: { dilutedWeightedAverageShares: 4343000000 } },
    ],
  };
  const path = "comparativePeriods[0].gaap.dilutedWeightedAverageShares";
  assert.equal(
    normalizeReportPath(path),
    "comparativePeriods.0.gaap.dilutedWeightedAverageShares",
  );
  assert.equal(getPath(input, path), 4343000000);
  for (const bad of [
    "__proto__.x",
    "constructor.name",
    "comparativePeriods[-1]",
    "comparativePeriods[0];run()",
  ])
    assert.throws(() => normalizeReportPath(bad));
  assert.equal(getPath(input, "unknown"), undefined);
});
test("all generated contracts keep reference descriptions inline and bare references free of siblings", () => {
  for (const schema of Object.values(modelContracts)) {
    const json = modelJsonSchema(schema);
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (node.$ref) assert.deepEqual(Object.keys(node), ["$ref"]);
      for (const child of Object.values(node)) walk(child);
    }
    walk(json);
  }
  const json = modelJsonSchema(modelContracts.extraction);
  assert.match(
    json.properties.events.items.anyOf[0].properties.transactionKey.description,
    /transaction identity/,
  );
});
test("a 15-report bounded review stays within provider schema budgets", () => {
  const reports = Array.from({ length: 15 }, (_, i) => ({
    documentId: "report-" + i,
    report: { ...report(doc), events: [investment("Investor " + i)] },
  }));
  const contract = companyResponseContract(reports);
  assert.ok(assertModelBudget(modelJsonSchema(contract.schema)).maxDepth <= 10);
});
test("annotated reused schemas retain their own descriptions and constraints", async () => {
  const { z } = await import("zod/v4");
  const shared = z.string().min(2).max(12);
  const schema = z
    .object({
      plain: shared,
      named: shared.describe("Source-specific meaning"),
    })
    .strict();
  const json = modelJsonSchema(schema);
  assert.equal(json.properties.named.description, "Source-specific meaning");
  assert.equal(json.properties.named.minLength, 2);
  assert.equal(json.properties.named.maxLength, 12);
  assert.equal(json.properties.named.$ref, undefined);
  assert.equal(schema.safeParse({ plain: "ok", named: "x" }).success, false);
});
