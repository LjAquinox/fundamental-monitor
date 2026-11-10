import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18, 19].includes(b))
    );
  }
  // Only globally routed IPv6; excludes local, mapped IPv4 and multicast ranges.
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(?:0*:|db8:)/i.test(address) &&
    !/^2002:/i.test(address)
  );
}
export function reportUrl(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    isIP(u.hostname.replace(/^\[|\]$/g, "")) ||
    !u.hostname.includes(".") ||
    /\.(localhost|local|internal|test|invalid)$/i.test(u.hostname)
  )
    throw new Error(
      "Report downloads require a public HTTPS hostname on port 443.",
    );
  return u;
}
export async function downloadReport(value, depth = 0) {
  if (depth > 5) throw new Error("Too many PDF redirects.");
  const u = reportUrl(value),
    addresses = await lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error("This report host does not resolve to a public address.");
  // Pin the checked address for this connection, preventing DNS rebinding.
  const address = addresses.find((a) => a.family === 4) || addresses[0];
  const result = await new Promise((resolve, reject) => {
    const req = request(
      u,
      {
        lookup: (_host, options, cb) =>
          options.all
            ? cb(null, [address])
            : cb(null, address.address, address.family),
        headers: {
          "User-Agent": "FundamentalMonitor/0.2 financial-report reader",
          Accept: "application/pdf",
        },
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          resolve({ redirect: response.headers.location });
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              `Report download returned HTTP ${response.statusCode}. You can download it manually and use Import PDF.`,
            ),
          );
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size >= 50000000) {
            response.destroy(new Error("Choose a PDF smaller than 50 MB."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ bytes: Buffer.concat(chunks) }));
        response.on("error", reject);
      },
    );
    const timer = setTimeout(
      () =>
        req.destroy(
          new Error("PDF download timed out. Try a manual download."),
        ),
      60000,
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
  if (result.redirect)
    return downloadReport(new URL(result.redirect, u).href, depth + 1);
  if (!result.bytes || result.bytes.subarray(0, 5).toString() !== "%PDF-")
    throw new Error(
      "The link did not return a PDF. Open its source page and import the PDF manually.",
    );
  return new Uint8Array(result.bytes);
}
