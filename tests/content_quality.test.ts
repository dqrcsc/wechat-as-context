import './support/isolation.ts';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { extractStructuredTextFromImageCards } from '../src/extractor/asr.ts';
const savedFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=savedFetch;});
function config(){const root=mkdtempSync(join(tmpdir(),'quality-'));return loadConfig({IGNORE_HOME_DOTENV:'true',VAULT_ROOT:'none',WECHAT_CONTEXT_DATA_DIR:root,LLM_API_KEY:'fixture',LLM_PROVIDER:'custom',LLM_BASE_URL:'https://model.example.test/v1',LLM_MODEL:'fixture'},root);}
const urls=Array.from({length:9},(_,i)=>`https://images.example.test/${i+1}.jpg`);
function mockOcr(options:{badImage?:number;omit?:number;duplicate?:number}={}){
 const batches:number[][]=[];
 globalThis.fetch=(async(url:any,init:any)=>{
  if(String(url).includes('images.example.test'))return new Response(new Uint8Array(256).fill(1),{status:Number(String(url).match(/(\d+)\.jpg/)?.[1])===options.badImage?403:200,headers:{'content-type':'image/jpeg'}});
  const body=JSON.parse(init.body);const content=body.messages[1].content;
  const pages=content.filter((p:any)=>p.type==='text'&&/^页码：/.test(p.text)).map((p:any)=>Number(p.text.slice(3)));batches.push(pages);
  const result=pages.filter((n:number)=>n!==options.omit).map((page:number)=>({page,text:`页${page}正文`}));
  if(options.duplicate&&pages.includes(options.duplicate))result.push({page:options.duplicate,text:'重复页'});
  return Response.json({choices:[{message:{content:JSON.stringify({pages:result})}}]});
 }) as unknown as unknown as typeof fetch;
 return batches;
}
test('nine-card OCR covers all pages in bounded batches',async()=>{
 const batches=mockOcr();const result:any=await extractStructuredTextFromImageCards({imageUrls:urls,noteTitle:'fixture',noteDesc:'',refererUrl:'https://www.xiaohongshu.com/',config:config()});
 expect(batches).toEqual([[1,2,3,4,5,6],[7,8,9]]);expect(result.quality.processedPages).toEqual([1,2,3,4,5,6,7,8,9]);expect(result.text).toContain('页9正文');
});
test('bad downloads and omitted OCR pages are explicit partial coverage',async()=>{
 mockOcr({badImage:2,omit:8,duplicate:9});const result:any=await extractStructuredTextFromImageCards({imageUrls:urls,noteTitle:'fixture',noteDesc:'',refererUrl:'https://www.xiaohongshu.com/',config:config()});
 expect(result.quality.status).toBe('partial');expect(result.quality.missingPages).toEqual([2,8,9]);expect(result.text).toContain('未解析页：2、8、9');expect(result.text).not.toContain('重复页');
});

