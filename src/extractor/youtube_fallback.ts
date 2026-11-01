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

/** Optional maintained extractor, metadata only. Media still uses our bounded downloader. */
export async function resolveYouTubeFallbackAudio(videoId: string): Promise<{ urls: string[]; reason?: string }> {
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
      execFile(bin, argv, { encoding: "utf8", timeout: 45_000, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => error ? reject(new Error(error.killed ? "resolver_timeout" : "resolver_failed")) : resolve(stdout));
    })))(binary, args);
    if (output.length > 2 * 1024 * 1024) return { urls: [], reason: "resolver_output_limit" };
    const info = JSON.parse(output);
    if (info.id !== videoId) return { urls: [], reason: "resolver_identity_mismatch" };
    const urls = (Array.isArray(info.formats) ? info.formats : []).filter((format: any) =>
      format.vcodec === "none" && format.acodec && format.acodec !== "none" && typeof format.url === "string")
      .sort((a: any, b: any) => (Number(a.filesize) || Infinity) - (Number(b.filesize) || Infinity))
      .map((format: any) => format.url).filter((raw: string) => {
        try { const url = assertPublicUrl(raw); return url.protocol === "https:" && url.hostname.endsWith(".googlevideo.com"); }
        catch { return false; }
      });
    return { urls: [...new Set<string>(urls)].slice(0, 3), ...(urls.length ? {} : { reason: "resolver_no_audio" }) };
  } catch (error) {
    return { urls: [], reason: String(error).includes("resolver_timeout") ? "resolver_timeout" : "resolver_failed" };
  }
}
