export type SourcePlatform =
  | "wechat_mp"
  | "medium"
  | "youtube"
  | "xiaohongshu"
  | "douyin"
  | "general_web";

export interface SanitizedShareInput {
  url?: string;
  platform: SourcePlatform;
  userNotes: string;
  extractedTitle: string;
  wasShareBoilerplateStripped: boolean;
}

const KNOWN_MEDIUM_DOMAINS = new Set([
  "medium.com",
  "towardsdatascience.com",
  "betterprogramming.pub",
  "levelup.gitconnected.com",
  "javascript.plainenglish.io",
  "python.plainenglish.io",
  "ai.plainenglish.io",
  "aws.plainenglish.io",
  "itnext.io",
  "uxdesign.cc",
  "blog.devops.dev",
  "codeburst.io",
  "hackernoon.com",
]);

/**
 * Extract clean HTTP(S) URLs from mixed Chinese/English text without swallowing
 * adjacent Chinese commas, brackets, or share-token suffixes.
 */
export function extractUrlsFromMixedText(rawText: string): string[] {
  if (!rawText) return [];
  // Stop URL matching at whitespace, quotes, angle brackets, backslashes, or any CJK / fullwidth character
  const matches =
    rawText.match(
      /https?:\/\/[^\s"'<>\\\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]+/gi
    ) ?? [];

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const cleaned = raw
      .replace(/&amp;/g, "&")
      .replace(/[),.;!?:]+$/g, "")
      .trim();
    if (!cleaned || !/^https?:\/\/[a-z0-9.-]+/i.test(cleaned)) continue;
    if (
      cleaned.includes("novac2c.cdn.weixin.qq.com") ||
      cleaned.includes("wxapp.tc.qq.com") ||
      cleaned.includes("mmbiz.qpic.cn")
    ) {
      continue;
    }
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      urls.push(cleaned);
    }
  }
  return urls;
}

/**
 * Detect the source platform from a URL (and optional HTML content hints).
 */
export function detectSourcePlatform(
  rawUrl: string,
  htmlHint?: string
): SourcePlatform {
  try {
    const u = new URL(rawUrl.trim().replace(/&amp;/g, "&"));
    const host = u.hostname.toLowerCase();

    if (
      u.protocol === "https:" &&
      host === "mp.weixin.qq.com" &&
      /^\/s(?:\/|$)/.test(u.pathname)
    ) {
      return "wechat_mp";
    }

    if (
      host === "youtu.be" ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com")
    ) {
      return "youtube";
    }

    if (
      host === "xhslink.com" ||
      host === "xiaohongshu.com" ||
      host.endsWith(".xiaohongshu.com")
    ) {
      return "xiaohongshu";
    }

    if (
      host === "v.douyin.com" ||
      host === "douyin.com" ||
      host.endsWith(".douyin.com") ||
      host === "iesdouyin.com" ||
      host.endsWith(".iesdouyin.com")
    ) {
      return "douyin";
    }

    if (
      KNOWN_MEDIUM_DOMAINS.has(host) ||
      host.endsWith(".medium.com")
    ) {
      return "medium";
    }
  } catch {
    // Fall through to HTML hint check
  }

  if (
    htmlHint &&
    (/<meta\s+property=["']al:ios:app_name["']\s+content=["']Medium["']/i.test(
      htmlHint
    ) ||
      /<meta\s+name=["']twitter:app:name:iphone["']\s+content=["']Medium["']/i.test(
        htmlHint
      ) ||
      htmlHint.includes("cdn-client.medium.com"))
  ) {
    return "medium";
  }

  return "general_web";
}

/**
 * Return a human-readable Chinese label + emoji for a source platform.
 */
export function getPlatformDisplayLabel(platform: SourcePlatform): string {
  switch (platform) {
    case "wechat_mp":
      return "公众号文章";
    case "medium":
      return "Medium 深度文章";
    case "youtube":
      return "YouTube 视频";
    case "xiaohongshu":
      return "小红书笔记";
    case "douyin":
      return "抖音视频";
    default:
      return "网页链接";
  }
}

/**
 * Strip platform auto-generated share boilerplate (Douyin, Xiaohongshu, Bilibili, etc.)
 * so that:
 * 1) The URL is cleanly isolated without trailing Chinese text;
 * 2) Share token boilerplate is NOT mistaken for a user annotation (preserving the 10s voice annotation window);
 * 3) Any genuine user commentary is preserved.
 */
