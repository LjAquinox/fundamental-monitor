/** Interpret printed notation only. Never infer a missing number or currency conversion. */
export const PRINTED_AMOUNT_PARSER_VERSION = "qualified-unit-literals-v2";
const scales: Record<string, number> = {
  USD_billions: 1000,
  USD_millions: 1,
  USD_thousands: 0.001,
  USD: 0.000001,
  percent: 1,
  percentage_points: 1,
  basis_points: 0.01,
  ratio: 1,
  days: 1,
  years: 1,
  count: 1,
  count_thousands: 1000,
  count_millions: 1e6,
};
const suffixes: Record<
  string,
  { scale?: number; dimension?: string; unit?: string }
> = {
  b: { scale: 1e9 },
  bn: { scale: 1e9 },
  billion: { scale: 1e9 },
  billions: { scale: 1e9 },
  m: { scale: 1e6 },
  mn: { scale: 1e6 },
  mm: { scale: 1e6 },
  million: { scale: 1e6 },
  millions: { scale: 1e6 },
  k: { scale: 1e3 },
  thousand: { scale: 1e3 },
  thousands: { scale: 1e3 },
  "%": { unit: "percent" },
  percent: { unit: "percent" },
  "per cent": { unit: "percent" },
  pp: { unit: "percentage_points" },
  "percentage point": { unit: "percentage_points" },
  "percentage points": { unit: "percentage_points" },
  bp: { unit: "basis_points" },
  bps: { unit: "basis_points" },
  "basis point": { unit: "basis_points" },
  "basis points": { unit: "basis_points" },
  x: { unit: "ratio" },
  ratio: { unit: "ratio" },
  day: { unit: "days" },
  days: { unit: "days" },
  year: { unit: "years" },
  years: { unit: "years" },
  yr: { unit: "years" },
  yrs: { unit: "years" },
  share: { dimension: "count", scale: 1 },
  shares: { dimension: "count", scale: 1 },
  count: { dimension: "count", scale: 1 },
};
export type PrintedAmount = {
  number: number | null;
  decimals: number;
  error: string | null;
  errorKind?: "uninterpretable" | "unit_mismatch";
  approximate?: boolean;
};
const invalid = (
  error: string,
  errorKind: "uninterpretable" | "unit_mismatch" = "uninterpretable",
): PrintedAmount => ({
  number: null,
  decimals: 0,
  error,
  errorKind,
});
function dimension(unit: string) {
  return unit.startsWith("USD")
    ? "money"
    : unit.startsWith("count")
      ? "count"
      : unit;
}
function absoluteScale(unit: string) {
  return dimension(unit) === "money" ? scales[unit] * 1e6 : scales[unit];
}

