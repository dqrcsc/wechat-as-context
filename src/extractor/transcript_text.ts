/** Only punctuation is normalized. Words, numbers and model/brand names are evidence. */
export function normalizeTranscriptPunctuation(raw: string): string {
  return raw.replace(/[，。！？；、]{2,}/g, marks => {
    for (const mark of ['？','！','。','；','，','、']) if(marks.includes(mark))return mark;
    return marks;
  });
}
export function renderAsrTranscript(raw: string): string {
  const clean=normalizeTranscriptPunctuation(raw);
  const suspects = transcriptReviewFragments(raw);
  const review = suspects.length ? '\n> 待人工听音核对（原始转写 UTF-16 字符位置，非时间戳）：' + suspects.map(item => `第${item.offset + 1}字符附近「${item.text}」`).join('；') + '。仅定位疑似断句，不据此改词。' : '';
  const notice='> 自动语音转写，未经逐字核对；专名、数字及同音词可能有误，未自动猜改。' + review;
  if(clean===raw)return `${notice}\n\n${raw}`;
  const escaped=raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `${notice}\n\n${clean}\n\n<details data-asr-raw="true"><summary>原始自动转写（仅上文标点经过清理）</summary>\n\n<pre>${escaped}</pre>\n\n</details>`;
}

/** Conservative, exact excerpts only; no inferred words, timestamps or confidence scores. */
export function transcriptReviewFragments(raw: string): Array<{ offset: number; text: string }> {
  const matches = raw.matchAll(/^[？！，。；]+|[。！？]\s+\d+(?:\.\d+)?[%％]?/g);
  return [...matches].slice(0, 3).map(match => ({ offset: match.index!,
    text: raw.slice(Math.max(0, match.index! - 6), Math.min(raw.length, match.index! + match[0].length + 12)).replace(/[\r\n]/g, ' ') }));
}
