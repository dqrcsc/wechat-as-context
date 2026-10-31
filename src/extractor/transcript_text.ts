/** Only punctuation is normalized. Words, numbers and model/brand names are evidence. */
export function normalizeTranscriptPunctuation(raw: string): string {
  return raw.replace(/[，。！？；、]{2,}/g, marks => {
    for (const mark of ['？','！','。','；','，','、']) if(marks.includes(mark))return mark;
    return marks;
  });
}
export function renderAsrTranscript(raw: string): string {
  const clean=normalizeTranscriptPunctuation(raw);
  const notice='> 自动语音转写，未经逐字核对；专名、数字及同音词可能有误，未自动猜改。';
  if(clean===raw)return `${notice}\n\n${raw}`;
  const escaped=raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `${notice}\n\n${clean}\n\n<details data-asr-raw="true"><summary>原始自动转写（仅上文标点经过清理）</summary>\n\n<pre>${escaped}</pre>\n\n</details>`;
}
