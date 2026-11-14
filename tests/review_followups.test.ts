import './support/isolation.ts';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { ContextDatabase } from '../src/db.ts';
import { AsrUnavailableError, asrFailureReasons, MediaDownloadError, transcribeAudioFromMedia } from '../src/extractor/asr.ts';
import { describeMediaTools, findMediaToolBinary } from '../src/extractor/tool_binary.ts';
import { htmlToCleanMarkdownWithImages, toSafeMarkdownHref } from '../src/extractor/wechat.ts';
import { saveRawWebArticleToVault } from '../src/extractor/web.ts';
import { isPlaceholderYouTubeTitle } from '../src/extractor/youtube.ts';
import { compareKnownSizeFirst } from '../src/extractor/youtube_fallback.ts';
import { WeChatContextPipeline } from '../src/pipeline.ts';
import { renderSchedulerManagedBlock } from '../src/scheduler/vault_sync.ts';
import type { ScheduledTaskRecord } from '../src/db.ts';

const savedFetch = globalThis.fetch;
const savedEnv = { FFMPEG_BIN: process.env.FFMPEG_BIN, LOCAL_ASR_BIN: process.env.LOCAL_ASR_BIN };
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function config(model = 'fixture') {
  const root = mkdtempSync(join(tmpdir(), 'followup-'));
  return loadConfig({ IGNORE_HOME_DOTENV: 'true', VAULT_ROOT: 'none', WECHAT_CONTEXT_DATA_DIR: root,
    LLM_API_KEY: 'fixture', LLM_PROVIDER: 'custom', LLM_BASE_URL: 'https://model.example.test/v1', LLM_MODEL: model }, root);
}

// ---------------------------------------------------------------- ASR tool overrides

test('invalid ffmpeg/local-asr overrides do not block the cloud ASR fallback and stay diagnosable', async () => {
  process.env.FFMPEG_BIN = 'ffmpeg';               // bare name: not looked up on PATH
  process.env.LOCAL_ASR_BIN = '~/missing-local-asr';
  const media = join(mkdtempSync(join(tmpdir(), 'asr-media-')), 'clip.mp4');
  writeFileSync(media, new Uint8Array(2048).fill(7));
  const requests: string[] = [];
  globalThis.fetch = (async (url: any) => {
    requests.push(String(url));
    return Response.json({ candidates: [{ content: { parts: [{ text: '云端转写成功的逐字稿内容。' }] } }] });
  }) as unknown as typeof fetch;
  const result = await transcribeAudioFromMedia({ mediaPath: media, config: config('gemini-fixture') });
  expect(result.transcript).toBe('云端转写成功的逐字稿内容。');
  expect(result.engineUsed).toBe('gemini_audio:gemini-fixture');
  expect(result.toolIssues).toEqual(['ffmpeg_invalid_path', 'local-asr_not_found']);
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('missing-local-asr');
});

test('when every engine fails the sanitized tool issues are surfaced as acquisition reasons', async () => {
  process.env.LOCAL_ASR_BIN = '~/missing-local-asr';
  const media = join(mkdtempSync(join(tmpdir(), 'asr-media-')), 'clip.mp4');
  writeFileSync(media, new Uint8Array(2048).fill(7));
  const error = await transcribeAudioFromMedia({ mediaPath: media }).catch(e => e);
  expect(error).toBeInstanceOf(AsrUnavailableError);
  expect(error.message).toContain('Audio transcription unavailable');
  expect(error.message).not.toContain('missing-local-asr');
  expect(asrFailureReasons(error)).toEqual(['asr_failed', 'asr_tool_local-asr_not_found']);
  expect(asrFailureReasons(error, 'resolver_')).toEqual(['resolver_asr_failed', 'resolver_asr_tool_local-asr_not_found']);
  expect(asrFailureReasons(new MediaDownloadError('http_403'), 'resolver_')).toEqual(['resolver_audio_http_403']);
  expect(asrFailureReasons(new Error('other'))).toEqual(['asr_failed']);
});

test('bare tool names report a path-notation problem; existing project files still resolve', () => {
  const project = mkdtempSync(join(tmpdir(), 'project-'));
  expect(() => findMediaToolBinary('yt-dlp', 'yt-dlp', project)).toThrow('yt-dlp_invalid_path');
  expect(() => findMediaToolBinary('yt-dlp', './yt-dlp', project)).toThrow('yt-dlp_not_found');
  writeFileSync(join(project, 'yt-dlp'), 'synthetic; never executed'); chmodSync(join(project, 'yt-dlp'), 0o700);
  expect(findMediaToolBinary('yt-dlp', 'yt-dlp', project)).toBe(join(project, 'yt-dlp'));
});

