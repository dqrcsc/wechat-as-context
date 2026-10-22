import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeNewFile } from "../storage.ts";
import { fetchPublicResource, UnsafeUrlError } from "../public_url.ts";

export interface ExtractedWeChatArticle {
  url: string;
  title: string;
  author: string;
  publishDate: string;
  digest: string;
  markdownBody: string;
  imageUrls: string[];
  extractorUsed: "native_http" | "native_chrome_cdp" | "jina_reader";
}

const WECHAT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Mac MacWechat/WMPF";

/**
 * 100% Autonomous WeChat Article Extractor (Zero external Skill / CLI dependencies).
 * - Mode 1: Direct WeChat MP HTTP protocol fetch with full headers.
 * - Mode 2: Built-in macOS Chrome headless DOM renderer fallback (if JS execution is required).
 */
export async function extractWeChatArticle(
  url: string,
  fallbackTitle = "",
  fallbackAuthor = "",
  fallbackDigest = ""
): Promise<ExtractedWeChatArticle> {
  // Mode 1: Direct fast HTTP fetch
  try {
    const direct = await tryNativeHttpFetch(
      url,
      fallbackTitle,
      fallbackAuthor,
      fallbackDigest
    );
    if (direct && direct.markdownBody.trim().length > 80) {
      return direct;
    }
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    console.warn(`[Extractor] Native HTTP fetch warning for ${url}:`, err);
  }

  // Mode 2: Autonomous headless Chrome DOM dump (no external CLI/skill required)
  try {
    const chromeRes = tryNativeChromeDomFetch(
      url,
      fallbackTitle,
      fallbackAuthor,
      fallbackDigest
    );
    if (chromeRes && chromeRes.markdownBody.trim().length > 80) {
      return chromeRes;
    }
  } catch (err) {
    console.warn(`[Extractor] Native Chrome fallback warning for ${url}:`, err);
  }

  throw new Error(
    `Failed to extract WeChat article from ${url}. The link may have expired or been deleted.`
  );
}

