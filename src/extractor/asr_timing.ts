/** Times are VAD segment boundaries in milliseconds, never word alignment. */
export interface TimedAsrCoverage {
  schema: 'wxctx-vad-v1';
  audioDurationMs: number;
  scanComplete: boolean;
  vadSegments: Array<{startMs: number; endMs: number}>;
  segments: Array<{startMs: number; endMs: number; status: 'ok' | 'empty' | 'failed'; text: string}>;
}

export function validateAsrTiming(value: unknown, text: string): TimedAsrCoverage | null {
  const t = value as TimedAsrCoverage;
  if (!t || t.schema !== 'wxctx-vad-v1' || !Number.isSafeInteger(t.audioDurationMs) || t.audioDurationMs <= 0 ||
      t.audioDurationMs > 4 * 3600 * 1000 || typeof t.scanComplete !== 'boolean' ||
      !Array.isArray(t.vadSegments) || !Array.isArray(t.segments) || t.vadSegments.length > 2000 || t.vadSegments.length !== t.segments.length) return null;
  let last = 0;
  for (let i = 0; i < t.vadSegments.length; i++) {
    const v = t.vadSegments[i]!, s = t.segments[i]!;
    if (!v || !s || !Number.isSafeInteger(v.startMs) || !Number.isSafeInteger(v.endMs) ||
        v.startMs < last || v.endMs <= v.startMs || v.endMs > t.audioDurationMs ||
        s.startMs !== v.startMs || s.endMs !== v.endMs || !['ok','empty','failed'].includes(s.status) ||
        typeof s.text !== 'string' || s.text !== s.text.trim() || (s.status === 'ok') !== Boolean(s.text)) return null;
    last = v.endMs;
  }
  if (t.segments.filter(s => s.status === 'ok').map(s => s.text).join('\n') !== text.trim()) return null;
  // Copy the contract fields only; do not archive arbitrary tool payloads.
  return {schema:t.schema,audioDurationMs:t.audioDurationMs,scanComplete:t.scanComplete,
    vadSegments:t.vadSegments.map(v=>({startMs:v.startMs,endMs:v.endMs})),
    segments:t.segments.map(s=>({startMs:s.startMs,endMs:s.endMs,status:s.status,text:s.text}))};
}

export function timedCoverageStats(t: TimedAsrCoverage) {
  const detectedMs=t.vadSegments.reduce((sum,s)=>sum+s.endMs-s.startMs,0);
  const transcribedMs=t.segments.filter(s=>s.status==='ok').reduce((sum,s)=>sum+s.endMs-s.startMs,0);
  return {detectedMs,transcribedMs,missingSegments:t.segments.filter(s=>s.status!=='ok').length};
}

function timestamp(ms: number): string {
  return `${Math.floor(ms/60000).toString().padStart(2,'0')}:${(Math.floor(ms/1000)%60).toString().padStart(2,'0')}.${(ms%1000).toString().padStart(3,'0')}`;
}
export function renderAsrTimeline(t: TimedAsrCoverage): string {
  return '<details data-asr-timing="true"><summary>VAD分段时间与转写（非逐字对齐）</summary>\n\n' +
    t.segments.map((s,i)=>`- ${i+1}. [${timestamp(s.startMs)}–${timestamp(s.endMs)}] ${s.status==='ok'?s.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):s.status==='empty'?'【未取得文本】':'【转写失败】'}`).join('\n')+'\n\n</details>';
}

/** Numeric checks are container/decoder tolerances, not statistical confidence bounds. */
export function timingCanComplete(t: TimedAsrCoverage, input: number | undefined, decoded: number | undefined, completion: string, reasons: string[]): boolean {
  const stats=timedCoverageStats(t);
  return t.scanComplete && stats.detectedMs>0 && stats.missingSegments===0 && completion==='completed' &&
    input!==undefined && decoded!==undefined && Math.abs(decoded*1000-t.audioDurationMs)<=20 && Math.abs(input-decoded)<=0.5 &&
    !reasons.some(r=>['asr_truncated','asr_finish_reason_missing'].includes(r));
}
