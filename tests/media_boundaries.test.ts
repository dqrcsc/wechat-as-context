import './support/isolation.ts';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { ContextDatabase } from '../src/db.ts';
import { WeChatContextPipeline } from '../src/pipeline.ts';
import { downloadAndDecryptCdnMedia, encryptAes128Ecb } from '../src/clawbot/media.ts';
import { setAsrTestRunner } from '../src/extractor/asr.ts';
import { setSubagentTestRunner } from '../src/agent/subagent_cli.ts';
const savedFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=savedFetch;setAsrTestRunner(null);setSubagentTestRunner(null);});
function fixture(){const root=mkdtempSync(join(tmpdir(),'media-boundary-'));const cfg=loadConfig({IGNORE_HOME_DOTENV:'true',VAULT_ROOT:'none',WECHAT_CONTEXT_DATA_DIR:root},root);const db=new ContextDatabase(cfg.dbPath);return{root,cfg,db,pipeline:new WeChatContextPipeline(cfg,db)};}
function msg(key:string,items:any[],idea=false){return{messageKey:key,senderId:'fixture-user',rawMessage:{message_id:key,from_user_id:'fixture-user',message_type:1,item_list:[{type:1,text_item:{text:idea?'记录灵感':'归档材料'}},...items]}};}
function fileItem(name:string,query:string){return{type:4,file_item:{file_name:name,media:{encrypt_query_param:query}}};}
function mockModel(){const prompts:string[]=[];setSubagentTestRunner(async req=>{prompts.push(req.prompt);return{backend:req.backend,modelUsed:'fixture',outputText:'MODEL_SUMMARY',generatedImages:[],generatedFiles:[]};});return prompts;}
for(const idea of [false,true])test(`all attachments are reachable from ${idea?'idea':'inbox'} note`,async()=>{
 const f=fixture();mockModel();globalThis.fetch=(async(input:any)=>new Response(String(input).includes('file-a')?'first evidence':'second evidence')) as unknown as typeof fetch;
 try{const r=await f.pipeline.agent.processClawBotMessage(msg('many-files',[fileItem('报告 [A](1).txt','file-a'),fileItem('第二份.txt','file-b')],idea));
  const source=readFileSync(r.depositedPath!,'utf8');const links=[...source.split('\n').filter(line=>line.startsWith('- **关联附件 / 图片**')).join('\n').matchAll(/\]\(([^\n)]+)\)$/gm)].map(m=>resolve(dirname(r.depositedPath!),decodeURIComponent(m[1])));
  expect(links.length).toBe(2);expect(links.every(p=>existsSync(p))).toBe(true);expect(links.map(p=>readFileSync(p,'utf8')).sort()).toEqual(['first evidence','second evidence']);
 }finally{f.db.db.close();}
});
for(const idea of [false,true])test(`truncated text preview remains explicit in ${idea?'idea':'inbox'} prompt, note and reply`,async()=>{
 const f=fixture();const prompts=mockModel();globalThis.fetch=(async()=>new Response('A'.repeat(8500)+'END_OF_SOURCE')) as unknown as typeof fetch;
 try{const r=await f.pipeline.agent.processClawBotMessage(msg('long-file',[fileItem('long.txt','long')],idea));
  expect(prompts[0]).not.toContain('END_OF_SOURCE');for(const text of [prompts[0],readFileSync(r.depositedPath!,'utf8'),r.replyText]){expect(text).toContain('8000');expect(text).toContain('8513');expect(text).toContain('预览');}
 }finally{f.db.db.close();}
});
for(const declared of [true,false])test(`CDN ${declared?'declared':'actual'} oversize is rejected before persistence`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'cdn-limit-'));let cancelled=false,sent=false;
 globalThis.fetch=(async()=>new Response(new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(new Uint8Array(600));}else c.close();},cancel(){cancelled=true;}},{highWaterMark:0}),{headers:declared?{'content-length':'600'}:{}})) as unknown as typeof fetch;
 await expect(downloadAndDecryptCdnMedia({media:{full_url:'https://cdn.example.test/file'},saveDir:root,suggestedFileName:'data.bin',maxBytes:500})).rejects.toThrow('size limit');expect(readdirSync(root)).toEqual([]);expect(cancelled).toBe(true);
});
test('concurrent equal native videos have distinct temporary ownership',async()=>{
 const f=fixture();mockModel();globalThis.fetch=(async()=>new Response(new Uint8Array(512))) as unknown as typeof fetch;
 const paths:string[]=[];let both!:()=>void,releaseSecond!:()=>void;const bothEntered=new Promise<void>(r=>both=r),secondMayFinish=new Promise<void>(r=>releaseSecond=r);
 setAsrTestRunner(async req=>{paths.push(req.mediaPath!);if(paths.length===1)await bothEntered;else{both();await secondMayFinish;expect(existsSync(req.mediaPath!)).toBe(true);}return{transcript:'Fixture speech',engineUsed:'fixture'};});
 const video={type:5,video_item:{media:{encrypt_query_param:'same-video'}}};
 try{const first=f.pipeline.agent.processClawBotMessage(msg('first',[video]));const second=f.pipeline.agent.processClawBotMessage(msg('second',[video]));await bothEntered;await first;releaseSecond();await second;expect(paths[0]).not.toBe(paths[1]);expect(paths.every(p=>!existsSync(p))).toBe(true);
 }finally{releaseSecond?.();f.db.db.close();}
});

