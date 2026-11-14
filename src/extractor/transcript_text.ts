import { renderAsrTimeline } from './asr_timing.ts';
import { asrEvidenceNotice } from './asr_quality.ts';
import type { ExtractionQuality } from './quality.ts';
/** Only punctuation is normalized. Words, numbers and model/brand names are evidence. */
export function normalizeTranscriptPunctuation(raw: string): string {
  return raw.replace(/[，。！？；、]{2,}/g, marks => {
    for (const mark of ['？','！','。','；','，','、']) if(marks.includes(mark))return mark;
    return marks;
  });
}
export function transcriptReviewNotice(raw: string): string {
  const suspects = transcriptReviewFragments(raw);
  const review = suspects.length ? '\n> 待人工听音核对（原始转写 UTF-16 字符位置，非时间戳）：' + suspects.map(item => `第${item.offset + 1}字符附近「${item.text}」`).join('；') + '。仅定位疑似断句，不据此改词。' : '';
  const terms = transcriptTermCandidates(raw);
  const termNotice = terms.length ? '\n> 疑似错词复核候选（最多5处外文词/专名，UTF-16 字符位置，非时间戳；不代表已判错）：' + terms.map(t => `第${t.offset + 1}字符「${t.text}」`).join('；') + '。不自动猜改；中文同音词也需听音核对，未列出不表示无误。' : '';
  return '> 自动语音转写，未经逐字核对；专名、数字及同音词可能有误，未自动猜改。' + review + termNotice;
}
export function renderAsrTranscript(raw: string, quality?: ExtractionQuality): string {
  const clean=normalizeTranscriptPunctuation(raw);
  const evidence=asrEvidenceNotice(quality);
  const notice=transcriptReviewNotice(raw)+(evidence ? '\n'+evidence : '');
  const timeline=(quality?.asrEvidence ?? []).filter(e=>e.timingAvailable && e.timing).map(e=>renderAsrTimeline(e.timing!)).join('\n\n');
  const suffix=timeline ? '\n\n'+timeline : '';
  if(clean===raw)return `${notice}\n\n${raw}${suffix}`;
  const escaped=raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `${notice}\n\n${clean}\n\n<details data-asr-raw="true"><summary>原始自动转写（仅上文标点经过清理）</summary>\n\n<pre>${escaped}</pre>\n\n</details>${suffix}`;
}

/** Conservative, exact excerpts only; no inferred words, timestamps or confidence scores. */
export function transcriptReviewFragments(raw: string): Array<{ offset: number; text: string }> {
  const matches = raw.matchAll(/^[？！，。；]+|[。！？]\s+\d+(?:\.\d+)?[%％]?/g);
  return [...matches].slice(0, 3).map(match => ({ offset: match.index!,
    text: raw.slice(Math.max(0, match.index! - 6), Math.min(raw.length, match.index! + match[0].length + 12)).replace(/[\r\n]/g, ' ') }));
}

/** Review candidates, not a dictionary/spelling verdict. Preserve exact source spans. */
export function transcriptTermCandidates(raw: string): Array<{offset: number; text: string}> {
  // Chinese speech only: an English transcript would otherwise flag every word.
  if (!/[\u3400-\u9fff]/u.test(raw)) return [];
  const ignored = new Set(['ai','asr','api','cpu','gpu','http','https','ok','llm','pdf','app']);
  const result: Array<{offset: number; text: string}> = [];
  const seen = new Set<string>();
  for (const match of raw.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[ -][A-Za-z][A-Za-z0-9]*){0,2}/g)) {
    const text = match[0], key = text.toLowerCase();
    if (text.length < 2 || text.length > 40 || key.split(/[ -]/).every(word => ignored.has(word)) || seen.has(key)) continue;
    seen.add(key); result.push({offset: match.index!, text});
    if (result.length === 5) break;
  }
  return result;
}
