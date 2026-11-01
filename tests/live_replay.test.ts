import './support/isolation.ts';
import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fetchPublicResource} from '../src/public_url.ts';
import {setSystemTlsTestRunner,parseSystemTlsResponse} from '../src/extractor/system_tls.ts';
import {setYouTubeResolverTestRunner,resolveYouTubeFallbackAudio} from '../src/extractor/youtube_fallback.ts';
import {extractYouTubeVideo} from '../src/extractor/youtube.ts';
import {setAsrTestRunner,MediaDownloadError} from '../src/extractor/asr.ts';
import {extractDouyinWork} from '../src/extractor/social_media.ts';
import {stripWeChatRewardTail} from '../src/extractor/wechat.ts';
import {renderAsrTranscript,transcriptReviewFragments} from '../src/extractor/transcript_text.ts';
import {loadConfig} from '../src/config.ts';
import {ContextDatabase} from '../src/db.ts';
import {WeChatAgentRuntime} from '../src/agent/runtime.ts';
import {applyValidationContract} from '../src/vault/validation_contract.ts';
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;setSystemTlsTestRunner();setYouTubeResolverTestRunner();setAsrTestRunner(null);});
const tlsError=()=>{throw new Error('unknown certificate verification error');};
function wire(status=200,headers='',body='valid page'){return Buffer.from(`HTTP/2 ${status} OK\r\n${headers}\r\n${body}`);}

