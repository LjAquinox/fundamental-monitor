import { z } from "zod/v4";
import {
  readModelResponse,
  ModelStreamError,
  modelTransportError,
  modelHttpError,
  traceSuffix,
  type RequestTrace,
} from "./model-response";
import { modelJsonSchema } from "./structured-output";
import type { Usage } from "./types";
const forecastLimits = {
  assessment: 5000,
  rationale: 2000,
  uncertainty: 1500,
  evidenceIds: 12,
  predictions: 2,
} as const;
export const forecastSchema = z
  .object({
    assessment: z.string().max(forecastLimits.assessment),
    predictions: z
      .array(
        z
          .object({
            metric: z.enum(["revenue_growth", "operating_margin"]),
            direction: z.enum([
              "increase",
              "stable",
              "decrease",
              "insufficient_evidence",
            ]),
            rationale: z.string().max(forecastLimits.rationale),
            evidenceIds: z.array(z.string()).max(forecastLimits.evidenceIds),
            uncertainty: z.string().max(forecastLimits.uncertainty),
          })
          .strict(),
      )
      .length(forecastLimits.predictions),
  })
  .strict();

export interface ModelConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export interface GenerationRequest<T> {
  system: string;
  input: string;
  name: string;
  schema: z.ZodType<T>;
  pdf?: { base64: string; filename: string };
  pdfs?: { base64: string; filename: string }[];
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
  maxOutputTokens?: number;
  webSearch?: boolean;
}
export interface StructuredProvider {
  generate<T>(args: GenerationRequest<T>): Promise<{ data: T; usage: Usage }>;
}
export function modelValidationMessage(error: z.ZodError): string {
  const problems = error.issues.slice(0, 5).map((issue) => {
    let reason = issue.message;
    if (issue.code === "too_big") {
      reason =
        issue.origin === "string"
          ? `must contain at most ${issue.maximum} characters`
          : issue.origin === "array"
            ? `must contain at most ${issue.maximum} items`
            : reason;
    } else if (issue.code === "too_small") {
      reason =
        issue.origin === "string"
          ? `must contain at least ${issue.minimum} characters`
          : issue.origin === "array"
            ? `must contain at least ${issue.minimum} items`
            : reason;
    } else if (issue.code === "invalid_type") {
      reason = `expected ${issue.expected}`;
    } else if (issue.code === "invalid_format") {
      reason = "invalid format";
    }
    return `${issue.path.join(".") || "response"}: ${reason}`;
  });
  const more =
    error.issues.length > 5
      ? `; and ${error.issues.length - 5} more issue(s)`
      : "";
  const dates = error.issues.some((i) =>
    ["periodStart", "periodEnd"].includes(String(i.path.at(-1))),
  )
    ? " Reporting dates must be real YYYY-MM-DD dates or null; reversed periods and inconsistent instant dates are not allowed."
    : "";
  return `The model returned invalid structured output (${problems.join("; ")}${more}).${dates} No proposals were saved.`;
}
export function usageFromResponse(usage: any): Usage {
  const inputTokens = usage?.input_tokens || 0,
    outputTokens = usage?.output_tokens || 0;
  const cachedInputTokens = usage?.input_tokens_details?.cached_tokens || 0;
  const cacheWriteTokens = usage?.input_tokens_details?.cache_write_tokens || 0;
  const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens || 0;
  // Token usage is exact; monetary cost is not inferred from hard-coded tariffs.
  const estimatedCost: number | null = null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    reasoningTokens,
    estimatedCost,
  };
}
/** Providers implement this interface; this adapter requires Responses + PDF input.
 * It never silently substitutes text-only input or a different model.
 */