test('doctor media tool status is read-only and reports invalid overrides without falling back', () => {
  const project = mkdtempSync(join(tmpdir(), 'project-'));
  const ok = join(project, 'bin-ffmpeg'); writeFileSync(ok, 'synthetic'); chmodSync(ok, 0o700);
  const status = describeMediaTools({ YT_DLP_BIN: 'yt-dlp', FFMPEG_BIN: ok, LOCAL_ASR_BIN: '  ' }, project);
  const byTool = Object.fromEntries(status.map(s => [s.tool, s]));
  expect(byTool['yt-dlp']).toMatchObject({ source: 'override', status: 'invalid_override', reason: 'yt-dlp_invalid_path' });
  expect(byTool.ffmpeg).toMatchObject({ source: 'override', status: 'ok', path: ok });
  expect(byTool['local-asr'].source).toBe('default');
  expect(['ok', 'not_installed']).toContain(byTool['local-asr'].status);
});

test('audio formats sort by known size with unknown sizes last and a deterministic order', () => {
  const formats = [{ id: 'a' }, { id: 'b', size: 300 }, { id: 'c', size: 'x' }, { id: 'd', size: 100 }, { id: 'e', size: 0 }];
  expect(formats.slice().sort((x: any, y: any) => compareKnownSizeFirst(x.size, y.size)).map(f => f.id))
    .toEqual(['d', 'b', 'a', 'c', 'e']);
});

// ---------------------------------------------------------------- link safety

test('anchor hrefs are normalized before the scheme check; only http(s)/mailto survive', () => {
  for (const href of ['jav&#x09;ascript:alert(1)', 'java&#10;script:alert(1)', ' JAVASCRIPT:alert(2)',
    '&#106;avascript:alert(3)', 'data:text/html,hi', 'vbscript:x', 'file:///etc/passwd']) {
    expect(toSafeMarkdownHref(href, 'https://medium.com/p/post')).toBeNull();
    expect(toSafeMarkdownHref(href)).toBeNull();
  }
  expect(toSafeMarkdownHref('/tag/a b(1)', 'https://medium.com/p/post')).toBe('https://medium.com/tag/a%20b%281%29');
  expect(toSafeMarkdownHref('mailto:me@example.test')).toBe('mailto:me@example.test');
  expect(toSafeMarkdownHref('#section')).toBe('#section');
  const html = `<p>${'x '.repeat(40)}</p><a href="jav&#x09;ascript:alert(1)">A</a> <a href="https://ok.example/x">B</a>`;
  for (const base of [undefined, 'https://medium.com/p/post']) {
    const markdown = htmlToCleanMarkdownWithImages(html, base).markdown;
    expect(markdown).not.toMatch(/javascript|jav\s*ascript/i);
    expect(markdown).toContain('A [B](https://ok.example/x)');
  }
});

// ---------------------------------------------------------------- scheduler titles

test('scheduler task titles escape Obsidian tag, highlight, strike, math, block-ref and comment syntax', () => {
  const task = { id: 7, status: 'active', schedule_type: 'once', title: '#tag ==hi== ~~s~~ $x$ ^ref %%c%%',
    updated_at: '2026-11-06T00:00:00Z', timezone: 'Asia/Shanghai' } as ScheduledTaskRecord;
  const row = renderSchedulerManagedBlock([task]).split('\n').find(line => line.includes('**#7'))!;
  expect(row).toContain('\\#tag \\=\\=hi\\=\\= \\~\\~s\\~\\~ \\$x\\$ \\^ref \\%\\%c\\%\\%');
});

// ---------------------------------------------------------------- placeholder video reanalysis

const VIDEO_ID = 'abcdefghijk';
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const PLACEHOLDER = `YouTube Video (${VIDEO_ID})`;
const brief = '💧 脱水干货：核心观点。\n💡 观点碰撞：适用边界。\n🏢 业务与规划启发：需验证。\n🔍 边界与待验证：证据有限。\n🚦 分诊与下一步：待研究。';
const modelOk = () => Response.json({ choices: [{ message: { content: JSON.stringify({ english_slug: 'fixture',
  triage: 'process_later', validation_contract: null, wechat_reply: brief, companion_note_markdown: '## 脱水干货\n详细证据必须保留。' }) } }] });