import { extractYouTubeVideo } from '../src/extractor/youtube.ts';
function youtubeMock(mode:'audio403'|'caption403'|'caption'|'none') {
 const player:any={videoDetails:{title:'Video',author:'Author',shortDescription:'Only a description',lengthSeconds:'747'}};
 if(mode==='audio403')player.streamingData={adaptiveFormats:[{mimeType:'audio/mp4',url:'https://audio.example.test/fixture'}]};
 if(mode.startsWith('caption'))player.captions={playerCaptionsTracklistRenderer:{captionTracks:[{languageCode:'en',baseUrl:'https://captions.example.test/fixture'}]}};
 globalThis.fetch=(async(url:any)=>{
  if(String(url).includes('youtube.com/watch'))return new Response(`<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`);
  if(String(url).includes('captions')&&mode==='caption')return new Response('<transcript><text start="0" dur="2">Actual transcript.</text></transcript>');
  return new Response('denied',{status:403});
 }) as unknown as unknown as typeof fetch;
}
for(const [mode,reason] of [['audio403','audio_http_403'],['caption403','caption_http_403'],['none','caption_track_not_found']] as const){
 test(`YouTube ${mode} records observed failure without claiming subtitles are unavailable at source`,async()=>{
  youtubeMock(mode);const r=await extractYouTubeVideo('https://www.youtube.com/watch?v=abcdefghijk','','','',{config:config()});
  expect(r.extractionQuality?.status).toBe('metadata_only');expect(r.extractionQuality?.reasons).toContain(reason);
  expect(r.markdownBody).toContain('本次未取得逐字稿');expect(r.markdownBody).not.toContain('未开放');
 });
}
test('YouTube acquired captions are not marked as metadata-only',async()=>{
 youtubeMock('caption');const r=await extractYouTubeVideo('https://www.youtube.com/watch?v=abcdefghijk');expect(r.extractionQuality?.status).toBe('complete');expect(r.markdownBody).toContain('Actual transcript.');
});
test('YouTube LOGIN_REQUIRED extracts ytInitialData metadata and rejects empty login shells',async()=>{
 const initialData={
  currentVideoEndpoint:{watchEndpoint:{videoId:'j2VzCwJ7of8'}},
  contents:{twoColumnWatchNextResults:{results:{results:{contents:[
   {videoPrimaryInfoRenderer:{title:{runs:[{text:'易论AI访谈杨攀 宋勰睿'}]},dateText:{simpleText:'2026年10月30日'}}},
   {videoSecondaryInfoRenderer:{owner:{videoOwnerRenderer:{title:{runs:[{text:'易论AI'}]}}}}}
  ]}}}},
  engagementPanels:[{engagementPanelSectionListRenderer:{panelIdentifier:'engagement-panel-structured-description',content:{structuredDescriptionContentRenderer:{items:[{expandableVideoDescriptionBodyRenderer:{attributedDescriptionBodyText:{content:'Personal Agent 深度访谈简介与7个核心问题。'}}}]}}}}]
 };
 globalThis.fetch=(async(url:any)=>{
  if(String(url).includes('youtube.com/watch'))return new Response(`<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"请登录，以便我们确认你不是聊天机器人"}}; var ytInitialData = ${JSON.stringify(initialData)};</script>`);
  return new Response('denied',{status:403});
 }) as unknown as typeof fetch;
 const r=await extractYouTubeVideo('https://youtu.be/j2VzCwJ7of8?si=fixture','YouTube Video (j2VzCwJ7of8)','YouTube Channel','',{config:config()});
 expect(r.title).toBe('易论AI访谈杨攀 宋勰睿');expect(r.author).toBe('易论AI');expect(r.publishDate).toBe('2026-10-30');
 expect(r.markdownBody).toContain('Personal Agent 深度访谈简介与7个核心问题。');expect(r.extractionQuality?.reasons).toContain('login_required');
 const mismatched={...initialData,currentVideoEndpoint:{watchEndpoint:{videoId:'otherVideo1'}}};
 globalThis.fetch=(async(url:any)=>{
  if(String(url).includes('youtube.com/watch'))return new Response(`<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED"}}; var ytInitialData = ${JSON.stringify(mismatched)};</script>`);
  return new Response('denied',{status:403});
 }) as unknown as typeof fetch;
 await expect(extractYouTubeVideo('https://youtu.be/j2VzCwJ7of8','YouTube Video (j2VzCwJ7of8)','YouTube Channel','',{config:config()})).rejects.toThrow('Failed to extract YouTube video content');
});

