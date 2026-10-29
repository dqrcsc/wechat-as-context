import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sanitizeSlug, yamlQuote } from "../extractor/wechat.ts";
import { createHash, randomUUID } from "node:crypto";
import { replaceFileAtomically, writeNewFile } from "../storage.ts";
import { TriageLevel } from "../db.ts";
import type { AppConfig } from "../config.ts";
import { prepareMarkdownExport, isUsablePdf } from "../agent/doc_exporter.ts";

export interface VaultMatch {
  wikiLink: string;
  relativePath: string;
  absolutePath: string;
  excerpt: string;
  hitCount: number;
}

export interface VaultContextSnapshot {
  nowSummary: string;
  queueSummary: string;
  topicsOverview: string;
  matchedNotes: VaultMatch[];
}

export interface VaultContextExclusions {
  excludePaths?: string[];
  excludeSourceUrls?: string[];
}

export interface VaultContextOptions extends VaultContextExclusions {
  nowFile?: string;
  queueFile?: string;
  topicsFile?: string;
  searchDirs?: string[];
  domainKeywords?: string[];
}

const IGNORED_VAULT_DIRS = new Set([
  ".git",
  ".obsidian",
  ".trash",
  ".vscode",
  ".idea",
  "node_modules",
  "data",
  "assets",
  "dist",
]);

interface CachedVaultMarkdown {
  mtimeMs: number;
  size: number;
  rawContent: string;
  lowerContent: string;
  strippedBody: string;
}

const MAX_VAULT_CACHE_ENTRIES = 4000;
const vaultMarkdownCache = new Map<string, CachedVaultMarkdown>();
let vaultCacheHits = 0;
let vaultCacheMisses = 0;

export function getVaultCacheStats(): {
  size: number;
  hits: number;
  misses: number;
} {
  return {
    size: vaultMarkdownCache.size,
    hits: vaultCacheHits,
    misses: vaultCacheMisses,
  };
}

export function clearVaultMarkdownCache(): void {
  vaultMarkdownCache.clear();
  vaultCacheHits = 0;
  vaultCacheMisses = 0;
}

function getCachedVaultMarkdown(filePath: string): CachedVaultMarkdown | null {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    const existing = vaultMarkdownCache.get(filePath);
    if (
      existing &&
      existing.mtimeMs === st.mtimeMs &&
      existing.size === st.size
    ) {
      vaultCacheHits++;
      return existing;
    }
    vaultCacheMisses++;
    const rawContent = readFileSync(filePath, "utf-8");
    const strippedBody = rawContent
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "")
      .trim();
    const entry: CachedVaultMarkdown = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      rawContent,
      lowerContent: rawContent.toLowerCase(),
      strippedBody,
    };
    if (vaultMarkdownCache.size >= MAX_VAULT_CACHE_ENTRIES) {
      const oldestKey = vaultMarkdownCache.keys().next().value;
      if (oldestKey) vaultMarkdownCache.delete(oldestKey);
    }
    vaultMarkdownCache.set(filePath, entry);
    return entry;
  } catch {
    return null;
  }
}

function resolveFirstExistingFile(vaultRoot: string, candidates: string[]): string {
  for (const c of candidates) {
    if (!c) continue;
    const full = isAbsolute(c) ? c : join(vaultRoot, c);
    if (existsSync(full)) return full;
  }
  return join(vaultRoot, candidates[0] || "00_home/now.md");
}

export function gatherVaultContext(
  vaultRoot: string,
  searchContent: string,
  options?: VaultContextOptions
): VaultContextSnapshot {
  const nowPath = resolveFirstExistingFile(vaultRoot, [
    options?.nowFile || "00_home/now.md",
    "now.md",
    "FOCUS.md",
    "README.md",
  ]);
  const queuePath = resolveFirstExistingFile(vaultRoot, [
    options?.queueFile || "00_home/queue.md",
    "queue.md",
    "TODO.md",
  ]);
  const topicsPath = resolveFirstExistingFile(vaultRoot, [
    options?.topicsFile || "00_home/topics.md",
    "topics.md",
    "INDEX.md",
  ]);

  const isExcluded = createContextExclusion(vaultRoot, options);
  const readContext = (path: string, limit: number) => {
    if (isExcluded(path)) return "";
    const cached = getCachedVaultMarkdown(path);
    return cached && !isExcluded(path, cached.rawContent) ? safeReadExcerpt(path, limit) : "";
  };
  const nowSummary = readContext(nowPath, 2400);
  const queueSummary = readContext(queuePath, 2000);
  const topicsOverview = readContext(topicsPath, 1800);

  const dynamicFocusTerms = extractDynamicFocusTerms(
    [nowSummary, topicsOverview].filter(Boolean).join("\n"),
    options?.domainKeywords
  );
  const keywords = extractSearchKeywords(searchContent, dynamicFocusTerms);
  const matchedNotes = searchVaultNotes(vaultRoot, keywords, 6, options?.searchDirs, options);

  return {
    nowSummary,
    queueSummary,
    topicsOverview,
    matchedNotes,
  };
}

