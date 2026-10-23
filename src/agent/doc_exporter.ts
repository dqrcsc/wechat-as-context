import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { writeNewFile } from "../storage.ts";

export type DeliverableFormat = "md" | "html" | "pdf";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findBrowserBinary(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Detect which file formats (md, html, pdf) the user is asking to generate/deliver.
 */
export function detectRequestedFormats(
  text: string,
  explicitFormats?: string[]
): DeliverableFormat[] {
  const found = new Set<DeliverableFormat>();
  if (explicitFormats && Array.isArray(explicitFormats)) {
    for (const fmt of explicitFormats) {
      const lower = String(fmt).toLowerCase().replace(/^\./, "");
      if (lower === "md" || lower === "markdown") found.add("md");
      if (lower === "html" || lower === "htm") found.add("html");
      if (lower === "pdf") found.add("pdf");
    }
  }

  const lower = text.toLowerCase();
  if (/(?:\bmarkdown\b|\bmd格式|\.md\b|md版|md文件)/i.test(lower)) {
    found.add("md");
  }
  if (/(?:\bhtml\b|\.html\b|网页格式|网页版|html格式|html文件)/i.test(lower)) {
    found.add("html");
  }
  if (/(?:\bpdf\b|\.pdf\b|pdf格式|pdf版|pdf文件)/i.test(lower)) {
    found.add("pdf");
  }

  // Order deterministically: md -> html -> pdf
  const ordered: DeliverableFormat[] = [];
  if (found.has("md")) ordered.push("md");
  if (found.has("html")) ordered.push("html");
  if (found.has("pdf")) ordered.push("pdf");
  return ordered;
}

/**
 * Detect whether the user wants generated/matched files sent back to WeChat.
 */
export function detectWantsFileDelivery(
  text: string,
  explicitFlag?: boolean
): boolean {
  if (explicitFlag === true) return true;
  if (
    /(?:发给我|发我|发文件|传给我|推送给我|推送文件|发到微信|发我微信|各自生成.*发|导出.*发)/i.test(
      text
    )
  ) {
    return true;
  }
  const formats = detectRequestedFormats(text);
  if (formats.length >= 2 && /(?:生成|导出|整理|制作)/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * Detect whether a user message is a compound research/synthesis + document generation request.
 */
export function isDocumentGenerationTask(text: string): boolean {
  const formats = detectRequestedFormats(text);
  const hasDocNoun =
    /(?:学习指南|入门指南|新手指南|指南|教程|手册|研究报告|调研报告|白皮书|总结报告|文档|文章初稿)/i.test(
      text
    );
  const hasGenVerb = /(?:整理|生成|撰写|写一篇|写一份|制作|输出|编写|汇总)/i.test(
    text
  );
  if (formats.length > 0 && (hasDocNoun || hasGenVerb)) return true;
  if (hasDocNoun && hasGenVerb && detectWantsFileDelivery(text)) return true;
  return false;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInlineMarkdown(line: string): string {
  let out = escapeHtml(line);
  const images: string[] = [];
  // Inline code: `code`
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Images precede links so ![alt](url) cannot turn into !<a>.
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt, url) => {
    const index = images.push(`<img src="${url}" alt="${alt}" style="max-width:100%;height:auto" />`) - 1;
    return `\u0000IMAGE${index}\u0000`;
  });
  // Markdown links: [label](url)
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  // WikiLinks: [[note_name|label]] or [[note_name]]
  out = out.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<span class="wikilink">⟦$2⟧</span>');
  out = out.replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">⟦$1⟧</span>');
  // Bold: **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic: *text*
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return out.replace(/\u0000IMAGE(\d+)\u0000/g, (_match, index) => images[Number(index)]);
}

/**
 * Compile Markdown content into a self-contained, responsive, print-ready HTML document.
 */
export function compileMarkdownToHtml(
  markdown: string,
  fallbackTitle = "学习指南与研究笔记"
): string {
  let bodyMd = markdown.trim();
  let frontmatterTitle = "";
  let frontmatterSubtitle = "";
  let frontmatterDate = new Date().toISOString().slice(0, 10);

  const fmMatch = bodyMd.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n+/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const tMatch = fm.match(/^title:\s*["']?([^"'\r\n]+)["']?/m);
    const subMatch = fm.match(/^subtitle:\s*["']?([^"'\r\n]+)["']?/m);
    const dateMatch = fm.match(/^created:\s*["']?([^"'\r\n]+)["']?/m);
    if (tMatch?.[1]) frontmatterTitle = tMatch[1].trim();
    if (subMatch?.[1]) frontmatterSubtitle = subMatch[1].trim();
    if (dateMatch?.[1]) frontmatterDate = dateMatch[1].trim();
    bodyMd = bodyMd.slice(fmMatch[0].length).trim();
  }

  const lines = bodyMd.split(/\r?\n/);
  let docTitle = frontmatterTitle || fallbackTitle;
  const htmlBlocks: string[] = [];

  let inCodeBlock = false;
  let codeLang = "";
  let codeLines: string[] = [];
  let inUl = false;
  let inOl = false;
  let inBlockquote = false;
  let tableRows: string[][] = [];

  const flushList = () => {
    if (inUl) {
      htmlBlocks.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      htmlBlocks.push("</ol>");
      inOl = false;
    }
  };

  const flushBlockquote = () => {
    if (inBlockquote) {
      htmlBlocks.push("</blockquote>");
      inBlockquote = false;
    }
  };

  const flushTable = () => {
    if (tableRows.length === 0) return;
    const rows = tableRows;
    tableRows = [];
    if (rows.length === 1) {
      htmlBlocks.push(
        `<p>${ rows[0].map((c) => renderInlineMarkdown(c)).join(" | ") }</p>`
      );
      return;
    }
    const header = rows[0];
    const isSeparator = (r: string[]) =>
      r.every((cell) => /^[:\-\s]+$/.test(cell.trim()));
    const bodyStartIdx = rows.length > 1 && isSeparator(rows[1]) ? 2 : 1;

    let tbl = '<div class="table-wrap"><table><thead><tr>';
    for (const h of header) {
      tbl += `<th>${renderInlineMarkdown(h.trim())}</th>`;
    }
    tbl += "</tr></thead><tbody>";
    for (let i = bodyStartIdx; i < rows.length; i++) {
      if (isSeparator(rows[i])) continue;
      tbl += "<tr>";
      for (let c = 0; c < header.length; c++) {
        tbl += `<td>${renderInlineMarkdown((rows[i][c] ?? "").trim())}</td>`;
      }
      tbl += "</tr>";
    }
    tbl += "</tbody></table></div>";
    htmlBlocks.push(tbl);
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("```")) {
      flushList();
      flushBlockquote();
      flushTable();
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = trimmed.slice(3).trim();
        codeLines = [];
      } else {
        inCodeBlock = false;
        const langBadge = codeLang
          ? `<div class="code-lang">${escapeHtml(codeLang)}</div>`
          : "";
        htmlBlocks.push(
          `<div class="code-block">${langBadge}<pre><code>${escapeHtml(
            codeLines.join("\n")
          )}</code></pre></div>`
        );
        codeLang = "";
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    // Table detection
    if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2) {
      flushList();
      flushBlockquote();
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      tableRows.push(cells);
      continue;
    } else if (tableRows.length > 0) {
      flushTable();
    }

    if (!trimmed) {
      flushList();
      flushBlockquote();
      continue;
    }

    if (/^(?:---|\*\*\*|___)$/.test(trimmed)) {
      flushList();
      flushBlockquote();
      htmlBlocks.push("<hr />");
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,6})\s+([\s\S]+)$/);
    if (hMatch) {
      flushList();
      flushBlockquote();
      const level = hMatch[1].length;
      const headingText = hMatch[2].trim();
      if (level === 1 && !frontmatterTitle) {
        docTitle = headingText.replace(/[*`]/g, "");
      }
      const idSlug = `sec-${i}`;
      htmlBlocks.push(
        `<h${level} id="${idSlug}">${renderInlineMarkdown(headingText)}</h${level}>`
      );
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushList();
      if (!inBlockquote) {
        htmlBlocks.push("<blockquote>");
        inBlockquote = true;
      }
      const quoteBody = trimmed.replace(/^>\s?/, "");
      htmlBlocks.push(`<p>${renderInlineMarkdown(quoteBody)}</p>`);
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
    }

    const ulMatch = rawLine.match(/^\s*[-*+]\s+([\s\S]+)$/);
    if (ulMatch) {
      if (inOl) {
        htmlBlocks.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        htmlBlocks.push("<ul>");
        inUl = true;
      }
      htmlBlocks.push(`<li>${renderInlineMarkdown(ulMatch[1].trim())}</li>`);
      continue;
    }

    const olMatch = rawLine.match(/^\s*\d+[.)]\s+([\s\S]+)$/);
    if (olMatch) {
      if (inUl) {
        htmlBlocks.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        htmlBlocks.push("<ol>");
        inOl = true;
      }
      htmlBlocks.push(`<li>${renderInlineMarkdown(olMatch[1].trim())}</li>`);
      continue;
    }

    flushList();
    htmlBlocks.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  }

  if (inCodeBlock) {
    htmlBlocks.push(
      `<div class="code-block"><pre><code>${escapeHtml(
        codeLines.join("\n")
      )}</code></pre></div>`
    );
  }
  flushList();
  flushBlockquote();
  flushTable();

  const subtitleHtml = frontmatterSubtitle
    ? `<p class="doc-subtitle">${escapeHtml(frontmatterSubtitle)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(docTitle)}</title>
  <style>
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --accent: #0f766e;
      --accent-soft: #f0fdfa;
      --border: #e2e8f0;
      --code-bg: #1e293b;
      --code-fg: #f8fafc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 36px 20px 64px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
      font-size: 16px;
      line-height: 1.78;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 840px;
      margin: 0 auto;
      background: var(--surface);
      padding: 48px 56px;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(15, 23, 42, 0.05);
      border: 1px solid var(--border);
    }
    .doc-header {
      border-bottom: 2px solid var(--border);
      padding-bottom: 22px;
      margin-bottom: 32px;
    }
    .doc-meta {
      font-size: 13px;
      color: var(--accent);
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .doc-subtitle {
      font-size: 18px;
      color: var(--muted);
      margin: 8px 0 0;
    }
    h1 {
      font-size: 30px;
      line-height: 1.32;
      margin: 0 0 14px;
      color: #0f172a;
      letter-spacing: -0.01em;
    }
    h2 {
      font-size: 22px;
      line-height: 1.4;
      margin: 38px 0 14px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
      color: #0f172a;
    }
    h3 {
      font-size: 18px;
      line-height: 1.45;
      margin: 26px 0 10px;
      color: #1e293b;
    }
    h4 {
      font-size: 16px;
      margin: 20px 0 8px;
      color: #334155;
    }
    p {
      margin: 0 0 16px;
      text-align: justify;
    }
    ul, ol {
      margin: 0 0 18px;
      padding-left: 24px;
    }
    li {
      margin-bottom: 8px;
    }
    blockquote {
      margin: 20px 0;
      padding: 14px 20px;
      background: var(--accent-soft);
      border-left: 4px solid var(--accent);
      border-radius: 0 10px 10px 0;
      color: #134e4a;
    }
    blockquote p:last-child {
      margin-bottom: 0;
    }
    code {
      font-family: "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
      font-size: 0.88em;
      background: #f1f5f9;
      color: #0f766e;
      padding: 2px 6px;
      border-radius: 5px;
    }
    .code-block {
      margin: 18px 0 22px;
      border-radius: 10px;
      overflow: hidden;
      background: var(--code-bg);
      border: 1px solid #334155;
      page-break-inside: avoid;
    }
    .code-lang {
      background: #0f172a;
      color: #94a3b8;
      font-size: 12px;
      font-family: monospace;
      padding: 6px 14px;
      border-bottom: 1px solid #334155;
    }
    pre {
      margin: 0;
      padding: 16px 18px;
      overflow-x: auto;
    }
    pre code {
      background: transparent;
      color: var(--code-fg);
      padding: 0;
      font-size: 13.5px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .table-wrap {
      margin: 20px 0 24px;
      overflow-x: auto;
      page-break-inside: avoid;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14.5px;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 10px 14px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #f1f5f9;
      font-weight: 600;
      color: #1e293b;
    }
    tr:nth-child(even) td {
      background: #f8fafc;
    }
    a {
      color: var(--accent);
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .wikilink {
      color: var(--accent);
      background: var(--accent-soft);
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 0.92em;
    }
    hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 28px 0;
    }
    @media (max-width: 640px) {
      body { padding: 12px 8px 32px; }
      .container { padding: 24px 20px; border-radius: 12px; }
      h1 { font-size: 24px; }
      h2 { font-size: 19px; }
    }
    @media print {
      body {
        background: #ffffff;
        padding: 0;
        font-size: 11pt;
        line-height: 1.65;
      }
      .container {
        max-width: 100%;
        border: none;
        box-shadow: none;
        padding: 0;
      }
      h2, h3 {
        page-break-after: avoid;
      }
      .code-block, .table-wrap, blockquote {
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <article class="container">
    ${
      frontmatterTitle
        ? `<header class="doc-header">
             <div class="doc-meta">Knowledge Base Learning Guide · ${escapeHtml(frontmatterDate)}</div>
             <h1>${escapeHtml(frontmatterTitle)}</h1>
             ${subtitleHtml}
           </header>`
        : ""
    }
    ${htmlBlocks.join("\n")}
  </article>
</body>
</html>`;
}

/**
 * Render an HTML file to PDF using local Headless Chrome / Chromium / Edge.
 */
// This is a basic container check, not a full PDF parser or visual validation.
export function isUsablePdf(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    const content = readFileSync(path);
    return content.length > 500 && /^%PDF-\d\.\d/.test(content.subarray(0, 16).toString("ascii")) && /%%EOF\s*$/.test(content.subarray(-1024).toString("ascii"));
  } catch { return false; }
}

export async function renderHtmlToPdf(htmlPath: string, pdfPath: string, timeoutMs = 35_000): Promise<boolean> {
  const browserBin = findBrowserBinary();
  if (!browserBin || !existsSync(htmlPath)) return false;
  mkdirSync(dirname(pdfPath), { recursive: true });
  const temporary = `${pdfPath}.${randomUUID()}.tmp.pdf`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const proc = Bun.spawn([
      browserBin, "--headless", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer",
      `--print-to-pdf=${temporary}`, `file://${htmlPath}`,
    ], {stdout: "ignore", stderr: "ignore"});
    timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, timeoutMs);
    const exitCode = await proc.exited;
    if (timedOut || exitCode !== 0 || !isUsablePdf(temporary)) return false;
    if (existsSync(pdfPath)) {
      if (isUsablePdf(pdfPath)) return true;
      renameSync(pdfPath, `${pdfPath}.invalid.${randomUUID()}`);
    }
    writeNewFile(pdfPath, readFileSync(temporary));
    return isUsablePdf(pdfPath);
  } catch (err) {
    console.warn("[DocExporter] Headless browser PDF render warning:", err);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Compute the shared source/image revision used by export creation and lookup. */
export function prepareMarkdownExport(markdown: string, targetDir: string, targetStem: string, title?: string): { derivedStem: string; html: string; sourceRevision: string } {
  const embeddedMarkdown = markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (original, alt, url) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(url)) return original;
    const imagePath = join(targetDir, url);
    const mime = ({ ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".gif":"image/gif", ".webp":"image/webp" } as Record<string,string>)[extname(imagePath).toLowerCase()];
    if (!mime || !existsSync(imagePath)) return original;
    const imageRelative = relative(realpathSync(targetDir), realpathSync(imagePath));
    if (imageRelative === ".." || imageRelative.startsWith(`..${sep}`) || isAbsolute(imageRelative)) {
      return `${alt}（图片路径超出文档目录，未嵌入）`;
    }
    return `![${alt}](data:${mime};base64,${readFileSync(imagePath).toString("base64")})`;
  });
  const revision = createHash("sha256").update("html-v2\0" + (title || targetStem) + "\0" + embeddedMarkdown).digest("hex").slice(0, 16);
  const sourceRevision = createHash("sha256").update("source-v1\0" + embeddedMarkdown).digest("hex");
  return {
    derivedStem: `${targetStem}_export_${revision}`,
    sourceRevision,
    html: compileMarkdownToHtml(embeddedMarkdown, title || targetStem) + `\n<!-- wechat-export-source:${sourceRevision} -->\n`,
  };
}

export async function ensureMultiFormatDeliverables(params: {
  markdownPath?: string;
  markdownContent?: string;
  outputDir: string;
  baseFileStem: string;
  title?: string;
  existingFiles?: string[];
  requestedFormats: DeliverableFormat[];
}): Promise<string[]> {
  const {
    outputDir,
    baseFileStem,
    title,
    existingFiles = [],
    requestedFormats,
  } = params;

  mkdirSync(outputDir, { recursive: true });

  const formats: DeliverableFormat[] =
    requestedFormats.length > 0 ? requestedFormats : ["md"];

  // Map existing files by extension
  const byExt = new Map<DeliverableFormat, string>();
  for (const f of existingFiles) {
    if (!existsSync(f)) continue;
    const ext = extname(f).toLowerCase().replace(/^\./, "");
    if ((ext === "md" || ext === "html" || ext === "pdf") && !byExt.has(ext) && (ext !== "pdf" || isUsablePdf(f))) {
      byExt.set(ext, f);
    }
  }

  // Also check if sibling files with the same stem as an existing file already exist!
  if (byExt.size > 0) {
    const samplePath = Array.from(byExt.values())[0];
    const dir = dirname(samplePath);
    const stem = basename(samplePath, extname(samplePath));
    for (const fmt of ["md", "html", "pdf"] as DeliverableFormat[]) {
      const sibling = join(dir, `${stem}.${fmt}`);
      if (!byExt.has(fmt) && existsSync(sibling) && statSync(sibling).size > 0 && (fmt !== "pdf" || isUsablePdf(sibling))) {
        byExt.set(fmt, sibling);
      }
    }
  }

  // Ensure Markdown source exists first
  let mdPath = params.markdownPath || byExt.get("md") || "";
  let mdContent = params.markdownContent || "";

  if (mdPath && existsSync(mdPath)) {
    const diskContent = readFileSync(mdPath, "utf-8");
    if (params.markdownContent !== undefined && params.markdownContent !== diskContent) {
      throw new Error("Markdown source conflicts with explicit markdownContent; use a new source file");
    }
    mdContent = diskContent;
  } else if (params.markdownContent !== undefined) {
    mdPath = join(outputDir, `${baseFileStem}.md`);
    if (!writeNewFile(mdPath, mdContent) && readFileSync(mdPath, "utf8") !== mdContent) {
      throw new Error("Markdown target already contains different content");
    }
    byExt.set("md", mdPath);
  }

  if (mdPath && existsSync(mdPath)) {
    byExt.set("md", mdPath);
  }

  // Determine target directory and stem from mdPath if present
  const targetDir = mdPath ? dirname(mdPath) : outputDir;
  const targetStem = mdPath
    ? basename(mdPath, extname(mdPath))
    : baseFileStem;

  // A derived file is reusable only for this exact source (including embedded
  // local image bytes). Keep old/manual exports intact under their own names.
  let derivedStem = targetStem;
  let htmlString = "";
  const hasMarkdownSource = params.markdownContent !== undefined || Boolean(mdPath && existsSync(mdPath));
  if (hasMarkdownSource) {
    const prepared = prepareMarkdownExport(mdContent, targetDir, targetStem, title);
    derivedStem = prepared.derivedStem;
    htmlString = prepared.html;
    byExt.delete("html");
    byExt.delete("pdf");
  }

  // Match the source revision instead of accepting stale same-stem siblings.
  for (const fmt of ["html", "pdf"] as DeliverableFormat[]) {
    const candidate = join(targetDir, `${derivedStem}.${fmt}`);
    if (!byExt.has(fmt) && existsSync(candidate) && statSync(candidate).size > 0 && (fmt !== "pdf" || isUsablePdf(candidate))) {
      byExt.set(fmt, candidate);
    }
  }

  // Generate HTML if requested (or needed for PDF) and not yet present
  const needsHtml =
    (formats.includes("html") && !byExt.has("html")) ||
    (formats.includes("pdf") && !byExt.has("pdf") && !byExt.has("html"));

  if (needsHtml && hasMarkdownSource) {
    const htmlPath = join(targetDir, `${derivedStem}.html`);
    writeNewFile(htmlPath, htmlString);
    byExt.set("html", htmlPath);
  }

  // Generate PDF if requested and not yet present
  if (formats.includes("pdf") && !byExt.has("pdf")) {
    const htmlPath = byExt.get("html");
    if (htmlPath && existsSync(htmlPath)) {
      const pdfPath = join(targetDir, `${derivedStem}.pdf`);
      const ok = await renderHtmlToPdf(htmlPath, pdfPath);
      if (ok) {
        byExt.set("pdf", pdfPath);
      }
    }
  }

  // Return files in the requested order
  const result: string[] = [];
  for (const fmt of formats) {
    const p = byExt.get(fmt);
    if (p && existsSync(p)) {
      result.push(p);
    }
  }

  // Without a Markdown source, pass through supplied files. Once source exists,
  // missing exports must stay missing rather than resurrecting stale versions.
  if (result.length === 0 && !hasMarkdownSource) {
    for (const f of existingFiles) {
      if (existsSync(f) && !result.includes(f) && (extname(f).toLowerCase() !== ".pdf" || isUsablePdf(f))) {
        result.push(f);
      }
    }
  }

  return result;
}
