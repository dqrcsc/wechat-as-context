import { validPublicationDate } from "./publication_date.ts";
import { renderAsrTranscript } from "./transcript_text.ts";
import { extractionNotice } from "./quality.ts";
import { compareKnownSizeFirst, resolveYouTubeFallbackAudio } from "./youtube_fallback.ts";
import type { AppConfig } from "../config.ts";
import { fetchPublicResource, UnsafeUrlError } from "../public_url.ts";
import { asrFailureReasons, transcribeAudioFromMedia } from "./asr.ts";
import type { ExtractedWeChatArticle } from "./wechat.ts";

const WATCH_PAGE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

/** A conservative script contradiction check, not a language detector. */
export function hasChineseCaptionScriptMismatch(languageCode: string, text: string): boolean {
  if (!/^zh(?:-|$)/i.test(languageCode) || /\p{Script=Han}/u.test(text)) return false;
  const letters = text.match(/\p{L}/gu) ?? [];
  const latin = text.match(/\p{Script=Latin}/gu) ?? [];
  return letters.length >= 200 && (text.match(/[A-Za-z]+/g)?.length ?? 0) >= 40 && latin.length / letters.length >= 0.98;
}

const ANDROID_INNERTUBE_CLIENT = {
  clientName: "ANDROID",
  clientVersion: "20.10.38",
  clientHeaderName: "3",
  userAgent:
    "com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US; Pixel 8 Pro; Build/AP1A.240405.002)",
  extraContext: {
    clientFormFactor: "SMALL_FORM_FACTOR",
    androidSdkVersion: 34,
    osName: "Android",
    osVersion: "14",
    platform: "MOBILE",
  },
};

export interface YouTubeSnippet {
  text: string;
  startSec: number;
  durationSec: number;
}

export interface YouTubeChapter {
  title: string;
  startSec: number;
}

/**
 * Extract the 11-character YouTube video ID from any standard YouTube URL.
 */
/** True for the synthetic title used when no real YouTube title could be resolved. */
export function isPlaceholderYouTubeTitle(title: string | null | undefined): boolean {
  return /^YouTube Video \([A-Za-z0-9_-]{6,20}\)$/i.test(String(title ?? "").trim());
}

export function extractYouTubeVideoId(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.trim());
    const host = u.hostname.toLowerCase();
    if (host === "youtu.be") {
      const id = u.pathname.replace(/^\/+/, "").split("/")[0];
      return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const vParam = u.searchParams.get("v");
      if (vParam && /^[A-Za-z0-9_-]{6,20}$/.test(vParam)) return vParam;
      const pathMatch = u.pathname.match(
        /^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{6,20})/
      );
      if (pathMatch?.[1]) return pathMatch[1];
    }
  } catch {}
  return null;
}

/**
 * 100% Native YouTube Video Metadata, Chapters & Subtitle/Transcript Extractor.
 * Uses YouTube watch page + InnerTube player API, with automatic fallback to local/cloud ASR.
 */
