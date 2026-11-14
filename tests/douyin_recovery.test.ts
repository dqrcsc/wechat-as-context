import './support/isolation.ts';
import { expect, test } from 'bun:test';
import { parseDouyinSeoVideoObject } from '../src/extractor/social_media.ts';
const id='7660888653740166415', other='7660888653740166416';
const url=`https://www.douyin.com/video/${id}`;
const ld=(data:unknown)=>`<script type="application/ld+json">${JSON.stringify(data)}</script>`;
const canonical=(value=url)=>`<link rel="canonical" href="${value}">`;
const video={ '@type':'VideoObject', name:'Synthetic excerpt that ends midway', description:'A second description.', uploadDate:'2026-07-10T21:20:49+08:00Z', duration:'PT0H3M39S',creator:{name:'Synthetic creator'} };
const crumb=(value=url)=>({'@type':'BreadcrumbList',itemListElement:[{'@type':'ListItem',position:1,item:'https://www.douyin.com'},{'@type':'ListItem',position:2,item:value}]});
function page(v:unknown=video,b:unknown=crumb(),meta=canonical()){return meta+ld(b)+ld(v);}
test('unique SEO video inherits identity only from a verified page and matching breadcrumb leaf',()=>{
 const r=parseDouyinSeoVideoObject(page(),id);
 expect(r?.name).toBe(video.name);expect(r?.identitySource).toBe('page_breadcrumb');
 expect(r?.durationSeconds).toBe(219);expect(r?.uploadDate).toBe('2026-07-10');
});
for(const [label,v,b,meta] of [
 ['no page identity',video,crumb(),''],
 ['empty page identity',video,crumb(),canonical('')],
 ['no breadcrumb',video,{},canonical()],
 ['wrong breadcrumb',video,crumb(`https://www.douyin.com/video/${other}`),canonical()],
 ['generic breadcrumb leaf',video,crumb('https://www.douyin.com'),canonical()],
 ['multiple videos',[video,{...video,name:'Unrelated'}],crumb(),canonical()],
 ['empty declared url',{...video,url:''},crumb(),canonical()],
 ['null declared url',{...video,url:null},crumb(),canonical()],
 ['invalid declared main entity',{...video,mainEntityOfPage:{}},crumb(),canonical()],
 ['conflicting declared url',{...video,url:`https://www.douyin.com/video/${other}`},crumb(),canonical()],
 ['conflicting breadcrumb ancestor',video,{'@type':'BreadcrumbList',itemListElement:[{position:1,item:`https://www.douyin.com/video/${other}`},{position:2,item:url}]},canonical()],
 ['multiple breadcrumbs',video,[crumb(),crumb()],canonical()],
 ['invalid breadcrumb order',video,{'@type':'BreadcrumbList',itemListElement:[{position:2,item:url},{position:1,item:'https://www.douyin.com'}]},canonical()],
] as const)test(`SEO fallback rejects ${label}`,()=>{expect(parseDouyinSeoVideoObject(page(v,b,meta),id)).toBeNull();});
test('contradictory page reference still fails even when object ID matches',()=>{
 expect(()=>parseDouyinSeoVideoObject(page({...video,url},crumb(),canonical(`https://www.douyin.com/video/${other}`)),id)).toThrow('identity mismatch');
});
test('explicit object URL remains valid without page breadcrumb evidence',()=>{
 const r=parseDouyinSeoVideoObject(ld({...video,url}),id);expect(r?.name).toBe(video.name);expect(r?.identitySource).toBe('object');
});
test('graph metadata can anchor one video but malformed JSON cannot grant a fallback',()=>{
 expect(parseDouyinSeoVideoObject(canonical()+ld({'@graph':[crumb(),video]}),id)?.identitySource).toBe('page_breadcrumb');
 expect(parseDouyinSeoVideoObject(page()+'<script type="application/ld+json">broken</script>',id)).toBeNull();
});
test('SEO template name gives way to a meaningful description',()=>{
 const r=parseDouyinSeoVideoObject(page({...video,name:'于20261113发布在抖音，已经收获了0个喜欢，来抖音，记录美好生活！'}),id);
 expect(r?.name).toBe(video.description);
});

