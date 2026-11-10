import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, sep, extname } from "node:path";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
export function serveStatic(pathname, root, method = "GET", range) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }
  if (decoded.includes("\0") || decoded.includes("\\"))
    return new Response("Invalid path", { status: 400 });
  const target = resolve(
    root,
    "." + (decoded === "/" ? "/index.html" : decoded),
  );
  if (
    !target.startsWith(resolve(root) + sep) ||
    !existsSync(target) ||
    !statSync(target).isFile()
  )
    return new Response("Not found", { status: 404 });
  const bytes = readFileSync(target),
    size = bytes.length;
  const headers = {
    "Content-Type": mime[extname(target)] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "Accept-Ranges": "bytes",
  };
  if (range) {
    const m = range.match(/^bytes=(\d+)-(\d*)$/);
    if (!m)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    const start = Number(m[1]),
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || end < start)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    return new Response(
      method === "HEAD" ? null : bytes.subarray(start, end + 1),
      {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
        },
      },
    );
  }
  return new Response(method === "HEAD" ? null : bytes, {
    headers: { ...headers, "Content-Length": String(size) },
  });
}
export function allowedLocalHost(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
