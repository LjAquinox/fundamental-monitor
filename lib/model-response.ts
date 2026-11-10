/** Read a Responses stream without ever accepting partial model output. */
export class ModelStreamError extends Error {}
export type RequestTrace = { requestId?: string; responseId?: string };
export const safeId = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value)
    ? value
    : undefined;
export function traceSuffix(trace: RequestTrace) {
  return [
    trace.requestId ? ` Request ID: ${trace.requestId}.` : "",
    trace.responseId ? ` Response ID: ${trace.responseId}.` : "",
  ].join("");
}
export function modelTransportError(
  error: unknown,
  startedAt: number,
  signal: AbortSignal,
  trace: RequestTrace,
) {
  const knownCodes = new Set([
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
  ]);
  let code: string | undefined;
  let cause: any = error;
  for (let i = 0; cause && i < 5; i++, cause = cause.cause)
    if (knownCodes.has(cause.code)) {
      code = cause.code;
      break;
    }
  const timedOut =
    signal.aborted || code?.includes("TIMEOUT") || code === "ETIMEDOUT";
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return new Error(
    `The model request ${timedOut ? "timed out" : "lost its connection"} after ${seconds} seconds${code ? ` (${code})` : ""}. No automatic retry was made. Check provider usage before explicitly retrying.${traceSuffix(trace)}`,
  );
}

export async function readModelResponse(
  response: Response,
  trace: RequestTrace,
) {
  trace.requestId = safeId(response.headers.get("x-request-id"));
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return response.json();
  if (!response.body)
    throw new ModelStreamError(
      "The model response stream was empty. No data was accepted.",
    );
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  function frame(value: string) {
    const data = value
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      throw new ModelStreamError(
        "The model response stream contained unreadable event data. No data was accepted.",
      );
    }
    trace.responseId = safeId(event.response?.id) || trace.responseId;
    if (event.type === "error") {
      const code = safeId(event.code) || "unknown_error";
      throw new ModelStreamError(
        `The model provider stream failed (${code}). No data was accepted.${traceSuffix(trace)}`,
      );
    }
    if (
      ["response.completed", "response.incomplete", "response.failed"].includes(
        event.type,
      )
    ) {
      if (!event.response || event.response.status !== event.type.slice(9))
        throw new ModelStreamError(
          "The model response stream contained an invalid terminal event. No data was accepted.",
        );
      return event.response;
    }
    // Deltas, output_text.done and output_item.done are never a complete response.
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const result = frame(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (result) return result;
      }
      if (done) {
        if (buffer.trim()) {
          const result = frame(buffer);
          if (result) return result;
        }
        throw new ModelStreamError(
          `The model response stream ended before a terminal response. No partial results were accepted and no automatic retry was made.${traceSuffix(trace)}`,
        );
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Bounded, redacted diagnostics only: never echo a request, PDF or credential. */
export async function modelHttpError(
  response: Response,
  apiKey: string,
): Promise<Error> {
  const trace = { requestId: safeId(response.headers.get("x-request-id")) };
  let body = "";
  if (response.body) {
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let count = 0;
    try {
      while (count < 16384) {
        const { value, done } = await reader.read();
        if (done) {
          body += decoder.decode();
          break;
        }
        const part = value.subarray(0, 16384 - count);
        body += decoder.decode(part, { stream: true });
        count += part.length;
        if (part.length < value.length || count >= 16384) {
          await reader.cancel();
          break;
        }
      }
    } catch {
      /* Keep the HTTP status even if its error body is unreadable. */
    } finally {
      reader.releaseLock();
    }
  }
  const clean = (value: unknown, limit: number) =>
    typeof value === "string"
      ? (apiKey ? value.split(apiKey).join("[REDACTED]") : value)
          .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
          .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
          .replace(
            /data:application\/pdf;base64,[A-Za-z0-9+/=\s]+/gi,
            "[PDF REDACTED]",
          )
          .replace(/[A-Za-z0-9+/=_-]{200,}/g, "[DATA REDACTED]")
          .replace(/[\x00-\x1F\x7F]/g, " ")
          .slice(0, limit)
      : "";
  let error: any;
  try {
    error = JSON.parse(body)?.error;
  } catch {
    /* Do not echo raw proxy HTML/text. */
  }
  const code = clean(error?.code || error?.type, 120),
    param = clean(error?.param, 300),
    message = clean(error?.message, 2000);
  return new Error(
    `Model provider returned HTTP ${response.status}${code ? ` (${code})` : ""}.${param ? ` Parameter: ${param}.` : ""}${message ? ` ${message}` : " No readable JSON error details were supplied."}${traceSuffix(trace)} No automatic retry was made.`,
  );
}
