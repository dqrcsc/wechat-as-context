import {validateAsrTiming, timedCoverageStats, timingCanComplete} from './asr_timing.ts';
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
  const retained = reasons.filter(r=> !['asr_coverage_unverified','asr_timing_invalid','asr_segments_missing','asr_vad_scan_incomplete','asr_decode_duration_mismatch','asr_no_speech_detected'].includes(r));
  const timing = validateAsrTiming(evidence.timing, text);
  let complete = false;
  if (timing) {
    item.timingAvailable = true;
    item.timing = timing;
    item.segmentCount = timing.segments.length;
    const stats = timedCoverageStats(timing);
    if (!timing.scanComplete) retained.push('asr_vad_scan_incomplete');
    if (!timing.vadSegments.length) retained.push('asr_no_speech_detected');
    if (stats.missingSegments) retained.push('asr_segments_missing');
    const decoded = item.decodedDurationSeconds, input = item.inputDurationSeconds;
    const durationMatches = decoded !== undefined && input !== undefined &&
      Math.abs(decoded*1000-timing.audioDurationMs) <= 20 && Math.abs(input-decoded) <= 0.5;
    if (!durationMatches) retained.push('asr_decode_duration_mismatch');
    complete = timingCanComplete(timing, input, decoded, item.engineCompletion, retained);
  } else if (evidence.timing !== undefined || evidence.timingAvailable) retained.push('asr_timing_invalid');
  if (!complete && text.trim() && (!timing || (!retained.includes('asr_segments_missing') && !retained.includes('asr_truncated')))) retained.push('asr_coverage_unverified');
  if (!text.trim()) retained.push('asr_empty');
  return {status: text.trim() ? (complete ? 'complete' : 'partial') : 'unavailable', reasons:[...new Set(retained)], asrEvidence:[item]};
}

export function asrEvidenceNotice(quality?: ExtractionQuality): string {
  return (quality?.asrEvidence ?? []).map(e => {
    const input = e.inputDurationSeconds === undefined ? '未知' : `${e.inputDurationSeconds}秒`;
    const decoded = e.decodedDurationSeconds === undefined ? '未知' : `${e.decodedDurationSeconds}秒`;
    const completion = {completed: '正常结束', truncated: '已截断', unknown: '未知'}[e.engineCompletion];
    const stats = e.timing ? timedCoverageStats(e.timing) : null;
    const coverage = stats ? `VAD检测语音${(stats.detectedMs/1000).toFixed(3)}秒，取得文本的检测区间${(stats.transcribedMs/1000).toFixed(3)}秒，缺失${stats.missingSegments}段；分段时间来自VAD，非逐字对齐，不保证VAD无漏检或文字准确。` : '未取得逐段时间覆盖证据；时长与字符数不是口播覆盖率，也不证明文字准确。';
    return `> 转写证据${e.videoIndex ? `（视频${e.videoIndex}）` : ''}：输入时长${input}；解码时长${decoded}；引擎${completion}；输出${e.textCharacters}字符${e.segmentCount === undefined ? '' : `、${e.segmentCount}个文本段`}。${coverage}`;
  }).join('\n');
}
