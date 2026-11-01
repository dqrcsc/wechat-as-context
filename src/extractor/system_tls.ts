import { execFile } from "node:child_process";

const HOSTS = new Set(["v.douyin.com", "www.douyin.com", "www.iesdouyin.com"]);
const MAX_BYTES = 8 * 1024 * 1024;
type CurlRunner = (args: string[], signal?: AbortSignal) => Promise<Buffer>;
let testRunner: CurlRunner | undefined;
export class SystemTlsError extends Error {
  constructor(public reason: string) { super(`Douyin system transport failed: ${reason}`); }
}
export function setSystemTlsTestRunner(runner?: CurlRunner): void {
  if (!process.env.WXCTX_TEST_ROOT) throw new Error("Test isolation required");
  testRunner = runner;
}

export function canRetryWithSystemTls(url: URL, init: RequestInit, error: unknown): boolean {
  return url.protocol === "https:" && HOSTS.has(url.hostname) &&
    (init.method || "GET").toUpperCase() === "GET" && !init.body && !init.signal?.aborted &&
    /certificate|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT/i.test(String(error));
}

/** No curlrc, cookies, credential headers, TLS bypass or automatic redirects. */
export async function fetchWithSystemTls(url: URL, init: RequestInit): Promise<Response> {
  init.signal?.throwIfAborted();
  const args = ["-q", "--silent", "--show-error", "--include", "--proto", "=https",
    "--max-time", "20", "--max-filesize", String(MAX_BYTES)];
  const headers = new Headers(init.headers);
  for (const key of ["user-agent", "accept", "accept-language"]) {
    const value = headers.get(key);
    if (value) args.push("--header", `${key}: ${value}`);
  }
  args.push("--", url.toString());
  let output: Buffer;
  try {
    output = await (testRunner ?? ((argv, signal) => new Promise<Buffer>((resolve, reject) => {
      execFile("/usr/bin/curl", argv, { encoding: "buffer", timeout: 25_000,
        maxBuffer: MAX_BYTES + 65536, signal }, (error, stdout) => error ? reject(error) : resolve(stdout));
    })))(args, init.signal || undefined);
  } catch (error: any) {
    init.signal?.throwIfAborted();
    const reason = error?.code === "ENOENT" ? "system_tls_unavailable"
      : error?.killed || error?.code === 28 ? "system_tls_timeout"
      : error?.code === 63 || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "system_tls_size_limit"
      : error?.code === 60 ? "system_tls_certificate_rejected" : "system_tls_fetch_failed";
    throw new SystemTlsError(reason);
  }
  init.signal?.throwIfAborted();
  try { return parseSystemTlsResponse(output, url.toString()); }
  catch { throw new SystemTlsError("system_tls_invalid_response"); }
}

export function parseSystemTlsResponse(output: Buffer, url: string): Response {
  let offset = 0;
  // curl may include an HTTP CONNECT or interim response before the actual headers.
  for (let count = 0; count < 5; count++) {
    const end = output.indexOf("\r\n\r\n", offset);
    if (end < 0 || end - offset > 65536) throw new Error("system_tls_invalid_headers");
    const lines = output.subarray(offset, end).toString("utf8").split("\r\n");
    const status = /^HTTP\/[\d.]+ (\d{3})(?: |$)/.exec(lines.shift() || "");
    if (!status) throw new Error("system_tls_invalid_status");
    offset = end + 4;
    if (output.subarray(offset, offset + 5).toString() === "HTTP/") continue;
    const body = output.subarray(offset);
    if (body.length > MAX_BYTES) throw new Error("system_tls_body_limit");
    const headers = new Headers();
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    const code = Number(status[1]);
    const response = new Response([204, 205, 304].includes(code) ? null : body, { status: code, headers });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }
  throw new Error("system_tls_excess_headers");
}
