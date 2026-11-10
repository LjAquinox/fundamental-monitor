"use client";
import { useRef, useState } from "react";
import {
  Search,
  Loader2,
  ExternalLink,
  Trash2,
  Upload,
  Sparkles,
} from "lucide-react";
import { runCompanyReviews } from "../../lib/workflow/company-review-runner.mjs";
import { requestJson, responseJson } from "../../lib/browser-api";
import { readPdf } from "../../lib/pdf-client";
import { isReportingDate } from "../../lib/reporting-dates";
import type { Workspace } from "../../lib/types";

async function post(path: string, body?: unknown): Promise<any> {
  return requestJson(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
}
type Candidate = {
  id: string;
  title: string;
  kind: string;
  quarter: string;
  periodStart: string | null;
  periodEnd: string | null;
  publishedAt: string | null;
  pdfUrl: string;
  sourceUrl: string;
  notes: string;
  sourceConfirmed: boolean;
  selected: boolean;
  documentId?: string;
  extractionId?: string;
  status?: string;
  error?: string;
};
function metadataValid(r: Candidate) {
  return !!(
    r.title.trim() &&
    /^20\d{2}-Q[1-4]$/.test(r.quarter) &&
    r.periodStart &&
    r.periodEnd &&
    r.publishedAt &&
    [r.periodStart, r.periodEnd, r.publishedAt].every(isReportingDate) &&
    r.periodStart <= r.periodEnd &&
    r.periodEnd <= r.publishedAt
  );
}
export function CompanyDiscovery({
  ws,
  configured,
  reload,
  manual,
  open,
  busyChanged,
}: {
  ws: Workspace;
  configured: boolean;
  busyChanged: (busy: boolean) => void;
  reload: () => Promise<Workspace>;
  manual: () => void;
  open: (companyId: string, quarter: string, documentId: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [years, setYears] = useState(3),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [result, setResult] = useState<any>(null),
    [rows, setRows] = useState<Candidate[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [reviewAfter, setReviewAfter] = useState(true),
    [retryFailed, setRetryFailed] = useState(false),
    [progress, setProgress] = useState("");
  const stop = useRef(false);
  const update = (id: string, patch: Partial<Candidate>) =>
    setRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    busyChanged(true);
    setBusy("search");
    setError("");
    setProgress("Searching official report sources…");
    setConfirmed(false);
    try {
      const r = await post("/api/discovery", {
        company: query,
        years: Number(years),
      });
      setResult(r);
      setRows(
        r.reports.map((p: any) => ({
          ...p,
          id: crypto.randomUUID(),
          selected: p.sourceConfirmed && metadataValid(p),
        })),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
      busyChanged(false);
      setProgress("");
    }
  }
  async function run(extract: boolean) {
    if (busy) return;
    busyChanged(true);
    setBusy("import");
    setError("");
    stop.current = false;
    const selected = rows.filter(
      (r) =>
        r.selected && (!r.documentId || (extract && r.status !== "Extracted")),
    );
    let companyId =
      ws.companies.find(
        (c) =>
          c.ticker.toLowerCase() === result.ticker.toLowerCase() ||
          c.name.toLowerCase() === result.companyName.toLowerCase(),
      )?.id || "";
    let failures = 0;
    const imported: Candidate[] = [];
    try {
      for (let i = 0; i < selected.length; i++) {
        if (stop.current) break;
        const r = selected[i];
        update(r.id, { error: "" });
        try {
          if (!metadataValid(r))
            throw new Error(
              "Check the fiscal quarter, exact quarter dates and publication date before import.",
            );
          setProgress(`${i + 1}/${selected.length} · ${r.title}`);
          let id = r.documentId;
          if (!id) {
            update(r.id, { status: "Downloading" });
            const response = await fetch("/api/report-download", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: r.pdfUrl }),
            });
            if (!response.ok) await responseJson(response);
            const file = new File([await response.blob()], "report.pdf", {
              type: "application/pdf",
            });
            const pages = await readPdf(file, (n, total) =>
              setProgress(
                `${i + 1}/${selected.length} · Reading PDF page ${n}/${total}`,
              ),
            );
            const form = new FormData();
            form.set("file", file);
            form.set(
              "metadata",
              JSON.stringify({
                companyId,
                companyName: result.companyName,
                ticker: result.ticker,
                title: r.title,
                kind: r.kind,
                periodStart: r.periodStart,
                periodEnd: r.periodEnd,
                publishedAt: r.publishedAt,
                quarter: r.quarter,
                url: r.sourceUrl,
                aliases: [result.companyName, result.ticker],
                pages,
              }),
            );
            const saved = await fetch("/api/documents", {
              method: "POST",
              body: form,
            });
            const data: any = await responseJson(saved);
            id = data.document.id;
            companyId = data.document.companyId;
            update(r.id, { documentId: id, status: "Imported" });
          }
          if (id) imported.push({ ...r, documentId: id });
        } catch (e: any) {
          failures++;
          update(r.id, { status: "Failed", error: e.message });
        }
      }
      if (extract) {
        let next = 0,
          limited = false,
          acceptance: Promise<unknown> = Promise.resolve();
        async function worker() {
          while (!stop.current && !limited && next < imported.length) {
            const r = imported[next++];
            if (r.status === "Failed" && !r.extractionId && !retryFailed) {
              failures++;
              update(r.id, {
                error: "Explicit retry required after checking provider usage.",
              });
              continue;
            }
            try {
              update(r.id, { status: "Extracting", error: "" });
              setProgress(`Parallel whole-PDF extraction: ${r.title}`);
              let extractionId = r.extractionId;
              if (!extractionId) {
                const output = await post("/api/extract", {
                  documentId: r.documentId,
                });
                extractionId = output.extractionId;
                update(r.id, { extractionId });
              }
              const apply = acceptance.then(() =>
                post("/api/extractions", { action: "replace", extractionId }),
              );
              acceptance = apply.catch(() => {});
              const accepted = await apply;
              update(r.id, {
                status: "Extracted",
                notes: `${accepted.accepted} typed values/statements accepted; ${accepted.needsReview} blocking checks.`,
              });
            } catch (e: any) {
              failures++;
              update(r.id, { status: "Failed", error: e.message });
              if (
                /daily AI call limit|quota|HTTP (400|401|403|404|413|415|422|429)/i.test(
                  e.message,
                )
              )
                limited = true;
            }
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(4, imported.length) }, worker),
        );
      }
      if (extract && reviewAfter && !failures && !stop.current && companyId) {
        const reviews = await runCompanyReviews({
          companies: [{ id: companyId, name: result.companyName }],
          call: post,
          concurrency: 4,
          progress: (message: string) => setProgress(message),
          shouldStop: () => stop.current,
        });
        if (reviews.some((j) => j.status !== "completed"))
          setError(
            "Review progress was saved. Open Company workflow to inspect errors or resume remaining work.",
          );
      }
      await reload();
    } catch (e: any) {
      setError(e.message);
      await reload().catch((failure: Error) =>
        setError((previous) => previous + " " + failure.message),
      );
    } finally {
      setBusy("");
      busyChanged(false);
      setProgress(
        stop.current
          ? "Stopped after the current report. Completed imports were kept."
          : "Finished. Check each report's status; failed reports are not retried automatically.",
      );
    }
  }
  const selected = rows.filter((r) => r.selected);
  return (
    <>
      <div className="heading-row">
        <div>
          <div className="eyebrow">COMPANY RESEARCH</div>
          <h1>
            Add a company<span className="heading-period">.</span>
          </h1>
          <p>
            Find original financial PDFs, inspect the sources, then choose what
            to import.
          </p>
        </div>
        <button className="button secondary" onClick={manual} disabled={!!busy}>
          <Upload size={16} />
          Import a PDF manually
        </button>
      </div>
      <section className="panel discovery-search">
        <form onSubmit={search}>
          <label>
            Company name or ticker
            <input
              required
              value={query}
              maxLength={160}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="AMD, or Advanced Micro Devices"
              disabled={!!busy}
            />
          </label>
          <label>
            Trailing years
            <select
              value={years}
              onChange={(e) => setYears(Number(e.target.value))}
              disabled={!!busy}
            >
              {[1, 2, 3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n} year{n > 1 ? "s" : ""}
                </option>
              ))}
            </select>
          </label>
          <button className="button primary" disabled={!!busy || !configured}>
            {busy === "search" ? (
              <Loader2 className="spin" size={17} />
            ) : (
              <Search size={17} />
            )}
            Find financial reports
          </button>
        </form>
        <p>
          GPT-6 Luna uses live web search. Reports may be missing; search again
          with a narrower period or add a PDF manually. Search and extraction
          are separate paid requests.
        </p>
        {!configured && (
          <div className="form-error">
            Configure your key in API settings first.
          </div>
        )}
      </section>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {progress && (
        <p role="status" className="batch-progress">
          {busy && <Loader2 className="spin" size={17} />} {progress}
        </p>
      )}
      {result && (
        <label className="checkline">
          <input
            type="checkbox"
            checked={retryFailed}
            disabled={!!busy}
            onChange={(e) => setRetryFailed(e.target.checked)}
          />
          Retry failed/uncertain extraction calls after checking provider usage
        </label>
      )}
      {result && (
        <>
          <section className="panel discovery-summary">
            <h2>
              {result.companyName}{" "}
              <span className="badge subtle">{result.ticker}</span>
            </h2>
            <p>{result.coverageNotes}</p>
            <a href={result.website} target="_blank" rel="noreferrer">
              Company website <ExternalLink size={13} />
            </a>
            <details>
              <summary>Search sources ({result.sources?.length || 0})</summary>
              {result.sources?.map((s: string) => (
                <p key={s}>
                  <a href={s} target="_blank" rel="noreferrer">
                    {s}
                  </a>
                </p>
              ))}
            </details>
          </section>
          <div className="discovery-toolbar">
            <span>
              {selected.length} of {rows.length} selected
            </span>
            <button
              className="text-button"
              disabled={!!busy}
              onClick={() =>
                setRows((r) => r.map((x) => ({ ...x, selected: true })))
              }
            >
              Select all
            </button>
            <button
              className="text-button"
              disabled={!!busy}
              onClick={() =>
                setRows((r) => r.map((x) => ({ ...x, selected: false })))
              }
            >
              Select none
            </button>
          </div>
          <div className="discovery-results">
            {rows.map((r) => (
              <section className="panel discovery-report" key={r.id}>
                <div className="discovery-report-heading">
                  <label className="report-select">
                    <input
                      type="checkbox"
                      checked={r.selected}
                      disabled={!!busy}
                      onChange={(e) =>
                        update(r.id, { selected: e.target.checked })
                      }
                    />
                    <strong>{r.title}</strong>
                  </label>
                  <span className="badge subtle">
                    {r.quarter} · {r.kind.replaceAll("_", " ")}
                  </span>
                </div>
                <p>{r.notes}</p>
                <div className="quality-actions">
                  <a
                    href={r.pdfUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="source-link"
                  >
                    Read PDF <ExternalLink size={14} />
                  </a>
                  <a
                    href={r.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="source-link"
                  >
                    Source page <ExternalLink size={14} />
                  </a>
                  <span
                    className={
                      r.sourceConfirmed ? "badge green" : "badge amber"
                    }
                  >
                    {r.sourceConfirmed
                      ? "Source returned by search"
                      : "Source needs checking"}
                  </span>
                  {r.status && <span className="badge subtle">{r.status}</span>}
                  {!r.documentId && (
                    <button
                      className="icon-button danger"
                      aria-label={`Remove candidate ${r.title}`}
                      disabled={!!busy}
                      onClick={() =>
                        setRows((rows) => rows.filter((x) => x.id !== r.id))
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                  {r.documentId && (
                    <button
                      className="text-button"
                      onClick={() => {
                        const c = ws.companies.find(
                          (c) =>
                            c.ticker.toLowerCase() ===
                            result.ticker.toLowerCase(),
                        );
                        if (c) open(c.id, r.quarter, r.documentId!);
                      }}
                      disabled={!!busy}
                    >
                      Open imported report
                    </button>
                  )}
                </div>
                {r.error && <div className="form-error">{r.error}</div>}
                {!metadataValid(r) && (
                  <p className="amber-text">
                    Missing or inconsistent dates. Edit the report details
                    before import.
                  </p>
                )}
                <details>
                  <summary>Review / edit report details</summary>
                  <div className="form-grid">
                    <label className="full">
                      Title
                      <input
                        value={r.title}
                        disabled={!!busy || !!r.documentId}
                        onChange={(e) =>
                          update(r.id, { title: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Fiscal quarter
                      <input
                        value={r.quarter}
                        disabled={!!busy || !!r.documentId}
                        onChange={(e) =>
                          update(r.id, { quarter: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Report type
                      <select
                        value={r.kind}
                        disabled={!!busy || !!r.documentId}
                        onChange={(e) => update(r.id, { kind: e.target.value })}
                      >
                        <option value="filing">
                          Financial filing / annual report
                        </option>
                        <option value="earnings_release">
                          Earnings release
                        </option>
                      </select>
                    </label>
                    {(
                      [
                        ["periodStart", "Quarter start"],
                        ["periodEnd", "Quarter end"],
                        ["publishedAt", "Published"],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key}>
                        {label}
                        <input
                          type="date"
                          value={r[key] || ""}
                          disabled={!!busy || !!r.documentId}
                          onChange={(e) =>
                            update(r.id, { [key]: e.target.value || null })
                          }
                        />
                      </label>
                    ))}
                    <label className="full">
                      PDF URL
                      <input
                        type="url"
                        value={r.pdfUrl}
                        disabled={!!busy || !!r.documentId}
                        onChange={(e) =>
                          update(r.id, {
                            pdfUrl: e.target.value,
                            sourceConfirmed: false,
                          })
                        }
                      />
                    </label>
                  </div>
                </details>
              </section>
            ))}
          </div>
          {!rows.length && (
            <p>
              No PDF candidates found. Try the full company name or import a
              downloaded report.
            </p>
          )}
          {!!rows.length && (
            <div className="batch-actions">
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={!!busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />{" "}
                I checked the company and report metadata. Automatically
                accepted facts remain labelled as unreviewed.
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={reviewAfter}
                  disabled={!!busy}
                  onChange={(e) => setReviewAfter(e.target.checked)}
                />{" "}
                Reconcile the full company after extraction (one additional paid
                company call, with high reasoning by default).
              </label>
              <div className="quality-actions">
                <button
                  className="button secondary"
                  disabled={!!busy || !confirmed || !selected.length}
                  onClick={() => run(false)}
                >
                  <Upload size={16} />
                  Import selected
                </button>
                <button
                  className="button primary"
                  disabled={
                    !!busy || !configured || !confirmed || !selected.length
                  }
                  onClick={() => run(true)}
                >
                  <Sparkles size={16} />
                  Import & extract selected
                </button>
                {busy === "import" && (
                  <button
                    className="button secondary"
                    onClick={() => {
                      stop.current = true;
                      setProgress("Stopping after the current report…");
                    }}
                  >
                    Stop after current report
                  </button>
                )}
              </div>
              <small>
                Extraction sends each whole PDF once and replaces that report's
                previous active report revision after successful acceptance.
                Failed reports keep their previous data. Conflicts and failed
                checks remain in Data quality.
              </small>
            </div>
          )}
        </>
      )}
    </>
  );
}