import { extractGeneralWebArticle } from '../src/extractor/web.ts';
for(const [metadata,expected] of [
 ['<meta content="2026-10-03T23:00:00-07:00" property="article:published_time">','2026-10-03'],
 ['<script type="application/ld+json">{"@type":"BlogPosting","datePublished":"2026-10-03"}</script>','2026-10-03'],
 ['<time datetime="2026-10-03">Oct 3, 2026</time>','2026-10-03'],
 ['<meta property="article:published_time" content="2026-02-30">',''],
 ['', ''],
] as const){test(`web publication date uses source or unknown: ${metadata}`,async()=>{
 globalThis.fetch=(async()=>new Response(`<html><article>${metadata}<h1>Title</h1><p>${'Body with unrelated 2025 references. '.repeat(20)}</p></article></html>`)) as unknown as unknown as typeof fetch;
 expect((await extractGeneralWebArticle('https://news.example.test/article')).publishDate).toBe(expected);
});}
test('Medium byline date differs from collection date',async()=>{
 globalThis.fetch=(async()=>new Response(`<article><h1>Title</h1><p>4 min read·</p><span>Oct 3, 2026</span><p>${'Actual body. '.repeat(30)}</p></article>`)) as unknown as unknown as typeof fetch;
 expect((await extractGeneralWebArticle('https://medium.com/test/article')).publishDate).toBe('2026-10-03');
});

import { analyzeArticleWithVault } from '../src/vault/analyzer.ts';
const articleFixture={title:'Only title',url:'https://news.example.test/article',author:'Author',publishDate:'',digest:'body',markdownBody:'Body evidence.',imageUrls:[],extractorUsed:'native_http' as const};
const emptyVault={nowSummary:'',queueSummary:'',topicsOverview:'',matchedNotes:[]};
const brief='💧 脱水干货：核心观点。\n💡 观点碰撞：适用边界。\n🏢 业务与规划启发：需验证。\n🔍 边界与待验证：证据有限。\n🚦 分诊与下一步：待研究。';
function analysisOutput(reply:string){return {english_slug:'fixture',triage:'process_later',validation_contract:null,wechat_reply:reply,companion_note_markdown:'## 脱水干货\n详细证据必须保留。'};}
test('blank/title-only annotations do not produce an empty annotation module',async()=>{
 globalThis.fetch=(async()=>Response.json({choices:[{message:{content:JSON.stringify(analysisOutput('🎯 批注回应：无额外批注，直接进入分析。\n\n'+brief))}}]})) as unknown as unknown as typeof fetch;
 for(const userNotes of ['', '[链接] Only title']){const r=await analyzeArticleWithVault({config:config(),article:articleFixture,userNotes,vaultContext:emptyVault});expect(r.wechat_reply).not.toContain('批注回应');}
});
test('one bounded compression preserves full companion and triage',async()=>{
 let calls=0;globalThis.fetch=(async()=>Response.json({choices:[{message:{content:JSON.stringify(++calls===1?analysisOutput(brief.replace('核心观点。', '核心观点。'+'重复解释。'.repeat(170))):{wechat_reply:brief,triage:'keep_raw',companion_note_markdown:'伪造替换'})}}]})) as unknown as unknown as typeof fetch;
 const r=await analyzeArticleWithVault({config:config(),article:articleFixture,userNotes:'',vaultContext:emptyVault});
 expect(calls).toBe(2);expect(r.wechat_reply.length).toBeLessThanOrEqual(650);expect(r.companion_note_markdown).toContain('详细证据必须保留');expect(r.triage).toBe('process_later');
});
test('failed compression retains evidence and explicitly reports long output without a retry loop',async()=>{
 let calls=0;globalThis.fetch=(async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify(analysisOutput(brief+'重复解释。'.repeat(170)+'结尾重要条件'))}}]});}) as unknown as unknown as typeof fetch;
 const r=await analyzeArticleWithVault({config:config(),article:articleFixture,userNotes:'',vaultContext:emptyVault});expect(calls).toBe(2);expect(r.wechat_reply).toContain('结尾重要条件');expect(r.wechat_reply).toContain('未压缩到手机短版');
});