function safeReadExcerpt(filePath: string, maxChars: number): string {
  const cached = getCachedVaultMarkdown(filePath);
  if (!cached) return "";
  const stripped = cached.strippedBody;
  return stripped.length > maxChars
    ? stripped.slice(0, maxChars) + "\n...(truncated)"
    : stripped;
}

function extractDynamicFocusTerms(
  focusText: string,
  configuredKeywords?: string[]
): string[] {
  const terms = new Set<string>();
  for (const kw of configuredKeywords ?? []) {
    const trimmed = kw.trim();
    if (trimmed.length >= 2) terms.add(trimmed);
  }
  if (!focusText) return Array.from(terms);

  // Extract [[WikiLinks]] and **bold** terms from user's now.md / topics.md
  const wikiMatches = focusText.match(/\[\[([^\]|#]+)\]\]/g) ?? [];
  for (const wm of wikiMatches.slice(0, 15)) {
    const inner = wm.slice(2, -2).trim();
    if (inner.length >= 2 && inner.length <= 24) terms.add(inner);
  }
  const boldMatches = focusText.match(/\*\*([^*\r\n]{2,20})\*\*/g) ?? [];
  for (const bm of boldMatches.slice(0, 15)) {
    const inner = bm.slice(2, -2).trim();
    if (inner.length >= 2) terms.add(inner);
  }
  return Array.from(terms);
}

export function extractSearchKeywords(
  text: string,
  extraDomainTerms?: string[]
): string[] {
  const keywords = new Set<string>();
  const lower = text.toLowerCase();

  // 0. User-configured or dynamically extracted focus terms from their own vault
  for (const customTerm of extraDomainTerms ?? []) {
    const clean = customTerm.trim();
    if (clean.length >= 2 && lower.includes(clean.toLowerCase())) {
      keywords.add(clean.toLowerCase());
    }
  }

  // 1. High-signal English domain terms
  const domainTerms = [
    "agent",
    "harness",
    "loop",
    "memory",
    "context",
    "rag",
    "ontology",
    "evaluation",
    "eval",
    "hallucination",
    "prompt",
    "reasoning",
    "cot",
    "tool",
    "mcp",
    "skill",
    "knowledge",
    "world model",
    "observability",
    "verification",
  ];
  for (const term of domainTerms) {
    if (lower.includes(term)) keywords.add(term);
  }

  // 2. High-signal Chinese domain terms
  const zhTerms = [
    "智能体",
    "上下文",
    "记忆",
    "知识库",
    "知识工程",
    "本体",
    "评测",
    "评估",
    "幻觉",
    "推理",
    "世界模型",
    "可观测",
    "验证",
    "工作流",
    "检索",
    "提示词",
    "认知",
    "人机协作",
    "组织",
    "底座",
  ];
  for (const term of zhTerms) {
    if (text.includes(term)) keywords.add(term);
  }

  // 3. Extract capitalized English words or 3-18 char terms from the first 400 chars
  const head = text.slice(0, 400);
  const enWords = head.match(/\b[A-Za-z][A-Za-z0-9_-]{2,18}\b/g) ?? [];
  for (const w of enWords.slice(0, 8)) {
    const lw = w.toLowerCase();
    if (
      ![
        "http",
        "https",
        "weixin",
        "wechat",
        "html",
        "from",
        "with",
        "that",
        "this",
        "the",
        "and",
        "for",
      ].includes(lw)
    ) {
      keywords.add(lw);
    }
  }

  // 4. Extract meaningful Chinese words and phrases (2-6 chars) using Intl.Segmenter + phrase fallback
  const cleanedHead = head.replace(
    /(?:请问|查一下|搜一下|帮我找|我的知识库|关于|是什么|有哪些|怎么|如何)/g,
    " "
  );
  const zhStopwords = new Set([
    "想法",
    "灵感",
    "观点",
    "文章",
    "笔记",
    "今天",
    "这个",
    "那个",
    "我们",
    "可以",
    "一个",
    "一些",
    "进行",
    "通过",
    "以及",
    "或者",
    "因为",
    "所以",
    "如果",
    "但是",
    "没有",
    "已经",
  ]);
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
      const wordTokens: string[] = [];
      for (const seg of segmenter.segment(cleanedHead)) {
        const w = seg.segment.trim();
        if (seg.isWordLike && /^[\u4e00-\u9fa5]{2,6}$/.test(w) && !zhStopwords.has(w)) {
          wordTokens.push(w);
        }
      }
      for (let i = 0; i < wordTokens.length && keywords.size < 14; i++) {
        keywords.add(wordTokens[i]);
        if (i + 1 < wordTokens.length) {
          const compound = `${wordTokens[i]}${wordTokens[i + 1]}`;
          if (compound.length >= 3 && compound.length <= 6) {
            keywords.add(compound);
          }
        }
      }
    } catch {}
  }
  const zhPhrases = cleanedHead.match(/[\u4e00-\u9fa5]{2,6}/g) ?? [];
  for (const p of zhPhrases.slice(0, 6)) {
    if (!zhStopwords.has(p)) {
      keywords.add(p);
    }
  }

  return Array.from(keywords).slice(0, 16);
}

function resolveCandidateDirs(
  vaultRoot: string,
  preferredRelDirs: string[],
  customSearchDirs?: string[]
): string[] {
  const dirs: string[] = [];
  if (customSearchDirs && customSearchDirs.length > 0) {
    for (const d of customSearchDirs) {
      const full = isAbsolute(d) ? d : join(vaultRoot, d);
      if (existsSync(full)) dirs.push(full);
    }
  }
  for (const rel of preferredRelDirs) {
    const full = join(vaultRoot, rel);
    if (existsSync(full) && !dirs.includes(full)) {
      dirs.push(full);
    }
  }
  // Fallback for standard Obsidian / Logseq / arbitrary Markdown vaults that don't use 00_home..05_outputs
  if (dirs.length === 0 && existsSync(vaultRoot)) {
    dirs.push(vaultRoot);
  }
  return dirs;
}

export function searchVaultNotes(
  vaultRoot: string,
  keywords: string[],
  limit = 6,
  customSearchDirs?: string[],
  exclusions?: VaultContextExclusions
): VaultMatch[] {
  if (!existsSync(vaultRoot) || keywords.length === 0) return [];

  const targetDirs = resolveCandidateDirs(
    vaultRoot,
    [
      "04_topics",
      "03_ideas",
      "05_outputs",
      "01_inputs",
      "_system",
    ],
    customSearchDirs
  );

  if (targetDirs.length === 0) return [];

  const mdFiles: string[] = [];
  for (const dir of targetDirs) {
    collectMarkdownFiles(dir, mdFiles);
  }

  const lowerKeywords = keywords.map((k) => k.toLowerCase());
  const scored: Array<{ filePath: string; count: number }> = [];
  const isExcluded = createContextExclusion(vaultRoot, exclusions);

  for (const filePath of mdFiles) {
    try {
      if (isExcluded(filePath)) continue;
      const relFromRoot = relative(vaultRoot, filePath).replace(/\\/g, "/");
      if (
        relFromRoot.startsWith("00_home/") ||
        ["now.md", "queue.md", "topics.md"].includes(relFromRoot.toLowerCase())
      ) {
        continue;
      }
      const cached = getCachedVaultMarkdown(filePath);
      if (!cached || isExcluded(filePath, cached.rawContent)) continue;
      const content = cached.lowerContent;
      const fileNameLower = basename(filePath, ".md").toLowerCase();
      let score = 0;

      for (const kw of lowerKeywords) {
        if (fileNameLower.includes(kw)) {
          score += 6;
        }
        let idx = 0;
        let occurrences = 0;
        while ((idx = content.indexOf(kw, idx)) !== -1 && occurrences < 15) {
          occurrences++;
          idx += kw.length;
        }
        score += occurrences;
      }

      if (score > 0) {
        // Boost compiled synthesis layers (04_topics, 05_outputs/research_notes) over raw clippings
        if (relFromRoot.startsWith("04_topics/") || relFromRoot.startsWith("05_outputs/research_notes/")) {
          score += 4;
        }
        // Downweight append-only operational logs (_system/log.md) so they don't crowd out topical notes
        if (relFromRoot === "_system/log.md" || fileNameLower === "log") {
          score = Math.max(1, Math.floor(score * 0.25));
        }
        scored.push({ filePath, count: score });
      }
    } catch {}
  }

  scored.sort((a, b) => b.count - a.count);

  const matches: VaultMatch[] = [];
  for (const item of scored.slice(0, limit)) {
    const rel = relative(vaultRoot, item.filePath);
    const nameNoExt = basename(item.filePath, ".md");
    const excerpt = safeReadExcerpt(item.filePath, 650);
    matches.push({
      wikiLink: `[[${nameNoExt}]]`,
      relativePath: rel,
      absolutePath: item.filePath,
      excerpt,
      hitCount: item.count,
    });
  }

  return matches;
}

/** Filter identity before ranking, never by title or keyword similarity. */
function createContextExclusion(vaultRoot: string, options?: VaultContextExclusions) {
  const canonicalPath = (path: string, base = vaultRoot) => {
    const absolute = resolve(base, path);
    try { return realpathSync(absolute); } catch { return absolute; }
  };
  const paths = new Set((options?.excludePaths || []).filter(Boolean).map(path => canonicalPath(path)));
  const urls = new Set((options?.excludeSourceUrls || []).filter(Boolean).map(sourceUrlIdentity));
  return (path: string, raw?: string): boolean => {
    if (paths.size && paths.has(canonicalPath(path))) return true;
    if (!raw || (!paths.size && !urls.size)) return false;
    const header = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (!header) return false;
    const sourceUrl = frontmatterString(header, "source_url");
    if (sourceUrl && urls.has(sourceUrlIdentity(sourceUrl))) return true;
    const sourcePath = frontmatterString(header, "source_path");
    return Boolean(sourcePath && paths.has(canonicalPath(sourcePath, dirname(path))));
  };
}

function frontmatterString(header: string, key: string): string {
  const value = header.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"))?.[1]?.trim() || "";
  if (value.startsWith('"')) {
    try { const parsed = JSON.parse(value); return typeof parsed === "string" ? parsed : ""; } catch { return ""; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function sourceUrlIdentity(raw: string): string {
  try {
    const url = new URL(raw);
    const biz = url.searchParams.get("__biz"), mid = url.searchParams.get("mid");
    // Explicit WeChat article identity survives share/tracking/signature variations.
    if (url.hostname === "mp.weixin.qq.com" && biz && mid) {
      return JSON.stringify([url.hostname, biz, mid, url.searchParams.get("idx") || "1"]);
    }
    url.hash = "";
    url.searchParams.sort();
    return url.toString();
  } catch { return raw.trim(); }
}

function collectMarkdownFiles(dir: string, out: string[]): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry.startsWith(".") ||
      entry === "instruction.md" ||
      IGNORED_VAULT_DIRS.has(entry) ||
      /_export_[a-f0-9]{16}\.md$/i.test(entry)
    ) {
      continue;
    }
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        collectMarkdownFiles(full, out);
      } else if (st.isFile() && entry.endsWith(".md")) {
        out.push(full);
      }
    } catch {}
  }
}

