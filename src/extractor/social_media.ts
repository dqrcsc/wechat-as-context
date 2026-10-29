import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../config.ts";
import { fetchPublicResource, UnsafeUrlError } from "../public_url.ts";
import {
  extractStructuredTextFromImageCards,
  transcribeAudioFromMedia,
} from "./asr.ts";
import {
  ExtractedWeChatArticle,
  htmlToCleanMarkdownWithImages,
} from "./wechat.ts";
import { formatDurationHms } from "./youtube.ts";

const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MOBILE_IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// ============================================================================
// 1. Medium Deep Article Extractor
// ============================================================================

export function isMediumPaywalledOrTruncated(
  html: string,
  markdownBody: string
): boolean {
  const hasPaywallMarker =
    /Member-only story|Continue reading on Medium|Become a member to read this story|Read this story.*on Medium/i.test(
      html
    ) ||
    /Member-only story|Continue reading on Medium/i.test(markdownBody);
  if (hasPaywallMarker && markdownBody.trim().length < 1800) {
    return true;
  }
  return markdownBody.trim().length < 220;
}

export async function extractMediumArticle(
  url: string,
  fallbackTitle = "",
  fallbackAuthor = "",
  fallbackDigest = "",
  options?: {
    config?: AppConfig;
    allowJinaFallback?: boolean;
    parseHtmlFn: (
      html: string,
      url: string,
      title: string,
      author: string,
      digest: string
    ) => ExtractedWeChatArticle | null;
  }
): Promise<ExtractedWeChatArticle> {
  const parseHtml = options?.parseHtmlFn;
  let bestPartial: ExtractedWeChatArticle | null = null;

  // Step 1: Direct HTTP fetch
  try {
    const resp = await fetchPublicResource(url, {
      headers: {
        "User-Agent": DESKTOP_CHROME_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
    });
    if (resp.ok) {
      const html = await resp.text();
      const parsed = parseHtml?.(
        html,
        url,
        fallbackTitle,
        fallbackAuthor,
        fallbackDigest
      );
      if (parsed) {
        parsed.sourceType = "medium_article";
        if (!isMediumPaywalledOrTruncated(html, parsed.markdownBody)) {
          return parsed;
        }
        bestPartial = parsed;
      }
    }
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    console.warn(`[MediumExtractor] Direct HTTP warning for ${url}:`, err);
  }

  // Step 2: Native macOS Chrome DOM dump with synced session cookies (when not in isolated test sandbox)
  if (!process.env.WXCTX_TEST_ROOT && parseHtml) {
    try {
      const domHtml = renderDomWithLocalChromeSession(url, options?.config);
      if (domHtml && domHtml.length > 400) {
        const parsed = parseHtml(
          domHtml,
          url,
          fallbackTitle,
          fallbackAuthor,
          fallbackDigest
        );
        if (parsed) {
          parsed.sourceType = "medium_article";
          parsed.extractorUsed = "native_chrome_cdp";
          if (!isMediumPaywalledOrTruncated(domHtml, parsed.markdownBody)) {
            return parsed;
          }
          if (
            !bestPartial ||
            parsed.markdownBody.length > bestPartial.markdownBody.length
          ) {
            bestPartial = parsed;
          }
        }
      }
    } catch (err) {
      console.warn(`[MediumExtractor] Local Chrome session warning:`, err);
    }
  }

  // Step 3: Freedium full-text mirror fallback for Member-only Medium stories
  if (parseHtml) {
    try {
      const mirrorUrl = `https://freedium.cfd/${url}`;
      const mirrorResp = await fetchPublicResource(mirrorUrl, {
        headers: {
          "User-Agent": DESKTOP_CHROME_UA,
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(25_000),
      });
      if (mirrorResp.ok) {
        const mirrorHtml = await mirrorResp.text();
        const parsed = parseHtml(
          mirrorHtml,
          url,
          bestPartial?.title || fallbackTitle,
          bestPartial?.author || fallbackAuthor,
          bestPartial?.digest || fallbackDigest
        );
        if (
          parsed &&
          parsed.markdownBody.trim().length >
            Math.max(300, bestPartial?.markdownBody.length ?? 0)
        ) {
          parsed.url = url;
          parsed.sourceType = "medium_article";
          return parsed;
        }
      }
    } catch (err) {
      console.warn(`[MediumExtractor] Freedium fallback warning for ${url}:`, err);
    }
  }

  // Step 4: Return best partial with explicit paywall notice if truncated
  if (bestPartial && bestPartial.markdownBody.trim().length > 80) {
    bestPartial.markdownBody =
      `> ⚠️ **提示**：该 Medium 文章处于会员付费墙（Member-only）保护下，当前抓取到的为公开导览段落。\n\n` +
      bestPartial.markdownBody;
    return bestPartial;
  }

  throw new Error(`Failed to extract Medium article from ${url}`);
}

// ============================================================================
// 2. Xiaohongshu (RED) Dual-Modality Extractor (Image-Carousel OCR + Video ASR)
// ============================================================================

export async function extractXiaohongshuNote(
  rawUrl: string,
  fallbackTitle = "",
  fallbackAuthor = "",
  fallbackDigest = "",
  options?: { config?: AppConfig }
): Promise<ExtractedWeChatArticle> {
  let finalUrl = rawUrl;
  let html = "";

  // Follow xhslink.com short link redirect while preserving xsec_token query params
  try {
    const resp = await fetchPublicResource(rawUrl, {
      headers: {
        "User-Agent": DESKTOP_CHROME_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
    });
    if (resp.url) finalUrl = resp.url;
    if (resp.ok) {
      html = await resp.text();
    }
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    console.warn(`[XHSExtractor] Direct HTTP warning for ${rawUrl}:`, err);
  }

  let noteObj = parseXiaohongshuInitialState(html);

  // Fallback to local Chrome session if SSR state was blocked or empty
  if (!noteObj && !process.env.WXCTX_TEST_ROOT) {
    const domHtml = renderDomWithLocalChromeSession(finalUrl, options?.config);
    if (domHtml) {
      html = domHtml;
      noteObj = parseXiaohongshuInitialState(domHtml);
    }
  }

  const title =
    noteObj?.title ||
    matchMeta(html, "og:title")?.replace(/\s*-\s*小红书$/, "") ||
    fallbackTitle ||
    "小红书笔记";
  const desc =
    noteObj?.desc ||
    matchMeta(html, "og:description") ||
    matchMeta(html, "description") ||
    fallbackDigest ||
    "";
  const author =
    noteObj?.user?.nickname ||
    matchMeta(html, "author") ||
    fallbackAuthor ||
    "小红书博主";

  const publishDate = noteObj?.time
    ? new Date(Number(noteObj.time)).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  // Extract slide images
  const imageUrls: string[] = [];
  if (Array.isArray(noteObj?.imageList)) {
    for (const img of noteObj.imageList) {
      const candidate =
        img?.urlDefault ||
        img?.urlPre ||
        img?.url ||
        img?.infoList?.slice(-1)?.[0]?.url;
      if (typeof candidate === "string" && candidate.startsWith("http")) {
        imageUrls.push(candidate.replace(/^http:\/\//i, "https://"));
      }
    }
  }
  if (imageUrls.length === 0) {
    const ogImgs = matchAllMeta(html, "og:image");
    for (const u of ogImgs) {
      if (u.startsWith("http")) imageUrls.push(u);
    }
  }

  // Detect video stream URL if this is a video note
  const isVideoNote =
    noteObj?.type === "video" ||
    Boolean(noteObj?.video?.media?.stream) ||
    matchMeta(html, "og:type") === "video";

  const videoStreamUrl =
    noteObj?.video?.media?.stream?.h264?.[0]?.masterUrl ||
    noteObj?.video?.media?.stream?.h264?.[0]?.backupUrls?.[0] ||
    noteObj?.video?.media?.stream?.h265?.[0]?.masterUrl ||
    matchMeta(html, "og:video") ||
    "";

  const durationSeconds =
    Number(noteObj?.video?.capa?.duration || 0) || undefined;

  if (!desc.trim() && imageUrls.length === 0 && !videoStreamUrl) {
    throw new Error(`Failed to extract Xiaohongshu note from ${rawUrl}`);
  }

  // Branch A: Xiaohongshu Video Note -> Audio ASR Transcription + Save to 01_inputs/video/
  if (isVideoNote && videoStreamUrl) {
    let transcript = "";
    let engineUsed = "metadata_only";
    try {
      const asrRes = await transcribeAudioFromMedia({
        mediaUrl: videoStreamUrl,
        headers: { Referer: "https://www.xiaohongshu.com/" },
        config: options?.config,
        hintTitle: title,
      });
      transcript = asrRes.transcript.trim();
      engineUsed = asrRes.engineUsed;
    } catch (err) {
      console.warn(`[XHSExtractor] Video ASR warning for ${finalUrl}:`, err);
    }

    const coverUrl = imageUrls[0] || "";
    const sections: string[] = [];
    if (coverUrl) sections.push(`![视频封面](${coverUrl})`);
    if (desc.trim()) sections.push(`## 笔记正文与标签\n\n${desc.trim()}`);
    if (transcript) {
      sections.push(`## 视频口播逐字稿（${engineUsed}）\n\n${transcript}`);
    } else {
      sections.push(`> ⚠️ 暂未提取到口播语音转写稿，以上为笔记原始文案。`);
    }

    return {
      url: finalUrl,
      title: title.trim(),
      author: author.trim(),
      publishDate,
      digest: (desc || transcript).slice(0, 180).replace(/\r?\n/g, " ").trim(),
      markdownBody: sections.join("\n\n"),
      imageUrls: coverUrl ? [coverUrl] : [],
      extractorUsed: "native_http",
      mediaKind: "video",
      sourceType: "xiaohongshu_video",
      durationSeconds,
      durationText: durationSeconds ? formatDurationHms(durationSeconds) : undefined,
      transcriptEngine: engineUsed,
    };
  }

  // Branch B: Xiaohongshu Image-Carousel Note -> Download Images + Vision OCR Card Extraction
  const ocrText = await extractStructuredTextFromImageCards({
    imageUrls,
    noteTitle: title,
    noteDesc: desc,
    refererUrl: "https://www.xiaohongshu.com/",
    config: options?.config,
  });

  const sections: string[] = [];
  if (desc.trim()) {
    sections.push(`## 笔记正文\n\n${desc.trim()}`);
  }
  if (imageUrls.length > 0) {
    sections.push(
      `## 笔记配图（共 ${imageUrls.length} 张）\n\n` +
        imageUrls.map((u, idx) => `![配图 ${idx + 1}](${u})`).join("\n\n")
    );
  }
  if (ocrText.trim()) {
    sections.push(`## 图集卡片内容提取（Vision OCR）\n\n${ocrText.trim()}`);
  }

  return {
    url: finalUrl,
    title: title.trim(),
    author: author.trim(),
    publishDate,
    digest: (desc || ocrText).slice(0, 180).replace(/\r?\n/g, " ").trim(),
    markdownBody: sections.join("\n\n"),
    imageUrls,
    extractorUsed: "native_http",
    mediaKind: "article",
    sourceType: "xiaohongshu_note",
  };
}

function parseXiaohongshuInitialState(html: string): any | null {
  if (!html) return null;
  const marker = "window.__INITIAL_STATE__=";
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const endScript = html.indexOf("</script>", idx);
  if (endScript < 0) return null;
  const rawJs = html
    .slice(idx + marker.length, endScript)
    .trim()
    .replace(/;$/, "")
    .replace(/:\s*undefined\b/g, ":null");
  try {
    const state = JSON.parse(rawJs);
    const detailMap = state?.note?.noteDetailMap;
    if (detailMap && typeof detailMap === "object") {
      for (const key of Object.keys(detailMap)) {
        const note = detailMap[key]?.note;
        if (note && (note.title || note.desc || note.imageList || note.video)) {
          return note;
        }
      }
    }
    const mobileNote = state?.noteData?.data?.noteData;
    if (mobileNote) return mobileNote;
  } catch {}
  return null;
}

// ============================================================================
// 3. Douyin Video & Image-Album Extractor
// ============================================================================

export async function extractDouyinWork(
  rawUrl: string,
  fallbackTitle = "",
  fallbackAuthor = "",
  fallbackDigest = "",
  options?: { config?: AppConfig }
): Promise<ExtractedWeChatArticle> {
  let finalUrl = rawUrl;
  let html = "";

  // Step 1: Resolve short URL (v.douyin.com) with Mobile User-Agent so Douyin serves SSR _ROUTER_DATA
  try {
    const resp = await fetchPublicResource(rawUrl, {
      headers: {
        "User-Agent": MOBILE_IOS_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
    });
    if (resp.url) finalUrl = resp.url;
    if (resp.ok) {
      html = await resp.text();
    }
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    console.warn(`[DouyinExtractor] Mobile fetch warning for ${rawUrl}:`, err);
  }

  const awemeId =
    finalUrl.match(/\/(?:video|note)\/(\d{15,22})/)?.[1] ||
    finalUrl.match(/[?&]modal_id=(\d{15,22})/)?.[1] ||
    rawUrl.match(/\/(?:video|note)\/(\d{15,22})/)?.[1] ||
    "";

  let itemInfo = parseDouyinRouterData(html);

  // Step 2: If initial fetch hit desktop WAF or empty page and we have awemeId, query iesdouyin mobile share page
  if (!itemInfo && awemeId) {
    try {
      const shareUrl = `https://www.iesdouyin.com/share/video/${awemeId}/`;
      const shareResp = await fetchPublicResource(shareUrl, {
        headers: {
          "User-Agent": MOBILE_IOS_UA,
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (shareResp.ok) {
        const shareHtml = await shareResp.text();
        itemInfo = parseDouyinRouterData(shareHtml);
        if (!html) html = shareHtml;
      }
    } catch {}
  }

  // Step 3: Fallback to local Chrome session if still missing
  if (!itemInfo && !process.env.WXCTX_TEST_ROOT) {
    const domHtml = renderDomWithLocalChromeSession(finalUrl, options?.config);
    if (domHtml) {
      html = domHtml;
      itemInfo = parseDouyinRouterData(domHtml);
    }
  }

  const rawDesc =
    itemInfo?.desc ||
    matchMeta(html, "og:title") ||
    matchMeta(html, "description") ||
    fallbackTitle ||
    fallbackDigest ||
    "";
  const title =
    rawDesc
      .split(/\r?\n/)[0]
      ?.replace(/#[^\s#]+/g, "")
      .trim()
      .slice(0, 72) ||
    fallbackTitle ||
    (awemeId ? `抖音视频 (${awemeId})` : "抖音作品");
  const author =
    itemInfo?.author?.nickname ||
    matchMeta(html, "author") ||
    fallbackAuthor ||
    "抖音创作者";
  const publishDate = itemInfo?.create_time
    ? new Date(Number(itemInfo.create_time) * 1000).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const coverUrl =
    itemInfo?.video?.cover?.url_list?.[0] ||
    itemInfo?.video?.origin_cover?.url_list?.[0] ||
    matchMeta(html, "og:image") ||
    "";

  // Extract watermark-free video stream URL (replace playwm with play)
  const rawPlayUrl =
    itemInfo?.video?.play_addr?.url_list?.[0] ||
    matchMeta(html, "og:video") ||
    "";
  const playUrl = rawPlayUrl
    ? rawPlayUrl.replace("/playwm/", "/play/")
    : "";

  const durationSeconds = itemInfo?.video?.duration
    ? Math.round(Number(itemInfo.video.duration) / 1000) ||
      Number(itemInfo.video.duration)
    : undefined;

  // Check if it is a Douyin Image Album (图集)
  const albumImages: string[] = [];
  if (Array.isArray(itemInfo?.images) && itemInfo.images.length > 0) {
    for (const img of itemInfo.images) {
      const u = img?.url_list?.[0];
      if (typeof u === "string" && u.startsWith("http")) {
        albumImages.push(u);
      }
    }
  }

  if (albumImages.length > 0) {
    const ocrText = await extractStructuredTextFromImageCards({
      imageUrls: albumImages,
      noteTitle: title,
      noteDesc: rawDesc,
      refererUrl: "https://www.douyin.com/",
      config: options?.config,
    });
    const sections = [
      rawDesc ? `## 作品文案\n\n${rawDesc}` : "",
      `## 图集配图（共 ${albumImages.length} 张）\n\n` +
        albumImages.map((u, i) => `![配图 ${i + 1}](${u})`).join("\n\n"),
      ocrText ? `## 图集卡片内容提取（Vision OCR）\n\n${ocrText}` : "",
    ].filter(Boolean);

    return {
      url: awemeId ? `https://www.douyin.com/note/${awemeId}` : finalUrl,
      title,
      author,
      publishDate,
      digest: (rawDesc || ocrText).slice(0, 180).replace(/\r?\n/g, " ").trim(),
      markdownBody: sections.join("\n\n"),
      imageUrls: albumImages,
      extractorUsed: "native_http",
      mediaKind: "article",
      sourceType: "douyin_note",
    };
  }

  // Transcribe spoken audio via Local-ASR / Cloud Multimodal Audio
  let transcript = "";
  let engineUsed = "metadata_only";
  if (playUrl) {
    try {
      const asrRes = await transcribeAudioFromMedia({
        mediaUrl: playUrl,
        headers: {
          Referer: "https://www.douyin.com/",
          "User-Agent": MOBILE_IOS_UA,
        },
        config: options?.config,
        hintTitle: title,
      });
      transcript = asrRes.transcript.trim();
      engineUsed = asrRes.engineUsed;
    } catch (err) {
      console.warn(`[DouyinExtractor] Audio ASR warning for ${finalUrl}:`, err);
    }
  }

  if (!rawDesc.trim() && !transcript) {
    throw new Error(`Failed to extract Douyin video content from ${rawUrl}`);
  }

  const canonicalVideoUrl = awemeId
    ? `https://www.douyin.com/video/${awemeId}`
    : finalUrl;

  const sections: string[] = [];
  if (coverUrl) sections.push(`![视频封面](${coverUrl})`);
  if (rawDesc.trim()) sections.push(`## 视频文案与标签\n\n${rawDesc.trim()}`);
  if (transcript) {
    sections.push(`## 视频口播逐字稿（${engineUsed}）\n\n${transcript}`);
  } else {
    sections.push(
      `> ⚠️ 暂未获取到视频音频流或转写结果，以上为视频标题与文案。`
    );
  }

  return {
    url: canonicalVideoUrl,
    title,
    author,
    publishDate,
    digest: (transcript || rawDesc).slice(0, 180).replace(/\r?\n/g, " ").trim(),
    markdownBody: sections.join("\n\n"),
    imageUrls: coverUrl ? [coverUrl] : [],
    extractorUsed: "native_http",
    mediaKind: "video",
    sourceType: "douyin_video",
    durationSeconds,
    durationText: durationSeconds ? formatDurationHms(durationSeconds) : undefined,
    transcriptEngine: engineUsed,
  };
}

function parseDouyinRouterData(html: string): any | null {
  if (!html) return null;
  const marker = "window._ROUTER_DATA =";
  const idx = html.indexOf(marker);
  if (idx >= 0) {
    const endScript = html.indexOf("</script>", idx);
    if (endScript > idx) {
      const rawJson = html
        .slice(idx + marker.length, endScript)
        .trim()
        .replace(/;$/, "");
      try {
        const parsed = JSON.parse(rawJson);
        const loader = parsed?.loaderData;
        if (loader && typeof loader === "object") {
          for (const key of Object.keys(loader)) {
            const item = loader[key]?.videoInfoRes?.item_list?.[0];
            if (item) return item;
          }
        }
      } catch {}
    }
  }

  // Fallback: check RENDER_DATA (URL-encoded JSON in <script id="RENDER_DATA">)
  const renderMatch = html.match(
    /<script[^>]+id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (renderMatch?.[1]) {
    try {
      const decoded = decodeURIComponent(renderMatch[1].trim());
      const parsed = JSON.parse(decoded);
      for (const val of Object.values(parsed) as any[]) {
        if (val?.aweme?.detail) return val.aweme.detail;
        if (val?.videoInfoRes?.item_list?.[0]) {
          return val.videoInfoRes.item_list[0];
        }
      }
    } catch {}
  }
  return null;
}

// ============================================================================
// 4. Native Lock-Safe Local Chrome Session DOM Renderer
// ============================================================================

function renderDomWithLocalChromeSession(
  url: string,
  config?: AppConfig
): string | null {
  if (process.env.WXCTX_TEST_ROOT) return null;
  const chromePaths = [
    process.env.CHROME_BIN || "",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);
  const chromeBin = chromePaths.find((p) => existsSync(p));
  if (!chromeBin) return null;

  // Prepare an isolated shadow profile directory that syncs Cookies from the user's macOS Chrome Default profile
  // so it never collides with a running Chrome instance's SingletonLock.
  const shadowProfileDir = config?.dataDir
    ? join(config.dataDir, "browser_profile")
    : undefined;

  if (shadowProfileDir) {
    try {
      const shadowDefault = join(shadowProfileDir, "Default");
      mkdirSync(shadowDefault, { recursive: true });
      const macChromeRoot = join(
        homedir(),
        "Library",
        "Application Support",
        "Google",
        "Chrome"
      );
      const cookiesSrc = join(macChromeRoot, "Default", "Cookies");
      const cookiesDest = join(shadowDefault, "Cookies");
      if (existsSync(cookiesSrc) && !existsSync(cookiesDest)) {
        cpSync(cookiesSrc, cookiesDest);
      }
    } catch {}
  }

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-agent=${DESKTOP_CHROME_UA}`,
    ...(shadowProfileDir ? [`--user-data-dir=${shadowProfileDir}`] : []),
    "--virtual-time-budget=6000",
    "--dump-dom",
    url,
  ];

  const res = spawnSync(chromeBin, args, {
    encoding: "utf-8",
    timeout: 25_000,
    maxBuffer: 25 * 1024 * 1024,
  });

  if (res.stdout && res.stdout.length > 200) {
    return res.stdout;
  }
  return null;
}

function matchMeta(html: string, nameOrProp: string): string {
  const all = matchAllMeta(html, nameOrProp);
  return all[0] || "";
}

function matchAllMeta(html: string, nameOrProp: string): string[] {
  if (!html) return [];
  const escaped = nameOrProp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const results: string[] = [];
  const regexes = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
      "gi"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`,
      "gi"
    ),
  ];
  for (const r of regexes) {
    let m: RegExpExecArray | null;
    while ((m = r.exec(html)) !== null) {
      if (m[1]?.trim()) {
        results.push(
          m[1]
            .trim()
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
        );
      }
    }
  }
  return results;
}