test('system TLS recovery preserves URL and never forwards secrets or curl config',async()=>{
 let calls=0;globalThis.fetch=tlsError as any;
 setSystemTlsTestRunner(async(args)=>{calls++;expect(args[0]).toBe('-q');expect(args).not.toContain('-k');expect(args).not.toContain('-L');expect(args.join(' ')).not.toContain('private-secret');expect(args).toContain('--max-filesize');return wire(200,'Content-Type: text/html\r\n');});
 const r=await fetchPublicResource('https://www.iesdouyin.com/share/video/123/',{headers:{Authorization:'private-secret',Cookie:'private-secret','User-Agent':'fixture'}});
 expect(calls).toBe(1);expect(r.url).toBe('https://www.iesdouyin.com/share/video/123/');expect(await r.text()).toBe('valid page');
});
test('system TLS response redirect still rejects private destinations',async()=>{
 globalThis.fetch=tlsError as any;setSystemTlsTestRunner(async()=>wire(302,'Location: http://127.0.0.1/private\r\n'));
 await expect(fetchPublicResource('https://v.douyin.com/share/')).rejects.toThrow('Private');
});
for(const [url,method,error] of [
 ['https://other.example.test','GET','certificate'],['https://v.douyin.com/a','POST','certificate'],
 ['http://v.douyin.com/a','GET','certificate'],['https://v.douyin.com/a','GET','connection refused']]){
 test(`no TLS fallback outside approved boundary: ${url}/${method}/${error}`,async()=>{
  let calls=0;globalThis.fetch=(()=>{throw new Error(error);}) as any;setSystemTlsTestRunner(async()=>{calls++;return wire();});
  await expect(fetchPublicResource(url,{method})).rejects.toThrow(error);expect(calls).toBe(0);
 });
}
test('cancellation and malformed curl output never become successful content',async()=>{
 const abort=new AbortController();abort.abort();let calls=0;globalThis.fetch=tlsError as any;setSystemTlsTestRunner(async()=>{calls++;return wire();});
 await expect(fetchPublicResource('https://v.douyin.com/a',{signal:abort.signal})).rejects.toThrow();expect(calls).toBe(0);
 expect(()=>parseSystemTlsResponse(Buffer.from('garbage'),'https://v.douyin.com/a')).toThrow();
 expect(()=>parseSystemTlsResponse(wire(200,'', 'x'.repeat(8*1024*1024+1)),'https://v.douyin.com/a')).toThrow('limit');
 const r=parseSystemTlsResponse(Buffer.concat([Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'),wire(200,'','body')]),'https://v.douyin.com/a');expect(await r.text()).toBe('body');
});
test('Douyin preserves network and HTTP failures before identity checks',async()=>{
 globalThis.fetch=(()=>{throw new Error('offline');}) as any;
 await expect(extractDouyinWork('https://v.douyin.com/a')).rejects.toThrow('network_or_timeout');
 globalThis.fetch=(async()=>new Response('',{status:429})) as any;
 await expect(extractDouyinWork('https://v.douyin.com/a')).rejects.toThrow('http_429');
 globalThis.fetch=tlsError as any;setSystemTlsTestRunner(async()=>{throw Object.assign(new Error('missing curl'),{code:'ENOENT'});});
 await expect(extractDouyinWork('https://v.douyin.com/a')).rejects.toThrow('system_tls_unavailable');
});
const audio='https://r1.googlevideo.com/videoplayback?fixture=1';
function resolverData(id='abcdefghijk',url=audio){return JSON.stringify({id,formats:[{protocol:'https',vcodec:'none',acodec:'opus',url,http_headers:{'User-Agent':'fixture-agent',Cookie:'must-not-send'}}]});}
test('YouTube resolver validates target and allows only public Google video media',async()=>{
 setYouTubeResolverTestRunner(async(_binary,args)=>{expect(args).toContain('--ignore-config');expect(args).toContain('--no-cookies-from-browser');expect(args).toContain('--skip-download');expect(args.at(-1)).toBe('https://www.youtube.com/watch?v=abcdefghijk');return resolverData();});
 expect((await resolveYouTubeFallbackAudio('abcdefghijk')).urls).toEqual([audio]);
 setYouTubeResolverTestRunner(async()=>resolverData('wrongvideo00'));expect((await resolveYouTubeFallbackAudio('abcdefghijk')).reason).toBe('resolver_identity_mismatch');
 for(const url of ['http://127.0.0.1/a','https://evil.test/a','https://user:secret@r1.googlevideo.com/a']){setYouTubeResolverTestRunner(async()=>resolverData('abcdefghijk',url));expect((await resolveYouTubeFallbackAudio('abcdefghijk')).urls).toEqual([]);}
 setYouTubeResolverTestRunner(async()=>{throw new Error('resolver_timeout');});expect((await resolveYouTubeFallbackAudio('abcdefghijk')).reason).toBe('resolver_timeout');
 setYouTubeResolverTestRunner(async()=>'{bad json');expect((await resolveYouTubeFallbackAudio('abcdefghijk')).reason).toBe('resolver_failed');
});
function ytPage(captions=false){const player:any={videoDetails:{title:'Fixture',shortDescription:'Source description.'},streamingData:{adaptiveFormats:[{mimeType:'audio/mp4',url:'https://old.googlevideo.com/a'}]}};if(captions)player.captions={playerCaptionsTracklistRenderer:{captionTracks:[{languageCode:'en',baseUrl:'https://caption.example.test/a'}]}};globalThis.fetch=(async(url:any)=>String(url).includes('watch?')?new Response(`<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`):new Response('<transcript><text start="0" dur="1">Native captions.</text></transcript>')) as any;}
test('YouTube native audio 403 recovers using fresh resolver media and preserves diagnosis',async()=>{
 ytPage();setYouTubeResolverTestRunner(async()=>resolverData());let calls=0;setAsrTestRunner(async req=>{calls++;if(calls===1)throw new MediaDownloadError('http_403');expect(req.mediaUrls).toEqual([audio]);expect(req.headers?.Range).toBe('bytes=0-');expect(req.headers?.['User-Agent']).toBe('fixture-agent');expect(req.headers?.Cookie).toBeUndefined();return{transcript:'Actual recovered speech.',engineUsed:'fixture_asr'};});
 const r=await extractYouTubeVideo('https://youtu.be/abcdefghijk');expect(r.extractionQuality?.status).toBe('complete');expect(r.extractionQuality?.reasons).toContain('audio_http_403');expect(r.markdownBody).toContain('Actual recovered speech.');expect(r.transcriptEngine).toContain('yt-dlp');
});
test('resolver failure retains metadata-only and observed errors; native captions skip resolver',async()=>{
 ytPage();setAsrTestRunner(async()=>{throw new MediaDownloadError('http_403');});setYouTubeResolverTestRunner(async()=>{throw new Error('resolver_timeout');});
 const r=await extractYouTubeVideo('https://youtu.be/abcdefghijk');expect(r.extractionQuality?.status).toBe('metadata_only');expect(r.extractionQuality?.reasons).toContain('resolver_timeout');
 ytPage(true);let calls=0;setYouTubeResolverTestRunner(async()=>{calls++;return resolverData();});const complete=await extractYouTubeVideo('https://youtu.be/abcdefghijk');expect(complete.markdownBody).toContain('Native captions.');expect(calls).toBe(0);
});
const tail='**微信扫一扫赞赏作者**喜欢作者\n\n关闭\n\n**0人付费**\n\n更多\n\n正在加载...\n\n原文示例标题\n\n 收录于示例集合\n\n山东,9月17日,';
test('observed reward/navigation suffix is removed but prose and unknown content survive',()=>{
 expect(stripWeChatRewardTail('文章正文。\n\n'+tail,'示例标题')).toBe('文章正文。');
 expect(stripWeChatRewardTail('文章正文。\n\n'+tail+'\n作者补充证据。','示例标题')).toContain('作者补充证据。');
 expect(stripWeChatRewardTail('正文\n'+tail+'\n原文的结论仅适用于特定硬件','示例标题')).toContain('原文的结论');
 expect(stripWeChatRewardTail('作者讨论微信扫一扫赞赏作者与正在加载的交互。')).toContain('赞赏作者');
});
for(const prefix of ['我有个想法：','我有一个想法：','想法：'])test(`offline idea capture is idempotent: ${prefix}`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'offline-idea-'));const cfg=loadConfig({IGNORE_HOME_DOTENV:'true',VAULT_ROOT:'none',WECHAT_CONTEXT_DATA_DIR:root,ALLOW_CODEX_FALLBACK:'false'},root);const db=new ContextDatabase(cfg.dbPath);const runtime=new WeChatAgentRuntime(cfg,db);
 try{const message={messageKey:'same',senderId:'fixture',rawMessage:{message_id:'same',from_user_id:'fixture',message_type:1,item_list:[{type:1,text_item:{text:prefix+'信息差与执行反馈都需要核验。'}}]}};const a=await runtime.processClawBotMessage(message),b=await runtime.processClawBotMessage(message);expect(a.depositedPath).toBe(b.depositedPath);const note=readFileSync(a.depositedPath!,'utf8');expect(note).toContain('信息差与执行反馈都需要核验。');expect(note).not.toContain(prefix);expect(readdirSync(cfg.ideasSeedsDir)).toHaveLength(1);
 const other=await runtime.processClawBotMessage({...message,messageKey:'other',rawMessage:{...message.rawMessage,item_list:[{type:1,text_item:{text:'天气怎么样'}}]}});expect(other.depositedPath).toBeUndefined();
 }finally{db.db.close();}
});
test('ASR review uses exact source fragments and offsets without inventing corrections',()=>{
 const raw='？最近AI涨超。 20%。Codeex和压舱时都未核对。';const hints=transcriptReviewFragments(raw);expect(hints.map(h=>h.offset)).toEqual([0,7]);const rendered=renderAsrTranscript(raw);expect(rendered).toContain(raw);expect(rendered).toContain('非时间戳');expect(rendered).toContain('Codeex');expect(rendered).not.toContain('压舱石');expect(transcriptReviewFragments('正常转写，没有异常断句。')).toEqual([]);
});
test('compact metric rendering remains identical in both outputs and retains acceptance limits',()=>{
 for(const unit of ['percentage_points','relative_percent']){
 const raw='🏢 业务与规划启发：\n{{VALIDATION_CONTRACT}}\n🔍 边界：未验证。';const r=applyValidationContract({validation_contract:{metrics:[{name:'差错率',numerator:'错误步骤',denominator:'全部步骤',direction:'decrease',minimum_gain:{unit,value:5}}]},wechat_reply:raw,companion_note_markdown:raw});expect(r.wechat_reply).toBe(r.companion_note_markdown);expect(r.wechat_reply).toContain(unit==='percentage_points'?'(A - B) × 100（百分点）':'(A - B) / A × 100%');for(const phrase of ['分母为 0','未确认','有效试验','本次样本、模型、规则与配置','波动尚未估计','不作统计显著性判断'])expect(r.wechat_reply).toContain(phrase);expect(Array.from(r.wechat_reply).length).toBeLessThan(290);
 }
});