export function saveCompanionLightNote(params: {
  sourceMdPath: string;
  sourceUrl: string;
  title: string;
  author: string;
  triage: TriageLevel;
  relatedVaultNodes: string[];
  noteMarkdownBody: string;
  existingPath?: string;
  overwriteExisting?: boolean;
}): string {
  const noteMdPath = params.existingPath || params.sourceMdPath.replace(/\.md$/, "_note.md");
  if (!params.overwriteExisting && existsSync(noteMdPath)) return noteMdPath;
  const nowDate = new Date().toISOString().slice(0, 10);
  const sourceWiki = `[[${basename(params.sourceMdPath, ".md")}]]`;

  const frontmatter = [
    "---",
    "type: source_note",
    `title: ${yamlQuote(`${params.title}（初筛伴读笔记）`)}`,
    `source_path: ${yamlQuote(params.sourceMdPath)}`,
    `source_url: ${yamlQuote(params.sourceUrl)}`,
    `account_name: ${yamlQuote(params.author)}`,
    `created: ${nowDate}`,
    `updated: ${nowDate}`,
    "process_level: light",
    `triage: ${params.triage}`,
    `candidate_vault_nodes: ${JSON.stringify(params.relatedVaultNodes.map(node => node.replace(/^\[\[|\]\]$/g, "")))}`,
    "tags:",
    "  - wechat_article",
    "  - source_note",
    "---",
    "",
    `# ${params.title}（初筛伴读笔记）`,
    "",
    `- **原始材料**：${sourceWiki}（[微信原文](${params.sourceUrl})）`,
    `- **公众号 / 作者**：${params.author}`,
    `- **处理深度**：\`light\`（后台自动初筛）`,
    `- **建议分诊（Triage）**：\`${params.triage}\``,
    "- **关联状态**：候选线索仅供精读核验，尚未建立笔记关系。",
    "",
    "---",
    "",
    params.noteMarkdownBody.trim(),
    "",
  ];

  if (params.overwriteExisting) {
    replaceFileAtomically(noteMdPath, frontmatter.join("\n"));
  } else {
    writeNewFile(noteMdPath, frontmatter.join("\n"));
  }

  return noteMdPath;
}

