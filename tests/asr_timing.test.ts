import './support/isolation.ts';
import {expect,test} from 'bun:test';
import {asrQuality} from '../src/extractor/asr_quality.ts';
import {validateAsrTiming,type TimedAsrCoverage} from '../src/extractor/asr_timing.ts';
import {extractionNotice,readSavedExtractionQuality} from '../src/extractor/quality.ts';
import {renderAsrTranscript} from '../src/extractor/transcript_text.ts';
const text='原词 Zorpex\n后段原文';
const timing:TimedAsrCoverage={schema:'wxctx-vad-v1',audioDurationMs:10000,scanComplete:true,
 vadSegments:[{startMs:1000,endMs:2000},{startMs:8000,endMs:9000}],
 segments:[{startMs:1000,endMs:2000,status:'ok',text:'原词 Zorpex'},{startMs:8000,endMs:9000,status:'ok',text:'后段原文'}]};
const evidence={engineCompletion:'completed' as const,inputDurationSeconds:10,decodedDurationSeconds:10,timing};
test('complete means all detected speech regions, not silence or word accuracy',()=>{
 const q=asrQuality(text,evidence,['asr_coverage_unverified']);expect(q.status).toBe('complete');expect(q.reasons).toEqual([]);
 expect(q.asrEvidence?.[0].timingAvailable).toBe(true);expect(q.asrEvidence?.[0].segmentCount).toBe(2);
 expect(extractionNotice(q)).toContain('不保证 VAD 无漏检');
 const body=renderAsrTranscript(text,q);expect(body).toContain('[00:01.000–00:02.000]');expect(body).toContain('[00:08.000–00:09.000]');expect(body).toContain(text);expect(body).not.toContain('原词 Zorpex改');
 expect(readSavedExtractionQuality(`---\nextraction_quality: ${JSON.stringify(q)}\n---\n${body}`)).toEqual(q);
});
for(const status of ['empty','failed'] as const)test(`missing segment is retained with exact interval: ${status}`,()=>{
 const t=structuredClone(timing);t.segments[1]={...t.segments[1]!,status,text:''};const q=asrQuality('原词 Zorpex',{...evidence,timing:t});
 expect(q.status).toBe('partial');expect(q.reasons).toContain('asr_segments_missing');expect(q.asrEvidence?.[0].timing?.segments).toHaveLength(2);
 expect(renderAsrTranscript('原词 Zorpex',q)).toContain('[00:08.000–00:09.000]');
});
for(const [label,mutate] of [
 ['overlap',(t:any)=>t.vadSegments[1].startMs=1500],
 ['wrong pair',(t:any)=>t.segments[1].endMs=9100],
 ['out of range',(t:any)=>t.vadSegments[1].endMs=10001],
 ['missing row',(t:any)=>t.segments.pop()],
 ['duplicate row',(t:any)=>t.segments.push(t.segments[0])],
 ['wrong unit',(t:any)=>t.schema='seconds'],
 ['empty ok',(t:any)=>t.segments[1].text=''],
 ['failed with text',(t:any)=>t.segments[1].status='failed'],
 ['fractional',(t:any)=>t.vadSegments[0].startMs=1.5],
] as const)test(`malformed time evidence cannot grant complete: ${label}`,()=>{
 const t=structuredClone(timing);mutate(t);expect(validateAsrTiming(t,text)).toBeNull();expect(asrQuality(text,{...evidence,timing:t}).status).toBe('partial');
});
test('text/times, decoding duration, engine completion and full VAD scan must agree',()=>{
 expect(asrQuality('different text',evidence).reasons).toContain('asr_timing_invalid');
 for(const change of [{inputDurationSeconds:11},{decodedDurationSeconds:9.9},{engineCompletion:'unknown' as const},{timing:{...timing,scanComplete:false}}])expect(asrQuality(text,{...evidence,...change}).status).toBe('partial');
 expect(asrQuality(text,evidence,['asr_truncated']).status).toBe('partial');
 expect(asrQuality(text,{...evidence,inputDurationSeconds:10.5}).status).toBe('complete');
 expect(asrQuality(text,{...evidence,inputDurationSeconds:10.501}).status).toBe('partial');
});
test('no detected speech is never complete and saved evidence cannot forge completeness',()=>{
 const t={...timing,vadSegments:[],segments:[]};const q=asrQuality('',{...evidence,timing:t});expect(q.status).toBe('unavailable');expect(q.reasons).toContain('asr_no_speech_detected');
 expect(readSavedExtractionQuality(`---\nextraction_quality: ${JSON.stringify(q)}\n---\nBody`)).toEqual(q);
 const forged=asrQuality(text,evidence);forged.asrEvidence![0].textCharacters++;
 expect(readSavedExtractionQuality(`---\nextraction_quality: ${JSON.stringify(forged)}\n---\nBody`)?.status).toBe('unavailable');
});

import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {saveRawWebArticleToVault} from '../src/extractor/web.ts';
import {saveRawArticleToVault} from '../src/extractor/wechat.ts';
test('both writers preserve timed evidence and unchanged names through disk roundtrip',async()=>{
 const root=mkdtempSync(join(tmpdir(),'asr-timed-write-')),q=asrQuality(text,evidence);
 const article={url:'https://example.test/timed',title:'Timed',author:'',publishDate:'',markdownBody:renderAsrTranscript(text,q),digest:'',imageUrls:[],extractorUsed:'native_http' as const,extractionQuality:q};
 for(const mode of ['web','wechat']){
  const path=mode==='web'?await saveRawWebArticleToVault({articlesDir:join(root,mode),article,slug:'timed'}):await saveRawArticleToVault({wechatArticlesDir:join(root,mode),article,slug:'timed'});
  const disk=readFileSync(path,'utf8');expect(readSavedExtractionQuality(disk)).toEqual(q);expect(disk).toContain('[00:08.000–00:09.000]');expect(disk).toContain(text);
 }
});
test('failed duration verification does not claim timestamps are missing',()=>{
 const q=asrQuality(text,{...evidence,decodedDurationSeconds:8});expect(extractionNotice(q)).toContain('音轨时长校验未通过');expect(extractionNotice(q)).not.toContain('缺少逐段');
});

test('saved complete rejects contradictory empty diagnostics and timeline escapes markup without guessing words',()=>{
 for(const reason of ['asr_no_speech_detected','asr_empty']) { const q=asrQuality(text,evidence);q.reasons.push(reason);expect(readSavedExtractionQuality(`---\nextraction_quality: ${JSON.stringify(q)}\n---\nBody`)?.status).toBe('unavailable'); }
 const t=structuredClone(timing);t.segments[0]!.text='原词 </details> & Zorpex';const raw=t.segments.map(s=>s.text).join('\n');
 expect(renderAsrTranscript(raw,asrQuality(raw,{...evidence,timing:t}))).toContain('原词 &lt;/details&gt; &amp; Zorpex');
});
