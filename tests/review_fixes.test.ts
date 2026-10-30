import "./support/isolation.ts";
import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {ContextDatabase} from '../src/db.ts';
import {WeChatContextPipeline} from '../src/pipeline.ts';
import {ensureMultiFormatDeliverables} from '../src/agent/doc_exporter.ts';
import type {AppConfig} from '../src/config.ts';
const databases:ContextDatabase[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.db.close();});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'wx-review-fixes-'));
 const config:AppConfig={projectRoot:root,dataDir:root,dbPath:join(root,'test.db'),vaultRoot:root,vaultMode:'standalone',vaultEnabled:false,wechatArticlesDir:join(root,'articles'),ideasSeedsDir:join(root,'ideas'),port:0,annotationWaitSeconds:0,taskHeartbeatSeconds:0,llm:{apiKey:'',baseUrl:'https://invalid.example',model:'mock',allowCodexFallback:false}};
 const db=new ContextDatabase(config.dbPath);databases.push(db);const p=new WeChatContextPipeline(config,db);
 const send=(record:string,formats:string[]=[]) => (p.agent as any).handleSendFile({senderId:'A',unpacked:{userText:'把刚才生成的合同发给我'},decision:{slots:{fileTarget:'recent_generated',requestedFormats:formats}},recentTurns:record?[{deposited_path:record,user_text:'合同'}]:[]});
 return{root,config,db,p,send};
}
function probe(file:string,mode=''){
 const proc=Bun.spawnSync([process.execPath,join(import.meta.dir,'fixtures',file),mode],{env:{PATH:process.env.PATH,IGNORE_HOME_DOTENV:'true'}});
 expect(proc.exitCode).toBe(0);return JSON.parse(proc.stdout.toString());
}
test('F01 no conversation artifact never selects an unrelated daily document',async()=>{
 const f=fixture(),out=join(f.root,'outputs');mkdirSync(out);
 writeFileSync(join(out,new Date().toISOString().slice(0,10).replace(/-/g,'_')+'_unrelated.md'),'# UNRELATED');
 const r=await f.send('', ['md']);expect(r.mediaDeliveries??[]).toEqual([]);expect(r.replyText).toContain('未找到');expect(r.outcome).toBe('failed');
});
test('F02 queued media freezes bytes across source edits and duplicate enqueue',async()=>{
 const f=fixture(),md=join(f.root,'report.md');writeFileSync(md,'# V1');
 const [html]=await ensureMultiFormatDeliverables({markdownPath:md,outputDir:f.root,baseFileStem:'report',requestedFormats:['html']});
 f.db.queueMediaReply('md','A','file',md);f.db.queueMediaReply('html','A','file',html);
 writeFileSync(md,'# V2');f.db.queueMediaReply('md','A','file',md);
 const sent:string[]=[];(f.p.clawbot as any).sendMediaFile=async (_to:string,path:string)=>{sent.push(readFileSync(path,'utf8'));};
 await f.p.flushReplies();expect(sent).toHaveLength(2);expect(sent.every(x=>x.includes('V1')&&!x.includes('V2'))).toBe(true);
 const row=f.db.db.query('SELECT media_path FROM reply_outbox WHERE id=?').get('md') as any;expect(basename(row.media_path)).toBe('report.md');expect(row.media_path).not.toBe(md);
});
for(const backend of ['codex','opencode','claude','gemini','workbuddy','aider','custom']){
 test(`F03 ${backend} nonzero with output falls through to next backend`,()=>{const r=probe('review-cli-probe.ts',backend);expect(r.ok).toBe(true);expect(r.calls).toBe(2);expect(r.result.backend).toBe('success');});
}
test('F04 invalid PDF cache and failed browser output are rejected; valid output publishes atomically',()=>{
 const r=probe('review-pdf-probe.ts');expect(r.invalidCacheReturned).toBe(false);expect(r.failedRender).toBe(false);expect(r.goodRender).toBe(true);expect(r.directFinalWrite).toBe(false);expect(r.oldPreserved).toBe(true);
});
test('F05 conflicting inline body cannot be delivered with an old Markdown source',async()=>{
 const f=fixture(),md=join(f.root,'report.md');writeFileSync(md,'# OLD');
 await expect(ensureMultiFormatDeliverables({markdownPath:md,markdownContent:'# NEW',outputDir:f.root,baseFileStem:'report',requestedFormats:['md','html']})).rejects.toThrow('Markdown');
 expect(readFileSync(md,'utf8')).toBe('# OLD');
 const good=await ensureMultiFormatDeliverables({markdownPath:md,markdownContent:'# OLD',outputDir:f.root,baseFileStem:'report',requestedFormats:['md','html']});expect(good).toHaveLength(2);
});
test('F06 explicit formats cover all selected documents',async()=>{
 const f=fixture(),a=join(f.root,'a.md'),b=join(f.root,'b.md');writeFileSync(a,'# A');writeFileSync(b,'# B');
 const r=await f.send([a,b].join(', '),['html']);expect(r.mediaDeliveries).toHaveLength(2);expect(r.missingFormats).toEqual([]);
});
test('F07 JSON and legacy comma-containing single paths resolve without guessing',async()=>{
 const f=fixture(),md=join(f.root,'report, final.md');writeFileSync(md,'# RIGHT');
 for(const record of [JSON.stringify([md]),md]){const r=await f.send(record,['md']);expect(r.mediaDeliveries?.map((d:any)=>d.mediaPath)).toEqual([md]);}
 f.db.recordConversationTurn({messageKey:'turn',senderId:'A',userText:'test',intent:'send_file',complexity:'fast',modelUsed:'test',depositedPath:md,assistantReply:'ok'});
 expect(JSON.parse(f.db.getRecentConversationTurns('A',1)[0].deposited_path)).toEqual([md]);
});
test('F08 actual image generation failure is recorded as failed',async()=>{
 const f=fixture();f.db.enqueueAgentTask('image','A',JSON.stringify({from_user_id:'A',item_list:[{type:1,text_item:{text:'画一张猫咪图片'}}]}));
 await f.p.drainAgentQueue();const task=f.db.db.query('SELECT status,error FROM agent_tasks').get() as any;expect(task.status).toBe('failed');expect(task.error.length).toBeGreaterThan(0);
});
test('F09 key detection and Web preset save respect ignored home and source precedence',()=>{
 const r=probe('review-config-probe.ts');expect(r.detected).toBe('runtime-fixture');expect(r.uiSavedHome).toBe(false);expect(r.projectWins).toBe(true);expect(r.homeFallback).toBe(true);
});
test('F10 queue recovers in the same instance after config read failure',async()=>{
 const f=fixture();f.db.enqueueAgentTask('task','A',JSON.stringify({from_user_id:'A',item_list:[{type:1,text_item:{text:'帮助'}}]}));
 mkdirSync(join(f.root,'.env'));await expect(f.p.drainAgentQueue()).rejects.toThrow();
 renameSync(join(f.root,'.env'),join(f.root,'broken-env'));writeFileSync(join(f.root,'.env'),'IGNORE_HOME_DOTENV=true\nALLOW_CODEX_FALLBACK=false\nVAULT_ROOT=none\n');
 expect(await f.p.drainAgentQueue()).toBe(1);expect(f.db.getPendingAgentTasks()).toHaveLength(0);
});

