import { z } from "zod/v4";
import { runtime, json, writeGuard, errorResponse } from "../../../lib/server";
import { providerConfig } from "../../../lib/provider";
export async function GET() {
  const e = runtime();
  return json({
    configured:
      e.LLM_PROVIDER && e.LLM_PROVIDER !== "openai"
        ? !!(e.LLM_API_KEY && e.LLM_BASE_URL)
        : !!e.OPENAI_API_KEY,
    provider: e.LLM_PROVIDER || "openai",
    model: e.LLM_MODEL || "gpt-6-luna",
    reviewModel: e.LLM_REVIEW_MODEL || null,
    reviewReasoningEffort: e.LLM_REVIEW_REASONING_EFFORT || "high",
    masking: true,
    extractionInput: "original_pdf",
    extractionMasked: false,
    noise: false,
    editable: !!e.LOCAL_SETTINGS,
    dailyCallLimit: Math.min(
      200,
      Math.max(1, Number(e.AI_DAILY_CALL_LIMIT) || 40),
    ),
  });
}
const input = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("save"),
      apiKey: z
        .string()
        .trim()
        .min(10)
        .max(500)
        .regex(/^sk-[A-Za-z0-9_-]+$/)
        .optional(),
      model: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-zA-Z0-9_.:-]+$/),
      dailyCallLimit: z.number().int().min(1).max(200),
      reviewReasoningEffort: z
        .enum(["low", "medium", "high", "xhigh", "max"])
        .optional(),
      reviewModel: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-zA-Z0-9_.:-]+$/)
        .nullable()
        .optional(),
    })
    .strict(),
  z.object({ action: z.literal("remove") }).strict(),
  z.object({ action: z.literal("test") }).strict(),
]);
export async function POST(request: Request) {
  try {
    writeGuard(request);
    const body = input.parse(await request.json());
    const e = runtime();
    if (!e.LOCAL_SETTINGS)
      throw new Error(
        "API key editing is available only in the local Windows app. Configure hosted secrets on the server.",
      );
    if (body.action === "test") {
      const config = providerConfig(e);
      const response = await fetch(
        `${config.baseUrl}/models/${encodeURIComponent(config.model)}`,
        {
          headers: { Authorization: `Bearer ${config.apiKey}` },
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!response.ok)
        throw new Error(
          `Credential/model check returned HTTP ${response.status}. No generation request was made.`,
        );
      return json({
        ok: true,
        message:
          "Credential and model access confirmed. PDF and web-search requests have not been tested.",
      });
    }
    await e.LOCAL_SETTINGS.save(
      body.action === "remove"
        ? { OPENAI_API_KEY: null }
        : {
            ...(body.apiKey ? { OPENAI_API_KEY: body.apiKey } : {}),
            LLM_MODEL: body.model,
            ...(body.reviewReasoningEffort
              ? { LLM_REVIEW_REASONING_EFFORT: body.reviewReasoningEffort }
              : {}),
            ...(body.reviewModel !== undefined
              ? { LLM_REVIEW_MODEL: body.reviewModel }
              : {}),
            LLM_PROVIDER: "openai",
            AI_DAILY_CALL_LIMIT: String(body.dailyCallLimit),
          },
    );
    return GET();
  } catch (error) {
    return errorResponse(error);
  }
}
