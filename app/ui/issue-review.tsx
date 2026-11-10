import { useEffect, useState } from "react";
import { responseJson } from "../../lib/browser-api";
import {
  evidenceForPath,
  normalizationDetails,
  normalizationMessage,
} from "../../lib/report-checks";
import { getPath } from "../../lib/report-contract";
import type { Finding, ReportRevision } from "../../lib/types";
const amount = (n: number | null) =>
  n === null
    ? "Cannot interpret printed number"
    : n.toLocaleString("en-US", { maximumSignificantDigits: 15 });

export function IssueReview({
  finding,
  revision,
  onPage,
  onCorrect,
  editable,
}: {
  finding: Finding;
  revision: ReportRevision;
  onPage: (p: number) => void;
  onCorrect: () => void;
  editable: boolean;
}) {
  let field: any;
  try {
    field = getPath(revision.report, finding.path);
  } catch {}
  const unavailable = field === null;
  const coverage = revision.report.coverage.find(
    (c) => c.path === finding.path,
  );
  const [historical, setHistorical] = useState<any>(null);
  useEffect(() => {
    let active = true;
    setHistorical(null);
    if (unavailable && !finding.previousValue) {
      fetch(
        `/api/reports?documentId=${encodeURIComponent(revision.documentId)}`,
      )
        .then(responseJson)
        .then((history: ReportRevision[]) => {
          const previous = history
            .filter(
              (r) =>
                r.revision < revision.revision &&
                r.sourceHash === revision.sourceHash,
            )
            .map((r) => getPath(r.report, finding.path))
            .find((v) => v != null);
          if (active) setHistorical(previous || null);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [
    revision.documentId,
    revision.revision,
    revision.sourceHash,
    finding.path,
    unavailable,
    finding.previousValue,
  ]);
  const previous = finding.previousValue ?? historical;
  const evidence =
    evidenceForPath(revision.report, finding.path) ||
    (coverage?.source
      ? { source: coverage.source }
      : unavailable && previous?.source
        ? previous
        : null);
  const normalization =
    evidence?.type === "Value" &&
    (finding.code === "printed_normalization" ||
      finding.reason === normalizationMessage)
      ? normalizationDetails(evidence, finding.path)
      : null;
  const active = revision.issues.some(
    (i) => i.path === finding.path && i.reason === finding.reason,
  );
  return (
    <section className="issue-review">
      <div className="eyebrow">ISSUE REVIEW · REVISION {revision.revision}</div>
      <h2>
        {normalization
          ? normalization.expected === null
            ? "Printed notation could not be validated"
            : "Review printed amount conversion"
          : unavailable
            ? "Source information unavailable"
            : finding.code === "manual_review_conflict"
              ? "Proposed change to a manual correction"
              : "Review this finding"}
      </h2>
      <code>{finding.path}</code>
      {!active && (
        <p className="info-banner">
          This finding is absent from the current revision’s checks. The
          original finding remains visible here for context; the current
          revision is shown below.
        </p>
      )}
      <p className="form-error">{finding.reason}</p>
      {unavailable && (
        <div className="info-banner">
          <p>
            This field is unavailable in the current report revision. Null means
            unavailable, not zero. This is separate from any count or currency
            conversion you corrected.
          </p>
          {coverage && <p>{coverage.reason}</p>}
          {previous != null && (
            <details>
              <summary>
                Previously stored value (not currently published)
              </summary>
              <pre>{JSON.stringify(previous, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
      {finding.code === "manual_review_conflict" && (
        <details>
          <summary>Model proposal (not applied)</summary>
          <pre>{JSON.stringify(finding.proposedValue, null, 2)}</pre>
        </details>
      )}
      {normalization && (
        <>
          <p>
            {normalization.approximate &&
              "The source amount is approximate; its nominal number is used for conversion. "}
            This arithmetic check compares extraction fields. It does not prove
            which number or unit appears in the PDF.
          </p>
          <dl className="issue-values">
            <div>
              <dt>Literal printed number</dt>
              <dd>{normalization.literal}</dd>
            </div>
            <div>
              <dt>Declared printed unit</dt>
              <dd>{normalization.reportedUnit}</dd>
            </div>
            <div>
              <dt>Stored normalized value</dt>
              <dd>
                {amount(normalization.stored)} {normalization.unit}
              </dd>
            </div>
            <div>
              <dt>Expected normalized value</dt>
              <dd>
                {amount(normalization.expected)}{" "}
                {normalization.expected === null ? "" : normalization.unit}
              </dd>
            </div>
          </dl>
          <p>
            {normalization.parsed === null
              ? "The literal is not an unambiguous number. Check the original PDF for a range, footnote, missing-value dash or unsupported notation."
              : `Conversion: ${amount(normalization.parsed)} × ${amount(normalization.scale)}${normalization.magnitude ? " → absolute payment magnitude" : ""}.`}
          </p>
          {normalization.matches && (
            <p className="info-banner">
              This value passes the current arithmetic check. This stored
              finding may come from an older review. The original finding is
              shown for traceability.
            </p>
          )}
        </>
      )}
      {evidence?.source && (
        <section className="report-section">
          <h3>Evidence to inspect</h3>
          <p>
            {evidence.source.location.type === "Table"
              ? `${evidence.source.location.tableTitle || "Table"} · ${evidence.source.location.rowLabel} · ${evidence.source.location.columnLabel}`
              : evidence.source.location.section}
          </p>
          {evidence.type === "Statement" && <p>{evidence.text}</p>}
          <div className="actions">
            <button
              type="button"
              className="source-link"
              onClick={() => onPage(evidence.source.page)}
            >
              Open PDF page {evidence.source.page}
            </button>
            {evidence.source.location.contextPages.map((p: number) => (
              <button
                type="button"
                className="source-link"
                key={p}
                onClick={() => onPage(p)}
              >
                Context p. {p}
              </button>
            ))}
          </div>
        </section>
      )}
      {!evidence && (
        <p>
          No field-level page was supplied. Inspect the report and its fiscal
          metadata before changing this field.
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          className="button primary"
          disabled={!editable}
          onClick={onCorrect}
        >
          Correct this field
        </button>
      </div>
      <p className="field-help">
        Check the PDF first: the literal, unit, sign or normalized value may be
        wrong. Saving creates a report revision and invalidates company
        publication. Use “Refresh publication from current reports” to recheck
        existing source choices without an AI call; new documents still require
        company review.
      </p>
      <details>
        <summary>
          {unavailable ? "Current field: unavailable" : "Stored field details"}
        </summary>
        <pre>{JSON.stringify(field ?? null, null, 2)}</pre>
      </details>
    </section>
  );
}
