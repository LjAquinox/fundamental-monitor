import { responseJson } from "../../lib/browser-api";
import { useState } from "react";

import {
  reportSchema,
  normalizeReportPath,
  type Report,
} from "../../lib/report-contract";

import type { Document, ReportRevision } from "../../lib/types";
const title = (s: string) =>
  s.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
function empty(schema: any): any {
  const d = schema._zod.def;
  switch (d.type) {
    case "nullable":
      return null;
    case "object":
      return Object.fromEntries(
        Object.entries(d.shape).map(([k, v]) => [k, empty(v)]),
      );
    case "array":
      return [];
    case "union":
      return empty(d.options[0]);
    case "literal":
      return d.values[0];
    case "enum":
      return Object.values(d.entries)[0];
    case "number":
      return 1;
    case "string":
      return "";
    default:
      return null;
  }
}
function variantName(schema: any): string {
  const d = schema._zod.def;
  if (d.type === "union") return variantName(d.options[0]);
  const shape = d.shape;
  return shape
    ? ["type", "metric"]
        .map((k) => (shape[k] ? empty(shape[k]) : ""))
        .filter(Boolean)
        .join(" · ")
    : "Variant";
}
function matches(schema: any, value: any): boolean {
  const d = schema._zod.def;
  if (d.type === "union") return d.options.some((s: any) => matches(s, value));
  if (!d.shape) return schema.safeParse(value).success;
  return Object.entries(d.shape)
    .filter(([, s]: any) => s._zod.def.type === "literal")
    .every(([k, s]: any) => value?.[k] === s._zod.def.values[0]);
}
function Field({
  schema,
  value,
  onChange,
  path,
}: {
  schema: any;
  value: any;
  onChange: (v: any) => void;
  path: string;
}) {
  const def = schema._zod.def;
  if (def.type === "nullable")
    return (
      <div className="nullable-field">
        <label className="checkline">
          <input
            type="checkbox"
            checked={value !== null}
            onChange={(e) =>
              onChange(e.target.checked ? empty(def.innerType) : null)
            }
          />
          Reported / available
        </label>
        {value !== null && (
          <Field
            schema={def.innerType}
            value={value}
            onChange={onChange}
            path={path}
          />
        )}
      </div>
    );
  if (def.type === "union") {
    const selected = Math.max(
      0,
      def.options.findIndex((s: any) => matches(s, value)),
    );
    return (
      <div className="typed-variant">
        <label>
          Type
          <select
            value={selected}
            onChange={(e) =>
              onChange(empty(def.options[Number(e.target.value)]))
            }
          >
            {def.options.map((s: any, i: number) => (
              <option key={i} value={i}>
                {variantName(s)}
              </option>
            ))}
          </select>
        </label>
        <Field
          schema={def.options[selected]}
          value={value}
          onChange={onChange}
          path={path}
        />
      </div>
    );
  }
  if (def.type === "object")
    return (
      <div className="typed-form">
        {Object.entries(def.shape).map(([key, child]: any) => {
          if (child._zod.def.type === "literal") return null;
          return (
            <fieldset key={key}>
              <legend>{title(key)}</legend>
              {child.description && (
                <p className="field-help">{child.description}</p>
              )}
              <Field
                schema={child}
                value={value?.[key]}
                path={`${path}.${key}`}
                onChange={(v) => {
                  const next = { ...value, [key]: v };
                  onChange(next);
                }}
              />
            </fieldset>
          );
        })}
      </div>
    );
  if (def.type === "array")
    return (
      <div>
        {(value || []).map((v: any, i: number) => (
          <section className="editor-item" key={i}>
            <div className="actions">
              <strong>Item {i + 1}</strong>
              <button
                type="button"
                className="button danger"
                onClick={() =>
                  onChange(value.filter((_: any, j: number) => j !== i))
                }
              >
                Remove
              </button>
            </div>
            <Field
              schema={def.element}
              value={v}
              path={`${path}.${i}`}
              onChange={(v) =>
                onChange(
                  value.map((old: any, j: number) => (j === i ? v : old)),
                )
              }
            />
          </section>
        ))}
        <button
          type="button"
          className="button secondary"
          onClick={() => onChange([...(value || []), empty(def.element)])}
        >
          Add item
        </button>
      </div>
    );
  if (def.type === "enum")
    return (
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        {Object.values(def.entries).map((v: any) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  if (def.type === "literal") return <span>{def.values[0]}</span>;
  if (def.type === "number")
    return (
      <input
        aria-label={path}
        type="number"
        step="any"
        value={value ?? ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? undefined : Number(e.target.value))
        }
      />
    );
  return (
    <textarea
      aria-label={path}
      rows={path.endsWith(".text") || path.endsWith(".reason") ? 3 : 1}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
/** Resolve the existing field through canonical object/array/union definitions. */
function fieldAt(schema: any, value: any, path: string) {
  const keys = normalizeReportPath(path).split(".");
  for (const key of keys) {
    while (schema._zod.def.type === "nullable")
      schema = schema._zod.def.innerType;
    if (schema._zod.def.type === "union")
      schema = schema._zod.def.options.find((s: any) => matches(s, value));
    if (!schema)
      throw Error("The field variant no longer exists. Reload the report.");
    const def = schema._zod.def;
    if (def.type === "object" && Object.hasOwn(def.shape, key))
      schema = def.shape[key];
    else if (
      def.type === "array" &&
      /^\d+$/.test(key) &&
      Array.isArray(value) &&
      Number(key) < value.length
    )
      schema = def.element;
    else
      throw Error("This finding does not identify an editable report field.");
    value = value?.[key];
  }
  return { schema, value };
}
function replaceField(report: Report, path: string, value: unknown): Report {
  const draft = structuredClone(report) as any,
    keys = normalizeReportPath(path).split("."),
    last = keys.pop()!;
  let parent = draft;
  for (const key of keys) {
    if (parent === null || !Object.hasOwn(parent, key))
      throw Error("Field no longer exists.");
    parent = parent[key];
  }
  if (!parent || !Object.hasOwn(parent, last))
    throw Error("Field no longer exists.");
  parent[last] = value;
  return draft;
}
export function TypedEditor({
  document: d,
  revision,
  saved,
  focusPath,
  busyChanged,
}: {
  document: Omit<Document, "pages">;
  revision: ReportRevision;
  saved: () => Promise<void>;
  focusPath?: string;
  busyChanged?: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState<Report>(structuredClone(revision.report)),
    [section, setSection] = useState<keyof Report>("currentQuarter"),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    busyChanged?.(true);
    try {
      const parsed = reportSchema.parse(draft),
        response = await fetch("/api/reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            documentId: d.id,
            expectedRevision: revision.revision,
            report: parsed,
            reason,
          }),
        });
      await responseJson(response);
      await saved();
    } catch (e: any) {
      setError(
        e.issues
          ? e.issues
              .map((i: any) => `${i.path.join(".")}: ${i.message}`)
              .join("\n")
          : e.message,
      );
    } finally {
      setBusy(false);
      busyChanged?.(false);
    }
  }
  let focused: { schema: any; value: any } | undefined,
    focusError = "";
  if (focusPath)
    try {
      focused = fieldAt(reportSchema, draft, focusPath);
    } catch (e) {
      focusError = (e as Error).message;
    }
  return (
    <form onSubmit={submit} className="report-editor">
      <fieldset disabled={busy}>
        <p>
          Corrections create a new revision and protect edited fields from
          automatic model replacement. Edited arrays are protected as a section
          so reordering cannot move your correction. Use “Refresh publication
          from current reports” to revalidate existing source choices without
          AI; new PDFs require company review. A fresh extraction replaces the
          report and resets these protections.
        </p>
        {!focusPath && (
          <label>
            Report section
            <select
              value={section}
              onChange={(e) => setSection(e.target.value as keyof Report)}
            >
              {Object.keys(reportSchema.shape).map((s) => (
                <option key={s} value={s}>
                  {title(s)}
                </option>
              ))}
            </select>
          </label>
        )}
        {focusPath && <code>{focusPath}</code>}
        {focusError && (
          <p className="form-error">
            {focusError} Open the full report editor to choose a section.
          </p>
        )}
        {(!focusPath || focused) && (
          <Field
            schema={focused?.schema || reportSchema.shape[section]}
            value={focused ? focused.value : draft[section]}
            path={focusPath || section}
            onChange={(v) =>
              setDraft(
                focusPath
                  ? replaceField(draft, focusPath, v)
                  : { ...draft, [section]: v },
              )
            }
          />
        )}
        <label>
          Reason for correction
          <textarea
            required
            minLength={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {error && <pre className="form-error">{error}</pre>}
        <button className="button primary" disabled={busy || !!focusError}>
          {busy ? "Saving…" : "Save report correction"}
        </button>
      </fieldset>
    </form>
  );
}