async function tryNativeHttpFetch(
  url: string,
  fallbackTitle: string,
  fallbackAuthor: string,
  fallbackDigest: string
): Promise<ExtractedWeChatArticle | null> {
  const resp = await fetchPublicResource(url, {
    headers: {
      "User-Agent": WECHAT_USER_AGENT,
      Referer: "https://mp.weixin.qq.com/",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) return null;
  const html = await resp.text();
  return parseWeChatHtmlToArticle(
    html,
    url,
    fallbackTitle,
    fallbackAuthor,
    fallbackDigest,
    "native_http"
  );
}

function tryNativeChromeDomFetch(
  url: string,
  fallbackTitle: string,
  fallbackAuthor: string,
  fallbackDigest: string
): ExtractedWeChatArticle | null {
  const chromePaths = [
    process.env.CHROME_BIN || "",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ].filter(Boolean);
  const chromeBin = chromePaths.find((p) => existsSync(p));
  if (!chromeBin) return null;

  const res = spawnSync(
    chromeBin,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-agent=${WECHAT_USER_AGENT}`,
      "--virtual-time-budget=5000",
      "--dump-dom",
      url,
    ],
    {
      encoding: "utf-8",
      timeout: 25_000,
      maxBuffer: 25 * 1024 * 1024,
    }
  );

  if (!res.stdout || res.stdout.length < 200) return null;
  return parseWeChatHtmlToArticle(
    res.stdout,
    url,
    fallbackTitle,
    fallbackAuthor,
    fallbackDigest,
    "native_chrome_cdp"
  );
}

export function parseWeChatHtmlToArticle(
  html: string,
  url: string,
  fallbackTitle = "",
  fallbackAuthor = "",
  fallbackDigest = "",
  extractorUsed: "native_http" | "native_chrome_cdp" = "native_http"
): ExtractedWeChatArticle | null {
  const ogTitle =
    matchFirst(html, [
      /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i,
      /<h1[^>]*id=["']activity-name["'][^>]*>([\s\S]*?)<\/h1>/i,
      /var\s+msg_title\s*=\s*['"]([^'"]+)['"]/,
    ]) || fallbackTitle;

  const author =
    matchFirst(html, [
      /<a[^>]*id=["']js_name["'][^>]*>([\s\S]*?)<\/a>/i,
      /<meta\s+property=["']og:article:author["']\s+content=["']([^"']+)["']/i,
      /var\s+nickname\s*=\s*htmlDecode\(["']([^"']+)["']\)/,
      /var\s+nickname\s*=\s*["']([^"']+)["']/,
    ]) || fallbackAuthor;

  const digest =
    matchFirst(html, [
      /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i,
      /var\s+msg_desc\s*=\s*htmlDecode\(["']([^"']+)["']\)/,
    ]) || fallbackDigest;

  let publishDate = new Date().toISOString().slice(0, 10);
  const ctMatch =
    html.match(/var\s+ct\s*=\s*["'](\d{10})["']/) ||
    html.match(/create_time\s*:\s*JsDecode\(['"](\d{10})['"]\)/);
  if (ctMatch?.[1]) {
    const d = new Date(Number(ctMatch[1]) * 1000);
    if (!Number.isNaN(d.getTime())) {
      publishDate = d.toISOString().slice(0, 10);
    }
  }

  const jsContentHtml =
    extractDivById(html, "js_content") || extractTagContent(html, "article");
  if (!jsContentHtml) return null;

  const { markdown, imageUrls } = htmlToCleanMarkdownWithImages(jsContentHtml);
  if (!markdown || markdown.trim().length < 40) return null;

  return {
    url,
    title:
      decodeHtmlEntities(stripHtmlTags(ogTitle)).trim() ||
      "Untitled WeChat Article",
    author:
      decodeHtmlEntities(stripHtmlTags(author)).trim() ||
      "WeChat Official Account",
    publishDate,
    digest: decodeHtmlEntities(stripHtmlTags(digest)).trim(),
    markdownBody: markdown,
    imageUrls,
    extractorUsed,
  };
}

function extractDivById(html: string, id: string): string | null {
  const startRegex = new RegExp(`<div[^>]*\\bid=["']${id}["'][^>]*>`, "i");
  const match = startRegex.exec(html);
  if (!match) return null;

  const contentStart = match.index + match[0].length;
  const divTagRegex = /<\/?div\b[^>]*>/gi;
  divTagRegex.lastIndex = contentStart;

  let depth = 1;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = divTagRegex.exec(html)) !== null) {
    if (tagMatch[0].startsWith("</")) {
      depth--;
      if (depth === 0) {
        return html.slice(contentStart, tagMatch.index);
      }
    } else if (!tagMatch[0].endsWith("/>")) {
      depth++;
    }
  }
  return html.slice(contentStart);
}

function extractTagContent(html: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = regex.exec(html);
  return m ? m[1] : null;
}

export function htmlToCleanMarkdown(rawHtml: string): string {
  return htmlToCleanMarkdownWithImages(rawHtml).markdown;
}

export function htmlToCleanMarkdownWithImages(rawHtml: string): {
  markdown: string;
  imageUrls: string[];
} {
  let s = rawHtml;
  const imageUrls: string[] = [];

  // Remove script, style, svg, noscript
  s = s.replace(/<(script|style|svg|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Convert WeChat lazy-loaded images (<img ... data-src="..." ...>)
  s = s.replace(/<img\b[^>]*>/gi, (imgTag) => {
    const srcMatch =
      imgTag.match(/\bdata-src=["']([^"']+)["']/i) ||
      imgTag.match(/\bsrc=["']([^"']+)["']/i);
    if (!srcMatch?.[1] || srcMatch[1].startsWith("data:")) return "";
    const rawUrl = decodeHtmlEntities(srcMatch[1]).trim();
    if (!rawUrl.startsWith("http")) return "";
    imageUrls.push(rawUrl);
    const altMatch = imgTag.match(/\balt=["']([^"']*)["']/i);
    const alt = altMatch?.[1]
      ? decodeHtmlEntities(altMatch[1]).replace(/[\r\n[\]]+/g, " ").trim()
      : "image";
    return `\n\n![${alt || "image"}](${rawUrl})\n\n`;
  });

  // Code blocks (<pre>...</pre>)
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => {
    const codeText = decodeHtmlEntities(
      inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    ).trim();
    return `\n\n\`\`\`\n${codeText}\n\`\`\`\n\n`;
  });

  // Headings h1..h6
  for (let level = 1; level <= 6; level++) {
    const hashes = "#".repeat(level);
    const hRegex = new RegExp(
      `<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`,
      "gi"
    );
    s = s.replace(hRegex, (_m, inner) => {
      const text = decodeHtmlEntities(stripHtmlTags(inner)).trim();
      return text ? `\n\n${hashes} ${text}\n\n` : "";
    });
  }

  // Blockquotes
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) => {
    const lines = decodeHtmlEntities(
      inner
        .replace(/<\/?(p|section|div|br)[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, "")
    )
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return "";
    return `\n\n${lines.map((l) => `> ${l}`).join("\n")}\n\n`;
  });

  // Links
  s = s.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, inner) => {
      const text = decodeHtmlEntities(stripHtmlTags(inner)).trim();
      if (!text) return "";
      if (href.startsWith("javascript:")) return text;
      return `[${text}](${href})`;
    }
  );

  // Bold / Strong
  s = s.replace(
    /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_m, _tag, inner) => {
      const text = stripHtmlTags(inner).trim();
      return text ? `**${text}**` : "";
    }
  );

  // List items
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => {
    const text = decodeHtmlEntities(stripHtmlTags(inner)).trim();
    return text ? `\n- ${text}` : "";
  });

  // Line breaks and block boundaries
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|section|div|tr|ul|ol|table)>/gi, "\n\n");

  // Strip remaining HTML tags
  s = stripHtmlTags(s);
  s = decodeHtmlEntities(s);

  // Normalize whitespace and blank lines
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/^\u00a0+/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { markdown: s, imageUrls };
}

