import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeNewFile } from "../storage.ts";
import {
  ExtractedWeChatArticle,
  htmlToCleanMarkdownWithImages,
  localizeWeChatImages,
  parseWeChatHtmlToArticle,
  sanitizeSlug,
  yamlQuote,
} from "./wechat.ts";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export function isWeChatArticleUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.trim().replace(/&amp;/g, "&"));
    return (
      u.protocol === "https:" &&
      u.hostname === "mp.weixin.qq.com" &&
      /^\/s(?:\/|$)/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

export function normalizeExternalWebUrl(rawUrl: string): string {
  const normalized = rawUrl.trim().replace(/&amp;/g, "&").replace(/[),.;，。；！!]+$/, "");
  const url = new URL(normalized);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Expected an HTTP/HTTPS URL");
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("Private or loopback URLs are not allowed");
  }
  url.hash = "";
  return url.toString();
}

/**
 * Extract any general web article (ArXiv, blogs, Substack, news, X/Twitter via Jina fallback, etc.).
 */
export async function extractGeneralWebArticle(
  url: string,
  fallbackTitle = "",
  fallbackAuthor = "",
  fallbackDigest = ""
): Promise<ExtractedWeChatArticle> {
  if (isWeChatArticleUrl(url)) {
    const { extractWeChatArticle } = await import("./wechat.ts");
    return extractWeChatArticle(url, fallbackTitle, fallbackAuthor, fallbackDigest);
  }

  // Mode 1: Direct HTML fetch & semantic container extraction
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
    });
    if (resp.ok) {
      const html = await resp.text();
      const parsed = parseGeneralHtmlToArticle(
        html,
        url,
        fallbackTitle,
        fallbackAuthor,
        fallbackDigest
      );
      if (parsed && parsed.markdownBody.trim().length > 120) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn(`[WebExtractor] Direct HTTP fetch warning for ${url}:`, err);
  }

  // Mode 2: Jina Reader API fallback for JS-heavy pages (X/Twitter, SPAs)
  try {
    const jinaResp = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        Accept: "text/plain",
        "X-Return-Format": "markdown",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (jinaResp.ok) {
      const text = await jinaResp.text();
      if (text && text.trim().length > 100) {
        const titleMatch = text.match(/^Title:\s*(.+)$/m);
        const title = titleMatch?.[1]?.trim() || fallbackTitle || new URL(url).hostname;
        const bodyStart = text.indexOf("Markdown Content:");
        const markdownBody =
          bodyStart >= 0
            ? text.slice(bodyStart + "Markdown Content:".length).trim()
            : text.trim();
        return {
          url,
          title,
          author: fallbackAuthor || new URL(url).hostname,
          publishDate: new Date().toISOString().slice(0, 10),
          digest: fallbackDigest || markdownBody.slice(0, 180).replace(/\r?\n/g, " "),
          markdownBody,
          imageUrls: [],
          extractorUsed: "native_http",
        };
      }
    }
  } catch (err) {
    console.warn(`[WebExtractor] Jina fallback warning for ${url}:`, err);
  }

  throw new Error(`Failed to extract web page content from ${url}`);
}

export function parseGeneralHtmlToArticle(
  html: string,
  url: string,
  fallbackTitle = "",
  fallbackAuthor = "",
  fallbackDigest = ""
): ExtractedWeChatArticle | null {
  // If it happens to have WeChat structure, delegate
  const wechatParsed = parseWeChatHtmlToArticle(
    html,
    url,
    fallbackTitle,
    fallbackAuthor,
    fallbackDigest
  );
  if (wechatParsed) return wechatParsed;

  const title =
    matchMeta(html, [
      /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i,
      /<meta\s+name=["']twitter:title["']\s+content=["']([^"']+)["']/i,
      /<title[^>]*>([\s\S]*?)<\/title>/i,
      /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    ]) ||
    fallbackTitle ||
    new URL(url).hostname;

  const author =
    matchMeta(html, [
      /<meta\s+name=["']author["']\s+content=["']([^"']+)["']/i,
      /<meta\s+property=["']og:site_name["']\s+content=["']([^"']+)["']/i,
    ]) ||
    fallbackAuthor ||
    new URL(url).hostname;

  const digest =
    matchMeta(html, [
      /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i,
      /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i,
    ]) || fallbackDigest;

  // Strip nav/header/footer/aside before converting
  const cleanedHtml = html
    .replace(/<(script|style|svg|noscript|nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, "");

  const mainRegion =
    extractRegion(cleanedHtml, "article") ||
    extractRegion(cleanedHtml, "main") ||
    extractRegion(cleanedHtml, "body") ||
    cleanedHtml;

  const { markdown, imageUrls } = htmlToCleanMarkdownWithImages(mainRegion);
  if (!markdown || markdown.trim().length < 60) return null;

  return {
    url,
    title: stripTags(title).trim() || "Web Article",
    author: stripTags(author).trim() || new URL(url).hostname,
    publishDate: new Date().toISOString().slice(0, 10),
    digest: stripTags(digest).trim(),
    markdownBody: markdown,
    imageUrls,
    extractorUsed: "native_http",
  };
}

export async function saveRawWebArticleToVault(params: {
  articlesDir: string;
  article: ExtractedWeChatArticle;
  slug: string;
  userNotes?: string;
  existingPath?: string;
}): Promise<string> {
  mkdirSync(params.articlesDir, { recursive: true });
  const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "_");
  const cleanSlug = sanitizeSlug(params.slug);
  const identity = createHash("sha256").update(params.article.url).digest("hex").slice(0, 16);
  const baseFolderSlug = `${datePrefix}_${cleanSlug}_${identity}`;
  const fullPath = params.existingPath || join(params.articlesDir, `${baseFolderSlug}.md`);
  if (existsSync(fullPath)) return fullPath;

  const assetsDir = join(params.articlesDir, "assets", baseFolderSlug);
  const relativeAssetsPrefix = `assets/${baseFolderSlug}`;
  const { localizedMarkdown } = await localizeWeChatImages({
    markdownBody: params.article.markdownBody,
    articleUrl: params.article.url,
    assetsDir,
    relativeAssetsPrefix,
  });

  const nowDate = new Date().toISOString().slice(0, 10);
  const isWeChat = isWeChatArticleUrl(params.article.url);
  const sourceType = isWeChat ? "wechat_article" : "web_article";

  const lines = [
    "---",
    "type: source",
    `source_type: ${sourceType}`,
    `title: ${yamlQuote(params.article.title)}`,
    `account_name: ${yamlQuote(params.article.author)}`,
    `source_url: ${yamlQuote(params.article.url)}`,
    `published_date: ${params.article.publishDate}`,
    `captured_date: ${nowDate}`,
    "process_level: raw",
    "triage: process_later",
    "tags:",
    `  - ${sourceType}`,
    "  - input",
    "---",
    "",
    `# ${params.article.title}`,
    "",
    `- **来源 / 作者**：${params.article.author}`,
    `- **发布时间**：${params.article.publishDate}`,
    `- **捕获时间**：${nowDate}`,
    `- **原始链接**：[原文链接](${params.article.url})`,
    ...(params.userNotes?.trim() ? [`- **转发时批注**：${params.userNotes.trim()}`] : []),
    "",
    "---",
    "",
    localizedMarkdown,
    "",
  ];

  writeNewFile(fullPath, lines.join("\n"));
  return fullPath;
}

function matchMeta(html: string, regexes: RegExp[]): string {
  for (const r of regexes) {
    const m = r.exec(html);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return "";
}

function extractRegion(html: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = regex.exec(html);
  return m ? m[1] : null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}