const watchPage = (title: string) => `<script>var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: {
  videoId: VIDEO_ID, title, author: 'Real Channel', shortDescription: 'Real public description.' } })};</script>`;

async function placeholderFixture(options: { title?: string; metadataOnly?: boolean; body?: string } = {}) {
  const cfg = config();
  const metadataOnly = options.metadataOnly ?? true;
  const source = await saveRawWebArticleToVault({
    articlesDir: join(cfg.dataDir, 'video'), slug: 'placeholder',
    article: { title: options.title ?? PLACEHOLDER, url: VIDEO_URL, author: 'YouTube Channel', publishDate: '', digest: '',
      markdownBody: options.body ?? (metadataOnly ? '## 视频简介\n\n> ⚠️ 本次未取得逐字稿。' : '## 逐字稿\n\n已经取得的完整逐字稿内容。'),
      imageUrls: [], extractorUsed: 'native_http', mediaKind: 'video',
      transcriptEngine: metadataOnly ? 'metadata_only' : '音频自动转写 (fixture)',
      extractionQuality: { status: metadataOnly ? 'metadata_only' : 'complete', reasons: metadataOnly ? ['login_required'] : [] } } as any,
  });
  const db = new ContextDatabase(cfg.dbPath);
  const row = db.enqueueArticle({ msgid: `placeholder-${Math.random()}`, url: VIDEO_URL, channel: 'cli' }).record;
  db.updateArticle(row.id, { source_md_path: source, title: options.title ?? PLACEHOLDER });
  return { cfg, db, row, source, original: readFileSync(source, 'utf8') };
}

function routeFetch(youtube: 'real' | 'denied', model: 'ok' | 'offline', calls: string[]) {
  globalThis.fetch = (async (url: any) => {
    const target = String(url); calls.push(target);
    if (target.includes('model.example.test')) {
      if (model === 'offline') throw new Error('fixture offline');
      return modelOk();
    }
    if (target.includes('youtube.com/watch') && youtube === 'real') return new Response(watchPage('Real Video Title'));
    return new Response('denied', { status: 403 });
  }) as unknown as typeof fetch;
}

test('placeholder metadata-only video is refreshed without --force when a real title is recovered', async () => {
  const f = await placeholderFixture();
  try {
    const calls: string[] = []; routeFetch('real', 'ok', calls);
    const result = await new WeChatContextPipeline(f.cfg, f.db).reanalyzeArticleById(f.row.id);
    expect(result.record.title).toBe('Real Video Title');
    expect(result.record.source_md_path).toBe(f.source);
    const source = readFileSync(f.source, 'utf8');
    expect(source).toContain('Real Video Title');
    expect(source).not.toContain(PLACEHOLDER);
  } finally { f.db.db.close(); }
});

test('failed placeholder refresh reuses the saved capture instead of failing or overwriting it', async () => {
  const f = await placeholderFixture();
  try {
    const calls: string[] = []; routeFetch('denied', 'ok', calls);
    const result = await new WeChatContextPipeline(f.cfg, f.db).reanalyzeArticleById(f.row.id);
    expect(calls.some(url => url.includes('youtube.com'))).toBe(true);
    expect(result.isFallback).toBe(false);
    expect(readFileSync(f.source, 'utf8')).toBe(f.original);
  } finally { f.db.db.close(); }
});

test('placeholder title never triggers refetch of a capture that already holds a transcript (no --force)', async () => {
  const f = await placeholderFixture({ metadataOnly: false });
  try {
    const calls: string[] = []; routeFetch('real', 'ok', calls);
    await new WeChatContextPipeline(f.cfg, f.db).reanalyzeArticleById(f.row.id);
    expect(calls.some(url => url.includes('youtube.com'))).toBe(false);
    expect(readFileSync(f.source, 'utf8')).toBe(f.original);
  } finally { f.db.db.close(); }
});

test('a placeholder title quoted in the body is not mistaken for a placeholder frontmatter title', async () => {
  const f = await placeholderFixture({ title: 'Real Saved Title', body: `引用：\ntitle: "${PLACEHOLDER}"\n\n> ⚠️ 本次未取得逐字稿。` });
  try {
    const calls: string[] = []; routeFetch('real', 'ok', calls);
    await new WeChatContextPipeline(f.cfg, f.db).reanalyzeArticleById(f.row.id);
    expect(calls.some(url => url.includes('youtube.com'))).toBe(false);
    expect(readFileSync(f.source, 'utf8')).toBe(f.original);
  } finally { f.db.db.close(); }
});