export function sanitizeSharedLinkMessage(
  rawText: string,
  explicitUrl?: string
): SanitizedShareInput {
  const urls = extractUrlsFromMixedText(rawText);
  const targetUrl = explicitUrl
    ? extractUrlsFromMixedText(explicitUrl)[0] || explicitUrl.trim()
    : urls[0];

  const platform = targetUrl
    ? detectSourcePlatform(targetUrl)
    : "general_web";

  if (!targetUrl) {
    return {
      url: undefined,
      platform: "general_web",
      userNotes: rawText.trim(),
      extractedTitle: "",
      wasShareBoilerplateStripped: false,
    };
  }

  let remaining = rawText;
  for (const u of urls) {
    remaining = remaining.replace(u, " ");
  }
  remaining = remaining.replace(targetUrl, " ");

  let extractedTitle = "";
  let wasBoilerplate = false;

  // 1. Douyin share boilerplate detection & title extraction
  // Example: "4.89 复制打开抖音，看看【AGI前沿的作品】大模型Agent记忆架构拆解 #AI #大模型 https://v.douyin.com/iYabc/ 08/21 u@s.EH :8pm"
  if (
    platform === "douyin" ||
    /复制打开抖音|打开抖音，看看|复制此链接，打开抖音/.test(remaining)
  ) {
    const urlIdx = rawText.indexOf(targetUrl);
    const beforeUrl = urlIdx >= 0 ? rawText.slice(0, urlIdx) : remaining;
    const afterUrl =
      urlIdx >= 0 ? rawText.slice(urlIdx + targetUrl.length) : "";

    const dyCreatorAndCaption = beforeUrl.match(
      /看看【([^】]+)】\s*([\s\S]*?)$/
    );
    if (dyCreatorAndCaption) {
      wasBoilerplate = true;
      const caption = dyCreatorAndCaption[2]
        ?.replace(/#\s*[^\s#]+/g, "")
        .replace(/\b\d{2}\/\d{2}\b.*$/g, "")
        .replace(/[a-zA-Z0-9]+@[a-zA-Z0-9.]+\s*(?::\d+[a-z]+)?/g, "")
        .trim();
      if (caption) {
        extractedTitle = caption.slice(0, 80);
      }
      remaining = afterUrl
        .replace(
          /^\s*\b\d{2}\/\d{2}\b(?:\s+[A-Za-z0-9@._:/-]+){1,4}\s*/g,
          ""
        )
        .replace(
          /\b\d{2}\/\d{2}\b(?:\s+[A-Za-z0-9@._:/-]+){1,4}\s*$/g,
          ""
        )
        .trim();
    } else {
      const beforeStrip = remaining;
      remaining = remaining
        .replace(/^\s*\d+\.\d+\s+[A-Za-z0-9@/:._\s]*?(?=复制|打开|$)/g, "")
        .replace(/复制打开抖音[^。！!]*[。！!]?/g, "")
        .replace(/复制此链接，打开抖音[^。！!]*[。！!]?/g, "")
        .replace(/看看【[^】]+】/g, "")
        .replace(
          /\b\d{2}\/\d{2}\b(?:\s+[A-Za-z0-9@._:/-]+){1,4}\s*/g,
          ""
        )
        .trim();
      if (remaining !== beforeStrip) wasBoilerplate = true;
    }
  }

  // 2. Xiaohongshu share boilerplate detection
  // Example: "67 AI研究员发布了一篇小红书笔记，快来看吧！ 😆 abc12345 😆 http://xhslink.com/a/xyz，复制本条信息，打开【小红书】App查看精彩内容！"
  if (
    platform === "xiaohongshu" ||
    /发布了一篇小红书笔记|打开【小红书】App|复制本条信息|小红书\s*-\s*你的生活/.test(
      remaining
    )
  ) {
    const beforeStrip = remaining;
    // Extract optional bracketed title if XHS shared with title
    const xhsTitleMatch = remaining.match(/【([^】]{2,120})】/);
    if (xhsTitleMatch?.[1] && xhsTitleMatch[1] !== "小红书") {
      extractedTitle = xhsTitleMatch[1]
        .replace(/\s*\|\s*小红书.*$/, "")
        .replace(/\s*-\s*[^-|]+$/, "")
        .trim();
    }
    remaining = remaining
      .replace(/^\s*\d+\s+/g, "")
      .replace(/[^\n，,！!]*?发布了一篇小红书笔记(?:[，,]\s*快来看吧[！!]?)?\s*/g, "")
      .replace(/😆\s*[A-Za-z0-9_-]{3,25}\s*😆/g, "")
      .replace(/😆/g, "")
      .replace(/[，,。.\s]*复制本条信息[，,]\s*打开【小红书】App查看精彩内容[！!]?/g, "")
      .replace(/小红书[，,\s-]*你的生活(?:指南|兴趣社区)/g, "")
      .trim();
    if (remaining !== beforeStrip || xhsTitleMatch) {
      wasBoilerplate = true;
      // If only the extracted bracketed title remains, treat it as title rather than user note
      if (
        xhsTitleMatch?.[0] &&
        (remaining === xhsTitleMatch[0] ||
          remaining === xhsTitleMatch[1] ||
          remaining === extractedTitle)
      ) {
        remaining = "";
      }
    }
  }

  // 3. Bilibili / YouTube bracketed title prefix when shared via mobile share sheet
  const bracketTitleOnly = remaining.match(/^\s*【([^】]{4,100})】\s*$/);
  if (bracketTitleOnly) {
    extractedTitle = extractedTitle || bracketTitleOnly[1].trim();
    remaining = "";
    wasBoilerplate = true;
  }

  // Clean stray punctuation left over after URL removal
  const cleanedNotes = remaining
    .replace(/^[，,。.;；:：!！?？\s]+|[，,。.;；:：\s]+$/g, "")
    .trim();

  return {
    url: targetUrl,
    platform,
    userNotes: cleanedNotes,
    extractedTitle,
    wasShareBoilerplateStripped: wasBoilerplate,
  };
}
