import './support/isolation.ts';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { ContextDatabase } from '../src/db.ts';
import { WeChatContextPipeline } from '../src/pipeline.ts';
import { encryptAes128Ecb } from '../src/clawbot/media.ts';
import { MediaDownloadError, setAsrTestRunner } from '../src/extractor/asr.ts';
import { setSubagentTestRunner } from '../src/agent/subagent_cli.ts';
import { readSavedExtractionQuality } from '../src/extractor/quality.ts';
import { savedPublicationDate } from '../src/extractor/publication_date.ts';
import { extractDouyinWork, extractXiaohongshuNote } from '../src/extractor/social_media.ts';
const savedFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=savedFetch;setAsrTestRunner(null);setSubagentTestRunner(null);});
const raw='专名 Codeex 15%。，原始口播结束。';
async function native(options:{outcomes:string[];mixed?:boolean;idea?:boolean;modelFails?:boolean;fileFails?:boolean;fileFirst?:boolean}){
 const root=mkdtempSync(join(tmpdir(),'video-entry-'));
 const config=loadConfig({IGNORE_HOME_DOTENV:'true',VAULT_ROOT:'none',WECHAT_CONTEXT_DATA_DIR:root},root);
 const db=new ContextDatabase(config.dbPath);const pipeline=new WeChatContextPipeline(config,db);
 for(let i=0;i<17;i++)db.db.query("INSERT INTO reply_outbox(id,recipient,text,status,attempts,error) VALUES(?,?,?,'failed',3,'historical')").run(`old-${i}`,'test-user','synthetic historical failure');
 const failures=JSON.stringify(db.db.query("SELECT * FROM reply_outbox WHERE status='failed' ORDER BY id").all());
 const key=Buffer.alloc(16,1), payload=encryptAes128Ecb(Buffer.alloc(512,2),key);
 const paths:string[]=[],prompts:string[]=[];let asrCalls=0;
 globalThis.fetch=(async(input:any)=>{
  const url=String(input);if(!url.includes('c2c/download'))throw new Error('Unexpected network '+url);
  if(url.includes('text-file')&&options.fileFails)return new Response('',{status:403});
  if(url.includes('video-0')&&options.outcomes[0]==='download')return new Response('',{status:403});
  return new Response(new Uint8Array(payload));
 }) as unknown as typeof fetch;
 setAsrTestRunner(async req=>{paths.push(req.mediaPath!);const outcome=options.outcomes[asrCalls++];if(outcome==='throw')throw new Error('private upstream secret');return {transcript:outcome==='empty'?'':raw,engineUsed:'fixture_asr'};});
 setSubagentTestRunner(async req=>{prompts.push(req.prompt);if(options.modelFails)throw new Error('model unavailable');return {backend:req.backend,modelUsed:'fixture',outputText:'MODEL_SUMMARY',generatedImages:[],generatedFiles:[]};});
 const videos=options.outcomes.map((_,i)=>({type:5,video_item:{aeskey:key.toString('hex'),media:{encrypt_query_param:`video-${i}`}}}));
 const items:any[]=[{type:1,text_item:{text:options.idea?'记为灵感':'请归档视频'}},...videos];
 if(options.mixed){const file={type:4,file_item:{file_name:'note.txt',aeskey:key.toString('hex'),media:{encrypt_query_param:'text-file'}}};if(options.fileFirst)items.splice(1,0,file);else items.push(file);}
 try{
  const result=await pipeline.agent.processClawBotMessage({messageKey:'fixture-native',senderId:'fixture-user',rawMessage:{message_id:'fixture-native',message_type:1,from_user_id:'fixture-user',item_list:items}});
  expect(JSON.stringify(db.db.query("SELECT * FROM reply_outbox WHERE status='failed' ORDER BY id").all())).toBe(failures);
  expect(paths.every(path=>!existsSync(path))).toBe(true);
  return {result,source:result.depositedPath?readFileSync(result.depositedPath,'utf8'):'',prompts,asrCalls};
 }finally{db.db.close();}
}
for(const mode of ['video','mixed','idea'] as const){test(`native ${mode} preserves raw transcript, unknown publication and quality`,async()=>{
 const r=await native({outcomes:['ok'],mixed:mode==='mixed',idea:mode==='idea'});
 expect(r.source).toContain('Codeex 15%。原始口播结束');expect(r.source).toContain(raw);
 expect(readSavedExtractionQuality(r.source)?.status).toBe('complete');expect(readSavedExtractionQuality(r.source)?.totalVideos).toBe(1);
 if(mode==='video'){expect(savedPublicationDate(r.source)).toBe('');expect(r.source).toContain('发布时间**：未知');}
 expect(r.prompts).toHaveLength(1);expect(r.prompts[0]).not.toContain('data-asr-raw');expect(r.prompts[0]).not.toContain(raw);expect(r.prompts[0]).toContain('Codeex 15%。原始口播结束');
});}
for(const outcome of ['empty','throw','download']){test(`native ${outcome} records unavailable without a false success or model guess`,async()=>{
 const r=await native({outcomes:[outcome]});const q=readSavedExtractionQuality(r.source);
 expect(q?.status).toBe('unavailable');expect(q?.missingVideos).toEqual([1]);expect(r.source).not.toContain('private upstream secret');expect(r.prompts).toHaveLength(0);expect(r.result.replyText).not.toContain('已完成视频语音转写');
});}
test('native multiple videos retain successful evidence and missing index',async()=>{
 const r=await native({outcomes:['ok','empty']});const q=readSavedExtractionQuality(r.source);expect(q?.status).toBe('partial');expect(q?.processedVideos).toEqual([1]);expect(q?.missingVideos).toEqual([2]);expect(r.source).toContain(raw);expect(r.result.replyText).toContain('1/2');
});
test('native model failure cannot discard a successful transcript',async()=>{
 const r=await native({outcomes:['ok'],modelFails:true});expect(r.source).toContain(raw);expect(readSavedExtractionQuality(r.source)?.status).toBe('complete');expect(r.result.replyText).toContain('未解析');
});
for(const platform of ['xhs','douyin'] as const)for(const outcome of ['ok','empty','throw','download','no_stream'] as const){test(`${platform} ${outcome} has video-scoped quality and safe date`,async()=>{
 const id=platform==='xhs'?'bbbbbbbbbbbbbbbbbbbbbbbb':'76543210987654321';let calls=0;
 const video=outcome==='no_stream'?{}:{play_addr:{url_list:['https://media.example.test/video.mp4']},media:{stream:{h264:[{masterUrl:'https://media.example.test/video.mp4'}]}}};
 const state=platform==='xhs'?{note:{noteDetailMap:{[id]:{note:{noteId:id,type:'video',title:'Fixture video',desc:'Fixture description',time:'bad',video}}}}}:{loaderData:{page:{videoInfoRes:{item_list:[{aweme_id:id,desc:'Fixture description',create_time:'bad',video}]}}}};
 const html=`<script>window.${platform==='xhs'?'__INITIAL_STATE__':'_ROUTER_DATA'}=${JSON.stringify(state)}</script>`;
 globalThis.fetch=(async()=>new Response(html)) as unknown as typeof fetch;
 setAsrTestRunner(async()=>{calls++;if(outcome==='throw')throw new Error('private token');if(outcome==='download')throw new MediaDownloadError('http_403');return {transcript:outcome==='empty'?'':raw,engineUsed:'fixture'};});
 const r=await (platform==='xhs'?extractXiaohongshuNote:extractDouyinWork)(platform==='xhs'?`https://www.xiaohongshu.com/explore/${id}`:`https://www.douyin.com/video/${id}`);
 expect(r.mediaKind).toBe('video');expect(r.publishDate).toBe('');expect(r.extractionQuality?.status).toBe(outcome==='ok'?'complete':'metadata_only');expect(r.markdownBody).not.toContain('private token');
 if(outcome==='ok')expect(r.markdownBody).toContain(raw);else expect(r.extractionQuality?.reasons.length).toBeGreaterThan(0);
 if(outcome==='no_stream'){expect(calls).toBe(0);expect(r.markdownBody).not.toContain('Vision OCR');}
});}

