import type { AsrEvidence, ExtractionQuality } from './quality.ts';

/** Engine completion and decoded duration are evidence, never a speech coverage proof. */
export function asrQuality(text: string, evidence: Partial<AsrEvidence> = {}, reasons: string[] = []): ExtractionQuality {
  const item: AsrEvidence = {
    engineCompletion: evidence.engineCompletion ?? 'unknown',
    textCharacters: Array.from(text.trim()).length,
    timingAvailable: false,
  };
  for (const key of ['inputDurationSeconds', 'decodedDurationSeconds'] as const) {
    const value = evidence[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) item[key] = value;
  }
  if (Number.isSafeInteger(evidence.segmentCount) && evidence.segmentCount! > 0) item.segmentCount = evidence.segmentCount;
  return { status: text.trim() ? 'partial' : 'unavailable',
    reasons: [...new Set([...reasons, text.trim() ? 'asr_coverage_unverified' : 'asr_empty'])], asrEvidence: [item] };
}

export function asrEvidenceNotice(quality?: ExtractionQuality): string {
  return (quality?.asrEvidence ?? []).map(e => {
    const input = e.inputDurationSeconds === undefined ? '未知' : `${e.inputDurationSeconds}秒`;
    const decoded = e.decodedDurationSeconds === undefined ? '未知' : `${e.decodedDurationSeconds}秒`;
    const completion = {completed: '正常结束', truncated: '已截断', unknown: '未知'}[e.engineCompletion];
    return `> 转写证据${e.videoIndex ? `（视频${e.videoIndex}）` : ''}：输入时长${input}；解码时长${decoded}；引擎${completion}；输出${e.textCharacters}字符${e.segmentCount === undefined ? '' : `、${e.segmentCount}个文本段`}。未取得逐段时间覆盖证据；时长与字符数不是口播覆盖率，也不证明文字准确。`;
  }).join('\n');
}