test('F02 retries retain the queued snapshot even after original deletion',async()=>{
 const f=fixture(),md=join(f.root,'retry.md');writeFileSync(md,'# SNAPSHOT');f.db.queueMediaReply('retry','A','file',md);
 renameSync(md,join(f.root,'moved.md'));let calls=0;const bodies:string[]=[];
 (f.p.clawbot as any).sendMediaFile=async (_to:string,path:string)=>{bodies.push(readFileSync(path,'utf8'));if(++calls===1)throw new Error('synthetic transient failure');};
 await f.p.flushReplies({nowMs:1000});await f.p.flushReplies({nowMs:6000});expect(bodies).toEqual(['# SNAPSHOT','# SNAPSHOT']);
 expect((f.db.db.query('SELECT status FROM reply_outbox WHERE id=?').get('retry') as any).status).toBe('sent');
});
test('F02 legacy and tampered snapshots cannot silently send mutable bytes',async()=>{
 const f=fixture(),md=join(f.root,'source.md');writeFileSync(md,'# SAFE');f.db.queueMediaReply('snapshot','A','file',md);
 const row=f.db.db.query('SELECT media_path FROM reply_outbox WHERE id=?').get('snapshot') as any;writeFileSync(row.media_path,'# TAMPERED');
 f.db.db.query("INSERT INTO reply_outbox(id,recipient,text,media_type,media_path) VALUES('legacy','A','','file',?)").run(md);
 let sends=0;(f.p.clawbot as any).sendMediaFile=async()=>{sends++;};
 for(let i=0;i<3;i++)await f.p.flushReplies({nowMs:1000+i*20000});expect(sends).toBe(0);
 const rows=f.db.db.query('SELECT status,error FROM reply_outbox').all() as any[];expect(rows.every(r=>r.status==='failed'&&r.error.length>0)).toBe(true);
});
test('F07 legacy multi-file records still work but damaged records do not guess',async()=>{
 const f=fixture(),a=join(f.root,'a.md'),b=join(f.root,'b.md');writeFileSync(a,'# A');writeFileSync(b,'# B');
 const legacy=await f.send([a,b].join(', '),['md']);expect(legacy.mediaDeliveries).toHaveLength(2);
 for(const raw of ['[broken-json',`${a}, /nonexistent/document.md`]){const bad=await f.send(raw,['md']);expect(bad.outcome).toBe('failed');expect(bad.mediaDeliveries??[]).toEqual([]);}
});
test('F08 queue distinguishes partial and successful outcomes',async()=>{
 const f=fixture();
 for(const [key,outcome] of [['partial','partial'],['success','success']] as const){
  f.p.agent.registerIntentHandler('general_assistant',async()=>({replyText:'fixture result',modelUsed:'fixture',outcome}));
  f.db.enqueueAgentTask(key,'A',JSON.stringify({from_user_id:'A',item_list:[{type:1,text_item:{text:'你好'}}]}));await f.p.drainAgentQueue();
  const row=f.db.db.query('SELECT status,stage FROM agent_tasks WHERE message_key=?').get(key) as any;expect(row.status).toBe('done');expect(row.stage.includes('部分')).toBe(outcome==='partial');
 }
});
test('excluded push historical files contract remains unchanged',async()=>{
 const f=fixture(),md=join(f.root,'guide.md');writeFileSync(md,'# OLD');
 const [old]=await ensureMultiFormatDeliverables({markdownPath:md,outputDir:f.root,baseFileStem:'guide',requestedFormats:['html']});writeFileSync(md,'# NEW');
 f.p.clawbot.isConfigured=()=>true;f.p.clawbot.resolveDefaultRecipient=()=> 'A';
 const result=await f.p.pushToWeChat({files:[md,old],formats:['html'],queueOnly:true});expect(result.ok).toBe(true);expect(result.items).toHaveLength(2);expect(result.items.map(x=>x.target)).toContain(old);
});