test('recovered video metadata is persisted even when the model still falls back', async () => {
  const f = await placeholderFixture();
  try {
    const calls: string[] = []; routeFetch('denied', 'offline', calls);
    const pipeline = new WeChatContextPipeline(f.cfg, f.db);
    const first = await pipeline.processArticleById(f.row.id, { sendWeChatReply: false });
    expect(first.short_summary).toContain('未完成模型分析');
    const note = readFileSync(first.note_md_path, 'utf8');

    routeFetch('real', 'offline', calls);
    const result = await pipeline.reanalyzeArticleById(f.row.id);
    expect(result.isFallback).toBe(true);
    expect(result.record.title).toBe('Real Video Title');
    expect(isPlaceholderYouTubeTitle(f.db.getArticleById(f.row.id)!.title)).toBe(false);
    expect(readFileSync(f.source, 'utf8')).toContain('Real Video Title');
    expect(readFileSync(first.note_md_path, 'utf8')).toBe(note);
  } finally { f.db.db.close(); }
});

for (const marker of ['transcript_engine: metadata_only', '暂未获取到视频音频流或转写结果']) {
  test(`complete transcript quoting ${marker} is never refreshed without force`, async () => {
    const f = await placeholderFixture({metadataOnly: false, body: `## 逐字稿\n完整证据。配置示例：${marker}`});
    try {
      const calls: string[] = []; routeFetch('real', 'ok', calls);
      await new WeChatContextPipeline(f.cfg, f.db).reanalyzeArticleById(f.row.id);
      expect(calls.some(url => url.includes('youtube.com'))).toBe(false);
      expect(readFileSync(f.source, 'utf8')).toBe(f.original);
    } finally { f.db.db.close(); }
  });
}

for (const force of [false, true]) for (const model of ['ok', 'offline'] as const) {
  for (const mutation of ['edit', 'delete'] as const) {
    test(`source changes survive placeholder recovery (force=${force}, model=${model}, mutation=${mutation})`, async () => {
      const f = await placeholderFixture();
      try {
        const pipeline = new WeChatContextPipeline(f.cfg, f.db);
        const calls: string[] = []; routeFetch('denied', 'offline', calls);
        const first = await pipeline.processArticleById(f.row.id, {sendWeChatReply: false});
        const note = readFileSync(first.note_md_path, 'utf8');
        let changed = false;
        globalThis.fetch = (async (url: any) => {
          if (String(url).includes('model.example.test')) {
            if (!changed) {
              changed = true;
              if (mutation === 'delete') unlinkSync(f.source);
              else writeFileSync(f.source, f.original + '\n用户新补入的证据');
            }
            if (model === 'offline') throw new Error('fixture offline');
            return modelOk();
          }
          if (String(url).includes('youtube.com/watch')) return new Response(watchPage('Real Video Title'));
          return new Response('', {status: 403});
        }) as unknown as typeof fetch;
        await expect(pipeline.reanalyzeArticleById(f.row.id, {force})).rejects.toThrow('Source changed during analysis');
        if (mutation === 'edit') expect(readFileSync(f.source, 'utf8')).toBe(f.original + '\n用户新补入的证据');
        else expect(() => readFileSync(f.source)).toThrow();
        expect(readFileSync(first.note_md_path, 'utf8')).toBe(note);
        expect(f.db.getArticleById(f.row.id)!.title).toBe(PLACEHOLDER);
      } finally { f.db.db.close(); }
    });
  }
}

test('source edits during image localization are checked immediately before replacement', async () => {
  const f = await placeholderFixture();
  try {
    globalThis.fetch = (async () => {
      writeFileSync(f.source, f.original + '\n图片下载期间新增证据');
      return new Response('', {status: 403});
    }) as unknown as typeof fetch;
    await expect(saveRawWebArticleToVault({articlesDir: join(f.cfg.dataDir, 'video'), existingPath: f.source,
      overwriteExisting: true, expectedExistingContent: f.original, slug: 'fixture', article: {
        title: 'Real', url: VIDEO_URL, author: '', publishDate: '', digest: '', imageUrls: [], extractorUsed: 'native_http',
        markdownBody: '![image](https://images.example.test/cover.jpg)',
      }})).rejects.toThrow('Source changed during analysis');
    expect(readFileSync(f.source, 'utf8')).toBe(f.original + '\n图片下载期间新增证据');
  } finally { f.db.db.close(); }
});