export function createIdeaSeedInVault(params: {
  ideasSeedsDir: string;
  thoughtText: string;
  slug: string;
  sourceMdPath?: string;
  sourceUrl?: string;
  relatedVaultNodes?: string[];
  captureId?: string;
}): string {
  mkdirSync(params.ideasSeedsDir, { recursive: true });
  const datePrefix = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "_");
  const nowDate = new Date().toISOString().slice(0, 10);
  const cleanSlug = sanitizeSlug(params.slug);
  const identity = params.captureId
    ? createHash("sha256").update(params.captureId).digest("hex").slice(0, 24)
    : randomUUID();
  // Replay identity is independent of date, so restarting tomorrow cannot duplicate a capture.
  const filename = params.captureId
    ? `wechat_idea_${identity}.md`
    : `${datePrefix}_${cleanSlug}_${identity}.md`;
  const filePath = join(params.ideasSeedsDir, filename);

  const sourceWiki = params.sourceMdPath
    ? `[[${basename(params.sourceMdPath, ".md")}]]`
    : "";

  const lines = [
    "---",
    "type: idea",
    "status: seed",
    `created: ${nowDate}`,
    `updated: ${nowDate}`,
    ...(params.sourceMdPath ? [`source_path: ${yamlQuote(params.sourceMdPath)}`] : []),
    ...(params.sourceUrl ? [`source_url: ${yamlQuote(params.sourceUrl)}`] : []),
    "tags:",
    "  - idea",
    "  - seed",
    "---",
    "",
    `# ${params.thoughtText.slice(0, 48).replace(/\r?\n/g, " ")}`,
    "",
    params.thoughtText.trim(),
    "",
    "## 来源与关联",
    "",
    ...(sourceWiki
      ? [
          `- 触发来源：${sourceWiki}${
            params.sourceUrl ? ` ([原文](${params.sourceUrl}))` : ""
          }`,
        ]
      : []),
    ...(params.relatedVaultNodes && params.relatedVaultNodes.length > 0
      ? [`- 关联节点：${params.relatedVaultNodes.join("、")}`]
      : []),
    "",
  ];

  writeNewFile(filePath, lines.join("\n"));
  return filePath;
}