export class ResponsesProvider implements StructuredProvider {
  private config: ModelConfig;
  constructor(config: ModelConfig) {
    this.config = config;
  }
  async generate<T>(args: GenerationRequest<T>) {
    if ("jsonSchema" in args || "validate" in args)
      throw new Error(
        "Pass only schema: separate JSON schemas and response validators are forbidden.",
      );
    const jsonSchema = modelJsonSchema(args.schema);
    const content: any[] = [];
    for (const pdf of [...(args.pdf ? [args.pdf] : []), ...(args.pdfs || [])])
      content.push({
        type: "input_file",
        filename: pdf.filename,
        file_data: `data:application/pdf;base64,${pdf.base64}`,
        detail: "high",
      });
    content.push({ type: "input_text", text: args.input });
    const startedAt = Date.now(),
      signal = AbortSignal.timeout(args.timeoutMs || 300000),
      trace: RequestTrace = {};
    let response: Response;
    try {
      response = await fetch(
        `${this.config.baseUrl.replace(/\/$/, "")}/responses`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          signal,
          body: JSON.stringify({
            model: this.config.model,
            instructions: args.system,
            ...(args.reasoningEffort
              ? { reasoning: { effort: args.reasoningEffort } }
              : {}),
            input: [{ role: "user", content }],
            text: {
              format: {
                type: "json_schema",
                name: args.name,
                strict: true,
                schema: jsonSchema,
              },
            },
            max_output_tokens:
              args.maxOutputTokens || (args.pdf ? 16000 : 6500),
            store: false,
            // Receive response headers/events while a long reasoning pass runs.
            ...(this.config.provider === "openai" ? { stream: true } : {}),
            ...(args.webSearch
              ? {
                  tools: [{ type: "web_search" }],
                  tool_choice: "required",
                  include: ["web_search_call.action.sources"],
                }
              : {}),
          }),
        },
      );
    } catch (error) {
      throw modelTransportError(error, startedAt, signal, trace);
    }
    if (!response.ok) throw await modelHttpError(response, this.config.apiKey);
    let body: any;
    try {
      body = await readModelResponse(response, trace);
    } catch (error) {
      if (error instanceof ModelStreamError) throw error;
      if (error instanceof SyntaxError)
        throw new Error(
          `The provider returned unreadable response data. No data was accepted.${traceSuffix(trace)}`,
        );
      throw modelTransportError(error, startedAt, signal, trace);
    }
    if (
      body.output?.some(
        (o: any) =>
          o.type === "message" &&
          o.content?.some((c: any) => c.type === "refusal"),
      )
    )
      throw new Error("The model declined this request. No data was saved.");
    if (body.status !== "completed")
      throw new Error(
        `Model output was incomplete or failed${["max_output_tokens", "content_filter"].includes(body.incomplete_details?.reason) ? ` (${body.incomplete_details.reason})` : ""}. No proposals were saved and no automatic retry was made. Check provider usage before retrying.${traceSuffix(trace)}`,
      );
    const text = (body.output || [])
      .flatMap((o: any) => (o.type === "message" ? o.content || [] : []))
      .filter((c: any) => c.type === "output_text")
      .map((c: any) => c.text)
      .join("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        "The model returned unreadable JSON. No proposals were saved.",
      );
    }
    let data: T;
    try {
      data = args.schema.parse(parsed);
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new Error(modelValidationMessage(error));
      throw error;
    }
    const sources = [
      ...new Set<string>(
        (body.output || [])
          .flatMap((o: any) => [
            ...(o.type === "web_search_call"
              ? (o.action?.sources || []).map((s: any) => s.url)
              : []),
            ...(o.content || []).flatMap((c: any) =>
              (c.annotations || [])
                .filter((a: any) => a.type === "url_citation")
                .map((a: any) => a.url),
            ),
          ])
          .filter(
            (url: unknown) =>
              typeof url === "string" && /^https:\/\//.test(url),
          ),
      ),
    ];
    if (
      args.webSearch &&
      !body.output?.some(
        (o: any) => o.type === "web_search_call" && o.status === "completed",
      )
    )
      throw new Error(
        "The provider did not complete the required web search. No reports were imported.",
      );
    return {
      data,
      usage: usageFromResponse(body.usage),
      sources,
      rawOutput: text,
    };
  }
}
export function providerConfig(
  env: Record<string, any>,
  model?: string,
): ModelConfig {
  const provider = env.LLM_PROVIDER || "openai";
  const apiKey = provider === "openai" ? env.OPENAI_API_KEY : env.LLM_API_KEY;
  if (!apiKey)
    throw new Error(
      "AI is not configured. Add the server-side provider credential to enable extraction and forecasting. Your saved research remains available.",
    );
  const baseUrl =
    provider === "openai" ? "https://api.openai.com/v1" : env.LLM_BASE_URL;
  if (!baseUrl || !/^https:\/\//.test(baseUrl))
    throw new Error("The provider must have a configured HTTPS base URL.");
  return {
    provider,
    model: model || env.LLM_MODEL || "gpt-6-luna",
    baseUrl,
    apiKey,
  };
}