import { afterEach } from 'bun:test';
import { collectDouyinDetail, hasDouyinMedia } from '../src/extractor/douyin_browser.ts';
import { extractDouyinWork, setDouyinAcquisitionTestHooks } from '../src/extractor/social_media.ts';
import { extractionNotice, readSavedExtractionQuality } from '../src/extractor/quality.ts';
import { setAsrTestRunner } from '../src/extractor/asr.ts';
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;setDouyinAcquisitionTestHooks(null);setAsrTestRunner(null);});
const mediaDetail={aweme_id:id,desc:'Synthetic full work description.',video:{bit_rate_audio:[{audio_meta:{url_list:{main_url:'https://media.example.test/audio.mp4'}}}]}};
class Socket extends EventTarget {
  listeners=0;
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>){this.listeners++;super.addEventListener(...args);}
  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>){this.listeners--;super.removeEventListener(...args);}
  emit(method:string,params:unknown){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({method,params})}));}
}
const detailUrl='https://www.douyin.com/aweme/v1/web/aweme/detail/?secret=not-for-diagnostics';
async function observe(options:{body?:any;fail?:string;http?:number;network?:string;noRequest?:boolean;delayBody?:boolean;navigationError?:string;signal?:AbortSignal;reload?:boolean;secondBody?:any}={}){
 const socket=new Socket();const calls:string[]=[];let ticks=0,release:(()=>void)|undefined;
 const cdp={async call(method:string,params?:Record<string,unknown>):Promise<any>{
  calls.push(method);
  if(method==='Page.navigate'){
   if(options.fail)throw new Error(options.fail);
   socket.emit('Network.requestWillBeSent',{requestId:'doc',type:'Document',request:{url}});
   if(options.http)socket.emit('Network.responseReceived',{requestId:'doc',type:'Document',response:{url,status:options.http}});
   if(options.network)socket.emit('Network.loadingFailed',{requestId:'doc',errorText:options.network});
   return options.navigationError?{errorText:options.navigationError}:{};
  }
  if(method==='Network.getResponseBody'){
   if(options.delayBody)await new Promise<void>(resolve=>{release=resolve;queueMicrotask(resolve);});
   return params?.requestId==='second'?options.secondBody:options.body??{body:JSON.stringify({aweme_detail:mediaDetail})};
  }
  return {};
 }};
 const result=await collectDouyinDetail(id,cdp,socket,{signal:options.signal??new AbortController().signal,observeMs:1000,reloadAtMs:options.reload?500:null,sleep:async()=>{
  ticks++;
  if(!options.noRequest&&ticks===1){
   socket.emit('Network.requestWillBeSent',{requestId:'detail',request:{url:detailUrl}});
   socket.emit('Network.responseReceived',{requestId:'detail',response:{url:detailUrl,status:options.http||200}});
   socket.emit('Network.loadingFinished',{requestId:'detail'});
   if(options.secondBody){socket.emit('Network.requestWillBeSent',{requestId:'second',request:{url:detailUrl}});socket.emit('Network.loadingFinished',{requestId:'second'});}
  }
  release?.();
 }});
 expect(socket.listeners).toBe(0);
 expect(JSON.stringify(result.reasons)).not.toContain('secret');
 return {result,calls};
}
test('CDP late body read recovers an audio-only target and stops without reload',async()=>{
 const {result,calls}=await observe({delayBody:true});expect(result.awemeDetail?.aweme_id).toBe(id);expect(result.reasons).toEqual([]);expect(calls.filter(m=>m==='Page.navigate')).toHaveLength(1);
});
for(const [label,body,reason] of [
 ['empty',{body:''},'douyin_cdp_detail_empty'],
 ['invalid JSON',{body:'private error not JSON'},'douyin_cdp_detail_invalid_json'],
 ['missing detail',{body:JSON.stringify({status_code:0})},'douyin_cdp_detail_missing'],
 ['wrong ID',{body:JSON.stringify({aweme_detail:{...mediaDetail,aweme_id:other}})},'douyin_cdp_detail_identity_mismatch'],
 ['metadata only',{body:JSON.stringify({aweme_detail:{aweme_id:id,desc:'Known title',video:{},images:[]}})},'douyin_cdp_media_missing'],
] as const)test(`CDP diagnoses ${label}`,async()=>{const {result}=await observe({body});expect(result.reasons).toContain(reason);expect(result.reasons.join(' ')).not.toContain('private error');});
test('base64 response uses the same target identity check',async()=>{
 const {result}=await observe({body:{base64Encoded:true,body:Buffer.from(JSON.stringify({aweme_detail:mediaDetail})).toString('base64')}});expect(result.awemeDetail?.aweme_id).toBe(id);
});
test('a later matching metadata-only response cannot replace valid media',async()=>{
 const {result}=await observe({secondBody:{body:JSON.stringify({aweme_detail:{aweme_id:id,desc:'Restricted'}})}});expect(hasDouyinMedia(result.awemeDetail)).toBe(true);
});
test('document and detail status, missing request and TLS failures remain distinct',async()=>{
 expect((await observe({noRequest:true,http:403,network:'net::ERR_CERT_AUTHORITY_INVALID'})).result.reasons).toEqual(expect.arrayContaining(['douyin_cdp_document_http_403','douyin_cdp_document_tls_failed','douyin_cdp_detail_request_missing']));
 expect((await observe({http:429,body:{body:'{}'}})).result.reasons).toContain('douyin_cdp_detail_http_429');
});
for(const [error,reason] of [['CDP request timeout: Page.navigate','douyin_cdp_navigation_timeout'],['secret stack trace','douyin_cdp_navigation_failed']] as const)test(`navigation failure is controlled: ${reason}`,async()=>{expect((await observe({fail:error})).result.reasons).toContain(reason);});
test('CDP navigation returned errorText is a failure, not usable document content',async()=>{
 expect((await observe({navigationError:'net::ERR_CERT_INVALID'})).result.reasons).toContain('douyin_cdp_document_tls_failed');
});
test('overall abort and idle reload are bounded',async()=>{
 const c=new AbortController();c.abort();expect((await observe({signal:c.signal})).result.reasons).toContain('douyin_cdp_deadline');
 const idle=await observe({noRequest:true,reload:true});expect(idle.calls.filter(m=>m==='Page.navigate')).toHaveLength(2);expect(idle.result.reasons).toContain('douyin_cdp_detail_request_missing');
});
test('malformed media lists and empty albums cannot hide missing video streams',()=>{
 expect(hasDouyinMedia({images:[],video:{bit_rate:{some:'not a function'},play_addr:{url_list:{some:1}}}})).toBe(false);
 expect(hasDouyinMedia(mediaDetail)).toBe(true);expect(hasDouyinMedia({images:[{url_list:['https://images.example.test/image.jpg']}]})).toBe(true);
});
for(const transcription of [false,true])test(`SEO excerpt and browser diagnostics propagate across extraction (ASR=${transcription})`,async()=>{
 globalThis.fetch=(async()=>new Response(canonical()+`<meta property="og:title" content="于20261113发布在抖音，已经收获了0个喜欢，来抖音，记录美好生活！">`)) as unknown as typeof fetch;
 let browserCalls=0;
 setDouyinAcquisitionTestHooks({seo:async()=>parseDouyinSeoVideoObject(page(),id),browser:async()=>{browserCalls++;return {awemeDetail:transcription?{...mediaDetail,desc:''}:null,reasons:['douyin_cdp_navigation_timeout']};}});
 setAsrTestRunner(async()=>({transcript:'Synthetic audio transcript.',engineUsed:'fixture'}));
 const r=await extractDouyinWork(url);
 expect(r.markdownBody).toContain('SEO 简介片段（可能截断）');expect(r.markdownBody).toContain(video.name);
 expect(r.extractionQuality?.reasons).toEqual(expect.arrayContaining(['douyin_seo_excerpt','douyin_seo_page_identity','douyin_cdp_navigation_timeout']));
 expect(r.extractionQuality?.status).toBe(transcription?'partial':'metadata_only');expect(browserCalls).toBe(transcription?1:2);
 const persisted=readSavedExtractionQuality(`---\nextraction_quality: ${JSON.stringify(r.extractionQuality)}\n---\n`);expect(extractionNotice(persisted)).toContain('可能被截断');
 if(transcription)expect(r.markdownBody).toContain('Synthetic audio transcript.');
});