for(const mode of ['http','empty','broken','lying_length','cancel_error'] as const)test(`CDN ${mode} leaves no archived partial file`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'cdn-failure-'));let sent=false;
 globalThis.fetch=(async()=>{
  if(mode==='http')return new Response('denied',{status:403});
  if(mode==='empty')return new Response('');
  if(mode==='broken')return new Response(new ReadableStream({start(c){c.error(new Error('broken stream'));}}));
  if(mode==='cancel_error')return new Response(new ReadableStream({cancel(){throw new Error('cancel failure');}}),{status:403});
  return new Response(new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(new Uint8Array(600));}else c.close();}},{highWaterMark:0}),{headers:{'content-length':'20'}});
 }) as unknown as typeof fetch;
 const request=downloadAndDecryptCdnMedia({media:{full_url:'https://cdn.example.test/file'},saveDir:root,maxBytes:500});
 await expect(request).rejects.toThrow(mode==='cancel_error'?'CDN download HTTP 403':undefined);expect(readdirSync(root)).toEqual([]);
});
test('CDN default size cap rejects declared 128 MiB plus one before reading',async()=>{
 let pulled=false,cancelled=false;globalThis.fetch=(async()=>new Response(new ReadableStream({pull(c){pulled=true;c.close();},cancel(){cancelled=true;}},{highWaterMark:0}),{headers:{'content-length':String(128*1024*1024+1)}})) as unknown as typeof fetch;
 await expect(downloadAndDecryptCdnMedia({media:{full_url:'https://cdn.example.test/large'},saveDir:mkdtempSync(join(tmpdir(),'cdn-default-'))})).rejects.toThrow('size limit');expect(pulled).toBe(false);expect(cancelled).toBe(true);
});
for(const encrypted of [false,true])test(`bounded CDN preserves ${encrypted?'encrypted':'plain'} bytes and deduplicates permanent assets`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'cdn-roundtrip-'));const plain=Buffer.from('Complete fixture file.'),key=Buffer.alloc(16,1),wire=encrypted?encryptAes128Ecb(plain,key):plain;
 globalThis.fetch=(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(wire.subarray(0,7)));c.enqueue(new Uint8Array(wire.subarray(7)));c.close();}}),{headers:{'content-length':String(wire.length)}})) as unknown as typeof fetch;
 const params={media:{full_url:'https://cdn.example.test/file',...(encrypted?{aes_key:key.toString('base64')}:{})},saveDir:root,suggestedFileName:'fixture.txt',maxBytes:wire.length};
 const a=await downloadAndDecryptCdnMedia(params),b=await downloadAndDecryptCdnMedia(params);expect(a.buffer).toEqual(plain);expect(readFileSync(a.filePath)).toEqual(plain);expect(b.filePath).toBe(a.filePath);expect(readdirSync(root)).toHaveLength(1);
});
test('CDN size limit validation and private redirects fail before target fetch',async()=>{
 let calls=0;globalThis.fetch=(async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});}) as unknown as typeof fetch;
 const root=mkdtempSync(join(tmpdir(),'cdn-private-'));for(const maxBytes of [0,-1,NaN,Infinity])await expect(downloadAndDecryptCdnMedia({media:{full_url:'https://cdn.example.test/file'},saveDir:root,maxBytes})).rejects.toThrow('size limit');expect(calls).toBe(0);
 await expect(downloadAndDecryptCdnMedia({media:{full_url:'https://cdn.example.test/file'},saveDir:root})).rejects.toThrow();expect(calls).toBe(1);expect(readdirSync(root)).toHaveLength(0);
});
import { createInboxCaptureInVault, createIdeaSeedInVault } from '../src/vault/context.ts';
test('attachment writer keeps legacy single-path support and deduplicates merged lists',()=>{
 const root=mkdtempSync(join(tmpdir(),'capture-links-'));
 const path=createInboxCaptureInVault({inboxDir:root,title:'Fixture',bodyText:'body',attachedAssetRelPath:'assets/a.txt',attachedAssetRelPaths:['assets/a.txt','assets/b (1)#%.txt']});
 const lines=readFileSync(path,'utf8').split('\n').filter(line=>line.startsWith('- **关联附件 / 图片**'));
 expect(lines).toHaveLength(2);expect(lines[0]).toContain('(assets/a.txt)');expect(lines[1]).toContain('assets/b%20%281%29%23%25.txt');
 const idea=createIdeaSeedInVault({ideasSeedsDir:root,thoughtText:'idea',slug:'idea',attachedAssetRelPaths:['../a.txt','../a.txt']});expect(readFileSync(idea,'utf8').match(/关联附件 \/ 图片/g)).toHaveLength(1);
});
for(const length of [7999,8000,8001])test(`preview boundary ${length} preserves the original file and warns only when truncated`,async()=>{
 const f=fixture();const prompts=mockModel(),body='A'.repeat(length);globalThis.fetch=(async()=>new Response(body)) as unknown as typeof fetch;
 try{const r=await f.pipeline.agent.processClawBotMessage(msg('boundary',[fileItem('body.txt','body')]));
  const source=readFileSync(r.depositedPath!,'utf8');expect(r.replyText.includes('内嵌预览')).toBe(length>8000);expect(prompts[0].includes('内嵌预览')).toBe(length>8000);
  const link=source.split('\n').find(line=>line.startsWith('- **关联附件 / 图片**'))!.match(/\]\(([^)]+)\)$/)![1];expect(readFileSync(resolve(dirname(r.depositedPath!),decodeURIComponent(link)),'utf8')).toBe(body);
 }finally{f.db.db.close();}
});
