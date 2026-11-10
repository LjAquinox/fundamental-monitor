import { z } from "zod/v4";
/** Shared by model fields, manual input and contextual date checks. */
export const reportingDateSchema = z.iso
  .date()
  .nullable()
  .describe(
    "Complete supported YYYY-MM-DD date, or null when the exact fiscal boundary cannot be established. Never guess or use empty strings.",
  );
export function isReportingDate(value: string): boolean {
  return (
    typeof value === "string" && reportingDateSchema.safeParse(value).success
  );
}

const months: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** Normalize only complete, unambiguous calendar dates. Never infer a period. */
export function normalizeReportingDate(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (isReportingDate(text)) return text;
  const render = (year: string, month: number, day: string) => {
    const iso = `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
    return isReportingDate(iso) ? iso : text;
  };
  // A year-first numeric date is unambiguous. Day-first / month-first slash
  // dates are deliberately rejected, even if a particular locale would guess.
  let match = text.match(/^([1-9][0-9]{3})[-/]([0-9]{1,2})[-/]([0-9]{1,2})$/);
  if (match) return render(match[1], Number(match[2]), match[3]);
  match = text.match(/^([A-Za-z]+)\.?\s+([0-9]{1,2}),?\s+([1-9][0-9]{3})$/);
  if (match && months[match[1].toLowerCase()])
    return render(match[3], months[match[1].toLowerCase()], match[2]);
  match = text.match(/^([0-9]{1,2})\s+([A-Za-z]+)\.?,?\s+([1-9][0-9]{3})$/);
  if (match && months[match[2].toLowerCase()])
    return render(match[3], months[match[2].toLowerCase()], match[1]);
  return text;
}
