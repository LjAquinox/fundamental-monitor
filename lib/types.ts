import type { Report, ReconciliationOutput } from "./report-contract";
import type { z } from "zod/v4";
import type { forecastSchema } from "./provider";
export interface Company {
  id: string;
  name: string;
  ticker: string;
  color: string;
  sector: string;
  aliases: string[];
}
export interface Page {
  page: number;
  text: string;
}
export interface Document {
  id: string;
  companyId: string;
  title: string;
  kind: string;
  quarter: string;
  periodStart: string;
  periodEnd: string;
  publishedAt: string;
  url: string;
  pdfUrl: string;
  pages: Page[];
  sha256: string;
  deleted?: boolean;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number | null;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
export interface Finding {
  path: string;
  effect: "block" | "warning";
  reason: string;
  documentId?: string;
  code?:
    "printed_normalization" | "source_unavailable" | "manual_review_conflict";
  reference?: {
    inputPath: string;
    inputRevision: number;
    currentPath: string | null;
    status: "active" | "superseded_by_correction";
  };
  resolvedAt?: string;
  proposedValue?: unknown;
  previousValue?: unknown;
  normalization?: {
    literal: string;
    reportedUnit: string;
    stored: number;
    unit: string;
    parsed: number | null;
    scale: number;
    expected: number | null;
    magnitude: boolean;
    tolerance: number;
    matches: boolean;
  };
}
export interface ManualCorrection {
  path: string;
  value: unknown;
  at: string;
  reason: string;
}
export interface ReportRevision {
  manualCorrections?: ManualCorrection[];
  normalizations?: { path: string; previous: number; value: number }[];
  contractVersion: string;
  id: string;
  documentId: string;
  companyId: string;
  revision: number;
  sourceHash: string;
  runId: string | null;
  reviewId: string | null;
  at: string;
  reason: string;
  report: Report;
  issues: Finding[];
}
export interface SourceRef {
  documentId: string;
  revision: number;
  path: string;
}
export interface Selection {
  quarter: string;
  choices: Record<string, { source: SourceRef | null; reason: string }>;
}
export interface Publication {
  id: string;
  companyId: string;
  at: string;
  contractVersion: string;
  reviewId: string;
  snapshots: Record<string, { revision: number; hash: string }>;
  selections: Selection[];
  findings: Finding[];
  summary: string;
}
export interface Forecast extends z.infer<typeof forecastSchema> {
  id: string;
  companyId: string;
  quarter: string;
  asOf: string;
  createdAt: string;
  model: string;
  promptVersion: string;
  inputHash: string;
  inputSnapshot: string;
  evidenceMap: Record<string, string>;
  stateFingerprint: string;
  stale: boolean;
  usage: Usage;
}
export interface CompanyReview {
  id: string;
  companyId: string;
  at: string;
  updatedAt: string;
  model: string;
  workflow: "reconcile" | "extract_reconcile";
  status: "running" | "completed";
  contractVersion: string;
  reasoningEffort: any;
  documents: Record<
    string,
    {
      status: "pending" | "running" | "completed" | "failed";
      sourceHash: string;
      extractionId?: string;
      extractionSummary?: {
        accepted: number;
        needsReview: number;
        conflicts: number;
      };
      attempt?: string;
      startedAt?: string;
      error?: string;
      usage?: Usage;
    }
  >;
  consistency: {
    status: "pending" | "running" | "completed" | "failed";
    runId?: string;
    attempt?: string;
    startedAt?: string;
    error?: string;
    findings?: Finding[];
    summary?: string;
    usage?: Usage;
    reusedSavedResponse?: boolean;
    recovery?: { auditId: string; sourceRunId: string; paidCalls: 0 };
  };
  baseline?: Record<string, { revision: number; hash: string }>;
  result?: ReconciliationOutput;
}
export interface Workspace {
  contractVersion: string;
  token: string;
  companies: Company[];
  documents: Omit<Document, "pages">[];
  reports: ReportRevision[];
  publications: Publication[];
  forecasts: Forecast[];
  companyReviews: CompanyReview[];
  audit: { id: string; at: string; payload: string }[];
}
