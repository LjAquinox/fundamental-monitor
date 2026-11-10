import { z } from "zod/v4";
import {
  reportSchema,
  reconciliationSchema,
  replacementTargets,
  quarterSelectionSchema,
  getPath,
  type Report,
} from "./report-contract";
import { overlappingPaths } from "./review-state";

type InputReport = {
  documentId: string;
  report: Report;
  quarter?: string;
  manualCorrections?: { path: string }[];
};
type ChangeTarget = {
  target: string;
  documentId: string;
  path: string;
  index?: number;
};
type AdditionTarget = { target: string; documentId: string; path: string };

/** Derive reviewable paths from the canonical schema and actual revision.
 * Evidence is atomic. Absent nullable objects have no fictitious children. */
export function findingPaths(report: Report): string[] {
  const paths: string[] = [];
  function visit(schema: z.ZodType, value: any, path: string) {
    if (path) paths.push(path);
    let def = schema._zod.def as any;
    while (def.type === "nullable") {
      if (value === null) return;
      schema = def.innerType;
      def = schema._zod.def;
    }
    if (def.type === "union") {
      const selected = def.options.find(
        (option: z.ZodType) => option.safeParse(value).success,
      );
      if (!selected)
        throw Error(
          `Report input does not match its canonical variant at ${path}.`,
        );
      if (path) paths.pop();
      visit(selected, value, path);
      return;
    }
    if (def.type === "array") {
      if (!Array.isArray(value))
        throw Error(`Report input is not an array at ${path}.`);
      value.forEach((item, index) =>
        visit(def.element, item, `${path}.${index}`),
      );
    } else if (def.type === "object") {
      if (value?.type === "Value" || value?.type === "Statement") return;
      for (const [key, child] of Object.entries(def.shape)) {
        if (!value || !Object.hasOwn(value, key))
          throw Error(`Canonical report field is absent: ${path}.${key}`);
        visit(child as z.ZodType, value[key], path ? `${path}.${key}` : key);
      }
    }
  }
  visit(reportSchema, report, "");
  return [...new Set(paths)].sort();
}

/** The generated parser is also the Structured Outputs schema. The model
 * never writes document/path/index triples or free-text finding paths. */
export function companyResponseContract(reports: InputReport[]) {
  if (
    !reports.length ||
    new Set(reports.map((r) => r.documentId)).size !== reports.length
  )
    throw Error("Distinct populated report IDs are required.");
  reports = [...reports].sort((a, b) =>
    a.documentId.localeCompare(b.documentId),
  );
  for (const r of reports) reportSchema.parse(r.report);
  const baseFinding = reconciliationSchema.shape.findings.element,
    reason = baseFinding.shape.reason;
  const changes: ChangeTarget[] = [],
    additions: AdditionTarget[] = [];
  const changeShape: Record<string, z.ZodType> = {},
    documentShape: Record<string, z.ZodType> = {};
  const additionVariants: z.ZodObject<any>[] = [];
  const findings: Record<string, string[]> = {};
  const wrappers = new Map<z.ZodType, z.ZodType>();
  const nullableItems = new Map<z.ZodType, z.ZodType>();
  function changeValue(schema: z.ZodType) {
    if (!wrappers.has(schema))
      wrappers.set(
        schema,
        z.object({ reason, value: schema }).strict().nullable(),
      );
    return wrappers.get(schema)!;
  }
  for (const r of reports) {
    for (const [path, schema] of Object.entries(replacementTargets)) {
      if (r.manualCorrections?.some((pin) => overlappingPaths(pin.path, path)))
        continue;
      const def = schema._zod.def as any;
      if (def.type === "array") {
        const items = getPath(r.report, path),
          item = def.element as z.ZodType;
        if (!nullableItems.has(item)) nullableItems.set(item, item.nullable());
        items.forEach((_: unknown, index: number) => {
          const target = `c${changes.length}`;
          changes.push({ target, documentId: r.documentId, path, index });
          changeShape[target] = changeValue(nullableItems.get(item)!);
        });
        const target = `a${additions.length}`;
        additions.push({ target, documentId: r.documentId, path });
        additionVariants.push(
          z.object({ target: z.literal(target), reason, value: item }).strict(),
        );
      } else {
        const target = `c${changes.length}`;
        changes.push({ target, documentId: r.documentId, path });
        changeShape[target] = changeValue(schema);
      }
    }
    const paths = findingPaths(r.report);
    findings[r.documentId] = paths;
    documentShape[r.documentId] = z
      .object({
        findings: z.array(
          z
            .object({
              target: z
                .number()
                .int()
                .min(0)
                .max(paths.length - 1),
              effect: baseFinding.shape.effect,
              reason,
            })
            .strict(),
        ),
      })
      .strict();
  }
  const quarters = [
    ...new Set(
      reports.map((r) => r.quarter || r.report.currentQuarter.period.label),
    ),
  ].sort();
  const selectionShape: Record<string, z.ZodType> = {};
  for (const quarter of quarters) {
    const available = z
      .enum(
        reports
          .filter(
            (r) =>
              (r.quarter || r.report.currentQuarter.period.label) === quarter,
          )
          .map((r) => r.documentId) as [string, ...string[]],
      )
      .nullable();
    const narrowed = new Map<z.ZodType, z.ZodType>();
    const choices = Object.fromEntries(
      Object.entries(quarterSelectionSchema.shape.choices.shape).map(
        ([metric, base]) => {
          if (!narrowed.has(base)) {
            let choice = (base as z.ZodObject<any>).extend({
              documentId: available,
            });
            if (base.description) choice = choice.describe(base.description);
            narrowed.set(base, choice);
          }
          return [metric, narrowed.get(base)!];
        },
      ),
    );
    selectionShape[quarter] = z
      .object({ choices: z.object(choices).strict() })
      .strict();
  }
  const schema = z
    .object({
      summary: reconciliationSchema.shape.summary,
      changes: z
        .object(changeShape)
        .strict()
        .describe(
          "Null keeps the input unchanged. An object with value=null clears a nullable slot or removes an existing array item. Every supplied change key is required exactly once.",
        ),
      additions: additionVariants.length
        ? z.array(z.union(additionVariants as any))
        : z.array(z.null()).max(0),
      documents: z.object(documentShape).strict(),
      selections: z.object(selectionShape).strict(),
    })
    .strict();
  const targets = { changes, additions, findings };
  return {
    schema,
    targets,
    normalize(data: unknown) {
      const parsed = schema.parse(data);
      return reconciliationSchema.parse({
        summary: parsed.summary,
        reviewedDocumentIds: reports.map((r) => r.documentId),
        corrections: [
          ...changes.flatMap(({ target, ...reference }) => {
            const change = parsed.changes[target] as {
              reason: string;
              value: unknown;
            } | null;
            return change === null ? [] : [{ ...reference, ...change }];
          }),
          ...parsed.additions.map((addition: any) => {
            const { target, ...value } = addition;
            const { target: _, ...reference } = additions.find(
              (t) => t.target === target,
            )!;
            return { ...reference, index: null, ...value };
          }),
        ],
        findings: reports.flatMap((r) =>
          (
            parsed.documents[r.documentId] as {
              findings: { target: number; effect: string; reason: string }[];
            }
          ).findings.map(({ target, ...finding }) => ({
            ...finding,
            documentId: r.documentId,
            path: findings[r.documentId][target],
          })),
        ),
        selections: quarters.map((quarter) => ({
          quarter,
          ...(parsed.selections[quarter] as { choices: unknown }),
        })),
      });
    },
  };
}
