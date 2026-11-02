import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertPublicUrl } from "../public_url.ts";

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
  return env;
}

/** Optional maintained extractor, metadata only. Media still uses our bounded downloader. */
export async function resolveYouTubeFallbackAudio(videoId: string): Promise<{ urls: string[]; headers?: Record<string, string>; reason?: string }> {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return { urls: [], reason: "resolver_invalid_id" };
  const binary = testRunner ? "fixture-yt-dlp" : [process.env.YT_DLP_BIN || "",
    join(homedir(), ".local/bin/yt-dlp"), "/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp"]
    .find(path => path && existsSync(path));
  if (!binary) return { urls: [], reason: "resolver_not_installed" };
  const args = ["--ignore-config", "--no-plugin-dirs", "--no-playlist", "--no-cache-dir",
    "--no-cookies", "--no-cookies-from-browser", "--no-remote-components",
    "--skip-download", "--dump-single-json", "--socket-timeout", "15", "--retries", "0",
    "--extractor-retries", "0", "--js-runtimes", "node", "--", `https://www.youtube.com/watch?v=${videoId}`];
  try {
    const output = await (testRunner ?? ((bin, argv) => new Promise<string>((resolve, reject) => {
      execFile(bin, argv, { encoding: "utf8", timeout: 45_000, maxBuffer: 2 * 1024 * 1024, env: buildYouTubeResolverEnv() },
        (error, stdout) => error ? reject(new Error(error.killed ? "resolver_timeout" : "resolver_failed")) : resolve(stdout));
    })))(binary, args);
    if (output.length > 2 * 1024 * 1024) return { urls: [], reason: "resolver_output_limit" };
    const info = JSON.parse(output);
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
    return { urls: [], reason: String(error).includes("resolver_timeout") ? "resolver_timeout" : "resolver_failed" };
  }
}