for(const backend of ['codex','opencode','claude','gemini','workbuddy','aider','custom']){
 test(`F03 ${backend} timeout with a partial artifact still falls through`,()=>{const r=probe('review-cli-probe.ts',`${backend}:timeout`);expect(r.ok).toBe(true);expect(r.calls).toBe(2);expect(r.result.backend).toBe('success');});
}
test('F03 a successful CLI result remains successful without fallback',()=>{const r=probe('review-cli-probe.ts','codex:success');expect(r.ok).toBe(true);expect(r.calls).toBe(1);expect(r.result.backend).toBe('codex');});
test('F01 explicit referenced article wins over generic guide keywords',async()=>{
 const f=fixture(),md=join(f.root,'guide.md');writeFileSync(md,'# Referenced guide');
 const r=await (f.p.agent as any).handleSendFile({senderId:'A',unpacked:{userText:'请把这篇学习指南发给我'},decision:{slots:{fileTarget:'latest_note',requestedFormats:['md']}},referencedArticle:{id:1,title:'Guide',note_md_path:md},recentTurns:[]});
 expect(r.mediaDeliveries.map((d:any)=>d.mediaPath)).toEqual([md]);expect(r.outcome).toBe('success');
});
test('F07 empty artifact records do not hide prior files',async()=>{
 const f=fixture(),md=join(f.root,'guide.md');writeFileSync(md,'# Guide');
 for(const [key,record] of [['file',JSON.stringify([md])],['text','[]']]) f.db.recordConversationTurn({messageKey:key,senderId:'A',userText:'fixture',intent:'cli_push',complexity:'fast',modelUsed:'test',depositedPath:record,assistantReply:'ok'});
 const turns=f.db.getRecentConversationTurns('A',10);expect(turns.find(t=>t.message_key==='text')?.deposited_path).toBe('');
 const r=await (f.p.agent as any).handleSendFile({senderId:'A',unpacked:{userText:'文件呢'},decision:{slots:{fileTarget:'recent_generated',requestedFormats:['md']}},recentTurns:turns});
 expect(r.mediaDeliveries.map((d:any)=>d.mediaPath)).toEqual([md]);
});