import { publicationDateFromTimestamp } from '../src/extractor/publication_date.ts';
import { extractionNotice } from '../src/extractor/quality.ts';
import { saveRawWebArticleToVault } from '../src/extractor/web.ts';
import { saveRawArticleToVault } from '../src/extractor/wechat.ts';
import { extractYouTubeVideo } from '../src/extractor/youtube.ts';
for(const mode of ['mixed','idea'] as const)for(const outcomes of [['empty'],['ok','throw'],['ok','ok']]){
 test(`native ${mode} coverage persists for ${outcomes}`,async()=>{
  const r=await native({outcomes,mixed:mode==='mixed',idea:mode==='idea'});const q=readSavedExtractionQuality(r.source)!;
  expect(q.totalVideos).toBe(outcomes.length);expect(q.processedVideos).toEqual(outcomes.flatMap((o,i)=>o==='ok'?[i+1]:[]));
  expect(q.missingVideos).toEqual(outcomes.flatMap((o,i)=>o==='ok'?[]:[i+1]));
  expect(q.status).toBe(outcomes.every(o=>o==='ok')?'complete':outcomes.includes('ok')?'partial':'unavailable');
  if(outcomes.includes('ok'))expect(r.source).toContain(raw);
  if(q.status!=='complete'){expect(r.result.replyText).toContain('未取得转写的视频序号');expect(r.source).toContain('未取得转写的视频序号');}
 });
}
for(const value of [undefined,null,'',0,-1,'bad',Number.POSITIVE_INFINITY,1e30])test(`invalid source timestamp remains unknown: ${value}`,()=>{
 expect(publicationDateFromTimestamp(value,'seconds')).toBe('');expect(publicationDateFromTimestamp(value,'milliseconds')).toBe('');
});
test('valid source timestamps preserve publication independently of capture date',()=>{
 const millis=Date.parse('2025-02-03T12:00:00Z');expect(publicationDateFromTimestamp(millis,'milliseconds')).toBe('2025-02-03');expect(publicationDateFromTimestamp(String(millis/1000),'seconds')).toBe('2025-02-03');
});
test('YouTube invalid publication date is unknown and caption success still has coverage',async()=>{
 const data={videoDetails:{title:'Video',shortDescription:'Fixture'},microformat:{playerMicroformatRenderer:{publishDate:'2026-02-30'}},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{languageCode:'en',baseUrl:'https://captions.example.test/text'}]}}};
 globalThis.fetch=(async(input:any)=>String(input).includes('captions.example.test')?new Response('<transcript><text start="0" dur="2">Caption.</text></transcript>'):new Response(`<script>var ytInitialPlayerResponse = ${JSON.stringify(data)}</script>`)) as unknown as typeof fetch;
 const r=await extractYouTubeVideo('https://www.youtube.com/watch?v=abcdefghijk');expect(r.publishDate).toBe('');expect(r.extractionQuality?.status).toBe('complete');expect(r.markdownBody).not.toContain('原始自动转写');
});
for(const missing of [[1],[2]])test(`native video coverage validator rejects contradictory indices ${missing}`,()=>{
 const q=readSavedExtractionQuality(`---\nextraction_quality: ${JSON.stringify({status:'complete',reasons:[],totalVideos:2,processedVideos:[1],missingVideos:missing})}\n---\nBody`);
 expect(q?.reasons).toEqual(['invalid_saved_quality']);
});
test('video quality roundtrips both source writers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'video-write-'));
 const quality={status:'partial' as const,reasons:['video_2:asr_empty'],totalVideos:2,processedVideos:[1],missingVideos:[2]};
 const article={url:'https://example.test/video',title:'Video',author:'Fixture',publishDate:'',markdownBody:'Saved transcript evidence.',digest:'',imageUrls:[],extractorUsed:'native_http' as const,extractionQuality:quality};
 for(const writer of ['web','wechat']){
  const path=writer==='web'?await saveRawWebArticleToVault({articlesDir:join(root,writer),article,slug:'video'}):await saveRawArticleToVault({wechatArticlesDir:join(root,writer),article,slug:'video'});
  const source=readFileSync(path,'utf8');expect(readSavedExtractionQuality(source)).toEqual(quality);expect(savedPublicationDate(source)).toBe('');expect(extractionNotice(readSavedExtractionQuality(source))).toContain('1/2');
 }
});

for(const fileFirst of [true,false])for(const idea of [true,false])test(`mixed failed file preserves video regardless of order/target: ${fileFirst}/${idea}`,async()=>{
 const r=await native({outcomes:['ok'],mixed:true,fileFails:true,fileFirst,idea});
 expect(r.source).toContain(raw);expect(readSavedExtractionQuality(r.source)?.status).toBe('complete');
 expect(r.result.replyText).toContain('未归档或解析该附件');expect(r.source).toContain('未归档或解析该附件');expect(r.prompts[0]).toContain('未归档或解析该附件');
});
