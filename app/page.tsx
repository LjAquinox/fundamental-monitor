"use client";
import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  BookOpen,
  Search,
  Settings,
  ShieldCheck,
  TrendingUp,
  Plus,
  Download,
  RefreshCw,
  Loader2,
  Trash2,
  Play,
  Check,
} from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { ApiSettings } from "./ui/settings";
import { CompanyDiscovery } from "./ui/discovery";
import { TypedEditor } from "./ui/report-editor";
import { PdfViewer } from "./ui/pdf-viewer";
import { IssueReview } from "./ui/issue-review";
import { ErrorBoundary } from "./ui/error-boundary";
import { useDialog } from "./ui/use-dialog";
import { evidenceForPath, reviewFieldPath } from "../lib/report-checks";
import { requestJson, responseJson } from "../lib/browser-api";
import { readPdf } from "../lib/pdf-client";
import { runCompanyReviews } from "../lib/workflow/company-review-runner.mjs";
import {
  selectedSeries,
  activePublication,
  derivedMetrics,
  forecastOutcomes,
  displayedNetIncome,
  FINANCIAL_FORMULA_VERSION,
  type SelectedMetric,
} from "../lib/selections";
import { publicationSlots, getPath } from "../lib/report-contract";
import type {
  Workspace,
  Document,
  ReportRevision,
  Finding,
  SourceRef,
} from "../lib/types";
const label = (s: string) =>
  s.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