export function createInboxCaptureInVault(params: {
  inboxDir: string;
  title: string;
  bodyText: string;
  slug?: string;
  captureId?: string;
  attachedAssetRelPath?: string;
  tags?: string[];
}): string {
  mkdirSync(params.inboxDir, { recursive: true });
  const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "_");
  const nowDate = new Date().toISOString().slice(0, 10);
  const cleanSlug = sanitizeSlug(params.slug || "wechat_inbox_capture");
  const identity = params.captureId
    ? createHash("sha256").update(params.captureId).digest("hex").slice(0, 16)
    : randomUUID().slice(0, 12);
  const filename = `${datePrefix}_${cleanSlug}_${identity}.md`;
  const filePath = join(params.inboxDir, filename);

  const tags = params.tags?.length ? params.tags : ["inbox", "wechat_capture"];
  const lines = [
    "---",
    "type: inbox_capture",
    "process_level: raw",
    `title: ${yamlQuote(params.title || "WeChat Capture")}`,
    `created: ${nowDate}`,
    `updated: ${nowDate}`,
    "tags:",
    ...tags.map((t) => `  - ${t}`),
    "---",
    "",
    `# ${params.title || "WeChat Capture"}`,
    "",
    ...(params.attachedAssetRelPath
      ? [
          `- **关联附件 / 图片**：[${basename(params.attachedAssetRelPath)}](${
            params.attachedAssetRelPath
          })`,
          "",
        ]
      : []),
    params.bodyText.trim(),
    "",
  ];

  writeNewFile(filePath, lines.join("\n"));
  return filePath;
}