import { parseWeChatHtmlToArticle } from '../src/extractor/wechat.ts';
import { sanitizeSharedLinkMessage } from '../src/extractor/sanitizer.ts';
test('WeChat trailing reward UI is removed while mentions inside prose survive',()=>{
 const body='正文解释正在加载的交互状态，用户也可以关闭窗口。'.repeat(4);
 const r=parseWeChatHtmlToArticle(`<h1 id="activity-name">Title</h1><div id="js_content"><p>${body}</p><p><strong>微信扫一扫赞赏作者</strong>喜欢作者</p><p>关闭</p><p>0人付费</p><p>正在加载...</p></div>`,'https://mp.weixin.qq.com/s/fixture');
 expect(r?.markdownBody).toContain(body);expect(r?.markdownBody).not.toContain('赞赏作者');expect(r?.markdownBody).not.toContain('0人付费');
});
test('Douyin share trailer is not an annotation; real comments and standalone time survive',()=>{
 const share='8.23 复制打开抖音，看看【作者的作品】正文标题 https://v.douyin.com/fixture/ :4pm 02/21 o@D.uf VLw:/';
 expect(sanitizeSharedLinkMessage(share).userNotes).toBe('');expect(sanitizeSharedLinkMessage(share+'\n请关注验证方法').userNotes).toBe('请关注验证方法');
 expect(sanitizeSharedLinkMessage('https://v.douyin.com/fixture/ 明天下午4pm讨论').userNotes).toContain('4pm');
});