/**
 * Download all WeChat CDN (mmbiz.qpic.cn) images locally with proper WeChat Referer/UA
 * so Markdown viewers (Obsidian, VSCode, AntiGravity) NEVER show "此图片来自微信公众平台 未经允许不可引用".
 */
export async function localizeWeChatImages(params: {
  markdownBody: string;
  articleUrl: string;
  assetsDir: string;
  relativeAssetsPrefix: string;
}): Promise<{ localizedMarkdown: string; downloadedCount: number }> {
  const { markdownBody, articleUrl, assetsDir, relativeAssetsPrefix } = params;
  const imgRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  const matches = Array.from(markdownBody.matchAll(imgRegex));
  if (matches.length === 0) {
    return { localizedMarkdown: markdownBody, downloadedCount: 0 };
  }

  mkdirSync(assetsDir, { recursive: true });
  const urlToLocalRel = new Map<string, string>();
  let downloadedCount = 0;

  // Download concurrently in batches of 5
  const uniqueUrls = Array.from(new Set(matches.map((m) => m[2])));
  const batchSize = 5;

  for (let i = 0; i < uniqueUrls.length; i += batchSize) {
    const batch = uniqueUrls.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (remoteUrl, batchIdx) => {
        const idx = i + batchIdx + 1;
        try {
          const resp = await fetchPublicResource(remoteUrl, {
            signal: AbortSignal.timeout(30_000),
            headers: {
              "User-Agent": WECHAT_USER_AGENT,
              Referer: articleUrl || "https://mp.weixin.qq.com/",
              Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            },
          });
          if (!resp.ok) return;
          const arrayBuf = await resp.arrayBuffer();
          const buf = Buffer.from(arrayBuf);
          if (buf.length < 200) return;

          const ext = detectImageExtension(
            remoteUrl,
            resp.headers.get("content-type") || "",
            buf
          );
          const shortHash = createHash("md5")
            .update(remoteUrl)
            .digest("hex")
            .slice(0, 6);
          const fileName = `img_${String(idx).padStart(2, "0")}_${shortHash}.${ext}`;
          const fullImgPath = join(assetsDir, fileName);
          writeFileSync(fullImgPath, buf);

          urlToLocalRel.set(remoteUrl, `${relativeAssetsPrefix}/${fileName}`);
          downloadedCount++;
        } catch (err) {
          console.warn(`[ImageLocalizer] Failed to download ${remoteUrl}:`, err);
        }
      })
    );
  }

  const localizedMarkdown = markdownBody.replace(
    imgRegex,
    (fullMatch, alt, remoteUrl) => {
      const localRel = urlToLocalRel.get(remoteUrl);
      if (!localRel) return fullMatch;
      return `![${alt}](${localRel})`;
    }
  );

  return { localizedMarkdown, downloadedCount };
}