export function findVaultFilesByQuery(
  vaultRoot: string,
  query: string,
  limit = 6,
  customSearchDirs?: string[]
): VaultMatch[] {
  if (!existsSync(vaultRoot) || !query.trim()) return [];
  const q = query.trim();

  // Check if user specified a direct relative path inside the vault (e.g. "00_home/now.md")
  const directCandidate = join(
    vaultRoot,
    q.replace(/^\/+/, "").replace(/\.md$/i, "") + ".md"
  );
  if (existsSync(directCandidate)) {
    return [
      {
        wikiLink: `[[${basename(directCandidate, ".md")}]]`,
        relativePath: relative(vaultRoot, directCandidate),
        absolutePath: directCandidate,
        excerpt: safeReadExcerpt(directCandidate, 1200),
        hitCount: 100,
      },
    ];
  }

  const allDirs = resolveCandidateDirs(
    vaultRoot,
    ["05_outputs", "04_topics", "03_ideas", "00_home", "01_inputs", "_system"],
    customSearchDirs
  );

  const mdFiles: string[] = [];
  for (const dir of allDirs) {
    collectMarkdownFiles(dir, mdFiles);
  }

  const keywords = Array.from(
    new Set([
      ...extractSearchKeywords(q),
      ...q
        .toLowerCase()
        .replace(/[《》"'“”？?！!，,。.:：]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 2),
    ])
  );

  if (keywords.length === 0) return [];

  const nowMs = Date.now();
  const scored: Array<{ filePath: string; count: number }> = [];
  for (const filePath of mdFiles) {
    try {
      const relFromRoot = relative(vaultRoot, filePath).replace(/\\/g, "/");
      const cached = getCachedVaultMarkdown(filePath);
      if (!cached) continue;
      const content = cached.lowerContent;
      const fileNameLower = basename(filePath, ".md").toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        const lkw = kw.toLowerCase();
        if (fileNameLower.includes(lkw)) score += 8;
        let idx = 0;
        let occurrences = 0;
        while ((idx = content.indexOf(lkw, idx)) !== -1 && occurrences < 15) {
          occurrences++;
          idx += lkw.length;
        }
        score += occurrences;
      }
      if (score > 0) {
        // Prioritize compiled guides/outputs & topics over raw clippings
        if (relFromRoot.startsWith("05_outputs/research_notes/") || relFromRoot.startsWith("05_outputs/public_posts/")) {
          score += 10;
        } else if (relFromRoot.startsWith("04_topics/")) {
          score += 5;
        }
        // Boost files created/modified within the last 6 hours
        if (nowMs - cached.mtimeMs <= 6 * 3600 * 1000) {
          score += 12;
        }
        scored.push({ filePath, count: score });
      }
    } catch {}
  }

  scored.sort((a, b) => b.count - a.count);
  return scored.slice(0, limit).map((item) => ({
    wikiLink: `[[${basename(item.filePath, ".md")}]]`,
    relativePath: relative(vaultRoot, item.filePath),
    absolutePath: item.filePath,
    excerpt: safeReadExcerpt(item.filePath, 700),
    hitCount: item.count,
  }));
}

/**
 * Given a primary file path (e.g. `.../guide.md`), discover any sibling `.md`, `.html`, `.pdf`
 * files sharing the same filename stem in the same directory.
 */
export function findSiblingMultiFormatFiles(
  primaryFilePath: string,
  requestedExts: Array<"md" | "html" | "pdf"> = ["md", "html", "pdf"]
): string[] {
  if (!primaryFilePath || !existsSync(primaryFilePath)) return [];
  const dir = resolve(primaryFilePath, "..");
  const stem = basename(primaryFilePath).replace(/\.[a-zA-Z0-9]+$/, "");
  const isVersioned = /_export_[a-f0-9]{16}$/i.test(stem);
  const cleanStem = stem.replace(/_export_[a-f0-9]{16}$/i, "");
  const source = join(dir, `${cleanStem}.md`);
  const prepared = existsSync(source) && statSync(source).isFile()
    ? prepareMarkdownExport(readFileSync(source, "utf8"), dir, cleanStem)
    : undefined;
  const matchesSource = (candidateStem: string): boolean => {
    if (!prepared) return false;
    if (candidateStem === prepared.derivedStem) return true;
    const htmlPath = join(dir, `${candidateStem}.html`);
    if (!existsSync(htmlPath) || !statSync(htmlPath).isFile()) return false;
    return readFileSync(htmlPath, "utf8").endsWith(`\n<!-- wechat-export-source:${prepared.sourceRevision} -->\n`);
  };
  // Explicit historical exports retain their revision. A source document uses
  // its content revision, never the newest filesystem timestamp per extension.
  let exportStem = isVersioned ? stem : prepared?.derivedStem || cleanStem;
  if (!isVersioned && prepared && !existsSync(join(dir, `${exportStem}.html`))) {
    // A title changes the export revision but not its source identity. Only
    // consider exports carrying this source hash, never filesystem recency.
    const matchingStem = readdirSync(dir).sort().find((name) =>
      name.startsWith(`${cleanStem}_export_`) && /^[a-f0-9]{16}\.html$/i.test(name.slice(`${cleanStem}_export_`.length)) && matchesSource(name.slice(0, -5))
    );
    if (matchingStem) exportStem = matchingStem.slice(0, -5);
  }
  const results: string[] = [];
  for (const ext of requestedExts) {
    if (ext === "md" && isVersioned && !matchesSource(stem)) continue;
    const candidate = join(dir, `${ext === "md" ? cleanStem : exportStem}.${ext}`);
    if (existsSync(candidate) && statSync(candidate).isFile() && statSync(candidate).size > 0 && (ext !== "pdf" || isUsablePdf(candidate))) {
      results.push(candidate);
    }
  }
  return results;
}

/**
 * Gather foundational Knowledge Base architecture & evolution context when the user's task
 * involves understanding how their knowledge base is built, organized, or shared across AI tasks.
 */
export function gatherVaultArchitectureContext(
  vaultRoot: string,
  queryText: string
): string {
  if (!existsSync(vaultRoot)) return "";
  const needsArch =
    /(?:知识库|构建过程|组织方式|目录结构|共用上下文|跨任务|跨项目|llm\s*wiki|karpathy|agents\.md|学习指南|新手指南)/i.test(
      queryText
    );
  if (!needsArch) return "";

  const sections: string[] = [];
  const keyFiles: Array<{ label: string; relPath: string; maxChars: number }> = [
    { label: "知识库全局协议 (AGENTS.md)", relPath: "AGENTS.md", maxChars: 2200 },
    { label: "知识库结构地图 (00_home/knowledge_base_map.md)", relPath: "00_home/knowledge_base_map.md", maxChars: 1800 },
    { label: "跨任务/跨项目共享上下文协议 (_system/knowledge_base_access_protocol.md)", relPath: "_system/knowledge_base_access_protocol.md", maxChars: 2000 },
    { label: "跨项目 Agent 接入片段 (_system/other_project_agents_shared_knowledge_base_snippet.md)", relPath: "_system/other_project_agents_shared_knowledge_base_snippet.md", maxChars: 1200 },
    { label: "知识库自我修正协议 (_system/knowledge_self_correction_protocol.md)", relPath: "_system/knowledge_self_correction_protocol.md", maxChars: 1200 },
    { label: "LLM Wiki 主题页 (04_topics/knowledge_systems/llm_wiki.md)", relPath: "04_topics/knowledge_systems/llm_wiki.md", maxChars: 2000 },
    { label: "Karpathy LLM Wiki 原始剪藏与解读 (01_inputs/articles/clippings/llm_wiki_karpathy_note.md)", relPath: "01_inputs/articles/clippings/llm_wiki_karpathy_note.md", maxChars: 1800 },
    { label: "Karpathy LLM Wiki 原文 (01_inputs/articles/clippings/2026_05_12_llm_wiki.md)", relPath: "01_inputs/articles/clippings/2026_05_12_llm_wiki.md", maxChars: 2000 },
  ];

  for (const kf of keyFiles) {
    const full = join(vaultRoot, kf.relPath);
    if (existsSync(full)) {
      const excerpt = safeReadExcerpt(full, kf.maxChars);
      if (excerpt) {
        sections.push(`### ${kf.label} (\`${kf.relPath}\`)\n${excerpt}`);
      }
    }
  }

  // Also extract initial setup & restructure milestones from _system/log.md
  const logPath = join(vaultRoot, "_system", "log.md");
  if (existsSync(logPath)) {
    try {
      const rawLog = readFileSync(logPath, "utf-8");
      const headPart = rawLog.slice(0, 2600);
      const tailPart = rawLog.length > 3000 ? rawLog.slice(-2400) : "";
      sections.push(
        `### 知识库演进日志节选 (\`_system/log.md\`)\n【早期起步与重组记录】\n${headPart}\n\n${
          tailPart ? `【近期演进与跨项目共用验证记录】\n${tailPart}` : ""
        }`
      );
    } catch {}
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Initialize a starter Personal Knowledge Base directory structure for new users
 * so the system works out-of-the-box without requiring an existing vault.
 *
 * SAFETY INVARIANT:
 * - Strictly additive-only: NEVER deletes, moves, or overwrites any existing directory or file.
 * - Any directory that already exists (`existsSync`) is skipped immediately without calling `mkdirSync`.
 * - Starter files (`now.md`, `queue.md`) are only created when missing, using atomic `writeNewFile` (`wx` + `linkSync`).
 */
export function ensureStarterVaultInitialized(config: AppConfig): {
  createdDirs: string[];
  skippedDirs: string[];
  createdFiles: string[];
  skippedFiles: string[];
} {
  const rawDirs = [
    config.vaultRoot,
    join(config.vaultRoot, "00_home"),
    config.wechatArticlesDir,
    config.webArticlesDir || join(config.vaultRoot, "01_inputs", "articles", "web"),
    config.videoDir || join(config.vaultRoot, "01_inputs", "video"),
    config.inboxDir || join(config.vaultRoot, "01_inputs", "inbox"),
    config.papersDir || join(config.vaultRoot, "01_inputs", "papers"),
    config.ideasSeedsDir,
    join(config.vaultRoot, "04_topics"),
    join(config.vaultRoot, "05_outputs", "plans"),
  ];

  // Deduplicate resolved target paths so we never process the same directory twice
  const uniqueDirs = Array.from(new Set(rawDirs.map((d) => resolve(d))));

  const createdDirs: string[] = [];
  const skippedDirs: string[] = [];
  for (const resolved of uniqueDirs) {
    if (existsSync(resolved)) {
      skippedDirs.push(resolved);
      continue;
    }
    mkdirSync(resolved, { recursive: true });
    createdDirs.push(resolved);
  }

  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];
  const nowFile = resolve(
    config.vaultRoot,
    config.vaultLayout?.nowFile || join("00_home", "now.md")
  );
  if (existsSync(nowFile)) {
    skippedFiles.push(nowFile);
  } else {
    const nowParent = resolve(nowFile, "..");
    if (!existsSync(nowParent)) {
      mkdirSync(nowParent, { recursive: true });
    }
    const nowDate = new Date().toISOString().slice(0, 10);
    const starterNow = [
      "---",
      "type: home",
      `updated: ${nowDate}`,
      "---",
      "",
      "# 当前关注与研究主线 (Now)",
      "",
      "> 在这里写下你近期重点关注的课题、项目或问题。每次你在微信转发公众号文章给 ClawBot 时，AI 都会以此文件为锚点为你提炼增量信号。",
      "",
      "## 核心课题",
      "- **课题一**：AI Agent 架构与个人知识库自动化工作流",
      "- **课题二**：深度阅读、跨领域知识内化与个人观点沉淀",
      "",
    ].join("\n");
    if (writeNewFile(nowFile, starterNow)) {
      createdFiles.push(nowFile);
    } else {
      skippedFiles.push(nowFile);
    }
  }

  const queueFile = resolve(
    config.vaultRoot,
    config.vaultLayout?.queueFile || join("00_home", "queue.md")
  );
  if (existsSync(queueFile)) {
    skippedFiles.push(queueFile);
  } else {
    const queueParent = resolve(queueFile, "..");
    if (!existsSync(queueParent)) {
      mkdirSync(queueParent, { recursive: true });
    }
    const nowDate = new Date().toISOString().slice(0, 10);
    const starterQueue = [
      "---",
      "type: home",
      `updated: ${nowDate}`,
      "---",
      "",
      "# 待办与深读队列 (Queue)",
      "",
      "- [ ] 在微信里向「微信ClawBot [AI]」转发第一篇公众号文章",
      "- [ ] 尝试在微信里发送 `想法：...` 记录一条灵感种子",
      "",
    ].join("\n");
    if (writeNewFile(queueFile, starterQueue)) {
      createdFiles.push(queueFile);
    } else {
      skippedFiles.push(queueFile);
    }
  }

  return { createdDirs, skippedDirs, createdFiles, skippedFiles };
}