for (const [finishReason, text, status, reason] of [
  ['STOP', '好的，谢谢。', 'partial', undefined],
  ['STOP', 'OK', 'partial', undefined],
  ['MAX_TOKENS', '这是被截断的部分逐字稿。', 'partial', 'asr_truncated'],
  [undefined, '缺少完成状态的正文。', 'partial', 'asr_finish_reason_missing'],
] as const) {
  test(`cloud transcription preserves short/partial output accurately: ${finishReason}/${text}`, async () => {
    const media = join(mkdtempSync(join(tmpdir(), 'asr-quality-')), 'clip.mp4');
    writeFileSync(media, new Uint8Array(1024));
    globalThis.fetch = (async () => Response.json({candidates: [{finishReason, content: {parts: [{text: 'hidden reasoning', thought: true}, {text}]}}]})) as unknown as typeof fetch;
    const result = await transcribeAudioFromMedia({mediaPath: media, config: config('gemini-fixture')});
    expect(result.transcript).toBe(text);
    expect(result.extractionQuality).toMatchObject({status, reasons: reason ? [reason, 'asr_coverage_unverified'] : ['asr_coverage_unverified']});
    expect(result.extractionQuality?.asrEvidence?.[0]).toEqual({engineCompletion: finishReason === 'STOP' ? 'completed' : finishReason === 'MAX_TOKENS' ? 'truncated' : 'unknown', textCharacters: Array.from(text).length, timingAvailable:false});
  });
}
for (const response of [
  {candidates: [{finishReason: 'SAFETY', content: {parts: [{text: 'not a usable transcript'}]}}]},
  {promptFeedback: {blockReason: 'SAFETY'}, candidates: []},
  {candidates: [{finishReason: 'STOP', content: {parts: [{text: '  '} ]}}]},
  {candidates: []},
]) {
  test(`cloud rejection or empty output is not transcript success: ${JSON.stringify(response)}`, async () => {
    const media = join(mkdtempSync(join(tmpdir(), 'asr-quality-')), 'clip.mp4');
    writeFileSync(media, new Uint8Array(1024));
    globalThis.fetch = (async () => Response.json(response)) as unknown as typeof fetch;
    const error = await transcribeAudioFromMedia({mediaPath: media, config: config('gemini-fixture')}).catch(e => e);
    expect(error).toBeInstanceOf(AsrUnavailableError);
    expect(asrFailureReasons(error)).toContain('asr_failed');
    expect(error.reasons.length).toBeGreaterThan(0);
  });
}
for (const force of [false, true]) {
  test(`recovered metadata persists independently of model availability (force=${force})`, async () => {
    const f = await placeholderFixture();
    try {
      const calls: string[] = []; routeFetch('denied', 'offline', calls);
      const pipeline = new WeChatContextPipeline(f.cfg, f.db);
      const first = await pipeline.processArticleById(f.row.id, {sendWeChatReply: false});
      const note = readFileSync(first.note_md_path, 'utf8');
      routeFetch('real', 'offline', calls);
      const result = await pipeline.reanalyzeArticleById(f.row.id, {force});
      expect(result.isFallback).toBe(true);
      expect(result.record.title).toBe('Real Video Title');
      expect(readFileSync(f.source, 'utf8')).toContain('Real Video Title');
      expect(readFileSync(first.note_md_path, 'utf8')).toBe(note);
    } finally { f.db.db.close(); }
  });
}

test('a concurrently created source is not silently reused as the newly extracted source', async () => {
  const f = await placeholderFixture();
  try {
    await expect(saveRawWebArticleToVault({articlesDir: join(f.cfg.dataDir, 'video'), existingPath: f.source,
      expectedExistingContent: null, slug: 'fixture', article: {
        title: 'Real', url: VIDEO_URL, author: '', publishDate: '', digest: '', imageUrls: [], extractorUsed: 'native_http', markdownBody: 'Fresh body',
      }})).rejects.toThrow('Source changed during analysis');
    expect(readFileSync(f.source, 'utf8')).toBe(f.original);
  } finally { f.db.db.close(); }
});

test('explicit complete quality overrides conflicting legacy metadata_only engine', async () => {
  const f = await placeholderFixture({metadataOnly: false});
  try {
    const original = f.original.replace('音频自动转写 (fixture)', 'metadata_only');
    writeFileSync(f.source, original);
    const calls: string[] = []; routeFetch('real', 'ok', calls);
    await new WeChatContextPipeline(f.cfg, f.db).reanalyzeArticleById(f.row.id);
    expect(calls.some(url => url.includes('youtube.com'))).toBe(false);
    expect(readFileSync(f.source, 'utf8')).toBe(original);
  } finally { f.db.db.close(); }
});
