import './support/isolation.ts';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, statSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateDaemonLogsIfOversized as rotate } from '../src/log_rotation.ts';
import { saveCompanionLightNote, isUnmodifiedGeneratedLightNote } from '../src/vault/context.ts';
import { ContextDatabase } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { WeChatContextPipeline } from '../src/pipeline.ts';
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch});

test('non-fallback manual light note must survive stale fallback database summary', async()=>{
 const root=mkdtempSync(join(tmpdir(),'review-note-'));
 const config=loadConfig({IGNORE_HOME_DOTENV:'true',VAULT_ROOT:'none',WECHAT_CONTEXT_DATA_DIR:join(root,'data'),LLM_API_KEY:'fixture',LLM_PROVIDER:'custom',LLM_BASE_URL:'https://model.example.test/v1',LLM_MODEL:'fixture'});
 mkdirSync(config.dataDir,{recursive:true});
 const db=new ContextDatabase(config.dbPath);
 try {
  const source=join(root,'source.md'),note=join(root,'note.md');
  const manual='---\nprocess_level: light\n---\n# 人工修订\n独立补写的分析应保留。';
  writeFileSync(source,'---\nprocess_level: raw\n---\n原始文章足够正文。');writeFileSync(note,manual);
  const row=db.enqueueArticle({msgid:'manual-note',url:'https://mp.weixin.qq.com/s/fixture',channel:'cli'}).record;
  db.updateArticle(row.id,{source_md_path:source,note_md_path:note,title:'fixture',status:'light_done',process_level:'light',short_summary:'未完成模型分析，以下仅为本地原文摘录，不代表已完成观点或业务判断。'});
  globalThis.fetch=(async()=>Response.json({choices:[{message:{content:JSON.stringify({english_slug:'fixture',triage:'reference',validation_contract:null,wechat_reply:'新的模型分析',companion_note_markdown:'## 新分析\n替换正文'})}}]})) as unknown as typeof fetch;
  let error='';try{await new WeChatContextPipeline(config,db).reanalyzeArticleById(row.id);}catch(e){error=String(e)}
  console.log(JSON.stringify({probe:'manual-note',threw:error,manualPreserved:readFileSync(note,'utf8')===manual}));
  expect(error).toContain('--force');
  expect(readFileSync(note,'utf8')).toBe(manual);
 } finally {db.db.close()}
});

test('log rotation retains append descriptor and rotates repeatedly',()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-log-')),log=join(dir,'daemon.stdout.log');
 const fd=openSync(log,'a');
 try {
  writeFileSync(fd,'first-output');rotate(dir,1);
  writeFileSync(fd,'-more-output');rotate(dir,1);
  expect(readFileSync(log+'.1','utf8')).toBe('-more-output');
  expect(statSync(log).size).toBe(0);
  writeFileSync(fd, 'after-second-rotation');
  expect(readFileSync(log, 'utf8')).toBe('after-second-rotation');
  expect(existsSync(log)).toBe(true);
 } finally {closeSync(fd)}
});

test('manual edits retaining fallback marker must not be overwritten', async()=>{
 const root=mkdtempSync(join(tmpdir(),'review-note-'));
 const config=loadConfig({IGNORE_HOME_DOTENV:'true',VAULT_ROOT:'none',WECHAT_CONTEXT_DATA_DIR:join(root,'data'),LLM_API_KEY:'fixture',LLM_PROVIDER:'custom',LLM_BASE_URL:'https://model.example.test/v1',LLM_MODEL:'fixture'});
 mkdirSync(config.dataDir,{recursive:true});
 const db=new ContextDatabase(config.dbPath);
 try {
  const source=join(root,'source.md'),note=join(root,'note.md');
  const manual='---\nprocess_level: light\n---\n# 人工修订\n未完成模型分析，以下仅为本地原文摘录，不代表已完成观点或业务判断。\n## 我的补充\n独立补写的分析应保留。';
  writeFileSync(source,'---\nprocess_level: raw\n---\n原始文章足够正文。');writeFileSync(note,manual);
  const row=db.enqueueArticle({msgid:'manual-note',url:'https://mp.weixin.qq.com/s/fixture',channel:'cli'}).record;
  db.updateArticle(row.id,{source_md_path:source,note_md_path:note,title:'fixture',status:'light_done',process_level:'light',short_summary:'未完成模型分析，以下仅为本地原文摘录，不代表已完成观点或业务判断。'});
  globalThis.fetch=(async()=>Response.json({choices:[{message:{content:JSON.stringify({english_slug:'fixture',triage:'reference',validation_contract:null,wechat_reply:'新的模型分析',companion_note_markdown:'## 新分析\n替换正文'})}}]})) as unknown as typeof fetch;
  let error='';try{await new WeChatContextPipeline(config,db).reanalyzeArticleById(row.id);}catch(e){error=String(e)}
  console.log(JSON.stringify({probe:'manual-note',threw:error,manualPreserved:readFileSync(note,'utf8')===manual}));
  expect(readFileSync(note,'utf8')).toBe(manual);
 } finally {db.db.close()}
});




test('generated fallback fingerprint protects manual edits even when the disclaimer remains', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fingerprint-note-'));
  const config = loadConfig({ IGNORE_HOME_DOTENV: 'true', VAULT_ROOT: 'none', WECHAT_CONTEXT_DATA_DIR: join(root, 'data') });
  const db = new ContextDatabase(config.dbPath);
  try {
    const source = join(root, 'source.md'); writeFileSync(source, 'original source');
    const note = saveCompanionLightNote({ sourceMdPath: source, sourceUrl: 'https://example.test/article', title: 'fixture', author: 'fixture',
      triage: 'reference', relatedVaultNodes: [], noteMarkdownBody: '未完成模型分析，以下仅为本地原文摘录，不代表已完成观点或业务判断。' });
    expect(isUnmodifiedGeneratedLightNote(readFileSync(note, 'utf8'))).toBe(true);
    const edited = readFileSync(note, 'utf8') + '\n## My analysis\nManual changes must survive.\n';
    writeFileSync(note, edited);
    expect(isUnmodifiedGeneratedLightNote(edited)).toBe(false);
    const row = db.enqueueArticle({ msgid: 'fingerprinted', url: 'https://example.test/article', channel: 'cli' }).record;
    db.updateArticle(row.id, {source_md_path: source, note_md_path: note, process_level: 'light'});
    await expect(new WeChatContextPipeline(config, db).reanalyzeArticleById(row.id)).rejects.toThrow('--force');
    expect(readFileSync(note, 'utf8')).toBe(edited);
  } finally { db.db.close(); }
});