import {analyzeArticleWithVault} from '../src/vault/analyzer.ts';
const shortDraft='💧 脱水干货：作者建议规范表达。\n💡 观点碰撞：只测表达增量。\n🏢 业务与规划启发：建议离线验证：正常与异常样本，两组同规则同模型，仅改表达形式，由业务确认规则并独立复核。\n🔍 边界与待验证：尚未验证。\n🚦 分诊与下一步：阅读价值低，场景验证待做，process_later。';
test('compact fields cannot overwrite protected conditions or the companion, even when still long',async()=>{
 const root=mkdtempSync(join(tmpdir(),'compact-safe-'));const cfg=loadConfig({IGNORE_HOME_DOTENV:'true',VAULT_ROOT:'none',WECHAT_CONTEXT_DATA_DIR:root,LLM_PROVIDER:'custom',LLM_API_KEY:'fixture',LLM_BASE_URL:'https://model.example.test',LLM_MODEL:'fixture'},root);
 const first={english_slug:'fixture',triage:'process_later',validation_contract:null,wechat_reply:shortDraft.replace('作者建议规范表达。','作者建议规范表达。'+'可精简解释。'.repeat(100)).replace('建议离线验证：','建议离线验证：'+'必须独立复核，不可上线。'.repeat(50)),companion_note_markdown:'完整伴读不可替换'};
 let calls=0;globalThis.fetch=(async()=>Response.json({choices:[{message:{content:JSON.stringify(++calls===1?first:{digest:'作者建议规范表达。',collision:'仅测表达增量。',wechat_reply:'可直接上线',companion_note_markdown:'伪造替换',triage:'reference'})}}]})) as any;
 const result=await analyzeArticleWithVault({config:cfg,article:{url:'https://source.example.test/article',title:'Fixture',author:'Author',publishDate:'',digest:'Evidence',markdownBody:'Evidence',imageUrls:[],extractorUsed:'native_http'},userNotes:'',vaultContext:{nowSummary:'',queueSummary:'',topicsOverview:'',matchedNotes:[]}});
 expect(calls).toBe(2);expect(result.triage).toBe('process_later');expect(result.companion_note_markdown).toBe('完整伴读不可替换');expect(result.wechat_reply).toContain('必须独立复核，不可上线。'.repeat(50));expect(result.wechat_reply).not.toContain('可直接上线');expect(result.wechat_reply).not.toContain('可精简解释');expect(result.wechat_reply).toContain('未压缩到手机短版');
});