export async function extractYouTubeVideo(
  rawUrl: string,
  fallbackTitle = "",
  fallbackAuthor = "",
  fallbackDigest = "",
  options?: { config?: AppConfig; preferredLanguages?: string[] }
): Promise<ExtractedWeChatArticle> {
  const videoId = extractYouTubeVideoId(rawUrl);
  if (!videoId) {
    throw new Error(`Invalid YouTube video URL: ${rawUrl}`);
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let watchHtml = "";
  try {
    const resp = await fetchPublicResource(
      `${canonicalUrl}&hl=zh-CN&persist_hl=1&has_verified=1`,
      {
        headers: {
          "User-Agent": WATCH_PAGE_UA,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(25_000),
      }
    );
    if (resp.ok) {
      watchHtml = await resp.text();
    }
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    console.warn(`[YouTubeExtractor] Watch page fetch warning for ${rawUrl}:`, err);
  }

  const acquisitionReasons = new Set<string>();

  // Extract player response and initial watch data from watch HTML or InnerTube API
  let playerData = extractJsonObjectAfterMarker(
    watchHtml,
    "ytInitialPlayerResponse"
  );
  if (playerData?.videoDetails?.videoId && playerData.videoDetails.videoId !== videoId) {
    acquisitionReasons.add("web_player_video_id_mismatch");
    playerData = null;
  }
  const initialMeta = extractYouTubeInitialMetadata(watchHtml, videoId);
  const webCaptionTracks: any[] =
    playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const apiKey = watchHtml.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/)?.[1];
  const visitorData =
    watchHtml.match(/"VISITOR_DATA":\s*"([^"]+)"/)?.[1] ||
    watchHtml.match(/"visitorData":\s*"([^"]+)"/)?.[1] ||
    "";

  // Always query the ANDROID InnerTube player API when apiKey is present because YouTube's WEB
  // watch-page captionTracks baseUrl requires a Proof-of-Origin Token (pot) and returns 0 bytes,
  // and WEB streamingData encrypts audio stream URLs via signatureCipher.
  let usedAndroidInnerTube = false;
  if (apiKey) {
    try {
      const itResp = await fetchPublicResource(
        `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(
          apiKey
        )}&prettyPrint=false`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": ANDROID_INNERTUBE_CLIENT.userAgent,
            "X-YouTube-Client-Name": ANDROID_INNERTUBE_CLIENT.clientHeaderName,
            "X-YouTube-Client-Version": ANDROID_INNERTUBE_CLIENT.clientVersion,
            Origin: "https://www.youtube.com",
            Referer: canonicalUrl,
            ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {}),
          },
          body: JSON.stringify({
            context: {
              client: {
                hl: "zh-CN",
                gl: "US",
                visitorData,
                clientName: ANDROID_INNERTUBE_CLIENT.clientName,
                clientVersion: ANDROID_INNERTUBE_CLIENT.clientVersion,
                ...ANDROID_INNERTUBE_CLIENT.extraContext,
              },
              request: { useSsl: true },
            },
            videoId,
          }),
          signal: AbortSignal.timeout(20_000),
        }
      );
      if (itResp.ok) {
        let itJson = (await itResp.json()) as any;
        if (itJson?.videoDetails?.videoId && itJson.videoDetails.videoId !== videoId) {
          acquisitionReasons.add("android_player_video_id_mismatch");
          itJson = null;
        }
        if (itJson?.videoDetails || itJson?.captions || itJson?.streamingData) {
          usedAndroidInnerTube = Boolean(
            itJson?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length
          );
          playerData = {
            ...playerData,
            ...itJson,
            videoDetails: itJson.videoDetails || playerData?.videoDetails,
            captions:
              itJson.captions?.playerCaptionsTracklistRenderer?.captionTracks
                ?.length
                ? itJson.captions
                : playerData?.captions,
            streamingData:
              itJson.streamingData?.adaptiveFormats?.length
                ? itJson.streamingData
                : playerData?.streamingData,
          };
        }
      }
    } catch (err) {
      console.warn(`[YouTubeExtractor] InnerTube API warning for ${videoId}:`, err);
    }
  }

  const videoDetails =
    playerData?.videoDetails?.videoId &&
    playerData.videoDetails.videoId !== videoId
      ? {}
      : playerData?.videoDetails ?? {};
  const cleanFallbackTitle =
    fallbackTitle && !isPlaceholderYouTubeTitle(fallbackTitle)
      ? fallbackTitle.trim()
      : "";
  const cleanFallbackAuthor =
    fallbackAuthor && fallbackAuthor.trim() !== "YouTube Channel"
      ? fallbackAuthor.trim()
      : "";

  let oembedMeta: { title: string; author: string; thumbnailUrl: string } = {
    title: "",
    author: "",
    thumbnailUrl: "",
  };
  if (
    !videoDetails.title &&
    !initialMeta.title &&
    !matchMetaTag(watchHtml, "og:title")
  ) {
    oembedMeta = await fetchYouTubeOembedMetadata(canonicalUrl);
  }

  const resolvedTitle =
    videoDetails.title ||
    initialMeta.title ||
    matchMetaTag(watchHtml, "og:title") ||
    oembedMeta.title ||
    cleanFallbackTitle;
  const title = resolvedTitle || `YouTube Video (${videoId})`;
  const author =
    videoDetails.author ||
    initialMeta.author ||
    matchMetaTag(watchHtml, "author") ||
    oembedMeta.author ||
    cleanFallbackAuthor ||
    "YouTube Channel";
  const description =
    videoDetails.shortDescription ||
    initialMeta.description ||
    matchMetaTag(watchHtml, "og:description") ||
    fallbackDigest ||
    "";
  const durationSeconds = Number(videoDetails.lengthSeconds || 0) || undefined;

  const publishDateMatch =
    watchHtml.match(/"publishDate":\s*"(\d{4}-\d{2}-\d{2})/) ||
    watchHtml.match(/itemprop=["']datePublished["']\s+content=["'](\d{4}-\d{2}-\d{2})/);
  const publishDate =
    validPublicationDate(publishDateMatch?.[1]) || initialMeta.publishDate;

  const coverUrl =
    videoDetails.thumbnail?.thumbnails?.slice(-1)?.[0]?.url ||
    matchMetaTag(watchHtml, "og:image") ||
    oembedMeta.thumbnailUrl ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const chapters = parseChaptersFromDescription(description);

  // Step 2: Fetch caption track if available
  const captionTracks: any[] =
    playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const preferredLangs = options?.preferredLanguages ?? [
    "zh-Hans",
    "zh-CN",
    "zh",
    "zh-Hant",
    "zh-TW",
    "en",
    "en-US",
  ];

  if (
    String(playerData?.playabilityStatus?.status || "").toUpperCase() ===
    "LOGIN_REQUIRED"
  ) {
    acquisitionReasons.add("login_required");
  }
  let snippets: YouTubeSnippet[] = [];
  let transcriptSourceLabel = "";

  const candidateTrackPools = [
    {
      tracks: captionTracks,
      ua: usedAndroidInnerTube
        ? ANDROID_INNERTUBE_CLIENT.userAgent
        : WATCH_PAGE_UA,
    },
    ...(usedAndroidInnerTube && webCaptionTracks.length > 0
      ? [{ tracks: webCaptionTracks, ua: WATCH_PAGE_UA }]
      : []),
  ];

  if (!candidateTrackPools.some(pool => pool.tracks.length)) acquisitionReasons.add("caption_track_not_found");
  for (const pool of candidateTrackPools) {
    const selectedTrack = selectBestCaptionTrack(pool.tracks, preferredLangs);
    if (!selectedTrack?.baseUrl) continue;
    try {
      const trackResp = await fetchPublicResource(selectedTrack.baseUrl, {
        headers: {
          "User-Agent": pool.ua,
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!trackResp.ok) acquisitionReasons.add(`caption_http_${trackResp.status}`);
      if (trackResp.ok) {
        const rawTrack = await trackResp.text();
        const parsedSnippets = parseYouTubeTranscriptPayload(rawTrack);
        if (!parsedSnippets.length) acquisitionReasons.add("caption_empty_or_invalid");
        if (parsedSnippets.length > 0) {
          snippets = parsedSnippets;
          const langName =
            selectedTrack.name?.simpleText ||
            selectedTrack.name?.runs?.[0]?.text ||
            selectedTrack.languageCode ||
            "default";
          transcriptSourceLabel = `YouTube 字幕轨道 (${langName}${
            selectedTrack.kind === "asr" ? " · 自动生成" : ""
          })`;
          if (hasChineseCaptionScriptMismatch(selectedTrack.languageCode || "", snippets.map(s => s.text).join(" "))) {
            acquisitionReasons.add("caption_language_mismatch");
            transcriptSourceLabel = `YouTube 字幕轨道（源站声明：${langName} / ${selectedTrack.languageCode}${selectedTrack.kind === "asr" ? " · 自动生成" : ""}；正文以拉丁字母为主，语言待核验）`;
          }
          break;
        }
      }
    } catch (err) {
      acquisitionReasons.add("caption_download_failed");
      console.warn("[YouTubeExtractor] caption_download_failed");
    }
  }

  // Step 3: Fallback to audio stream + ASR if no captions were obtained
  let asrTranscript = "";
  let asrPartial = false;
  if (snippets.length === 0) {
    const audioFormats = (playerData?.streamingData?.adaptiveFormats ?? [])
      .filter(
        (f: any) =>
          typeof f?.mimeType === "string" &&
          f.mimeType.startsWith("audio/") &&
          typeof f?.url === "string"
      )
      .sort((a: any, b: any) =>
        compareKnownSizeFirst(a?.contentLength, b?.contentLength)
      );
    const audioUrls = audioFormats.map((f: any) => String(f.url));
    if (!audioUrls.length) acquisitionReasons.add("audio_stream_not_found");
    if (audioUrls.length > 0) {
      try {
        const asrRes = await transcribeAudioFromMedia({
          mediaUrl: audioUrls[0],
          mediaUrls: audioUrls,
          headers: {
            "User-Agent": ANDROID_INNERTUBE_CLIENT.userAgent,
          },
          config: options?.config,
          hintTitle: title,
        });
        asrPartial = asrRes.extractionQuality?.status === "partial";
        for (const reason of asrRes.extractionQuality?.reasons ?? []) acquisitionReasons.add(reason);
        for (const issue of asrRes.toolIssues ?? []) acquisitionReasons.add(`asr_tool_${issue}`);
        if (!asrRes.transcript.trim()) acquisitionReasons.add("asr_empty");
        if (asrRes.transcript.trim()) {
          asrTranscript = asrRes.transcript.trim();
          transcriptSourceLabel = `音频自动转写 (${asrRes.engineUsed})`;
        }
      } catch (err) {
        const reasons = asrFailureReasons(err);
        for (const reason of reasons) acquisitionReasons.add(reason);
        console.warn(`[YouTubeExtractor] ${reasons.join(", ")}`);
      }
    }
  }

  if (!snippets.length && !asrTranscript) {
    const fallback = await resolveYouTubeFallbackAudio(videoId);
    if (fallback.reason) acquisitionReasons.add(fallback.reason);
    if (fallback.exitCode !== undefined) acquisitionReasons.add(`resolver_exit_code_${fallback.exitCode}`);
    if (fallback.urls.length) {
      try {
        const result = await transcribeAudioFromMedia({ mediaUrls: fallback.urls, headers: fallback.headers, config: options?.config, hintTitle: title });
        asrPartial = result.extractionQuality?.status === "partial";
        for (const reason of result.extractionQuality?.reasons ?? []) acquisitionReasons.add(reason);
        for (const issue of result.toolIssues ?? []) acquisitionReasons.add(`resolver_asr_tool_${issue}`);
        asrTranscript = result.transcript.trim();
        if (asrTranscript) transcriptSourceLabel = `音频自动转写 (${result.engineUsed}; yt-dlp)`;
        else acquisitionReasons.add("resolver_asr_empty");
      } catch (error) {
        for (const reason of asrFailureReasons(error, "resolver_")) acquisitionReasons.add(reason);
      }
    }
  }

  const formattedTranscript =
    snippets.length > 0
      ? formatSnippetsWithChapters(snippets, chapters)
      : asrTranscript ? renderAsrTranscript(asrTranscript) : "";

  if (!formattedTranscript && !description.trim() && !resolvedTitle.trim()) {
    throw new Error(`Failed to extract YouTube video content for ${canonicalUrl}`);
  }

  const durationText = durationSeconds ? formatDurationHms(durationSeconds) : "";
  const mdSections: string[] = [];
  const languageNotice = extractionNotice({ status: "complete", reasons: [...acquisitionReasons] });
  if (languageNotice) mdSections.push(languageNotice);

  if (coverUrl) {
    mdSections.push(`![视频封面](${coverUrl})`);
  }

  if (description.trim()) {
    mdSections.push(`## 视频简介\n\n${description.trim()}`);
  }

  if (chapters.length > 0) {
    mdSections.push(
      `## 章节目录\n\n` +
        chapters
          .map((c) => `- \`[${formatDurationHms(c.startSec)}]\` ${c.title}`)
          .join("\n")
    );
  }

  if (formattedTranscript) {
    mdSections.push(
      `## ${asrPartial ? "部分逐字稿（未取得完整转写）" : "完整字幕 / 逐字稿"}${
        transcriptSourceLabel ? `（${transcriptSourceLabel}）` : ""
      }\n\n${formattedTranscript}`
    );
  } else {
    mdSections.push(
      `> ⚠️ 本次未取得逐字稿，以上仅为视频元数据与简介摘录，不代表源站未提供字幕。采集原因：${[...acquisitionReasons].join("、")}。`
    );
  }

  const markdownBody = mdSections.join("\n\n");
  const digest =
    (description || formattedTranscript)
      .slice(0, 200)
      .replace(/\r?\n/g, " ")
      .trim() || title;

  return {
    url: canonicalUrl,
    title: decodeHtmlEntities(title).trim(),
    author: decodeHtmlEntities(author).trim(),
    publishDate,
    digest: decodeHtmlEntities(digest),
    markdownBody,
    imageUrls: coverUrl ? [coverUrl] : [],
    extractorUsed: "native_http",
    mediaKind: "video",
    sourceType: "youtube_video",
    durationSeconds,
     durationText,
    transcriptEngine: transcriptSourceLabel || "metadata_only",
    extractionQuality: { status: formattedTranscript ? (asrPartial ? "partial" : "complete") : "metadata_only", reasons: [...acquisitionReasons] },
  };
}

function selectBestCaptionTrack(
  tracks: any[],
  preferredLanguages: string[]
): any | null {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  // Prefer manual captions in preferred language order, then auto-generated in preferred language order
  for (const preferManual of [true, false]) {
    for (const lang of preferredLanguages) {
      const lower = lang.toLowerCase();
      const match = tracks.find((t) => {
        const code = String(t?.languageCode || "").toLowerCase();
        const isAsr = t?.kind === "asr";
        if (preferManual && isAsr) return false;
        return code === lower || code.startsWith(`${lower}-`);
      });
      if (match) return match;
    }
  }
  return tracks[0];
}

export function parseYouTubeTranscriptPayload(raw: string): YouTubeSnippet[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // Format 1: JSON3 ({ events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] })
  if (trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed);
      if (Array.isArray(data.events)) {
        const out: YouTubeSnippet[] = [];
        for (const ev of data.events) {
          if (!Array.isArray(ev.segs)) continue;
          const text = ev.segs
            .map((s: any) => s.utf8 || "")
            .join("")
            .replace(/\s+/g, " ")
            .trim();
          if (!text) continue;
          out.push({
            text: decodeHtmlEntities(text),
            startSec: Number(ev.tStartMs || 0) / 1000,
            durationSec: Number(ev.dDurationMs || 0) / 1000,
          });
        }
        if (out.length > 0) return out;
      }
    } catch {}
  }

  // Format 2: XML <text start="1.23" dur="4.56">...</text>
  const textRegex =
    /<text\b[^>]*\bstart=["']([\d.]+)["'][^>]*?(?:\bdur=["']([\d.]+)["'][^>]*)?>([\s\S]*?)<\/text>/gi;
  const out: YouTubeSnippet[] = [];
  let m: RegExpExecArray | null;
  while ((m = textRegex.exec(trimmed)) !== null) {
    const text = decodeHtmlEntities(m[3].replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    out.push({
      text,
      startSec: Number(m[1]) || 0,
      durationSec: Number(m[2]) || 0,
    });
  }
  if (out.length > 0) return out;

  // Format 3: SRV3 <p t="1230" d="4560">...</p>
  const pRegex =
    /<p\b[^>]*\bt=["'](\d+)["'][^>]*?(?:\bd=["'](\d+)["'][^>]*)?>([\s\S]*?)<\/p>/gi;
  while ((m = pRegex.exec(trimmed)) !== null) {
    const text = decodeHtmlEntities(m[3].replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    out.push({
      text,
      startSec: Number(m[1]) / 1000,
      durationSec: Number(m[2] || 0) / 1000,
    });
  }
  return out;
}

export function parseChaptersFromDescription(description: string): YouTubeChapter[] {
  if (!description) return [];
  const chapters: YouTubeChapter[] = [];
  for (const line of description.split(/\r?\n/)) {
    const m = line
      .trim()
      .match(/^(?:[-*•]\s*)?\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s*[-–—:：]?\s*(.+)$/);
    if (!m) continue;
    const parts = m[1].split(":").map(Number);
    const startSec =
      parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1];
    const title = m[2].trim();
    if (title && !Number.isNaN(startSec)) {
      chapters.push({ title, startSec });
    }
  }
  return chapters.length >= 2 ? chapters : [];
}

function formatSnippetsWithChapters(
  snippets: YouTubeSnippet[],
  chapters: YouTubeChapter[]
): string {
  if (snippets.length === 0) return "";

  const groupSnippetsIntoParagraphs = (list: YouTubeSnippet[]): string => {
    const paragraphs: string[] = [];
    let bucket: string[] = [];
    let bucketStart = list[0]?.startSec ?? 0;
    let charCount = 0;

    for (const item of list) {
      if (bucket.length === 0) bucketStart = item.startSec;
      bucket.push(item.text);
      charCount += item.text.length;
      const endsWithSentencePunct = /[.!?。！？]$/.test(item.text);
      if (charCount >= 220 || (charCount >= 120 && endsWithSentencePunct)) {
        paragraphs.push(
          `\`[${formatDurationHms(bucketStart)}]\` ${bucket.join(" ")}`
        );
        bucket = [];
        charCount = 0;
      }
    }
    if (bucket.length > 0) {
      paragraphs.push(
        `\`[${formatDurationHms(bucketStart)}]\` ${bucket.join(" ")}`
      );
    }
    return paragraphs.join("\n\n");
  };

  if (chapters.length === 0) {
    return groupSnippetsIntoParagraphs(snippets);
  }

  const sections: string[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const cur = chapters[i];
    const nextStart =
      i + 1 < chapters.length ? chapters[i + 1].startSec : Number.POSITIVE_INFINITY;
    const slice = snippets.filter(
      (s) => s.startSec >= cur.startSec && s.startSec < nextStart
    );
    if (slice.length === 0) continue;
    sections.push(
      `### ${formatDurationHms(cur.startSec)} ${cur.title}\n\n${groupSnippetsIntoParagraphs(
        slice
      )}`
    );
  }
  return sections.length > 0
    ? sections.join("\n\n")
    : groupSnippetsIntoParagraphs(snippets);
}

export function formatDurationHms(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
      s
    ).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function extractJsonObjectAfterMarker(html: string, marker: string): any | null {
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const braceStart = html.indexOf("{", idx + marker.length);
  if (braceStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = html.slice(braceStart, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function matchMetaTag(html: string, propOrName: string): string {
  const escaped = propOrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m =
    html.match(
      new RegExp(
        `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
        "i"
      )
    ) ||
    html.match(
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`,
        "i"
      )
    );
  return m?.[1] ? decodeHtmlEntities(m[1]).trim() : "";
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

function readYouTubeTextNode(node: any): string {
  if (!node || typeof node !== "object") return "";
  if (typeof node.content === "string" && node.content.trim()) {
    return node.content.trim();
  }
  if (typeof node.simpleText === "string" && node.simpleText.trim()) {
    return node.simpleText.trim();
  }
  if (Array.isArray(node.runs)) {
    const joined = node.runs
      .map((r: any) => (typeof r?.text === "string" ? r.text : ""))
      .join("")
      .trim();
    if (joined) return joined;
  }
  return "";
}

export function parseYouTubeDateText(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const direct = validPublicationDate(raw);
  if (direct) return direct;

  const zhMatch = raw.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (zhMatch) {
    return validPublicationDate(
      `${zhMatch[1]}-${zhMatch[2].padStart(2, "0")}-${zhMatch[3].padStart(2, "0")}`
    );
  }

  const months = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  const enMdy = raw.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})\b/);
  if (enMdy) {
    const mIdx = months.indexOf(enMdy[1].slice(0, 3).toLowerCase()) + 1;
    if (mIdx > 0) {
      return validPublicationDate(
        `${enMdy[3]}-${String(mIdx).padStart(2, "0")}-${enMdy[2].padStart(2, "0")}`
      );
    }
  }

  const enDmy = raw.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/);
  if (enDmy) {
    const mIdx = months.indexOf(enDmy[2].slice(0, 3).toLowerCase()) + 1;
    if (mIdx > 0) {
      return validPublicationDate(
        `${enDmy[3]}-${String(mIdx).padStart(2, "0")}-${enDmy[1].padStart(2, "0")}`
      );
    }
  }

  return "";
}

export function extractYouTubeInitialMetadata(
  watchHtml: string,
  videoId: string
): {
  title: string;
  author: string;
  description: string;
  publishDate: string;
} {
  const empty = { title: "", author: "", description: "", publishDate: "" };
  if (!watchHtml) return empty;
  const initialData = extractJsonObjectAfterMarker(watchHtml, "ytInitialData");
  if (!initialData || typeof initialData !== "object") return empty;

  const declaredVideoId =
    initialData?.currentVideoEndpoint?.watchEndpoint?.videoId;
  if (declaredVideoId && declaredVideoId !== videoId) {
    return empty;
  }

  const contents: any[] =
    initialData?.contents?.twoColumnWatchNextResults?.results?.results
      ?.contents ?? [];
  const primary = contents.find((c) => c?.videoPrimaryInfoRenderer)
    ?.videoPrimaryInfoRenderer;
  const secondary = contents.find((c) => c?.videoSecondaryInfoRenderer)
    ?.videoSecondaryInfoRenderer;

  const panels: any[] = Array.isArray(initialData?.engagementPanels)
    ? initialData.engagementPanels
    : [];
  const descPanel = panels.find(
    (p) =>
      (p?.engagementPanelSectionListRenderer?.panelIdentifier ||
        p?.engagementPanelSectionListRenderer?.targetId) ===
      "engagement-panel-structured-description"
  )?.engagementPanelSectionListRenderer;
  const descItems: any[] =
    descPanel?.content?.structuredDescriptionContentRenderer?.items ?? [];
  const titleHeader = descItems.find((i) => i?.videoTitleHeaderViewModel)
    ?.videoTitleHeaderViewModel;
  const descHeader = descItems.find((i) => i?.videoDescriptionHeaderRenderer)
    ?.videoDescriptionHeaderRenderer;
  const descBody = descItems.find(
    (i) => i?.expandableVideoDescriptionBodyRenderer
  )?.expandableVideoDescriptionBodyRenderer;
  const infocards = descItems.find(
    (i) => i?.videoDescriptionInfocardsSectionRenderer
  )?.videoDescriptionInfocardsSectionRenderer;
  const overlayDetails =
    initialData?.playerOverlays?.playerOverlayRenderer?.videoDetails
      ?.playerOverlayVideoDetailsRenderer;

  const title =
    readYouTubeTextNode(primary?.title) ||
    readYouTubeTextNode(titleHeader?.videoTitle) ||
    readYouTubeTextNode(descHeader?.title) ||
    readYouTubeTextNode(overlayDetails?.title);

  const author =
    readYouTubeTextNode(secondary?.owner?.videoOwnerRenderer?.title) ||
    readYouTubeTextNode(descHeader?.channel) ||
    readYouTubeTextNode(infocards?.sectionTitle);

  const description =
    readYouTubeTextNode(secondary?.attributedDescription) ||
    readYouTubeTextNode(secondary?.description) ||
    readYouTubeTextNode(descBody?.attributedDescriptionBodyText) ||
    readYouTubeTextNode(descBody?.descriptionBodyText);

  const publishDate =
    parseYouTubeDateText(readYouTubeTextNode(primary?.dateText)) ||
    parseYouTubeDateText(readYouTubeTextNode(descHeader?.publishDate));

  return { title, author, description, publishDate };
}

async function fetchYouTubeOembedMetadata(canonicalUrl: string): Promise<{
  title: string;
  author: string;
  thumbnailUrl: string;
}> {
  try {
    const resp = await fetchPublicResource(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        canonicalUrl
      )}&format=json`,
      {
        headers: {
          "User-Agent": WATCH_PAGE_UA,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!resp.ok) return { title: "", author: "", thumbnailUrl: "" };
    const data = (await resp.json()) as any;
    return {
      title: typeof data?.title === "string" ? data.title.trim() : "",
      author:
        typeof data?.author_name === "string" ? data.author_name.trim() : "",
      thumbnailUrl:
        typeof data?.thumbnail_url === "string"
          ? data.thumbnail_url.trim()
          : "",
    };
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    return { title: "", author: "", thumbnailUrl: "" };
  }
}