import { normalizeTranscriptPunctuation, renderAsrTranscript } from '../src/extractor/transcript_text.ts';
test('ASR punctuation cleanup preserves names, numbers and the escaped original',()=>{
 const raw='Codeex 0.5%。，绿政？。原词<details>，？，结束';
 const clean=normalizeTranscriptPunctuation(raw);expect(clean).toContain('Codeex 0.5%。绿政？');expect(clean.replace(/[，。！？；、]/g,'')).toBe(raw.replace(/[，。！？；、]/g,''));
 const saved=renderAsrTranscript(raw);expect(saved).toContain('原始自动转写');expect(saved).toContain('Codeex 0.5%。，绿政？。原词&lt;details&gt;');expect(saved).toContain('未自动猜改');
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { downloadMediaStream, setAsrTestRunner } from '../src/extractor/asr.ts';
import { extractionNotice, readSavedExtractionQuality } from '../src/extractor/quality.ts';
import { extractPublicationDate, savedPublicationDate } from '../src/extractor/publication_date.ts';
import { saveRawWebArticleToVault } from '../src/extractor/web.ts';
import { extractXiaohongshuNote, extractDouyinWork } from '../src/extractor/social_media.ts';
import { ContextDatabase } from '../src/db.ts';
import { WeChatContextPipeline } from '../src/pipeline.ts';
import { applyValidationContract } from '../src/vault/validation_contract.ts';
afterEach(()=>setAsrTestRunner(null));

test('OCR has explicit empty/unconfigured and bounded page-limit outcomes',async()=>{
 const noImages=await extractStructuredTextFromImageCards({imageUrls:[],noteTitle:'',noteDesc:'',refererUrl:''});
 expect(noImages.text).toBe('');expect(noImages.quality.reasons).toContain('no_images');
 const noKey=await extractStructuredTextFromImageCards({imageUrls:urls,noteTitle:'',noteDesc:'',refererUrl:''});
 expect(noKey.quality.status).toBe('unavailable');expect(noKey.quality.missingPages).toHaveLength(9);expect(noKey.quality.reasons).toContain('ocr_not_configured');
 const batches=mockOcr();const limited=await extractStructuredTextFromImageCards({imageUrls:Array.from({length:61},(_,i)=>`https://images.example.test/${i+1}.jpg`),noteTitle:'',noteDesc:'',refererUrl:'https://example.test',config:config()});
 expect(batches).toHaveLength(10);expect(limited.quality.processedPages).toHaveLength(60);expect(limited.quality.missingPages).toEqual([61]);expect(limited.quality.reasons).toContain('page_limit_60');
});
for(const mode of ['oversize','wrong_type','ocr_error','malformed'] as const){
 test(`OCR ${mode} cannot become complete coverage`,async()=>{
  globalThis.fetch=(async(url:any)=>String(url).includes('images.example.test')?
   new Response(new Uint8Array(mode==='oversize'?6*1024*1024+1:256),{headers:{'content-type':mode==='wrong_type'?'text/html':'image/jpeg'}}):
   mode==='ocr_error'?new Response('',{status:400}):Response.json({choices:[{message:{content:'not JSON'}}]})) as unknown as typeof fetch;
  const r=await extractStructuredTextFromImageCards({imageUrls:urls.slice(0,1),noteTitle:'',noteDesc:'',refererUrl:'https://example.test',config:config()});
  expect(r.quality.status).toBe('unavailable');expect(r.quality.missingPages).toEqual([1]);expect(r.quality.reasons.length).toBeGreaterThan(0);
 });
}
for(const platform of ['xhs','douyin'] as const){test(`${platform} gallery retains ninth-page coverage through source persistence`,async()=>{
 const cfg=config();const batches=mockOcr({omit:8});const imageFetch=globalThis.fetch;
 const id=platform==='xhs'?'66aabbcc1122':'7399887766554433221';
 const url=platform==='xhs'?`https://www.xiaohongshu.com/explore/${id}`:`https://www.douyin.com/video/${id}`;
 const state=platform==='xhs'?{note:{firstNoteId:id,noteDetailMap:{[id]:{note:{noteId:id,type:'normal',title:'Gallery',desc:'Fixture gallery',imageList:urls.map(urlDefault=>({urlDefault}))}}}}}:{page:{aweme:{detail:{aweme_id:id,desc:'Fixture gallery',images:urls.map(url=>({url_list:[url]}))}}}};
 const html=platform==='xhs'?`<script>window.__INITIAL_STATE__=${JSON.stringify(state)};</script>`:`<script id="RENDER_DATA">${encodeURIComponent(JSON.stringify(state))}</script>`;
 globalThis.fetch=(async(input:any,init:any)=>String(input)===url?new Response(html):imageFetch(input,init)) as unknown as typeof fetch;
 const r=await (platform==='xhs'?extractXiaohongshuNote:extractDouyinWork)(url,'','','',{config:cfg});
 expect(batches).toHaveLength(2);expect(r.markdownBody).toContain('页9正文');expect(r.extractionQuality?.missingPages).toEqual([8]);
 const path=await saveRawWebArticleToVault({articlesDir:join(cfg.dataDir,'articles'),article:r,slug:'gallery'});
 const source=readFileSync(path,'utf8');expect(readSavedExtractionQuality(source)).toEqual(r.extractionQuality);expect(source).toContain('captured_timezone: UTC');expect(source).toContain('未知（未取得可信来源日期）');
});}

for (const mode of ['stream','size','short','abort','cancel'] as const){test(`media ${mode} retains download-stage failure and cleans incomplete file`,async()=>{
 const target=join(config().dataDir,'audio.bin');const controller=new AbortController();
 globalThis.fetch=(async()=>{
  if(mode==='stream')return new Response(new ReadableStream({start(c){c.error(new Error('secret upstream details'));}}));
  if(mode==='cancel')return new Response(new ReadableStream({cancel(){throw new Error('cancel failed');}}),{status:403});
  if(mode==='abort')controller.abort();
  return new Response(new Uint8Array(mode==='short'?10:600));
 }) as unknown as typeof fetch;
 const reason={stream:'stream_or_write_failed',size:'size_limit',short:'empty_or_invalid',abort:'timeout_or_abort',cancel:'http_403'}[mode];
 await expect(downloadMediaStream('https://audio.example.test/file',target,{}, {maxBytes:500,signal:controller.signal})).rejects.toThrow(`Media download failed: ${reason}`);
 expect(existsSync(target)).toBe(false);
});}

test('YouTube ASR success preserves raw punctuation while caption errors remain diagnostic',async()=>{
 youtubeMock('audio403');setAsrTestRunner(async()=>({transcript:'专名 Codeex。，原话结束。',engineUsed:'local_funasr'}));
 const r=await extractYouTubeVideo('https://www.youtube.com/watch?v=abcdefghijk','','','',{config:config()});
 expect(r.extractionQuality?.status).toBe('complete');expect(r.markdownBody).toContain('专名 Codeex。原话结束。');expect(r.markdownBody).toContain('专名 Codeex。，原话结束。');expect(r.markdownBody).toContain('原始自动转写');
});

test('dates ignore recommendation/sidebar dates and conflicting article metadata',()=>{
 expect(extractPublicationDate('<article>Undated body</article><aside><time datetime="2025-01-02">Other post</time></aside>',articleFixture.url)).toBe('');
 expect(extractPublicationDate('<script type="application/ld+json">{"@type":"Article","url":"/other","datePublished":"2026-10-03"}</script>',articleFixture.url)).toBe('');
 expect(extractPublicationDate('<script type="application/ld+json">[{"@type":"Article","datePublished":"2026-10-03"},{"@type":"Article","datePublished":"2026-10-04"}]</script>',articleFixture.url)).toBe('');
});
for(const published of ['', 'Published Time: 2026-10-03T10:00:00Z\n']){test(`Jina fallback date is source-only: ${published || 'unknown'}`,async()=>{
 globalThis.fetch=(async(url:any)=>String(url).includes('r.jina.ai')?new Response(`Title: Fixture\n${published}Markdown Content:\n${'Body evidence. '.repeat(30)}`):new Response('denied',{status:403})) as unknown as typeof fetch;
 const r=await extractGeneralWebArticle(articleFixture.url,'','','',{allowJinaFallback:true});expect(r.publishDate).toBe(published?'2026-10-03':'');
});}

test('malformed or contradictory saved quality fails visibly; legacy unknown stays unknown',()=>{
 for(const raw of ['{bad}',JSON.stringify({status:'complete',reasons:[],totalPages:2,processedPages:[1],missingPages:[2]}),JSON.stringify({status:'partial',reasons:[],totalPages:2,processedPages:[1],missingPages:[1]})]){
  const q=readSavedExtractionQuality(`---\nextraction_quality: ${raw}\n---\nBody`);expect(q?.status).toBe('unavailable');expect(extractionNotice(q)).not.toContain('字幕');
 }
 expect(readSavedExtractionQuality('---\ntranscript_engine: "metadata_only"\n---\nBody')?.reasons).toEqual(['legacy_reason_unknown']);expect(readSavedExtractionQuality('Body')).toBeUndefined();
});

test('saved partial quality and unknown date survive process, reanalysis and show without modifying source or failed records',async()=>{
 const cfg=config();const quality={status:'partial' as const,reasons:['ocr_missing_or_invalid_page'],totalPages:9,processedPages:[1,2,3,4,5,6,7,9],missingPages:[8]};
 const source=await saveRawWebArticleToVault({articlesDir:join(cfg.dataDir,'articles'),article:{...articleFixture,extractionQuality:quality},slug:'source'});
 const original=readFileSync(source,'utf8');expect(savedPublicationDate(original)).toBe('');
 const db=new ContextDatabase(cfg.dbPath);try{
  for(let i=0;i<17;i++)db.db.query("INSERT INTO reply_outbox(id,recipient,text,status,attempts,error) VALUES(?,?,?,'failed',3,'historical')").run(`history-${i}`,'test-user','synthetic old failure');
  const failures=JSON.stringify(db.db.query("SELECT * FROM reply_outbox WHERE status='failed' ORDER BY id").all());
  const row=db.enqueueArticle({msgid:'quality-fixture',url:articleFixture.url,channel:'clawbot',sender_id:'test-user'}).record;
  db.updateArticle(row.id,{source_md_path:source,title:articleFixture.title});
  const requests:any[]=[];globalThis.fetch=(async(_url:any,init:any)=>{requests.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:JSON.stringify(analysisOutput(brief))}}]});}) as unknown as typeof fetch;
  const pipeline=new WeChatContextPipeline(cfg,db);const processed=await pipeline.processArticleById(row.id);
  expect(processed.short_summary).toContain('未解析页：8');expect(readFileSync(processed.note_md_path,'utf8')).toContain('未解析页：8');
  await pipeline.reanalyzeArticleById(row.id,{force:true});
  expect(requests).toHaveLength(2);for(const request of requests){const input=JSON.parse(request.messages[1].content);expect(input.article.extraction_quality).toEqual(quality);expect(input.article.publishDate).toBe('');}
  expect(readFileSync(source,'utf8')).toBe(original);
  const proc=Bun.spawnSync([process.execPath,'--no-env-file',join(import.meta.dir,'../src/cli.ts'),'show',String(row.id),'--json'],{env:{PATH:process.env.PATH,IGNORE_HOME_DOTENV:'true',VAULT_ROOT:'none',WECHAT_CONTEXT_DATA_DIR:cfg.dataDir}});
  expect(proc.exitCode).toBe(0);expect(JSON.parse(proc.stdout.toString()).extractionQuality).toEqual(quality);
  expect(JSON.stringify(db.db.query("SELECT * FROM reply_outbox WHERE status='failed' ORDER BY id").all())).toBe(failures);
  const replies=db.db.query("SELECT status, attempts FROM reply_outbox WHERE status!='failed'").all() as any[];expect(replies.every(r=>r.status==='pending'&&r.attempts===0)).toBe(true);
 }finally{db.db.close();}
});

