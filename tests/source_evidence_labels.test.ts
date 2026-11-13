import './support/isolation.ts';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { extractYouTubeVideo, hasChineseCaptionScriptMismatch } from '../src/extractor/youtube.ts';
import { cleanDouyinDescription, extractDouyinWork } from '../src/extractor/social_media.ts';
import { extractionNotice, readSavedExtractionQuality } from '../src/extractor/quality.ts';
import { setAsrTestRunner } from '../src/extractor/asr.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setAsrTestRunner(null); });
const latin = 'This synthetic caption explains how a small team can compare different methods using the same facts and examples. '.repeat(8).trim();
const template = '于20261113发布在抖音，已经收获了0个喜欢，来抖音，记录美好生活！';
const id = '76543210987654321';
const url = `https://www.douyin.com/video/${id}`;
function config() {
  const root = mkdtempSync(join(tmpdir(), 'source-labels-'));
  return loadConfig({ IGNORE_HOME_DOTENV: 'true', VAULT_ROOT: 'none', WECHAT_CONTEXT_DATA_DIR: root, LLM_API_KEY: 'fixture', LLM_PROVIDER: 'custom', LLM_BASE_URL: 'https://model.example.test/v1', LLM_MODEL: 'fixture' }, root);
}
function mockDouyin(item?: Record<string, unknown>, meta = '') {
  const html = item ? `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: { page: { videoInfoRes: { item_list: [{ aweme_id: id, ...item }] } } } })}</script>` : `<link rel="canonical" href="${url}">${meta}`;
  globalThis.fetch = (async () => new Response(html)) as unknown as typeof fetch;
}

for (const automatic of [false, true]) test(`Chinese track with Latin body keeps declaration and warning (automatic=${automatic})`, async () => {
  const player = { videoDetails: { videoId: 'abcdefghijk', title: 'Synthetic video', lengthSeconds: '60' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'zh-CN', name: { simpleText: '中文（中国）' }, kind: automatic ? 'asr' : undefined, baseUrl: 'https://captions.example.test/fixture' }] } } };
  globalThis.fetch = (async (input: any) => String(input).includes('youtube.com/watch')
    ? new Response(`<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`)
    : String(input).includes('captions.example.test') ? new Response(`<transcript><text start="0" dur="60">${latin}</text></transcript>`) : new Response('', { status: 403 })) as unknown as typeof fetch;
  const result = await extractYouTubeVideo('https://www.youtube.com/watch?v=abcdefghijk');
  expect(result.extractionQuality?.status).toBe('complete');
  expect(result.extractionQuality?.reasons).toContain('caption_language_mismatch');
  expect(result.transcriptEngine).toContain('源站声明：中文（中国） / zh-CN');
  expect(result.transcriptEngine).toContain('正文以拉丁字母为主');
  expect(result.transcriptEngine).not.toContain('英文');
  expect(result.markdownBody).toContain(latin);
  expect(result.markdownBody).toContain('实际语言待核验');
  const saved = readSavedExtractionQuality(`---\nextraction_quality: ${JSON.stringify(result.extractionQuality)}\n---\n`);
  expect(extractionNotice(saved)).toContain('实际语言待核验');
  if (automatic) expect(result.transcriptEngine).toContain('自动生成');
});
for (const [label, code, body] of [
  ['Chinese', 'zh-CN', '这是中文逐字稿。'.repeat(100)],
  ['mixed', 'zh', `${latin} 这是中文。`],
  ['short', 'zh-CN', 'A short greeting.'],
  ['English declaration', 'en', latin],
  ['unknown declaration', '', latin],
  ['Japanese', 'zh-CN', 'こんにちは'.repeat(100) + latin],
  ['Korean', 'zh-CN', '안녕하세요'.repeat(100) + latin],
]) test(`script heuristic does not overclaim: ${label}`, () => {
  expect(hasChineseCaptionScriptMismatch(code!, body!)).toBe(false);
});
test('language warning coexists with incomplete coverage', () => {
  const notice = extractionNotice({ status: 'partial', reasons: ['caption_language_mismatch'], totalVideos: 2, processedVideos: [1], missingVideos: [2] });
  expect(notice).toContain('实际语言待核验'); expect(notice).toContain('1/2');
});