for(const [code,reason] of [[28,'system_tls_timeout'],[63,'system_tls_size_limit'],[60,'system_tls_certificate_rejected'],['ENOENT','system_tls_unavailable']] as const)test(`system TLS preserves sanitized failure: ${reason}`,async()=>{
 globalThis.fetch=tlsError as any;setSystemTlsTestRunner(async()=>{throw Object.assign(new Error('private curl stderr'),{code});});await expect(fetchPublicResource('https://v.douyin.com/a')).rejects.toThrow(reason);
});
test('known Douyin ID preserves mobile fallback after first-page HTTP failure',async()=>{
 const id='7381234567890123456';let calls=0;const data={loaderData:{video:{videoInfoRes:{item_list:[{aweme_id:id,desc:'Fixture valid content',author:{nickname:'Author'},video:{play_addr:{url_list:[]}}}]}}}};
 globalThis.fetch=(async()=>++calls===1?new Response('',{status:403}):new Response(`<script>window._ROUTER_DATA=${JSON.stringify(data)}</script>`)) as any;
 const result=await extractDouyinWork(`https://www.douyin.com/video/${id}`);expect(calls).toBeGreaterThan(1);expect(result.markdownBody).toContain('Fixture valid content');
});

import {downloadMediaStream} from '../src/extractor/asr.ts';
import {existsSync} from 'node:fs';
for(const [range,size,reason] of [['bytes 0-511/512',512,''],['bytes 0-511/1024',512,'partial_response'],['bytes 1-512/513',512,'partial_response'],['',512,'partial_response'],['bytes 0-511/512',300,'incomplete_response']] as const)test(`Range media requires a complete object: ${range}/${size}`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'range-complete-'));const path=join(root,'audio.bin');globalThis.fetch=(async()=>new Response(new Uint8Array(size),{status:206,headers:{'content-range':range}})) as any;
 const pending=downloadMediaStream(audio,path,{Range:'bytes=0-'});if(reason){await expect(pending).rejects.toThrow(reason);expect(existsSync(path)).toBe(false);}else{await pending;expect(readFileSync(path).length).toBe(size);}
});
test('resolver ignores HLS playlists even if they use a Googlevideo hostname',async()=>{
 setYouTubeResolverTestRunner(async()=>JSON.stringify({id:'abcdefghijk',formats:[{protocol:'m3u8_native',vcodec:'none',acodec:'opus',url:audio}]}));expect((await resolveYouTubeFallbackAudio('abcdefghijk')).reason).toBe('resolver_no_audio');
});