test('compression preserves exact metrics, conditions, boundaries and visible triage',async()=>{
 const compact='💧 脱水干货：观点。\n💡 观点碰撞：补充。\n🏢 业务与规划启发：同一批案例，只改表达，独立复核。\n{{VALIDATION_CONTRACT}}\n🔍 边界与待验证：样本有限。\n🚦 分诊与下一步：process_later，先验证。';
 const contract={metrics:[{name:'准确率',numerator:'正确数',denominator:'样本数',direction:'increase',minimum_gain:{unit:'relative_percent',value:15}}]};
 const initial={...analysisOutput(compact.replace('观点。','观点。'+'重复解释。'.repeat(170))),validation_contract:contract,companion_note_markdown:'## 业务与规划启发\n同一批案例，只改表达，独立复核。\n{{VALIDATION_CONTRACT}}\n## 下一步\n详细证据。'};
 let calls=0;globalThis.fetch=(async()=>Response.json({choices:[{message:{content:JSON.stringify(++calls===1?initial:{wechat_reply:compact,validation_contract:null})}}]})) as unknown as typeof fetch;
 const r=await analyzeArticleWithVault({config:config(),article:articleFixture,userNotes:'',vaultContext:emptyVault});
 const expected=applyValidationContract({...initial,wechat_reply:compact});expect(calls).toBe(2);expect(r.wechat_reply).toBe(expected.wechat_reply);expect(r.companion_note_markdown).toBe(expected.companion_note_markdown);expect(Array.from(r.wechat_reply).length).toBeLessThanOrEqual(650);
});
for(const change of ['business','boundary','triage','http','malformed'] as const){test(`compression rejects ${change} regression and retains original conditions`,async()=>{
 const original=brief.replace('核心观点。','核心观点。'+'重复解释。'.repeat(170));let calls=0;
 const candidate=change==='business'?brief.replace('需验证。','直接上线。'):change==='boundary'?brief.replace('证据有限。','完全成立。'):brief.replace('待研究。','reference，无需验证。');
 globalThis.fetch=(async()=>{calls++;if(calls===2&&change==='http')return new Response('',{status:400});return Response.json({choices:[{message:{content:calls===1?JSON.stringify(analysisOutput(original)):change==='malformed'?'invalid':JSON.stringify({wechat_reply:candidate})}}]});}) as unknown as typeof fetch;
 const r=await analyzeArticleWithVault({config:config(),article:articleFixture,userNotes:'',vaultContext:emptyVault});expect(calls).toBe(2);expect(r.wechat_reply).toStartWith(original);expect(r.wechat_reply).toContain('未压缩到手机短版');
});}
test('quoting WeChat reward UI before continuing an article does not delete the continuation',()=>{
 const r=parseWeChatHtmlToArticle(`<div id="js_content"><p>${'正文解释。'.repeat(20)}</p><p>微信扫一扫赞赏作者</p><p>关闭</p><p>以上是界面文字，下面继续正文。</p><p>重要结论不可丢失。</p></div>`,'https://mp.weixin.qq.com/s/fixture');expect(r?.markdownBody).toContain('重要结论不可丢失。');
});

