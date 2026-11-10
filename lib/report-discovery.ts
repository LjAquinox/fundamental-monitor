import { z } from "zod/v4";
const text = (max: number) => z.string().min(1).max(max);
import { reportingDateSchema } from "./reporting-dates";
const url = z
  .string()
  .max(2000)
  .regex(
    /^https:\/\/(?![^/?#]*@)[^\s/?#@]+(?:[/?#][^\s]*)?$/,
    "Use a public HTTPS source URL.",
  );
const date = reportingDateSchema;
export const reportSchema = z
  .object({
    title: text(200),
    kind: z.enum(["filing", "earnings_release"]),
    quarter: z.string().regex(/^20\d{2}-Q[1-4]$/),
    periodStart: date,
    periodEnd: date,
    publishedAt: date,
    pdfUrl: url,
    sourceUrl: url,
    notes: z.string().max(500),
  })
  .strict();
export const discoverySchema = z
  .object({
    companyName: text(120),
    ticker: text(15),
    website: url,
    reports: z.array(reportSchema).max(80),
    coverageNotes: z.string().max(3000),
  })
  .strict();
export function sourcedReports(
  data: z.infer<typeof discoverySchema>,
  sources: string[],
) {
  const known = new Set(
    sources.map((u) => new URL(u).href.replace(/#.*$/, "")),
  );
  const seen = new Set<string>();
  const reports = data.reports
    .filter((r) => {
      const key = new URL(r.pdfUrl).href.replace(/#.*$/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => ({
      ...r,
      sourceConfirmed:
        known.has(new URL(r.sourceUrl).href.replace(/#.*$/, "")) ||
        known.has(new URL(r.pdfUrl).href.replace(/#.*$/, "")),
    }));
  return { ...data, reports };
}
