import { getPath, normalizeReportPath, type Report } from "./report-contract";
import type { Finding, ManualCorrection } from "./types";

export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export const overlappingPaths = (a: string, b: string) => {
  a = normalizeReportPath(a);
  b = normalizeReportPath(b);
  return a === b || a.startsWith(b + ".") || b.startsWith(a + ".");
};

/** Pin edited evidence as a unit. Pin edited arrays as a section so later
 * removals/reordering cannot redirect an index-based manual correction. */
export function recordManualCorrections(
  before: Report,
  after: Report,
  existing: ManualCorrection[],
  at: string,
  reason: string,
): ManualCorrection[] {
  const changes: ManualCorrection[] = [];
  function visit(a: any, b: any, path: string) {
    if (sameValue(a, b)) return;
    if (
      Array.isArray(a) ||
      Array.isArray(b) ||
      a == null ||
      b == null ||
      typeof a !== "object" ||
      typeof b !== "object" ||
      a.type === "Value" ||
      a.type === "Statement" ||
      b.type === "Value" ||
      b.type === "Statement"
    ) {
      changes.push({ path, value: structuredClone(b), at, reason });
      return;
    }
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
      visit(a[key], b[key], path ? `${path}.${key}` : key);
  }
  visit(before, after, "");
  return [
    ...existing.filter(
      (e) => !changes.some((c) => overlappingPaths(c.path, e.path)),
    ),
    ...changes,
  ];
}

/** Absence is a coverage limitation, not a bad stored numeric value. Keep
 * unresolved findings on populated slots blocking; do not invent missing data. */
export function contextualizeFinding(
  report: Report,
  finding: Finding,
): Finding {
  let path: string;
  try {
    path = normalizeReportPath(finding.path);
  } catch {
    return finding;
  }
  const coverage = report.coverage.find((c) => {
    try {
      return normalizeReportPath(c.path) === path;
    } catch {
      return false;
    }
  });
  if (
    getPath(report, path) === null &&
    coverage &&
    finding.code !== "manual_review_conflict"
  )
    return { ...finding, path, effect: "warning", code: "source_unavailable" };
  return { ...finding, path };
}