test('template-only metadata retains old title solely as identity', async () => {
  mockDouyin(undefined, `<meta property="og:title" content="${template}"><meta name="description" content="${template}">`);
  const result = await extractDouyinWork(url, '可信旧标题', '', '旧摘要不能冒充新正文');
  expect(result.title).toBe('可信旧标题');
  expect(result.digest).toBe(''); expect(result.publishDate).toBe('');
  expect(result.extractionQuality?.status).toBe('metadata_only');
  expect(result.extractionQuality?.reasons).toEqual(['douyin_template_text_filtered', 'audio_stream_not_found', 'douyin_content_unavailable']);
  expect(result.markdownBody).not.toContain(template);
  expect(result.markdownBody).not.toContain('可信旧标题');
  expect(result.markdownBody).not.toContain('旧摘要不能冒充新正文');
  expect(extractionNotice(result.extractionQuality)).toContain('不能据此分析正文');
});
for (const oldTitle of ['', template, `抖音视频 (${id})`]) test(`template without a usable old title fails visibly: ${oldTitle.slice(0, 10)}`, async () => {
  mockDouyin({ desc: template });
  await expect(extractDouyinWork(url, oldTitle)).rejects.toThrow('Douyin content unavailable');
});
test('template og:title does not hide a later valid description', async () => {
  mockDouyin(undefined, `<meta property="og:title" content="${template}"><meta name="description" content="真实作品文案">`);
  const result = await extractDouyinWork(url);
  expect(result.title).toBe('真实作品文案'); expect(result.markdownBody).toContain('真实作品文案');
  expect(result.extractionQuality?.reasons).toContain('douyin_template_text_filtered');
  expect(result.extractionQuality?.reasons).not.toContain('douyin_content_unavailable');
});
test('template item description cannot taint a successful transcript', async () => {
  mockDouyin({ desc: template, video: { play_addr: { url_list: ['https://media.example.test/video.mp4'] } } });
  setAsrTestRunner(async () => ({ transcript: '本次实际取得的口播。', engineUsed: 'fixture' }));
  const result = await extractDouyinWork(url, '可信旧标题');
  expect(result.extractionQuality?.status).toBe('complete');
  expect(result.extractionQuality?.reasons).toEqual(['douyin_template_text_filtered']);
  expect(result.markdownBody).toContain('本次实际取得的口播。'); expect(result.markdownBody).not.toContain(template);
});
for (const value of [template, `创作者${template}`, '抖音-记录美好生活', `真实内容 - 作者${template} - 抖音`, `真实内容-作者${template}`]) test(`recognized platform template: ${value.slice(0, 12)}`, () => {
  const cleaned = cleanDouyinDescription(value);
  expect(cleaned.templateRemoved).toBe(true);
  expect(cleaned.text).toBe(value.startsWith('真实') ? '真实内容' : '');
});
for (const value of [`作者说：“${template}”是网站模板。`, `分析 - “${template}”`, '于今天发布的作品值得讨论']) test('real prose mentioning platform copy survives', () => {
  expect(cleanDouyinDescription(value)).toEqual({ text: value, templateRemoved: false });
});
test('album filters template before OCR and retains page coverage', async () => {
  const item = { aweme_id: id, desc: template, images: [{ url_list: ['https://images.example.test/card.jpg'] }] };
  const html = `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: { page: { videoInfoRes: { item_list: [item] } } } })}</script>`;
  let modelCalls = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    const target = String(input);
    if (target.includes('douyin.com')) return new Response(html);
    if (target.includes('images.example.test')) return new Response(new Uint8Array(256).fill(1), { headers: { 'content-type': 'image/jpeg' } });
    if (target.includes('model.example.test')) {
      modelCalls++; expect(init.body).not.toContain(template);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ pages: [{ page: 1, text: '卡片里的真实文字' }] }) } }] });
    }
    throw new Error('Unexpected fixture request');
  }) as unknown as typeof fetch;
  const result = await extractDouyinWork(url, '旧图集标题', '', '', { config: config() });
  expect(modelCalls).toBe(1); expect(result.sourceType).toBe('douyin_note');
  expect(result.extractionQuality?.status).toBe('complete');
  expect(result.extractionQuality?.processedPages).toEqual([1]);
  expect(result.extractionQuality?.reasons).toContain('douyin_template_text_filtered');
  expect(result.markdownBody).toContain('卡片里的真实文字'); expect(result.markdownBody).not.toContain(template);
});

import { analyzeArticleWithVault } from '../src/vault/analyzer.ts';
import { saveRawWebArticleToVault } from '../src/extractor/web.ts';
import { readFileSync } from 'node:fs';
for (const reason of ['caption_language_mismatch', 'douyin_content_unavailable', 'douyin_seo_excerpt']) test(`quality warning survives source persistence and model omission: ${reason}`, async () => {
  const cfg = config();
  const quality = { status: reason === 'caption_language_mismatch' ? 'complete' as const : 'metadata_only' as const, reasons: [reason] };
  const article = { title: 'Synthetic source', url: 'https://example.test/article', author: 'Fixture', publishDate: '', digest: '', markdownBody: 'Synthetic evidence.', imageUrls: [], extractorUsed: 'native_http' as const, extractionQuality: quality };
  const path = await saveRawWebArticleToVault({ articlesDir: join(cfg.dataDir, 'articles'), article, slug: 'source-label' });
  expect(readSavedExtractionQuality(readFileSync(path, 'utf8'))).toEqual(quality);
  const payloads: any[] = [];
  globalThis.fetch = (async (_input: any, init: any) => {
    payloads.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ english_slug: 'fixture', triage: 'reference', validation_contract: null, wechat_reply: '合成回复。', companion_note_markdown: '合成伴读。' }) } }] });
  }) as unknown as typeof fetch;
  const result = await analyzeArticleWithVault({ config: cfg, article, userNotes: '', vaultContext: { nowSummary: '', queueSummary: '', topicsOverview: '', matchedNotes: [] } });
  expect(payloads).toHaveLength(1);
  expect(payloads[0].messages[0].content).toContain(reason);
  expect(JSON.parse(payloads[0].messages[1].content).article.extraction_quality).toEqual(quality);
  expect(result.companion_note_markdown).toContain("合成伴读。");
  expect(result.wechat_reply).toContain(extractionNotice(quality));
  expect(result.companion_note_markdown).toContain(extractionNotice(quality));
});