function detectImageExtension(
  url: string,
  contentType: string,
  buf: Buffer
): string {
  // Check magic bytes first
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif";
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "webp";

  const fmtMatch = url.match(/wx_fmt=([a-zA-Z0-9]+)/);
  if (fmtMatch?.[1]) {
    const f = fmtMatch[1].toLowerCase();
    if (["png", "gif", "webp", "jpg", "jpeg"].includes(f)) {
      return f === "jpeg" ? "jpg" : f;
    }
  }
  if (contentType.includes("png")) return "png";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("webp")) return "webp";
  return "jpg";
}

function matchFirst(text: string, regexes: RegExp[]): string {
  for (const r of regexes) {
    const m = r.exec(text);
    if (m?.[1] && m[1].trim()) {
      return m[1].trim();
    }
  }
  return "";
}

function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/**
 * Save the extracted raw WeChat article and download all its images locally into
 * 01_inputs/articles/wechat/assets/<YYYY_MM_DD_slug>/ so anti-hotlinking never happens.
 */
export async function saveRawArticleToVault(params: {
  wechatArticlesDir: string;
  article: ExtractedWeChatArticle;
  slug: string;
  userNotes?: string;
  existingPath?: string;
}): Promise<string> {
  mkdirSync(params.wechatArticlesDir, { recursive: true });
  const datePrefix = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "_");
  const cleanSlug = sanitizeSlug(params.slug);
  const identity = createHash("sha256").update(params.article.url).digest("hex").slice(0, 16);
  const baseFolderSlug = `${datePrefix}_${cleanSlug}_${identity}`;
  const filename = `${baseFolderSlug}.md`;
  const fullPath = params.existingPath || join(params.wechatArticlesDir, filename);
  if (existsSync(fullPath)) return fullPath;

  // Download all WeChat images locally to bypass mmbiz.qpic.cn Referer anti-hotlinking
  const assetsDir = join(params.wechatArticlesDir, "assets", baseFolderSlug);
  const relativeAssetsPrefix = `assets/${baseFolderSlug}`;
  const { localizedMarkdown } = await localizeWeChatImages({
    markdownBody: params.article.markdownBody,
    articleUrl: params.article.url,
    assetsDir,
    relativeAssetsPrefix,
  });

  const nowDate = new Date().toISOString().slice(0, 10);
  const frontmatterLines = [
    "---",
    "type: source",
    "source_type: wechat_article",
    `title: ${yamlQuote(params.article.title)}`,
    `account_name: ${yamlQuote(params.article.author)}`,
    `source_url: ${yamlQuote(params.article.url)}`,
    `published_date: ${params.article.publishDate}`,
    `captured_date: ${nowDate}`,
    "process_level: raw",
    "triage: process_later",
    "tags:",
    "  - wechat_article",
    "  - input",
    "---",
    "",
    `# ${params.article.title}`,
    "",
    `- **公众号 / 作者**：${params.article.author}`,
    `- **发布时间**：${params.article.publishDate}`,
    `- **捕获时间**：${nowDate}`,
    `- **原始链接**：[原文链接](${params.article.url})`,
  ];

  if (params.userNotes?.trim()) {
    frontmatterLines.push(`- **转发时批注**：${params.userNotes.trim()}`);
  }

  frontmatterLines.push("", "---", "", localizedMarkdown, "");

  writeNewFile(fullPath, frontmatterLines.join("\n"));
  return fullPath;
}

export function sanitizeSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (cleaned.length >= 3) {
    return cleaned.slice(0, 64);
  }
  return `wechat_article_${Date.now().toString(36)}`;
}

export function yamlQuote(val: string): string {
  return JSON.stringify(val.replace(/\r?\n/g, " ").trim());
}
