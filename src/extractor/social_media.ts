import { declaredSocialPostId, matchingDouyinDetail, pageHasSocialIdentity, requestedSocialPostId, socialPostId, SocialIdentityError } from "./social_identity.ts";
import { CdpSession, waitForDevToolsEndpoint } from "./cdp.ts";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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

  const noteId = requestedSocialPostId(rawUrl, finalUrl, "xiaohongshu");
  let metadataVerified = pageHasSocialIdentity(html, finalUrl, noteId, "xiaohongshu");
  let noteObj = parseXiaohongshuInitialState(html, finalUrl);

  // Fallback to local Chrome session if SSR state was blocked or empty
  if (!noteObj && !process.env.WXCTX_TEST_ROOT) {
    const domHtml = renderDomWithLocalChromeSession(finalUrl, options?.config);
    if (domHtml) {
      html = domHtml;
      metadataVerified = pageHasSocialIdentity(html, finalUrl, noteId, "xiaohongshu");
      noteObj = parseXiaohongshuInitialState(domHtml, finalUrl);
    }
  }

  if (!noteObj && !metadataVerified) throw new SocialIdentityError("Xiaohongshu metadata identity could not be verified");

  const rawTitle =
    noteObj?.title ||
    (!noteObj ? matchMeta(html, "og:title")?.replace(/\s*-\s*小红书$/, "") : "") ||
    fallbackTitle ||
    "小红书笔记";
  const title = rawTitle.replace(/#([^#\[]+)\[话题\]#/g, "#$1").trim();

  const rawDesc =
    noteObj?.desc ||
    (!noteObj ? matchMeta(html, "og:description") : "") ||
    (!noteObj ? matchMeta(html, "description") : "") ||
    fallbackDigest ||
    "";
  const desc = rawDesc.replace(/#([^#\[]+)\[话题\]#/g, "#$1").trim();

  const author =
    noteObj?.user?.nickname ||
    (!noteObj ? matchMeta(html, "author") : "") ||
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
  if (!noteObj && imageUrls.length === 0) {
    const ogImgs = matchAllMeta(html, "og:image");
    for (const u of ogImgs) {
      if (u.startsWith("http")) imageUrls.push(u);
    }
  }

  // Detect video stream URLs if this is a video note
  const candidateVideoUrls: string[] = [];
  const pushXhsVideoUrl = (u: unknown) => {
    if (typeof u !== "string" || !u.startsWith("http")) return;
    const httpsUrl = u.replace(/^http:\/\//i, "https://");
    if (!candidateVideoUrls.includes(httpsUrl)) {
      candidateVideoUrls.push(httpsUrl);
    }
  };
  for (const codec of ["h264", "h265"] as const) {
    const streams = noteObj?.video?.media?.stream?.[codec];
    if (Array.isArray(streams)) {
      for (const s of streams) {
        pushXhsVideoUrl(s?.masterUrl);
        if (Array.isArray(s?.backupUrls)) {
          for (const b of s.backupUrls) pushXhsVideoUrl(b);
        }
      }
    }
  }
  if (!noteObj) pushXhsVideoUrl(matchMeta(html, "og:video"));

  const videoStreamUrl = candidateVideoUrls[0] || "";
  const isVideoNote =
    noteObj?.type === "video" ||
    Boolean(noteObj?.video?.media?.stream) ||
    (!noteObj && matchMeta(html, "og:type") === "video") ||
    Boolean(videoStreamUrl);

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
        mediaUrls: candidateVideoUrls,
        headers: {
          Referer: "https://www.xiaohongshu.com/",
          "User-Agent": DESKTOP_CHROME_UA,
        },
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

function parseXiaohongshuInitialState(html: string, url: string): any | null {
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
  let state: any;
  try { state = JSON.parse(rawJs); } catch { return null; }
  const noteId = socialPostId(url, "xiaohongshu");
  const detailMap = state?.note?.noteDetailMap;
  if (detailMap && typeof detailMap === "object" && Object.keys(detailMap).length) {
    for (const [key, value] of Object.entries(detailMap)) {
      const note = (value as any)?.note;
      // A map key may identify a note lacking an embedded ID; conflicting IDs never match.
      if (noteId && note && (note.noteId || note.note_id || key) === noteId) return note;
    }
    throw new Error("Xiaohongshu note identity mismatch: requested note absent from page state");
  }
  const mobileNote = state?.noteData?.data?.noteData;
  if (mobileNote) {
    if (noteId && (mobileNote.noteId || mobileNote.note_id || mobileNote.id) === noteId) return mobileNote;
    throw new Error("Xiaohongshu mobile note identity could not be verified");
  }
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

  const awemeId = requestedSocialPostId(rawUrl, finalUrl, "douyin");
  let metadataVerified = pageHasSocialIdentity(html, finalUrl, awemeId, "douyin");
  let itemInfo = parseDouyinRouterData(html, awemeId);

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
        requestedSocialPostId(rawUrl, shareResp.url || shareUrl, "douyin");
        const shareVerified = pageHasSocialIdentity(shareHtml, shareResp.url || shareUrl, awemeId, "douyin");
        itemInfo = parseDouyinRouterData(shareHtml, awemeId);
        if (!html || shareVerified) { html = shareHtml; metadataVerified = shareVerified; }
      }
    } catch (err) { if (err instanceof SocialIdentityError) throw err; }
  }

  // Step 3: Fetch rich SEO JSON-LD metadata (creator, duration, uploadDate, creator/top comments)
  const seoMeta =
    !process.env.WXCTX_TEST_ROOT && awemeId
      ? await fetchDouyinSeoVideoObject(awemeId)
      : null;

  // Step 4: Use local headless Chrome CDP to intercept /aweme/v1/web/aweme/detail when SSR _ROUTER_DATA is empty
  if (
    !itemInfo?.video?.play_addr?.url_list?.length &&
    !Array.isArray(itemInfo?.images) &&
    !process.env.WXCTX_TEST_ROOT &&
    awemeId
  ) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cdpRes = await fetchDouyinAwemeDetailViaCdp(awemeId);
      if (cdpRes?.awemeDetail) itemInfo = matchingDouyinDetail(cdpRes.awemeDetail, awemeId);
      if (itemInfo?.video?.play_addr?.url_list?.length || itemInfo?.images?.length) break;
    }
  }

  if (!itemInfo && !seoMeta && !metadataVerified) throw new SocialIdentityError("Douyin content identity could not be verified");
  // Do not supplement an identified object with unrelated page-level media.
  const metadataHtml = !itemInfo && !seoMeta && metadataVerified ? html : "";

  const rawDescUnstripped =
    itemInfo?.desc ||
    seoMeta?.name ||
    matchMeta(metadataHtml, "og:title") ||
    matchMeta(metadataHtml, "description") ||
    fallbackTitle ||
    fallbackDigest ||
    "";
  const rawDesc = rawDescUnstripped
    .replace(/\s*-\s*[^-]+于\d{8}发布在抖音，已经收获了[\s\S]*$/, "")
    .replace(/\s*-\s*抖音$/, "")
    .trim();

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
    seoMeta?.creatorName ||
    matchMeta(metadataHtml, "author") ||
    fallbackAuthor ||
    "抖音创作者";
  const publishDate = itemInfo?.create_time
    ? new Date(Number(itemInfo.create_time) * 1000).toISOString().slice(0, 10)
    : seoMeta?.uploadDate || new Date().toISOString().slice(0, 10);

  const coverUrl =
    itemInfo?.video?.cover?.url_list?.[0] ||
    itemInfo?.video?.origin_cover?.url_list?.[0] ||
    seoMeta?.coverUrl ||
    matchMeta(metadataHtml, "og:image") ||
    "";

  // Extract watermark-free audio/video stream URLs (prioritize lightweight demuxed audio & low-bitrate gears)
  const candidateStreamUrls: string[] = [];
  const pushStreamCandidate = (u: unknown) => {
    if (typeof u !== "string" || !u.startsWith("http")) return;
    const clean = u.replace("/playwm/", "/play/");
    if (!candidateStreamUrls.includes(clean)) {
      candidateStreamUrls.push(clean);
    }
  };

  if (Array.isArray(itemInfo?.video?.bit_rate_audio)) {
    for (const audioGear of itemInfo.video.bit_rate_audio) {
      pushStreamCandidate(audioGear?.audio_meta?.url_list?.main_url);
      pushStreamCandidate(audioGear?.audio_meta?.url_list?.backup_url);
    }
  }
  if (
    itemInfo?.music?.play_url?.url_list?.[0] &&
    (itemInfo?.music?.is_original_sound ||
      itemInfo?.music?. is_original ||
      String(itemInfo?.music?.title || "").includes("原声") ||
      (itemInfo?.author?.uid &&
        itemInfo?.music?.owner_id === itemInfo?.author?.uid))
  ) {
    pushStreamCandidate(itemInfo.music.play_url.url_list[0]);
  }
  if (Array.isArray(itemInfo?.video?.bit_rate)) {
    const sortedGears = [...itemInfo.video.bit_rate].sort(
      (a, b) =>
        Number(a?.play_addr?.data_size || Infinity) -
        Number(b?.play_addr?.data_size || Infinity)
    );
    for (const gear of sortedGears) {
      if (Array.isArray(gear?.play_addr?.url_list)) {
        for (const u of gear.play_addr.url_list) pushStreamCandidate(u);
      }
    }
  }
  if (Array.isArray(itemInfo?.video?.play_addr?.url_list)) {
    for (const u of itemInfo.video.play_addr.url_list) {
      pushStreamCandidate(u);
    }
  }
  const ogVideo = matchMeta(metadataHtml, "og:video");
  if (ogVideo) pushStreamCandidate(ogVideo);
  const playUrl = candidateStreamUrls[0] || "";

  const durationSeconds = itemInfo?.video?.duration
    ? Math.round(Number(itemInfo.video.duration) / 1000) ||
      Number(itemInfo.video.duration)
    : seoMeta?.durationSeconds;

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
        mediaUrls: candidateStreamUrls,
        headers: {
          Referer: "https://www.douyin.com/",
          "User-Agent": DESKTOP_CHROME_UA,
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
  if (seoMeta?.comments && seoMeta.comments.length > 0) {
    sections.push(
      `## 创作者补充与高赞评论\n\n` +
        seoMeta.comments.map((c) => `- ${c}`).join("\n")
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

interface DouyinSeoVideoMeta {
  name?: string;
  creatorName?: string;
  uploadDate?: string;
  durationSeconds?: number;
  coverUrl?: string;
  comments: string[];
}

export async function fetchDouyinSeoVideoObject(
  awemeId: string
): Promise<DouyinSeoVideoMeta | null> {
  try {
    const seoUrl = `https://www.douyin.com/video/${awemeId}`;
    const resp = await fetchPublicResource(seoUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Bytespider; https://zhanzhang.toutiao.com/)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    requestedSocialPostId(seoUrl, resp.url || seoUrl, "douyin");
    return parseDouyinSeoVideoObject(html, awemeId);
  } catch { return null; }
}

export function parseDouyinSeoVideoObject(html: string, awemeId: string): DouyinSeoVideoMeta | null {
  const pageUrl = `https://www.douyin.com/video/${awemeId}`;
  pageHasSocialIdentity(html, pageUrl, awemeId, "douyin");
  const ldMatches = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ),
  ];
  for (const m of ldMatches) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const objects = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.["@graph"]) ? parsed["@graph"] : [parsed];
      for (const data of objects) {
        if (data?.["@type"] === "VideoObject") {
          const references = [data.url, data["@id"], typeof data.mainEntityOfPage === "string" ? data.mainEntityOfPage : data.mainEntityOfPage?.["@id"]].filter((v): v is string => typeof v === "string" && Boolean(v));
          if (!references.length || !references.every(ref => declaredSocialPostId(ref, pageUrl, "douyin") === awemeId)) continue;
          const name =
            typeof data.name === "string"
              ? data.name.replace(/\s*-\s*抖音$/, "").trim()
              : undefined;
          const creatorName =
            typeof data.creator?.name === "string"
              ? data.creator.name.trim()
              : undefined;
          const uploadDate =
            typeof data.uploadDate === "string"
              ? data.uploadDate.slice(0, 10)
              : undefined;
          let durationSeconds: number | undefined;
          if (typeof data.duration === "string") {
            const dm = data.duration.match(
              /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i
            );
            if (dm) {
              const h = Number(dm[1] || 0);
              const min = Number(dm[2] || 0);
              const s = Number(dm[3] || 0);
              const total = h * 3600 + min * 60 + s;
              if (total > 0) durationSeconds = total;
            }
          }
          const coverUrl = Array.isArray(data.thumbnailUrl)
            ? data.thumbnailUrl.find(
                (u: unknown) => typeof u === "string" && u.startsWith("http")
              )
            : undefined;
          const comments: string[] = [];
          if (Array.isArray(data.comment)) {
            for (const c of data.comment.slice(0, 6)) {
              const cAuthor = c?.creator?.name?.trim() || "网友";
              const cText = c?.text?.trim();
              const likes = Number(
                c?.interactionStatistic?.userInteractionCount || 0
              );
              if (cText) {
                const roleTag =
                  creatorName && cAuthor === creatorName
                    ? `**${cAuthor}（作者补充）**`
                    : `**${cAuthor}**${likes > 0 ? `（👍 ${likes}）` : ""}`;
                comments.push(`${roleTag}：${cText}`);
              }
            }
          }
          return {
            name,
            creatorName,
            uploadDate,
            durationSeconds,
            coverUrl,
            comments,
          };
        }
      }
    } catch {}
  }
  return null;
}