test('SEO preview is bounded and script metadata cannot smuggle a conflicting explicit reference',()=>{
 expect(parseDouyinSeoVideoObject(page({...video,name:'正文'.repeat(2000)}),id)?.name).toHaveLength(2000);
 expect(parseDouyinSeoVideoObject(page({...video,url,'@id':`https://www.douyin.com/video/${other}`}),id)).toBeNull();
});
for(const kind of ['body_error','network_error','wrong_host','missing_body'] as const)test(`detail observer handles ${kind} without leaking transport text`,async()=>{
 const socket=new Socket();let sent=false;let bodyReads=0;
 const cdp={async call(method:string):Promise<any>{if(method==='Network.getResponseBody'){bodyReads++;throw new Error('private signed URL');}return {};}};
 const result=await collectDouyinDetail(id,cdp,socket,{signal:new AbortController().signal,observeMs:500,reloadAtMs:null,sleep:async()=>{
  if(sent)return;sent=true;
  socket.emit('Network.requestWillBeSent',{requestId:'detail',request:{url:kind==='wrong_host'?'https://evil.example.test/aweme/v1/web/aweme/detail/':detailUrl}});
  if(kind==='network_error')socket.emit('Network.loadingFailed',{requestId:'detail',errorText:'private signed URL'});
  if(kind==='body_error'||kind==='wrong_host')socket.emit('Network.loadingFinished',{requestId:'detail'});
 }});
 expect(result.reasons).toContain(kind==='body_error'?'douyin_cdp_detail_body_failed':kind==='network_error'?'douyin_cdp_detail_network_failed':kind==='wrong_host'?'douyin_cdp_detail_request_missing':'douyin_cdp_detail_response_missing');
 expect(result.reasons.join(',')).not.toContain('private');expect(socket.listeners).toBe(0);
 expect(bodyReads).toBe(kind==='body_error'?1:0);
});
test('setup failure and failed reload have separate diagnoses',async()=>{
 for(const failingMethod of ['Network.enable','reload']){
  const socket=new Socket();let navigations=0;
  const cdp={async call(method:string):Promise<any>{if(method===failingMethod||(method==='Page.navigate'&&++navigations===2&&failingMethod==='reload'))throw new Error('private internals');return {};}};
  const result=await collectDouyinDetail(id,cdp,socket,{signal:new AbortController().signal,observeMs:1000,reloadAtMs:500,sleep:async()=>{}});
  expect(result.reasons).toContain(failingMethod==='reload'?'douyin_cdp_reload_failed':'douyin_cdp_setup_failed');expect(socket.listeners).toBe(0);
 }
});
test('valid SSR audio-only detail avoids browser while an empty album does not block fallback',async()=>{
 for(const available of [true,false]){
  const detail=available?mediaDetail:{aweme_id:id,desc:'Original description',images:[],video:{}};
  const html=`<script>window._ROUTER_DATA=${JSON.stringify({loaderData:{page:{videoInfoRes:{item_list:[detail]}}}})}</script>`;
  globalThis.fetch=(async()=>new Response(html)) as unknown as typeof fetch;
  let calls=0;setDouyinAcquisitionTestHooks({browser:async()=>{calls++;return {awemeDetail:mediaDetail,reasons:[]};}});
  setAsrTestRunner(async()=>({transcript:'Recovered speech.',engineUsed:'fixture'}));
  const r=await extractDouyinWork(url);expect(calls).toBe(available?0:1);expect(r.markdownBody).toContain('Recovered speech.');expect(r.extractionQuality?.status).toBe('partial');
 }
});
for(const verifiedPage of [true,false])test(`article acquisition error includes browser reasons (page verified=${verifiedPage})`,async()=>{
 globalThis.fetch=(async()=>new Response(verifiedPage?canonical():'<html></html>')) as unknown as typeof fetch;
 setDouyinAcquisitionTestHooks({browser:async()=>({awemeDetail:null,reasons:['douyin_cdp_endpoint_missing']})});
 await expect(extractDouyinWork(url)).rejects.toThrow('douyin_cdp_endpoint_missing');
});
