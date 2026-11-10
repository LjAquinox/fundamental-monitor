import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { closeStorage } from "./env.mjs";
import { serveStatic, allowedLocalHost } from "./http.mjs";
import * as workspace from "../app/api/workspace/route";
import * as documents from "../app/api/documents/route";
import * as reports from "../app/api/reports/route";
import * as extract from "../app/api/extract/route";
import * as forecast from "../app/api/forecast/route";
import * as quality from "../app/api/quality/route";
import * as config from "../app/api/config/route";
import * as extractions from "../app/api/extractions/route";
import * as discovery from "../app/api/discovery/route";
import * as download from "../app/api/report-download/route";
import * as companyReview from "../app/api/company-review/route";

const routes: Record<string, Record<string, any>> = {
  "/api/workspace": workspace,
  "/api/quality": quality,
  "/api/documents": documents,
  "/api/reports": reports,
  "/api/extract": extract,
  "/api/extractions": extractions,
  "/api/discovery": discovery,
  "/api/report-download": download,
  "/api/company-review": companyReview,
  "/api/forecast": forecast,
  "/api/config": config,
};
const port = Number(process.env.FUNDAMENTAL_PORT || 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Choose a local port between 1024 and 65535.");
const root = process.env.FUNDAMENTAL_ROOT || process.cwd();
export { closeStorage };
export async function dispatch(request: Request): Promise<Response> {
  const url = new URL(request.url),
    method = request.method;
  if (!allowedLocalHost(url.host, port))
    return new Response("Local requests only.", { status: 403 });
  if (url.pathname === "/api/health" && method === "GET")
    return Response.json({ ok: true, runtime: "local-node" });
  const route = routes[url.pathname];
  if (route)
    return route[method]
      ? await route[method](request)
      : new Response("Method not allowed", { status: 405 });
  if (url.pathname.startsWith("/api/"))
    return new Response("Not found", { status: 404 });
  if (!["GET", "HEAD"].includes(method))
    return new Response("Method not allowed", { status: 405 });
  const bundled = serveStatic(
    url.pathname,
    resolve(root, ".local-build/web"),
    method,
    request.headers.get("range"),
  );
  return bundled.status === 404
    ? serveStatic(
        url.pathname,
        resolve(root, "public"),
        method,
        request.headers.get("range"),
      )
    : bundled;
}

// Importing the built entry in automated tests does not open a listening socket.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const lock = resolve(root, ".local-data/batch-extraction.lock/pid");
  if (existsSync(lock)) {
    const owner = Number(readFileSync(lock, "utf8"));
    let alive = Number.isInteger(owner) && owner > 0;
    if (alive)
      try {
        process.kill(owner, 0);
      } catch (e: any) {
        if (e.code === "ESRCH") alive = false;
      }
    if (alive) {
      closeStorage();
      throw new Error(
        "A batch extraction or company review is running. Start the app after it finishes.",
      );
    }
  }
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (!allowedLocalHost(incoming.headers.host || "", port)) {
        outgoing.writeHead(403);
        outgoing.end("Local requests only.");
        return;
      }
      const method = incoming.method || "GET",
        buffers: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 65 * 1024 * 1024) {
          outgoing.writeHead(413);
          outgoing.end("Request too large.");
          return;
        }
        buffers.push(buffer);
      }
      const request = new Request(
        new URL(incoming.url || "/", `http://${incoming.headers.host}`),
        {
          method,
          headers: incoming.headers as Record<string, string>,
          ...(["GET", "HEAD"].includes(method)
            ? {}
            : { body: Buffer.concat(buffers) }),
        },
      );
      const response = await dispatch(request);
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        headers[k] = v;
      });
      outgoing.writeHead(response.status, headers);
      outgoing.end(
        method === "HEAD"
          ? undefined
          : Buffer.from(await response.arrayBuffer()),
      );
    } catch {
      if (!outgoing.headersSent)
        outgoing.writeHead(500, { "Content-Type": "application/json" });
      // Never log request bodies, document text, or provider credentials.
      outgoing.end(
        JSON.stringify({
          error:
            "Local server request failed. Restart the app if this persists.",
        }),
      );
    }
  });
  server.requestTimeout = 360000;
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${port} is already in use. The app may already be running.`
        : "Unable to start the local server.",
    );
    closeStorage();
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `\nFundamental Monitor: http://127.0.0.1:${port}\nLocal data: .local-data\nPress Ctrl+C in this window to stop.\n`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () =>
      server.close(() => {
        closeStorage();
        process.exit(0);
      }),
    );
}