/** A suffix validates reportedUnit; it is never multiplied into the magnitude twice. */
export function parsePrintedAmount(
  literal: string,
  reportedUnit?: string,
): PrintedAmount {
  if (typeof literal !== "string")
    return invalid("The reported literal is not text.");
  let raw = literal.trim().replace(/[−–]/g, "-"),
    sign = 1,
    hasSign = false,
    currency = false;
  let approximate = false;
  function takeQualifier() {
    const m = raw.match(
      /^(?:(?:approximately|approx\.?|about|around|roughly)\s+|[~≈]\s*)/i,
    );
    if (m) {
      approximate = true;
      raw = raw.slice(m[0].length).trim();
    }
  }
  takeQualifier();
  function takeSign() {
    if (/^[+-]/.test(raw)) {
      if (hasSign) return false;
      hasSign = true;
      sign = raw[0] === "-" ? -1 : 1;
      raw = raw.slice(1).trim();
    }
    return true;
  }
  function takeCurrency() {
    const m = raw.match(/^(?:US\s*\$|USD\b|\$)\s*/i);
    if (m) {
      if (currency) return false;
      currency = true;
      raw = raw.slice(m[0].length).trim();
    }
    return true;
  }
  if (!takeSign() || !takeCurrency() || !takeSign())
    return invalid(
      "The reported literal has contradictory signs or currency markers.",
    );
  takeQualifier();
  if (!takeSign())
    return invalid("The reported literal has contradictory signs.");
  if (raw.startsWith("(")) {
    const close = raw.indexOf(")");
    if (
      hasSign ||
      close < 0 ||
      /[()]/.test(raw.slice(1, close) + raw.slice(close + 1))
    )
      return invalid(
        "The reported literal has ambiguous parentheses or signs.",
      );
    sign = -1;
    hasSign = true;
    raw = (raw.slice(1, close) + " " + raw.slice(close + 1)).trim();
    if (!takeCurrency() || /^[+-]/.test(raw))
      return invalid(
        "The reported literal has contradictory signs or currency markers.",
      );
  } else if (/[()]/.test(raw))
    return invalid("The reported literal has unmatched parentheses.");
  // Accept US comma grouping or unambiguous grouped spaces; never decimal commas.
  const match = raw.match(
    /^((?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+))\s*(.*)$/,
  );
  if (!match)
    return invalid(
      "Cannot interpret the reported literal as one number. Ranges, missing-value dashes and footnote text require source review.",
    );
  const numeric = match[1].replace(/[, \u00a0\u202f]/g, ""),
    number = sign * Number(numeric),
    decimals = numeric.split(".")[1]?.length || 0;
  if (!Number.isFinite(number))
    return invalid("The reported literal is not a finite number.");
  let suffix = match[2].trim().toLowerCase().replace(/\s+/g, " ");
  // Dollar symbols denote currency, not whether the table uses millions/billions.
  suffix = suffix
    .replace(/\b(?:usd|us dollars?|dollars?)\b|us\s*\$|\$/g, () => {
      currency = true;
      return "";
    })
    .trim()
    .replace(/\s+/g, " ");
  let explicit = Object.hasOwn(suffixes, suffix) ? suffixes[suffix] : undefined;
  const scaledCount = suffix.match(
    /^(billion|billions|million|millions|thousand|thousands) shares?$/,
  );
  if (scaledCount)
    explicit = { scale: suffixes[scaledCount[1]].scale, dimension: "count" };
  if (suffix && !explicit)
    return invalid(
      `Unsupported or ambiguous unit notation in the reported literal: '${match[2]}'.`,
    );
  if (currency && explicit && (explicit.unit || explicit.dimension === "count"))
    return invalid(
      "The reported literal mixes a dollar currency with a nonmonetary unit.",
    );
  if (reportedUnit !== undefined) {
    if (!Object.hasOwn(scales, reportedUnit))
      return invalid(
        "The declared printed unit is unsupported.",
        "unit_mismatch",
      );
    const kind = dimension(reportedUnit);
    if (currency && kind !== "money")
      return invalid(
        `The literal contains a USD currency marker but reportedUnit is ${reportedUnit}.`,
        "unit_mismatch",
      );
    if (explicit?.unit && explicit.unit !== reportedUnit)
      return invalid(
        `The unit written in the literal disagrees with reportedUnit ${reportedUnit}.`,
        "unit_mismatch",
      );
    if (explicit?.dimension && explicit.dimension !== kind)
      return invalid(
        `The unit written in the literal disagrees with reportedUnit ${reportedUnit}.`,
        "unit_mismatch",
      );
    if (
      explicit?.scale !== undefined &&
      (!["money", "count"].includes(kind) ||
        absoluteScale(reportedUnit) !== explicit.scale)
    )
      return invalid(
        `The scale written in the literal disagrees with reportedUnit ${reportedUnit}.`,
        "unit_mismatch",
      );
    // An explicit word 'dollars' means unscaled dollars; a bare '$'/USD marker
    // still permits a table's declared scale, such as '$3.28' in billions.
    if (
      !suffix &&
      /\b(?:us dollars?|dollars?)\b/i.test(match[2]) &&
      reportedUnit !== "USD"
    )
      return invalid(
        `The literal says dollars without a scale but reportedUnit is ${reportedUnit}.`,
        "unit_mismatch",
      );
  }
  return { number, decimals, error: null, approximate };
}
export function printedUnitScale(
  unit: string,
  reportedUnit: string,
): number | null {
  if (!Object.hasOwn(scales, reportedUnit)) return null;
  const kind = dimension(reportedUnit);
  if (unit === "USD_millions")
    return kind === "money" ? scales[reportedUnit] : null;
  if (unit === "USD") return reportedUnit === "USD" ? 1 : null;
  if (unit === "count") return kind === "count" ? scales[reportedUnit] : null;
  if (unit === "percentage_points")
    return ["percentage_points", "basis_points"].includes(reportedUnit)
      ? scales[reportedUnit]
      : null;
  return unit === reportedUnit ? scales[reportedUnit] : null;
}
export function normalizePrintedAmount(v: {
  reportedValue: string;
  reportedUnit: string;
  unit: string;
}): number | null {
  const parsed = parsePrintedAmount(v.reportedValue, v.reportedUnit),
    scale = printedUnitScale(v.unit, v.reportedUnit);
  if (parsed.error || parsed.number === null || scale === null) return null;
  const result = parsed.number * scale;
  return Number.isFinite(result) ? result : null;
}
export function printedUnitPrecision(v: {
  reportedValue: string;
  reportedUnit: string;
  unit: string;
}): number {
  const parsed = parsePrintedAmount(v.reportedValue, v.reportedUnit),
    scale = printedUnitScale(v.unit, v.reportedUnit);
  return parsed.error || scale === null
    ? 0
    : 0.5 * 10 ** -parsed.decimals * scale;
}