export async function api(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<any> {
  return requestJson(
    path,
    body === undefined
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
}
const empty: Workspace = {
  contractVersion: "typed-report-v3",
  token: "",
  companies: [],
  documents: [],
  reports: [],
  publications: [],
  forecasts: [],
  companyReviews: [],
  audit: [],
};
function number(value: number | null, unit?: string | null) {
  return value == null || !Number.isFinite(value)
    ? "Not selected"
    : `${value.toLocaleString(undefined, { maximumSignificantDigits: 7 })}${unit === "percent" ? "%" : unit === "USD_millions" ? " M USD" : unit === "USD" ? " USD" : unit ? " " + unit : ""}`;
}
function metricNumber(metric: SelectedMetric) {
  return metric.origin === "calculated" &&
    metric.value !== null &&
    metric.unit === "percent"
    ? `${metric.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
    : number(metric.value, metric.unit);
}
export default function App() {
  const [ws, setWs] = useState(empty),
    [config, setConfig] = useState<any>(null),
    [companyId, setCompanyId] = useState(""),
    [view, setView] = useState("overview"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [progress, setProgress] = useState(""),
    [inspect, setInspect] = useState<string | null>(null),
    [page, setPage] = useState(1),
    [finding, setFinding] = useState<Finding | null>(null),
    [metricDetail, setMetricDetail] = useState<{
      metric: SelectedMetric;
      quarter: string;
    } | null>(null),
    [reportTab, setReportTab] = useState("data"),
    [childBusy, setChildBusy] = useState(false),
    [importing, setImporting] = useState(false),
    [concurrency, setConcurrency] = useState(4),
    [retry, setRetry] = useState(false),
    [fresh, setFresh] = useState(false),
    [all, setAll] = useState(false);
  const stop = useRef(false),
    reloadSequence = useRef(0);
  async function reload() {
    const sequence = ++reloadSequence.current,
      w = await api("/api/workspace");
    if (sequence === reloadSequence.current) {
      setWs(w);
      setCompanyId((id) =>
        w.companies.some((c: any) => c.id === id)
          ? id
          : w.companies[0]?.id || "",
      );
    }
    return w;
  }
  useEffect(() => {
    Promise.all([reload(), api("/api/config").then(setConfig)]).catch((e) =>
      setError(e.message),
    );
  }, []);
  const company = ws.companies.find((c) => c.id === companyId),
    docs = ws.documents
      .filter((d) => d.companyId === companyId)
      .sort(
        (a, b) =>
          b.quarter.localeCompare(a.quarter) ||
          b.publishedAt.localeCompare(a.publishedAt),
      ),
    series = selectedSeries(ws, companyId),
    pub = activePublication(ws, companyId),
    latest = series.at(-1),
    report = ws.reports.find((r) => r.documentId === inspect),
    doc = ws.documents.find((d) => d.id === inspect);
  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      try {
        await reload();
      } catch (e: any) {
        setError((previous) => [previous, e.message].filter(Boolean).join(" "));
      }
      setBusy("");
    }
  }
  function open(
    documentId: string,
    p = 1,
    issue: Finding | null = null,
    tab = "data",
  ) {
    setFinding(issue);
    setReportTab(issue ? "issue" : tab);
    setInspect(documentId);
    setPage(p);
  }
  function openMetric(v: SelectedMetric, quarter: string) {
    if (v.origin === "calculated") {
      setMetricDetail({ metric: v, quarter });
      return;
    }
    if (v.source)
      open(
        v.source.documentId,
        evidenceForPath(
          ws.reports.find((r) => r.documentId === v.source!.documentId)!.report,
          v.source.path,
        )?.source.page || 1,
      );
  }
  function openFinding(r: ReportRevision, f: Finding) {
    open(r.documentId, evidenceForPath(r.report, f.path)?.source.page || 1, f);
  }
  function closeReport() {
    setInspect(null);
    setFinding(null);
  }
  async function workflow(resume = false) {
    stop.current = false;
    await act("workflow", async () => {
      const companies = all
        ? ws.companies.filter((c) =>
            ws.documents.some((d) => d.companyId === c.id),
          )
        : company
          ? [company]
          : [];
      const jobs = [];
      for (const target of companies) {
        if (stop.current) break;
        const previous = ws.companyReviews.find(
          (j) => j.companyId === target.id,
        );
        if (
          resume &&
          previous?.status === "completed" &&
          !activePublication(ws, target.id)
        )
          throw new Error(
            "The saved workflow is complete, but its source data changed. Run a new company review using the existing accepted reports.",
          );
        const results = await runCompanyReviews({
          companies: [target],
          call: api,
          concurrency,
          retryFailed: retry,
          fresh: resume ? false : fresh,
          workflow:
            resume && previous
              ? previous.workflow
              : fresh
                ? "extract_reconcile"
                : "reconcile",
          shouldStop: () => stop.current,
          progress: setProgress,
        });
        jobs.push(...results);
      }
      if (jobs.some((j: any) => j.status !== "completed"))
        throw new Error(
          "Some workflows are incomplete. Progress is saved. Check the message and provider usage before enabling retry.",
        );
      setProgress(
        stop.current
          ? "Workflow stopped. Completed work was kept."
          : "Company review finished. See selected metrics and unresolved findings.",
      );
    });
  }
  async function extractDocument(id: string) {
    await act("extract", async () => {
      await api("/api/extract", { documentId: id });
      setProgress(
        "Extraction saved. Inspect the proposal and accept all changes to replace this report’s active data.",
      );
      open(id, 1, null, "extractions");
    });
  }
  function exportData() {
    const a = document.createElement("a"),
      url = URL.createObjectURL(
        new Blob(
          [
            JSON.stringify(
              {
                ...ws,
                financial: Object.fromEntries(
                  ws.companies.map((c) => [c.id, selectedSeries(ws, c.id)]),
                ),
                calculated: Object.fromEntries(
                  ws.companies.map((c) => [c.id, derivedMetrics(ws, c.id)]),
                ),
                formulaVersion: FINANCIAL_FORMULA_VERSION,
                exportedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
      );
    a.href = url;
    a.download = "fundamental-monitor-typed-v3.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">
            <BarChart3 size={19} />
          </span>
          Fundamental<span className="brand-dot">.</span>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          {[
            ["overview", "Overview", BarChart3],
            ["reports", "Reports", BookOpen],
            ["review", "Company workflow", ShieldCheck],
            ["quality", "Data quality", ShieldCheck],
            ["forecasts", "Forecasts", TrendingUp],
            ["discovery", "Add a company", Search],
            ["settings", "API settings", Settings],
          ].map(([key, title, Icon]: any) => (
            <button
              key={key}
              className={view === key ? "active" : ""}
              disabled={!!busy || childBusy}
              onClick={() => setView(key)}
            >
              <Icon size={18} />
              {title}
            </button>
          ))}
        </nav>
        <div className="watchlist-label">WATCHLIST</div>
        <div className="company-list">
          {ws.companies.map((c) => (
            <button
              type="button"
              disabled={!!busy || childBusy}
              key={c.id}
              className={`company-nav ${companyId === c.id ? "selected" : ""}`}
              onClick={() => setCompanyId(c.id)}
            >
              <span className="company-dot" style={{ background: c.color }} />
              {c.name}
              <span className="ticker-small">{c.ticker}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">
          Local research · Contract V3
          <br />
          Original PDFs remain attached.
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <select
            aria-label="Company"
            value={companyId}
            disabled={!!busy || childBusy}
            onChange={(e) => setCompanyId(e.target.value)}
          >
            {ws.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.ticker}
              </option>
            ))}
          </select>
          <div className="actions">
            <button className="button secondary" onClick={exportData}>
              <Download size={16} />
              Export research
            </button>
            <button
              className="button secondary"
              onClick={() => act("refresh", async () => {})}
              disabled={!!busy || childBusy}
            >
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>
        </header>
        <div className="content">
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {busy && (
            <p role="status" className="batch-progress">
              <Loader2 className="spin" size={16} />
              {busy} · {progress || "Working…"}
            </p>
          )}
          {!busy && progress && (
            <p role="status" className="batch-progress">
              {progress}
            </p>
          )}
          {view === "settings" && config && (
            <ApiSettings
              config={config}
              updated={setConfig}
              busyChanged={setChildBusy}
            />
          )}
          {view === "discovery" && (
            <CompanyDiscovery
              ws={ws}
              busyChanged={setChildBusy}
              configured={!!config?.configured}
              reload={reload}
              manual={() => setImporting(true)}
              open={(c, _quarter, d) => {
                setCompanyId(c);
                setView("reports");
                open(d);
              }}
            />
          )}
          {view === "overview" && (
            <>
              <div className="heading-row">
                <div>
                  <div className="eyebrow">COMPANY FUNDAMENTALS</div>
                  <h1>{company?.name || "Your research"}</h1>
                  <p>
                    Quarterly consolidated GAAP results, selected from reviewed
                    source reports.
                  </p>
                </div>
                <span className={`badge ${pub ? "green" : "amber"}`}>
                  {pub ? "Company reviewed" : "Review required"}
                </span>
              </div>
              <div className="metric-grid">
                {[
                  { key: "revenue", value: latest?.metrics.revenue },
                  {
                    key: "operatingMargin",
                    value: latest?.metrics.operatingMargin,
                  },
                  {
                    key: "netIncome",
                    value: latest
                      ? displayedNetIncome(latest.metrics)
                      : undefined,
                  },
                  {
                    key: "operatingCashFlow",
                    value: latest?.metrics.operatingCashFlow,
                  },
                ].map(({ key, value: v }) => (
                  <button
                    className="panel metric-card"
                    key={key}
                    onClick={() => v && latest && openMetric(v, latest.quarter)}
                  >
                    <span>{v?.label || label(key)}</span>
                    <strong>{v ? metricNumber(v) : number(null)}</strong>
                    <small>
                      {latest?.quarter || "No quarter"}
                      {v?.origin === "calculated" ? " · Calculated" : ""}
                    </small>
                    <p>
                      {v?.value == null
                        ? v?.reason ||
                          "Company review/source selection required."
                        : v.origin === "calculated"
                          ? "View calculation and both source inputs"
                          : "Open selected PDF evidence"}
                    </p>
                  </button>
                ))}
              </div>
              <section className="panel">
                <h2>Revenue by fiscal quarter</h2>
                <p>
                  Consolidated GAAP · USD millions · gaps remain unavailable.
                </p>
                <div className="chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={series.map((r) => ({
                        quarter: r.quarter,
                        revenue: r.metrics.revenue.value,
                      }))}
                    >
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="quarter" />
                      <YAxis width={70} />
                      <Tooltip />
                      <Line
                        dataKey="revenue"
                        stroke="#287b66"
                        strokeWidth={3}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </section>
              <section className="panel">
                <h2>Quarterly source selections</h2>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Quarter</th>
                        <th>Revenue</th>
                        <th>Operating margin</th>
                        <th>Net income</th>
                        <th>Revenue YoY</th>
                      </tr>
                    </thead>
                    <tbody>
                      {series.map((row) => (
                        <tr key={row.quarter}>
                          <th>{row.quarter}</th>
                          {["revenue", "operatingMargin", "netIncome"].map(
                            (m) => {
                              const v =
                                m === "netIncome"
                                  ? displayedNetIncome(row.metrics)
                                  : row.metrics[m];
                              return (
                                <td key={m}>
                                  <button
                                    title={v.reason}
                                    className="source-link"
                                    onClick={() => openMetric(v, row.quarter)}
                                  >
                                    {metricNumber(v)}
                                  </button>
                                  {m === "netIncome" && v.value !== null && (
                                    <small className="field-help metric-provenance">
                                      {v.label}
                                    </small>
                                  )}
                                  {m === "operatingMargin" &&
                                    v.origin === "calculated" && (
                                      <small className="field-help metric-provenance">
                                        Calculated · GAAP
                                      </small>
                                    )}
                                </td>
                              );
                            },
                          )}
                          <td>
                            {number(
                              derivedMetrics(ws, companyId).find(
                                (d) => d.quarter === row.quarter,
                              )?.revenueYoY ?? null,
                              "percent",
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="panel">
                <h2>Material events</h2>
                <p>
                  Equity investments, financing, acquisitions, divestitures and
                  restructuring. Transaction stages are not summed as new
                  capital.
                </p>
                {ws.reports
                  .filter((r) => r.companyId === companyId)
                  .flatMap((r) =>
                    r.report.events.map((e, i) => (
                      <article className="event-row" key={`${r.id}-${i}`}>
                        <span className="badge">
                          {e.type} · {e.status}
                        </span>
                        <strong>{e.transactionKey}</strong>
                        <p>{e.terms.text}</p>
                        <button
                          className="source-link"
                          onClick={() =>
                            open(r.documentId, e.terms.source.page)
                          }
                        >
                          Source PDF · p. {e.terms.source.page}
                        </button>
                        <small>
                          {r.reviewId
                            ? "Company reviewed"
                            : "Pending company review"}
                        </small>
                      </article>
                    )),
                  )}
              </section>
            </>
          )}
          {view === "reports" && (
            <>
              <div className="heading-row">
                <div>
                  <div className="eyebrow">SOURCE LIBRARY</div>
                  <h1>Reports</h1>
                  <p>Import, read, extract and remove company reports.</p>
                </div>
                <button
                  className="button primary"
                  onClick={() => setImporting(true)}
                >
                  <Plus size={16} />
                  Add report
                </button>
              </div>
              {docs.map((d) => {
                const r = ws.reports.find((r) => r.documentId === d.id);
                return (
                  <section className="panel report-row" key={d.id}>
                    <div>
                      <span className="badge">{d.quarter}</span>
                      <h2>{d.title}</h2>
                      <p>
                        Published {d.publishedAt} ·{" "}
                        {r
                          ? `Revision ${r.revision} · ${r.reviewId ? "company reviewed" : "pending review"}`
                          : "Not extracted"}
                      </p>
                    </div>
                    <div className="actions">
                      <button
                        className="button secondary"
                        onClick={() => open(d.id)}
                      >
                        Read & inspect
                      </button>
                      <button
                        className="button primary"
                        disabled={!!busy || !config?.configured}
                        onClick={() => extractDocument(d.id)}
                      >
                        Extract whole PDF
                      </button>
                      <button
                        title="Remove report"
                        className="button danger"
                        disabled={!!busy || childBusy}
                        onClick={() =>
                          act("remove", () =>
                            api("/api/documents", { id: d.id }, "DELETE"),
                          )
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </section>
                );
              })}
              {!docs.length && (
                <section className="panel empty">
                  Add a PDF manually or use report discovery.
                </section>
              )}
            </>
          )}
          {view === "review" && (
            <>
              <div className="heading-row">
                <div>
                  <div className="eyebrow">EXTRACTION & RECONCILIATION</div>
                  <h1>Company workflow</h1>
                  <p>
                    Parallel whole-PDF extraction, then one source-based company
                    reconciliation.
                  </p>
                </div>
              </div>
              <section className="panel">
                <div className="form-grid">
                  <label>
                    Parallel extractions
                    <input
                      type="number"
                      min={1}
                      max={16}
                      value={concurrency}
                      onChange={(e) => setConcurrency(Number(e.target.value))}
                    />
                  </label>
                  <p>
                    Review model: {config?.reviewModel || config?.model} ·
                    reasoning: {config?.reviewReasoningEffort || "high"}
                  </p>
                </div>
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={all}
                    onChange={(e) => setAll(e.target.checked)}
                  />
                  Run for all companies
                </label>
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={fresh}
                    onChange={(e) => setFresh(e.target.checked)}
                  />
                  Fresh extraction of all PDFs before review (paid; replaces
                  manual corrections). Otherwise run an AI review of existing
                  accepted reports.
                </label>
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={retry}
                    onChange={(e) => setRetry(e.target.checked)}
                  />
                  Retry failed/uncertain calls after checking provider usage
                </label>
                <div className="actions">
                  <button
                    className="button primary"
                    disabled={!!busy || !config?.configured || !company}
                    onClick={() => workflow()}
                  >
                    <Play size={16} />
                    Run company workflow (AI)
                  </button>
                  <button
                    className="button secondary"
                    disabled={!!busy || childBusy || !company}
                    onClick={() =>
                      act("refresh publication", async () => {
                        const targets = all
                          ? ws.companies.filter((c) =>
                              ws.documents.some((d) => d.companyId === c.id),
                            )
                          : company
                            ? [company]
                            : [];
                        for (const target of targets)
                          await api("/api/company-review", {
                            action: "refresh_publication",
                            companyId: target.id,
                          });
                        setProgress(
                          "Existing source choices refreshed locally. No AI calls were made.",
                        );
                      })
                    }
                  >
                    Refresh publication from current reports (no AI)
                  </button>
                  <button
                    className="button secondary"
                    disabled={!!busy || !config?.configured || !company}
                    onClick={() => workflow(true)}
                  >
                    Resume saved workflow
                  </button>
                  {busy === "workflow" && (
                    <button
                      className="button secondary"
                      onClick={() => {
                        stop.current = true;
                        setProgress(
                          "Stopping after in-flight requests complete…",
                        );
                      }}
                    >
                      Stop after current requests
                    </button>
                  )}
                </div>
                <p className="muted">
                  For manual corrections or parser updates, use the no-AI
                  refresh button. It reuses existing source choices and does not
                  re-extract PDFs. Missing source information remains
                  unavailable. Run company workflow makes a paid reconciliation
                  request when a new review is needed. Progress is saved.
                  Changes replace active report revisions while retaining the
                  source and revision history. Structured output constrains the
                  format; company review does not guarantee factual correctness.
                </p>
              </section>
              {ws.companyReviews
                .filter((j) => all || j.companyId === companyId)
                .slice(0, 10)
                .map((j) => (
                  <section className="panel" key={j.id}>
                    <h2>
                      {ws.companies.find((c) => c.id === j.companyId)?.name} ·{" "}
                      {j.consistency.status}
                    </h2>
                    <p>
                      {j.at} · {j.workflow}
                    </p>
                    <p>
                      {j.consistency.summary ||
                        j.consistency.error ||
                        "Awaiting reconciliation"}
                    </p>
                    {!!j.consistency.findings?.length && (
                      <details>
                        <summary>
                          Review findings:{" "}
                          {
                            j.consistency.findings.filter((f) => !f.resolvedAt)
                              .length
                          }{" "}
                          active,{" "}
                          {
                            j.consistency.findings.filter((f) => f.resolvedAt)
                              .length
                          }{" "}
                          input references superseded by corrections
                        </summary>
                        {j.consistency.findings.map((f, index) => (
                          <div key={index} className="report-section">
                            <code>
                              {f.documentId} · {f.path}
                            </code>
                            <p>{f.reason}</p>
                            {f.reference && (
                              <p className="field-help">
                                Input revision {f.reference.inputRevision}:{" "}
                                {f.reference.inputPath}.{" "}
                                {f.reference.status ===
                                "superseded_by_correction"
                                  ? "This input field/item was removed or replaced. Its finding is retained as history and is not attached to another current item."
                                  : `Current target: ${f.reference.currentPath}.`}
                              </p>
                            )}
                          </div>
                        ))}
                      </details>
                    )}
                    {Object.entries(j.documents)
                      .filter(([, d]) => d.error)
                      .map(([id, d]) => (
                        <p className="form-error" key={id}>
                          {id}: {d.error}
                        </p>
                      ))}
                  </section>
                ))}
            </>
          )}
          {view === "quality" && (
            <>
              <div className="heading-row">
                <div>
                  <h1>Data quality</h1>
                  <p>
                    Source/context checks and unresolved publication choices.
                  </p>
                </div>
              </div>
              {!pub && (
                <div className="info-banner">
                  Current company source selection is unavailable. Run the
                  company workflow after accepting all report extractions.
                </div>
              )}
              {ws.reports
                .filter((r) => r.companyId === companyId)
                .flatMap((r) =>
                  r.issues.map((i, n) => (
                    <section className="panel quality-row" key={`${r.id}-${n}`}>
                      <span
                        className={`badge ${i.effect === "block" ? "amber" : "subtle"}`}
                      >
                        {i.code === "source_unavailable"
                          ? "unavailable"
                          : i.code === "manual_review_conflict"
                            ? "proposal"
                            : i.effect}
                      </span>
                      <strong>
                        {docs.find((d) => d.id === r.documentId)?.title}
                      </strong>
                      <code>{i.path}</code>
                      <p>{i.reason}</p>
                      <button
                        className="source-link"
                        onClick={() => openFinding(r, i)}
                      >
                        Review this issue
                      </button>
                    </section>
                  )),
                )}
              {pub?.selections.flatMap((s) =>
                Object.entries(s.choices)
                  .filter(([, v]) => !v.source)
                  .map(([m, v]) => (
                    <section className="panel" key={`${s.quarter}-${m}`}>
                      <strong>
                        {s.quarter} · {label(m)}
                      </strong>
                      <p>{v.reason}</p>
                      {docs.find((d) => d.quarter === s.quarter) && (
                        <button
                          type="button"
                          className="source-link"
                          onClick={() => {
                            const source = docs.find(
                                (d) => d.quarter === s.quarter,
                              )!,
                              revision = ws.reports.find(
                                (r) => r.documentId === source.id,
                              );
                            const issue: Finding = {
                              path: publicationSlots[m].path,
                              effect: "block",
                              reason: v.reason,
                            };
                            if (revision) openFinding(revision, issue);
                            else open(source.id);
                          }}
                        >
                          Inspect this quarter’s source
                        </button>
                      )}
                    </section>
                  )),
              )}
            </>
          )}
          {view === "forecasts" && (
            <>
              <div className="heading-row">
                <div>
                  <div className="eyebrow">EVIDENCE-BASED OUTLOOK</div>
                  <h1>Forecasts</h1>
                  <p>
                    Direction of next-quarter revenue growth and GAAP operating
                    margin.
                  </p>
                </div>
                <button
                  className="button primary"
                  disabled={!!busy || !config?.configured || !pub || !latest}
                  onClick={() =>
                    act("forecast", () =>
                      api("/api/forecast", {
                        companyId,
                        quarter: latest!.quarter,
                        asOf: new Date().toISOString().slice(0, 10),
                      }),
                    )
                  }
                >
                  <TrendingUp size={16} />
                  Forecast next quarter
                </button>
              </div>
              <section className="info-banner">
                Only reviewed selected metrics form financial history. Events,
                risks and guidance supply separate context. Later PDFs cannot
                enter a historical forecast cutoff.
              </section>
              {ws.forecasts
                .filter((f) => f.companyId === companyId)
                .map((f) => (
                  <section className="panel" key={f.id}>
                    <h2>
                      After {f.quarter} · as of {f.asOf}{" "}
                      {f.stale && (
                        <span className="badge amber">Research changed</span>
                      )}
                    </h2>
                    <p>{f.assessment}</p>
                    {f.predictions.map((p) => (
                      <article className="event-row" key={p.metric}>
                        <strong>
                          {label(p.metric.replaceAll("_", " "))}:{" "}
                          {p.direction.replaceAll("_", " ")}
                        </strong>
                        <p>{p.rationale}</p>
                        <p className="muted">{p.uncertainty}</p>
                        <details>
                          <summary>Evidence references</summary>
                          {p.evidenceIds.map((id) => (
                            <p key={id}>
                              <code>{id}</code>
                            </p>
                          ))}
                        </details>
                      </article>
                    ))}
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Target outcome</th>
                            <th>Frozen baseline</th>
                            <th>Observed next quarter</th>
                            <th>Evaluation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {forecastOutcomes(ws, f).map((o) => (
                            <tr key={o.metric}>
                              <td>
                                {o.quarter} · {o.metric.replaceAll("_", " ")}
                              </td>
                              <td>{number(o.baseline, "percent")}</td>
                              <td>{number(o.actual, "percent")}</td>
                              <td>{o.status}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <details>
                      <summary>Frozen model input</summary>
                      <pre>{formatSnapshot(f.inputSnapshot)}</pre>
                    </details>
                  </section>
                ))}
            </>
          )}
        </div>
      </main>
      {metricDetail && (
        <CalculationModal
          detail={metricDetail}
          ws={ws}
          close={() => setMetricDetail(null)}
          openSource={(ref) => {
            setMetricDetail(null);
            const r = ws.reports.find(
              (r) =>
                r.documentId === ref.documentId && r.revision === ref.revision,
            );
            if (r)
              open(
                ref.documentId,
                evidenceForPath(r.report, ref.path)?.source.page || 1,
              );
          }}
        />
      )}
      {inspect && doc && (
        <ErrorBoundary
          key={`${inspect}:${finding?.path || "report"}`}
          close={closeReport}
        >
          <ReportModal
            key={inspect}
            document={doc}
            revision={report}
            initialPage={page}
            initialFinding={finding}
            initialTab={reportTab}
            close={closeReport}
            reload={reload}
            configured={!!config?.configured}
          />
        </ErrorBoundary>
      )}
      {importing && (
        <ErrorBoundary close={() => setImporting(false)}>
          <ImportModal
            ws={ws}
            companyId={companyId}
            close={() => setImporting(false)}
            done={async (d) => {
              await reload();
              setCompanyId(d.companyId);
              setView("reports");
              setImporting(false);
              open(d.id);
            }}
          />
        </ErrorBoundary>
      )}
    </div>
  );
}
function formatSnapshot(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return "Stored forecast input is not valid JSON.\n" + value;
  }
}
function EvidenceTree({
  value,
  path = "",
  onPage,
}: {
  value: any;
  path?: string;
  onPage: (p: number) => void;
}) {
  if (value === null) return <span className="muted">Unavailable</span>;
  if (typeof value !== "object") return <span>{String(value)}</span>;
  if (value.type === "Value" || value.type === "Statement")
    return (
      <div className="evidence-item">
        {value.type === "Value" ? (
          <>
            <strong>{number(value.value, value.unit)}</strong>
            <small>
              Printed: {value.reportedValue} {value.reportedUnit}
            </small>
            {value.attribution && (
              <small>
                Net-income attribution:{" "}
                {value.attribution === "Consolidated"
                  ? "Consolidated group"
                  : "Not specified in source"}
              </small>
            )}
          </>
        ) : (
          <p>{value.text}</p>
        )}
        <button
          className="source-link"
          onClick={() => onPage(value.source.page)}
        >
          PDF p. {value.source.page} ·{" "}
          {value.source.location.type === "Table"
            ? `${value.source.location.rowLabel} / ${value.source.location.columnLabel}`
            : value.source.location.section}
        </button>
        {value.source.location.contextPages.length > 0 && (
          <small>
            Context:{" "}
            {value.source.location.contextPages.map((p: number) => (
              <button key={p} onClick={() => onPage(p)} className="source-link">
                p. {p}{" "}
              </button>
            ))}
          </small>
        )}
      </div>
    );
  if (Array.isArray(value))
    return value.length ? (
      <div>
        {value.map((v, i) => (
          <details className="report-section" key={i} open={value.length < 4}>
            <summary>
              {v.type || v.category || v.kind || "Item"} ·{" "}
              {v.name ||
                v.transactionKey ||
                v.metric ||
                v.target?.metric ||
                v.path ||
                i + 1}
            </summary>
            <EvidenceTree value={v} path={`${path}.${i}`} onPage={onPage} />
          </details>
        ))}
      </div>
    ) : (
      <span className="muted">No extracted items</span>
    );
  return (
    <dl className="typed-fields">
      {Object.entries(value).map(([key, v]) => (
        <div key={key}>
          <dt>{label(key)}</dt>
          <dd>
            <EvidenceTree
              value={v}
              path={path ? `${path}.${key}` : key}
              onPage={onPage}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}
function CalculationModal({
  detail,
  ws,
  close,
  openSource,
}: {
  detail: { metric: SelectedMetric; quarter: string };
  ws: Workspace;
  close: () => void;
  openSource: (ref: SourceRef) => void;
}) {
  const dialog = useDialog(close),
    v = detail.metric;
  return (
    <div className="modal-overlay">
      <section
        ref={dialog}
        tabIndex={-1}
        className="report-modal metric-calculation-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Operating margin calculation"
      >
        <header>
          <div>
            <h2>{v.label} · Calculated</h2>
            <p>
              {detail.quarter} · GAAP · {v.formulaVersion}
            </p>
          </div>
          <button type="button" className="button secondary" onClick={close}>
            Close
          </button>
        </header>
        <p>{v.definition}</p>
        <strong>{metricNumber(v)}</strong>
        <p>
          <code>{v.formula}</code>
        </p>
        <p>
          This percentage is calculated by the application. It is not a printed
          amount extracted from the PDF.
        </p>
        {v.operands.map((operand) => (
          <section className="report-section" key={operand.metric}>
            <h3>{label(operand.metric)}</h3>
            <p>{number(operand.value, operand.unit)}</p>
            <p>
              {
                ws.documents.find((d) => d.id === operand.source.documentId)
                  ?.title
              }{" "}
              · revision {operand.source.revision}
            </p>
            <button
              type="button"
              className="source-link"
              onClick={() => openSource(operand.source)}
            >
              Open {label(operand.metric).toLowerCase()} PDF evidence
            </button>
          </section>
        ))}
        <p className="field-help">{v.reason}</p>
      </section>
    </div>
  );
}
function ReportModal({
  document: d,
  revision,
  initialPage,
  initialFinding,
  initialTab,
  close,
  reload,
  configured,
}: {
  document: Omit<Document, "pages">;
  revision?: ReportRevision;
  initialPage: number;
  initialFinding: Finding | null;
  initialTab: string;
  close: () => void;
  reload: () => Promise<Workspace>;
  configured: boolean;
}) {
  const [page, setPage] = useState(initialPage),
    [tab, setTab] = useState(initialTab),
    [focused, setFocused] = useState<Finding | null>(initialFinding),
    [history, setHistory] = useState<ReportRevision[]>([]),
    [runs, setRuns] = useState<any[]>([]),
    [selected, setSelected] = useState<number | null>(null),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dialog = useDialog(close, busy),
    refreshSequence = useRef(0);
  const shown =
    selected !== null ? history.find((r) => r.revision === selected) : revision;
  async function refresh() {
    const sequence = ++refreshSequence.current;
    const [nextHistory, nextRuns] = await Promise.all([
      api(`/api/reports?documentId=${encodeURIComponent(d.id)}`),
      api(`/api/extractions?documentId=${encodeURIComponent(d.id)}`),
    ]);
    if (sequence === refreshSequence.current) {
      setHistory(nextHistory);
      setRuns(nextRuns);
    }
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    return () => {
      ++refreshSequence.current;
    };
  }, [d.id, revision?.revision]);
  async function act(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      try {
        await reload();
        await refresh();
      } catch (e: any) {
        setError((previous) => [previous, e.message].filter(Boolean).join(" "));
      }
      setBusy(false);
    }
  }
  return (
    <div className="modal-overlay">
      <section
        ref={dialog}
        tabIndex={-1}
        className="report-modal"
        role="dialog"
        aria-modal="true"
        aria-label={d.title}
      >
        <header>
          <div>
            <h2>{d.title}</h2>
            <p>
              {d.quarter} · Published {d.publishedAt}
            </p>
          </div>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={close}
          >
            Close
          </button>
        </header>
        {error && <p className="form-error">{error}</p>}
        <div className="report-columns">
          <div className="pdf-pane">
            <ErrorBoundary>
              <PdfViewer
                url={d.pdfUrl}
                documentId={d.id}
                page={page}
                onPage={setPage}
              />
            </ErrorBoundary>
          </div>
          <div className="report-data">
            <div className="actions">
              {(focused
                ? ["issue", "data", "extractions", "history"]
                : ["data", "extractions", "history"]
              ).map((t) => (
                <button
                  className={`button ${tab === t ? "primary" : "secondary"}`}
                  key={t}
                  disabled={busy}
                  type="button"
                  onClick={() => {
                    setTab(t);
                    setEditing(false);
                  }}
                >
                  {t === "issue" ? "Problem review" : label(t)}
                </button>
              ))}
            </div>
            {tab === "issue" && focused && shown && (
              <>
                <IssueReview
                  finding={focused}
                  revision={shown}
                  onPage={setPage}
                  editable={!busy && shown.revision === revision?.revision}
                  onCorrect={() => setEditing(true)}
                />
                {editing && shown.revision === revision?.revision && (
                  <TypedEditor
                    key={`${shown.id}:${focused.path}`}
                    document={d}
                    revision={shown}
                    focusPath={reviewFieldPath(focused)}
                    busyChanged={setBusy}
                    saved={async () => {
                      await act(async () => {});
                      setEditing(false);
                      setSelected(null);
                    }}
                  />
                )}
              </>
            )}
            {tab === "data" && (
              <>
                {shown ? (
                  <>
                    <p>
                      Revision {shown.revision} ·{" "}
                      {shown.reviewId
                        ? "Company reviewed"
                        : "Pending company review"}{" "}
                      · {shown.at}
                    </p>
                    {selected !== null && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={() => {
                          setSelected(null);
                          setEditing(false);
                        }}
                      >
                        Return to current revision
                      </button>
                    )}
                    {shown.revision === revision?.revision && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => setEditing(!editing)}
                      >
                        {editing ? "Cancel editing" : "Correct report"}
                      </button>
                    )}
                    {editing ? (
                      <TypedEditor
                        key={shown.id}
                        busyChanged={setBusy}
                        document={d}
                        revision={shown}
                        saved={async () => {
                          await act(async () => {});
                          setEditing(false);
                          setSelected(null);
                        }}
                      />
                    ) : (
                      <>
                        {Object.entries(shown.report).map(([key, value]) => (
                          <details
                            className="report-section"
                            key={key}
                            open={key === "currentQuarter"}
                          >
                            <summary>{label(key)}</summary>
                            <EvidenceTree
                              value={value}
                              path={key}
                              onPage={setPage}
                            />
                          </details>
                        ))}
                        {shown.issues.map((i, n) => (
                          <section className="form-error" key={n}>
                            <p>
                              {i.path}: {i.reason}
                            </p>
                            <button
                              type="button"
                              className="source-link"
                              onClick={() => {
                                setFocused(i);
                                setPage(
                                  evidenceForPath(shown.report, i.path)?.source
                                    .page || 1,
                                );
                                setTab("issue");
                                setEditing(false);
                              }}
                            >
                              Review this issue
                            </button>
                          </section>
                        ))}
                      </>
                    )}
                  </>
                ) : (
                  <p>
                    No accepted typed extraction. Extract the PDF and accept its
                    report below.
                  </p>
                )}
              </>
            )}
            {tab === "extractions" && (
              <>
                <button
                  className="button primary"
                  disabled={busy || !configured}
                  onClick={() =>
                    act(() => api("/api/extract", { documentId: d.id }))
                  }
                >
                  {busy ? (
                    <Loader2 className="spin" size={16} />
                  ) : (
                    <Play size={16} />
                  )}
                  Extract whole PDF
                </button>
                {runs.map((run) => (
                  <section className="panel" key={run.id}>
                    <h3>{run.at}</h3>
                    <p>
                      {run.status} · {run.model}
                    </p>
                    {run.error && <p className="form-error">{run.error}</p>}
                    {run.status === "completed" && run.report && (
                      <>
                        <button
                          className="button primary"
                          disabled={
                            busy ||
                            revision?.runId === run.id ||
                            run.baselineRevision !== (revision?.revision || 0)
                          }
                          onClick={() =>
                            act(async () => {
                              await api("/api/extractions", {
                                action: "replace",
                                extractionId: run.id,
                              });
                              setSelected(null);
                            })
                          }
                        >
                          <Check size={16} />
                          {revision?.runId === run.id
                            ? "Accepted"
                            : run.baselineRevision !== (revision?.revision || 0)
                              ? "Outdated proposal"
                              : "Accept all changes"}
                        </button>
                        <details>
                          <summary>Proposed report</summary>
                          <EvidenceTree value={run.report} onPage={setPage} />
                        </details>
                      </>
                    )}
                  </section>
                ))}
              </>
            )}
            {tab === "history" &&
              history.map((r) => (
                <section className="panel" key={r.id}>
                  <h3>Revision {r.revision}</h3>
                  <p>
                    {r.at} · {r.reason}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    className="source-link"
                    onClick={() => {
                      setEditing(false);
                      setSelected(r.revision);
                      setTab("data");
                    }}
                  >
                    Inspect this revision
                  </button>
                </section>
              ))}
          </div>
        </div>
      </section>
    </div>
  );
}
function ImportModal({
  ws,
  companyId,
  close,
  done,
}: {
  ws: Workspace;
  companyId: string;
  close: () => void;
  done: (d: any) => Promise<void>;
}) {
  const [chosen, setChosen] = useState(companyId || "new"),
    [file, setFile] = useState<File | null>(null),
    [progress, setProgress] = useState(""),
    [error, setError] = useState("");
  const dialog = useDialog(close, !!progress),
    submitting = useRef(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file || submitting.current) return;
    submitting.current = true;
    setError("");
    const data = new FormData(e.currentTarget),
      company = ws.companies.find((c) => c.id === chosen);
    try {
      setProgress("Reading PDF…");
      const pages = await readPdf(file, (n, total) =>
          setProgress(`Reading page ${n}/${total}`),
        ),
        form = new FormData();
      form.set("file", file);
      form.set(
        "metadata",
        JSON.stringify({
          companyId: chosen === "new" ? "" : chosen,
          companyName: company?.name || data.get("companyName"),
          ticker: company?.ticker || data.get("ticker"),
          title: data.get("title"),
          kind: data.get("kind"),
          periodStart: data.get("periodStart"),
          periodEnd: data.get("periodEnd"),
          publishedAt: data.get("publishedAt"),
          quarter: data.get("quarter"),
          url: data.get("url") || "",
          aliases: company?.aliases || [],
          pages,
        }),
      );
      setProgress("Saving source…");
      const r = await fetch("/api/documents", { method: "POST", body: form }),
        d = await responseJson(r);
      await done(d.document);
    } catch (e: any) {
      setError(e.message);
    } finally {
      submitting.current = false;
      setProgress("");
    }
  }
  return (
    <div className="modal-overlay">
      <section
        ref={dialog}
        tabIndex={-1}
        className="import-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Add report"
      >
        <header>
          <h2>Add a source report</h2>
          <button
            type="button"
            className="button secondary"
            disabled={!!progress}
            onClick={close}
          >
            Close
          </button>
        </header>
        <form onSubmit={submit} className="import-form">
          <fieldset disabled={!!progress}>
            {error && <p className="form-error">{error}</p>}
            <label>
              Company
              <select
                value={chosen}
                onChange={(e) => setChosen(e.target.value)}
              >
                {ws.companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value="new">New company</option>
              </select>
            </label>
            {chosen === "new" && (
              <div className="form-grid">
                <label>
                  Company name
                  <input name="companyName" required />
                </label>
                <label>
                  Ticker
                  <input name="ticker" required maxLength={15} />
                </label>
              </div>
            )}
            <label>
              Original PDF
              <input
                type="file"
                accept=".pdf,application/pdf"
                required
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f && f.size < 50000000) {
                    setFile(f);
                    setError("");
                  } else {
                    setFile(null);
                    e.currentTarget.value = "";
                    setError("Choose a PDF smaller than 50 MB.");
                  }
                }}
              />
            </label>
            <label>
              Title
              <input
                name="title"
                required
                maxLength={200}
                defaultValue={file?.name.replace(/\.pdf$/i, "")}
              />
            </label>
            <div className="form-grid">
              <label>
                Document type
                <select name="kind">
                  <option value="earnings_release">Earnings release</option>
                  <option value="filing">Financial filing</option>
                  <option value="transcript">Transcript</option>
                  <option value="credit_report">Credit report</option>
                  <option value="internal_note">Internal note</option>
                </select>
              </label>
              <label>
                Fiscal quarter
                <input
                  name="quarter"
                  required
                  placeholder="2026-Q2"
                  pattern="[0-9]{4}-Q[1-4]"
                />
              </label>
              {["periodStart", "periodEnd", "publishedAt"].map((n) => (
                <label key={n}>
                  {label(n)}
                  <input name={n} type="date" required />
                </label>
              ))}
            </div>
            <label>
              Source URL
              <input name="url" type="url" />
            </label>
            <button className="button primary" disabled={!!progress || !file}>
              {progress || "Import report"}
            </button>
          </fieldset>
        </form>
      </section>
    </div>
  );
}
