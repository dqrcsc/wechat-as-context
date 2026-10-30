import type { AppConfig } from "../config.ts";
import { fetchPublicResource, UnsafeUrlError } from "../public_url.ts";
import { transcribeAudioFromMedia } from "./asr.ts";
import type { ExtractedWeChatArticle } from "./wechat.ts";

const WATCH_PAGE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

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

  // Extract player response from watch HTML or InnerTube API
  let playerData = extractJsonObjectAfterMarker(
    watchHtml,
    "ytInitialPlayerResponse"
  );
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
        const itJson = (await itResp.json()) as any;
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

  const videoDetails = playerData?.videoDetails ?? {};
  const title =
    videoDetails.title ||
    matchMetaTag(watchHtml, "og:title") ||
    fallbackTitle ||
    `YouTube Video (${videoId})`;
  const author =
    videoDetails.author ||
    matchMetaTag(watchHtml, "author") ||
    fallbackAuthor ||
    "YouTube Channel";
  const description =
    videoDetails.shortDescription ||
    matchMetaTag(watchHtml, "og:description") ||
    fallbackDigest ||
    "";
  const durationSeconds = Number(videoDetails.lengthSeconds || 0) || undefined;

  const publishDateMatch =
    watchHtml.match(/"publishDate":\s*"(\d{4}-\d{2}-\d{2})/) ||
    watchHtml.match(/itemprop=["']datePublished["']\s+content=["'](\d{4}-\d{2}-\d{2})/);
  const publishDate =
    publishDateMatch?.[1] || new Date().toISOString().slice(0, 10);

  const coverUrl =
    videoDetails.thumbnail?.thumbnails?.slice(-1)?.[0]?.url ||
    matchMetaTag(watchHtml, "og:image") ||
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
      if (trackResp.ok) {
        const rawTrack = await trackResp.text();
        const parsedSnippets = parseYouTubeTranscriptPayload(rawTrack);
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
          break;
        }
      }
    } catch (err) {
      console.warn(`[YouTubeExtractor] Failed to download caption track:`, err);
    }
  }

  // Step 3: Fallback to audio stream + ASR if no captions were obtained
  let asrTranscript = "";
  if (snippets.length === 0) {
    const audioFormats = (playerData?.streamingData?.adaptiveFormats ?? [])
      .filter(
        (f: any) =>
          typeof f?.mimeType === "string" &&
          f.mimeType.startsWith("audio/") &&
          typeof f?.url === "string"
      )
      .sort(
        (a: any, b: any) =>
          Number(a?.contentLength || Infinity) -
          Number(b?.contentLength || Infinity)
      );
    const audioUrls = audioFormats.map((f: any) => String(f.url));
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
        if (asrRes.transcript.trim()) {
          asrTranscript = asrRes.transcript.trim();
          transcriptSourceLabel = `音频自动转写 (${asrRes.engineUsed})`;
        }
      } catch (err) {
        console.warn(`[YouTubeExtractor] Audio ASR fallback warning:`, err);
      }
    }
  }

  const formattedTranscript =
    snippets.length > 0
      ? formatSnippetsWithChapters(snippets, chapters)
      : asrTranscript;

  if (!formattedTranscript && !description.trim() && !watchHtml.trim()) {
    throw new Error(`Failed to extract YouTube video content for ${canonicalUrl}`);
  }

  const durationText = durationSeconds ? formatDurationHms(durationSeconds) : "";
  const mdSections: string[] = [];

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
      `## 完整字幕 / 逐字稿${
        transcriptSourceLabel ? `（${transcriptSourceLabel}）` : ""
      }\n\n${formattedTranscript}`
    );
  } else {
    mdSections.push(
      `> ⚠️ 该视频暂未开放公开字幕轨道，以上为视频元数据与简介摘录。`
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
