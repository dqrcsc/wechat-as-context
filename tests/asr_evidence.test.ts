import './support/isolation.ts';
import {expect,test} from 'bun:test';
import {asrQuality, asrEvidenceNotice} from '../src/extractor/asr_quality.ts';
import {extractionNotice,readSavedExtractionQuality} from '../src/extractor/quality.ts';
import {transcriptTermCandidates,renderAsrTranscript} from '../src/extractor/transcript_text.ts';

test('nonempty local output is unverified even when engine completes and durations match',()=>{
 const q=asrQuality('真实正文',{engineCompletion:'completed',inputDurationSeconds:220,decodedDurationSeconds:220,segmentCount:1});
 expect(q.status).toBe('partial');expect(q.reasons).toContain('asr_coverage_unverified');
 expect(q.asrEvidence?.[0]).toMatchObject({textCharacters:4,timingAvailable:false,segmentCount:1});
 expect(extractionNotice(q)).toContain('完整性未核验');expect(extractionNotice(q)).not.toContain('转写不完整');
 expect(asrEvidenceNotice(q)).toContain('220');expect(asrEvidenceNotice(q)).toContain('不是口播覆盖率');
 expect(readSavedExtractionQuality(`---\nextraction_quality: ${JSON.stringify(q)}\n---\nBody`)).toEqual(q);
});
test('known truncation remains explicit and durations never invent coverage',()=>{
 const q=asrQuality('片段',{engineCompletion:'truncated'},['asr_truncated']);
 expect(q.status).toBe('partial');expect(extractionNotice(q)).toContain('转写不完整');
 expect(q.asrEvidence?.[0].inputDurationSeconds).toBeUndefined();
 expect(asrQuality('',{engineCompletion:'completed'}).status).toBe('unavailable');
});
test('invalid measurements are omitted rather than represented as successful coverage',()=>{
 const q=asrQuality('文',{engineCompletion:'unknown',inputDurationSeconds:NaN,decodedDurationSeconds:-1,segmentCount:Infinity});
 expect(q.asrEvidence?.[0]).toEqual({engineCompletion:'unknown',textCharacters:1,timingAvailable:false});
});
test('foreign term hints preserve exact UTF-16 offsets, do not propose corrected names',()=>{
 const text='😀工具 Zorpex 和 qlo cold，再用 Zorpex。中文同音词需要听音。';
 const hints=transcriptTermCandidates(text);
 expect(hints.map(h=>h.text)).toEqual(['Zorpex','qlo cold']);
 for(const h of hints)expect(text.slice(h.offset,h.offset+h.text.length)).toBe(h.text);
 const body=renderAsrTranscript(text);expect(body).toContain(text);expect(body).toContain('疑似错词复核候选');expect(body).toContain('不代表已判错');
 expect(transcriptTermCandidates('AI CPU HTTP ASR OK 正常中文')).toEqual([]);
 expect(transcriptTermCandidates('甲 Aardvark 乙 Bagger 丙 Crawler 丁 Dagger 戊 Evermore 己 Finder')).toHaveLength(5);
});
test('malformed evidence and complete with unverified ASR cannot be read as complete',()=>{
 for(const change of [{textCharacters:-1},{timingAvailable:true},{inputDurationSeconds:-3},{engineCompletion:'success'},{videoIndex:2}]){
  const q=asrQuality('文',{engineCompletion:'completed'});Object.assign(q.asrEvidence![0],change);
  expect(readSavedExtractionQuality(`---\nextraction_quality: ${JSON.stringify(q)}\n---\nBody`)?.status).toBe('unavailable');
 }
 const q={...asrQuality('文',{engineCompletion:'completed'}),status:'complete'};
 expect(readSavedExtractionQuality(`---\nextraction_quality: ${JSON.stringify(q)}\n---\nBody`)?.status).toBe('unavailable');
});

import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {saveRawWebArticleToVault} from '../src/extractor/web.ts';
import {saveRawArticleToVault} from '../src/extractor/wechat.ts';
import {setAsrTestRunner,transcribeAudioFromMedia} from '../src/extractor/asr.ts';

test('even legacy/custom complete output passes through the conservative ASR boundary',async()=>{
 setAsrTestRunner(async()=>({transcript:'有限文本',engineUsed:'fixture',extractionQuality:{status:'complete',reasons:[]}}));
 try { const r=await transcribeAudioFromMedia({});expect(r.extractionQuality?.status).toBe('partial');expect(r.extractionQuality?.asrEvidence?.[0].engineCompletion).toBe('unknown'); }
 finally {setAsrTestRunner(null);}
});
test('both source writers preserve new ASR evidence and unknown coverage',async()=>{
 const root=mkdtempSync(join(tmpdir(),'asr-evidence-write-'));
 const q=asrQuality('示例正文',{engineCompletion:'completed',inputDurationSeconds:60,decodedDurationSeconds:59.98,segmentCount:1});
 const article={url:'https://example.test/video',title:'Evidence',author:'',publishDate:'',markdownBody:renderAsrTranscript('示例正文',q),digest:'',imageUrls:[],extractorUsed:'native_http' as const,extractionQuality:q};
 for(const mode of ['web','wechat']){
  const path=mode==='web'?await saveRawWebArticleToVault({articlesDir:join(root,mode),article,slug:'evidence'}):await saveRawArticleToVault({wechatArticlesDir:join(root,mode),article,slug:'evidence'});
  const saved=readFileSync(path,'utf8');expect(readSavedExtractionQuality(saved)).toEqual(q);expect(saved).toContain('不是口播覆盖率');
 }
});
