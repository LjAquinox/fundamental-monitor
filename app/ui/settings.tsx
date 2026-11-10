"use client";
import { responseJson } from "../../lib/browser-api";
import { useState } from "react";
import { Loader2, KeyRound, ShieldCheck } from "lucide-react";

export function ApiSettings({
  config,
  updated,
  busyChanged,
}: {
  config: any;
  updated: (c: any) => void;
  busyChanged: (busy: boolean) => void;
}) {
  const [key, setKey] = useState(""),
    [model, setModel] = useState(config?.model || "gpt-6-luna"),
    [reviewEffort, setReviewEffort] = useState(
      config?.reviewReasoningEffort || "high",
    ),
    [reviewModel, setReviewModel] = useState(config?.reviewModel || ""),
    [limit, setLimit] = useState(config?.dailyCallLimit || 40),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  async function act(action: string) {
    if (busy) return;
    busyChanged(true);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const r = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "save"
            ? {
                ...(key.trim() ? { apiKey: key.trim() } : {}),
                model,
                reviewModel: reviewModel.trim() || null,
                reviewReasoningEffort: reviewEffort,
                dailyCallLimit: Number(limit),
              }
            : {}),
        }),
      });
      const data: any = await responseJson(r);
      setKey("");
      if (action !== "test") updated(data);
      setMessage(
        action === "test"
          ? data.message
          : action === "remove"
            ? "API key removed."
            : "Settings saved. New requests use them immediately; no restart needed.",
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
      busyChanged(false);
    }
  }
  return (
    <>
      <div className="heading-row">
        <div>
          <div className="eyebrow">LOCAL CONFIGURATION</div>
          <h1>
            API settings<span className="heading-period">.</span>
          </h1>
          <p>
            Manage the server-side credential used for extraction, source
            review, forecasts and report discovery.
          </p>
        </div>
        <KeyRound size={28} />
      </div>
      <section className="panel settings-page">
        <div className="info-banner">
          <ShieldCheck size={20} />
          <p>
            {config?.configured
              ? "A server-side credential is configured."
              : "No API credential is configured."}{" "}
            Saved keys are never returned to the browser or included in research
            exports. On Windows the key is stored in your local .dev.vars file.
          </p>
        </div>
        {!config?.editable && (
          <p>
            Hosted secrets must be managed on the server. Key editing is
            available in the local Windows app.
          </p>
        )}
        <form
          className="import-form"
          onSubmit={(e) => {
            e.preventDefault();
            act("save");
          }}
        >
          <label>
            OpenAI API key
            <input
              type="password"
              autoComplete="new-password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                config?.configured
                  ? "Leave blank to keep the saved key"
                  : "sk-…"
              }
              disabled={!config?.editable || busy}
            />
          </label>
          <div className="form-grid">
            <label>
              Model
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                required
                pattern="[a-zA-Z0-9_.:-]+"
                disabled={!config?.editable || busy}
              />
            </label>
            <label>
              Review model (optional)
              <input
                value={reviewModel}
                onChange={(e) => setReviewModel(e.target.value)}
                placeholder="Inherit the extraction model"
                pattern="[a-zA-Z0-9_.:-]+"
                disabled={!config?.editable || busy}
              />
            </label>
            <label>
              Company reasoning effort
              <select
                value={reviewEffort}
                onChange={(e) => setReviewEffort(e.target.value)}
                disabled={!config?.editable || busy}
              >
                {["low", "medium", "high", "xhigh", "max"].map((v) => (
                  <option key={v} value={v}>
                    {v === "high" ? "High (default)" : v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Daily AI request limit
              <input
                type="number"
                min="1"
                max="200"
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                disabled={!config?.editable || busy}
              />
            </label>
          </div>
          <p>
            The limit includes extraction, company reconciliation, forecasting
            and report discovery. Discovery uses GPT-6 Luna with web search.
            Searches incur separate tool charges.
          </p>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {message && <p role="status">{message}</p>}
          <div className="quality-actions">
            <button
              className="button primary"
              disabled={busy || !config?.editable}
            >
              {busy && <Loader2 size={16} className="spin" />}Save settings
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy || !config?.configured || !config?.editable}
              onClick={() => act("test")}
            >
              Test saved credential
            </button>
            <button
              type="button"
              className="button secondary danger"
              disabled={busy || !config?.configured || !config?.editable}
              onClick={() => act("remove")}
            >
              Remove key
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