for(const addition of ['业务验证：无需复核，可以直接上线。\n', '无需复核，可以直接上线。\n']){test(`compression cannot add a second set of conditions: ${addition}`,async()=>{
 const original=brief.replace('核心观点。','核心观点。'+'重复解释。'.repeat(170));let calls=0;
 globalThis.fetch=(async()=>Response.json({choices:[{message:{content:JSON.stringify(++calls===1?analysisOutput(original):{wechat_reply:addition+brief})}}]})) as unknown as typeof fetch;
 const r=await analyzeArticleWithVault({config:config(),article:articleFixture,userNotes:'',vaultContext:emptyVault});
 expect(calls).toBe(2);expect(r.wechat_reply).toStartWith(original);expect(r.wechat_reply).not.toContain('直接上线');expect(r.wechat_reply).toContain('未压缩到手机短版');
});}

for (const source of ['web', 'android'] as const) {
  test(`YouTube rejects all data from conflicting ${source} player before merging`, async () => {
    const player = (id: string) => ({videoDetails: {videoId: id, title: id, shortDescription: 'description'},
      captions: {playerCaptionsTracklistRenderer: {captionTracks: [{languageCode: 'en', baseUrl: `https://captions.example.test/${id}`}]}},
      streamingData: {adaptiveFormats: [{mimeType: 'audio/mp4', url: `https://audio.example.test/${id}`}]}});
    const calls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      const target = String(url); calls.push(target);
      if (target.includes('youtube.com/watch')) return new Response(`<meta property="og:title" content="A title"><script>var ytInitialPlayerResponse=${JSON.stringify(player(source === 'web' ? 'zzzzzzzzzzz' : 'abcdefghijk'))};</script>"INNERTUBE_API_KEY":"fixture"`);
      if (target.includes('youtubei')) return Response.json(source === 'android' ? player('zzzzzzzzzzz') : {playabilityStatus: {status: 'LOGIN_REQUIRED'}});
      if (target.includes('captions')) return new Response('<transcript><text start="0" dur="1">Correct A transcript</text></transcript>');
      return new Response('', {status: 403});
    }) as unknown as typeof fetch;
    const result = await extractYouTubeVideo('https://www.youtube.com/watch?v=abcdefghijk');
    expect(calls.some(url => url.includes('zzzzzzzzzzz'))).toBe(false);
    expect(result.extractionQuality?.reasons).toContain(`${source}_player_video_id_mismatch`);
    expect(result.extractionQuality?.status).toBe(source === 'web' ? 'metadata_only' : 'complete');
    if (source === 'android') expect(result.markdownBody).toContain('Correct A transcript');
  });
}