async function fetchDouyinAwemeDetailViaCdp(awemeId: string): Promise<{
  awemeDetail: any | null;
} | null> {
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

  const profileDir = mkdtempSync(join(tmpdir(), "wxctx-dy-cdp-"));
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let ws: WebSocket | null = null;
  let cdp: CdpSession | null = null;
  const deadline = AbortSignal.timeout(60_000);

  try {
    proc = Bun.spawn(
      [
        chromeBin,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--mute-audio",
        `--user-agent=${DESKTOP_CHROME_UA}`,
        `--user-data-dir=${profileDir}`,
        "--remote-debugging-port=0",
        "about:blank",
      ],
      { stderr: "pipe", stdout: "ignore" }
    );

    const browserWsUrl = await waitForDevToolsEndpoint(
      proc.stderr as ReadableStream<Uint8Array>,
      AbortSignal.any([deadline, AbortSignal.timeout(12_000)])
    );
    if (!browserWsUrl) return null;

    const baseHttp = browserWsUrl
      .replace(/^ws:\/\//, "http://")
      .replace(/\/devtools\/browser\/.*$/, "");
    let pageWsUrl = "";
    for (let i = 0; i < 15; i++) {
      try {
        const list = (await (await fetch(`${baseHttp}/json/list`, { signal: deadline })).json()) as any[];
        const page = list.find(
          (t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string"
        );
        if (page) {
          pageWsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await Bun.sleep(200);
    }
    if (!pageWsUrl) return null;

    ws = new WebSocket(pageWsUrl);
    cdp = new CdpSession(ws, { signal: deadline });
    await cdp.ready;
    const call = (method: string, params: Record<string, unknown> = {}) => cdp!.call(method, params);

    const detailReqIds = new Set<string>();
    let awemeDetail: any = null;

    ws.addEventListener("message", async (ev) => {
      try {
        const data = JSON.parse(String(ev.data));
        if (["Network.requestWillBeSent", "Network.responseReceived"].includes(data.method)) {
          const url = String(data.params?.request?.url || data.params?.response?.url || "");
          if (url.includes("/aweme/v1/web/aweme/detail") && data.params?.requestId) detailReqIds.add(String(data.params.requestId));
        }
        if (data.method === "Network.loadingFinished" && detailReqIds.delete(String(data.params?.requestId))) {
          const bodyRes = await call("Network.getResponseBody", { requestId: data.params.requestId });
          const detail = parseDouyinCdpBody(bodyRes, awemeId);
          if (detail) awemeDetail = detail;
        }
      } catch {}
    });

    await call("Network.enable");
    await call("Page.enable");
    await call("Page.navigate", {
      url: `https://www.douyin.com/video/${awemeId}`,
    });

    for (let i = 0; i < 50; i++) {
      deadline.throwIfAborted();
      await Bun.sleep(500);
      if (awemeDetail) break;
      if (i === 24 && detailReqIds.size === 0) {
        await call("Page.navigate", {
          url: `https://www.douyin.com/video/${awemeId}`,
        });
      }
    }

    return { awemeDetail };
  } catch (err) {
    console.warn(`[DouyinExtractor] CDP extraction warning for ${awemeId}:`, err);
    return null;
  } finally {
    cdp?.dispose();
    try {
      ws?.close();
    } catch {}
    try {
      proc?.kill();
    } catch {}
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  }
}

export function parseDouyinCdpBody(body: { body?: string; base64Encoded?: boolean } | null, awemeId: string): any | null {
  if (!body?.body) return null;
  try {
    const parsed = JSON.parse(body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body);
    return matchingDouyinDetail(parsed?.aweme_detail, awemeId);
  } catch { return null; }
}

export function parseDouyinRouterData(html: string, awemeId: string): any | null {
  const states: any[] = [];
  const router = html.match(/window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/i);
  if (router) { try { states.push(JSON.parse(router[1].trim().replace(/;$/, ""))); } catch {} }
  const render = html.match(/<script[^>]+id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i);
  if (render) { try { states.push(JSON.parse(decodeURIComponent(render[1].trim()))); } catch {} }
  for (const state of states) {
    const containers = [...Object.values(state?.loaderData || {}), ...Object.values(state || {})] as any[];
    for (const container of containers) {
      const items = container?.videoInfoRes?.item_list;
      const candidates = [container?.aweme?.detail, ...(Array.isArray(items) ? items : [])];
      for (const candidate of candidates) {
        const match = matchingDouyinDetail(candidate, awemeId);
        if (match) return match;
      }
    }
  }
  return null;
}

// ============================================================================
// 4. Native Lock-Safe Local Chrome Session DOM Renderer
// ============================================================================

function renderDomWithLocalChromeSession(
  url: string,
  config?: AppConfig,
  virtualTimeBudgetMs = 6000,
  ephemeralProfile = false
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

  // For Douyin video stream extraction, an ephemeral profile prevents xgplayer from caching MSE support
  // in Local Storage and switching from direct <source src="https://...douyinvod.com/..."> to blob: URLs.
  const profileDir = ephemeralProfile
    ? mkdtempSync(join(tmpdir(), "wxctx-chrome-dom-"))
    : config?.dataDir
      ? join(config.dataDir, "browser_profile")
      : join(homedir(), ".cache", "wechat_as_context_browser_profile");

  try {
    if (!ephemeralProfile) {
      const shadowDefault = join(profileDir, "Default");
      mkdirSync(shadowDefault, { recursive: true });
      for (const lockName of [
        "SingletonLock",
        "SingletonCookie",
        "SingletonSocket",
      ]) {
        try {
          unlinkSync(join(profileDir, lockName));
        } catch {}
      }
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
    }

    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-agent=${DESKTOP_CHROME_UA}`,
      `--user-data-dir=${profileDir}`,
      `--virtual-time-budget=${virtualTimeBudgetMs}`,
      "--dump-dom",
      url,
    ];

    const res = spawnSync(chromeBin, args, {
      encoding: "utf-8",
      timeout: Math.max(45_000, virtualTimeBudgetMs + 35_000),
      maxBuffer: 25 * 1024 * 1024,
    });

    if (res.stdout && res.stdout.length > 200) {
      return res.stdout;
    }
    return null;
  } finally {
    if (ephemeralProfile) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {}
    }
  }
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
