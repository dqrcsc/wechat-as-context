import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { assertPublicUrl } from "../public_url.ts";
import { findMediaToolBinary, MediaToolError } from "./tool_binary.ts";

type ResolverRunner = (binary: string, args: string[]) => Promise<string>;
let testRunner: ResolverRunner | undefined;
export function setYouTubeResolverTestRunner(runner?: ResolverRunner): void {
  if (!process.env.WXCTX_TEST_ROOT) throw new Error("Test isolation required");
  testRunner = runner;
}

export function buildYouTubeResolverEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  hasSystemCertPem: boolean = existsSync("/etc/ssl/cert.pem")
): NodeJS.ProcessEnv {
  const pathParts = (baseEnv.PATH || "").split(":").filter(Boolean);
  for (const dir of ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]) {
    if (!pathParts.includes(dir)) pathParts.push(dir);
  }
  const env: NodeJS.ProcessEnv = {
    PATH: pathParts.join(":"),
    HOME: baseEnv.HOME || homedir(),
    TMPDIR: baseEnv.TMPDIR || "/tmp",
    LANG: baseEnv.LANG || "en_US.UTF-8",
  };
  if (baseEnv.LC_ALL) env.LC_ALL = baseEnv.LC_ALL;
  if (baseEnv.SSL_CERT_FILE) env.SSL_CERT_FILE = baseEnv.SSL_CERT_FILE;
  else if (hasSystemCertPem) env.SSL_CERT_FILE = "/etc/ssl/cert.pem";
  if (baseEnv.SSL_CERT_DIR) env.SSL_CERT_DIR = baseEnv.SSL_CERT_DIR;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    // Preserve empty values as well: lowercase/uppercase precedence belongs to the client.
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  return env;
}

class ResolverFailure extends Error {
  constructor(public reason: string, public exitCode?: number) { super(reason); }
}

function subprocessFailure(error: any, stderr: string): ResolverFailure {
  const exitCode = Number.isSafeInteger(error?.code) ? error.code : undefined;
  // Match bounded stderr locally; only fixed categories and numeric exit status escape.
  const diagnostic = stderr.slice(0, 32768);
  const reason = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'resolver_output_limit'
    : error?.killed || error?.code === 'ETIMEDOUT' ? 'resolver_timeout'
    : error?.code === 'ENOENT' ? 'resolver_not_installed'
    : ['EACCES', 'EPERM', 'ENOEXEC'].includes(error?.code) ? 'resolver_not_executable'
    : /CERTIFICATE_VERIFY_FAILED|certificate verify failed|unable to get local issuer certificate/i.test(diagnostic) ? 'resolver_certificate_error'
    : /ProxyError|Unable to connect to proxy|Cannot connect to proxy|proxy connection failed/i.test(diagnostic) ? 'resolver_proxy_error'
    : /timed out|timeout/i.test(diagnostic) ? 'resolver_timeout'
    : /HTTP Error (\d{3})\b/i.test(diagnostic) ? `resolver_http_${diagnostic.match(/HTTP Error (\d{3})\b/i)![1]}`
    : /Connection refused|Network is unreachable|Name or service not known|Temporary failure in name resolution|nodename nor servname|Connection reset/i.test(diagnostic) ? 'resolver_network_error'
    : 'resolver_failed';
  return new ResolverFailure(reason, exitCode);
}

/** Optional maintained extractor, metadata only. Media still uses our bounded downloader. */
export async function resolveYouTubeFallbackAudio(videoId: string): Promise<{ urls: string[]; headers?: Record<string, string>; reason?: string; exitCode?: number }> {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return { urls: [], reason: "resolver_invalid_id" };
  let binary: string | null;
  try { binary = testRunner ? 'fixture-yt-dlp' : findMediaToolBinary('yt-dlp', process.env.YT_DLP_BIN); }
  catch (error) { return { urls: [], reason: error instanceof MediaToolError ? `resolver_tool_${error.reason}` : 'resolver_failed' }; }
  if (!binary) return { urls: [], reason: "resolver_not_installed" };
  const args = ["--ignore-config", "--no-plugin-dirs", "--no-playlist", "--no-cache-dir",
    "--no-cookies", "--no-cookies-from-browser", "--no-remote-components",
    "--skip-download", "--dump-single-json", "--socket-timeout", "15", "--retries", "0",
    "--extractor-retries", "0", "--js-runtimes", "node", "--", `https://www.youtube.com/watch?v=${videoId}`];
  try {
    const output = await (testRunner ?? ((bin, argv) => new Promise<string>((resolve, reject) => {
      execFile(bin, argv, { encoding: "utf8", timeout: 45_000, maxBuffer: 2 * 1024 * 1024, env: buildYouTubeResolverEnv() },
        (error, stdout, stderr) => error ? reject(subprocessFailure(error, stderr || '')) : resolve(stdout));
    })))(binary, args);
    if (Buffer.byteLength(output) > 2 * 1024 * 1024) return { urls: [], reason: "resolver_output_limit" };
    let info: any;
    try { info = JSON.parse(output); }
    catch { return { urls: [], reason: 'resolver_invalid_output' }; }
    if (!info || typeof info !== 'object' || Array.isArray(info)) return { urls: [], reason: 'resolver_invalid_output' };
    if (info.id !== videoId) return { urls: [], reason: "resolver_identity_mismatch" };
    const formats = (Array.isArray(info.formats) ? info.formats : []).filter((format: any) =>
      format.protocol === "https" && format.vcodec === "none" && format.acodec && format.acodec !== "none" && typeof format.url === "string")
      .sort((a: any, b: any) => (Number(a.filesize) || Infinity) - (Number(b.filesize) || Infinity))
      .filter((format: any) => {
        try { const url = assertPublicUrl(format.url); return url.protocol === "https:" && url.hostname.endsWith(".googlevideo.com"); }
        catch { return false; }
      });
    const agent = formats[0]?.http_headers?.["User-Agent"];
    const userAgent = typeof agent === "string" && agent.length <= 512 && !/[\r\n]/.test(agent) ? agent : "Mozilla/5.0";
    const urls = formats.filter((format: any) => format.http_headers?.["User-Agent"] === agent).map((format: any) => format.url);
    return { urls: [...new Set<string>(urls)].slice(0, 3), headers: { "User-Agent": userAgent,
      Referer: `https://www.youtube.com/watch?v=${videoId}`, Range: "bytes=0-" },
      ...(urls.length ? {} : { reason: "resolver_no_audio" }) };

  } catch (error) {
    if (error instanceof ResolverFailure) return { urls: [], reason: error.reason, ...(error.exitCode !== undefined ? { exitCode: error.exitCode } : {}) };
    return { urls: [], reason: String(error).includes("resolver_timeout") ? "resolver_timeout" : "resolver_failed" };
  }
}
