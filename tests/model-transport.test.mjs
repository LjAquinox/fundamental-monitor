import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";
import { ResponsesProvider } from "../lib/provider.ts";
const provider = new ResponsesProvider({
  provider: "openai",
  model: "gpt-6-luna",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "fake-never-live",
});
const args = {
  system: "Only supplied data",
  input: "source",
  name: "transport_test",
  schema: z.object({ title: z.string() }).strict(),
  timeoutMs: 900000,
};
const completed = {
  id: "resp_completed",
  status: "completed",
  output: [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: JSON.stringify({ title: "Checked € evidence" }),
        },
      ],
    },
  ],
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 5 },
  },
};
const event = (value) =>
  `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
function sse(text, { byteChunks = false, failure } = {}) {
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (index < bytes.length) {
          const end = byteChunks ? index + 1 : bytes.length;
          controller.enqueue(bytes.slice(index, end));
          index = end;
        } else if (failure) controller.error(failure);
        else controller.close();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "req_transport",
      },
    },
  );
}
async function withFetch(fn, run) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...values) => {
    calls++;
    return fn(...values);
  };
  try {
    await run();
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
}

test("streaming preserves the strict schema, parses split UTF-8/CRLF events and uses only the completed response", async () => {
  await withFetch(
    (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal(body.text.format.strict, true);
      assert.equal(body.text.format.schema.additionalProperties, false);
      return sse(
        ": keepalive\r\n\r\n" +
          event({
            type: "response.created",
            response: { id: "resp_live", status: "in_progress" },
          }) +
          event({
            type: "response.output_text.delta",
            delta: '{"title":"Do not use this partial text"}',
          }) +
          event({ type: "response.completed", response: completed }) +
          "data: [DONE]\r\n\r\n",
        { byteChunks: true },
      );
    },
    async () => {
      const result = await provider.generate(args);
      assert.equal(result.data.title, "Checked € evidence");
      assert.equal(result.usage.reasoningTokens, 5);
      assert.equal(result.usage.outputTokens, 20);
    },
  );
});

test("a stream with final-looking text but no terminal response cannot be accepted or retried automatically", async () => {
  await withFetch(
    () =>
      sse(
        event({
          type: "response.created",
          response: { id: "resp_cutoff", status: "in_progress" },
        }) +
          event({
            type: "response.output_text.done",
            text: '{"title":"Looks finished"}',
          }),
      ),
    async () => {
      await assert.rejects(
        () => provider.generate(args),
        /ended before a terminal response.*No partial.*req_transport.*resp_cutoff/,
      );
    },
  );
});

test("completed streaming responses still go through the sole canonical response validator", async () => {
  const invalid = structuredClone(completed);
  invalid.output[0].content[0].text = '{"title":42}';
  await withFetch(
    () => sse(event({ type: "response.completed", response: invalid })),
    async () => {
      await assert.rejects(
        () => provider.generate(args),
        /title: expected string/,
      );
    },
  );
});

test("stream failures and output-budget exhaustion never become successful partial results", async () => {
  for (const status of ["failed", "incomplete"]) {
    await withFetch(
      () =>
        sse(
          event({
            type: `response.${status}`,
            response: { ...completed, status },
          }),
        ),
      async () => {
        await assert.rejects(
          () => provider.generate(args),
          /incomplete or failed.*No proposals/,
        );
      },
    );
  }
  await withFetch(
    () =>
      sse(
        event({
          type: "error",
          code: "server_error",
          message: "Untrusted provider text",
        }),
      ),
    async () => {
      await assert.rejects(
        () => provider.generate(args),
        /stream failed \(server_error\)/,
      );
    },
  );
});

test("a body connection reset retains safe provider IDs and its underlying code without leaking raw messages", async () => {
  const failure = new TypeError("Raw transport text must not leak", {
    cause: Object.assign(new Error("secret-never-log"), {
      code: "UND_ERR_SOCKET",
    }),
  });
  await withFetch(
    () =>
      sse(
        event({
          type: "response.created",
          response: { id: "resp_interrupted", status: "in_progress" },
        }),
        { failure },
      ),
    async () => {
      await assert.rejects(
        () => provider.generate(args),
        (error) => {
          assert.match(
            error.message,
            /lost its connection after \d+ seconds \(UND_ERR_SOCKET\)/,
          );
          assert.match(error.message, /req_transport.*resp_interrupted/);
          assert.doesNotMatch(error.message, /Raw transport|secret-never-log/);
          return true;
        },
      );
    },
  );
});

test("Node's independent header timeout is reported accurately without an implicit paid retry", async () => {
  await withFetch(
    () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("Headers Timeout Error"), {
          code: "UND_ERR_HEADERS_TIMEOUT",
        }),
      });
    },
    async () => {
      await assert.rejects(
        () => provider.generate(args),
        /timed out after \d+ seconds \(UND_ERR_HEADERS_TIMEOUT\).*No automatic retry/,
      );
    },
  );
});

test("HTTP 400 retains the precise schema refusal, parameter and request ID without retry", async () => {
  await withFetch(
    () =>
      Response.json(
        {
          error: {
            type: "invalid_request_error",
            code: "invalid_json_schema",
            param: "text.format.schema",
            message:
              "Invalid schema: Objects provided via anyOf must not share identical first keys.",
          },
        },
        { status: 400, headers: { "x-request-id": "req_schema_rejected" } },
      ),
    async () => {
      await assert.rejects(
        () => provider.generate(args),
        (error) => {
          assert.match(error.message, /HTTP 400 \(invalid_json_schema\)/);
          assert.match(error.message, /Parameter: text.format.schema/);
          assert.match(error.message, /identical first keys/);
          assert.match(error.message, /req_schema_rejected/);
          assert.match(error.message, /No automatic retry/);
          return true;
        },
      );
    },
  );
});
test("provider error diagnostics redact credentials, bearer tokens and PDF data", async () => {
  const key = "fake-never-live",
    second = "sk-proj-do-not-print-this-key",
    blob = "data:application/pdf;base64," + "A".repeat(600);
  await withFetch(
    () =>
      Response.json(
        {
          error: {
            code: "invalid_api_key",
            param: "authorization",
            message: `Rejected credential ${key}, ${second}, Bearer top-secret-token and ${blob}`,
          },
        },
        { status: 401 },
      ),
    async () => {
      await assert.rejects(
        () => provider.generate(args),
        (error) => {
          assert.match(error.message, /HTTP 401/);
          assert.match(error.message, /invalid_api_key/);
          assert.doesNotMatch(
            error.message,
            /fake-never-live|sk-proj|top-secret-token|AAAAAA/,
          );
          return true;
        },
      );
    },
  );
});
test("non-JSON and excessively large error bodies never leak raw server text", async () => {
  await withFetch(
    () => new Response("<html>private upstream text</html>", { status: 502 }),
    async () => {
      await assert.rejects(
        () => provider.generate(args),
        (error) => {
          assert.match(error.message, /HTTP 502/);
          assert.doesNotMatch(error.message, /private upstream|html/);
          return true;
        },
      );
    },
  );
  let cancelled = false;
  await withFetch(
    () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(20000).fill(65));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 400 },
      ),
    async () => {
      await assert.rejects(() => provider.generate(args), /HTTP 400/);
      assert.equal(cancelled, true);
    },
  );
});
test("a locally incompatible schema makes zero network requests", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error("Must not call provider");
  };
  try {
    const schema = z
      .object({
        items: z.array(
          z.union([
            z.object({ id: z.string(), kind: z.literal("A") }).strict(),
            z.object({ id: z.string(), kind: z.literal("B") }).strict(),
          ]),
        ),
      })
      .strict();
    await assert.rejects(
      () => provider.generate({ ...args, schema }),
      /ambiguous first key/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
