/** Coverage describes acquired material, not semantic accuracy or source authenticity. */
export interface ExtractionQuality {
  status: 'complete' | 'partial' | 'metadata_only' | 'unavailable';
  reasons: string[];
  totalPages?: number;
  processedPages?: number[];
  missingPages?: number[];
  /** Coverage of video transcripts only, even when a message also contains files/images. */
  totalVideos?: number;
  processedVideos?: number[];
  /** Videos with some usable transcript but incomplete coverage; subset of processedVideos. */
  partialVideos?: number[];
  missingVideos?: number[];
}
export function extractionNotice(quality?: ExtractionQuality): string {
  const warnings = [];
  if (quality?.reasons.includes('caption_language_mismatch')) warnings.push('⚠️ 源站字幕语言声明与正文文字特征不一致，实际语言待核验；不能视为已取得声明语言的逐字稿。');
  if (quality?.reasons.includes('douyin_content_unavailable')) warnings.push('⚠️ 本次未取得有效作品文案或逐字稿；保留的旧标题仅用于识别作品，不能据此分析正文。');
  else if (quality) warnings.push(coverageNotice(quality));
  return warnings.filter(Boolean).join('\n\n');
}

function coverageNotice(quality?: ExtractionQuality): string {
  if (!quality || quality.status === 'complete') return '';
  if (quality.totalVideos !== undefined) return `⚠️ 视频口播转写仅取得 ${quality.processedVideos?.length ?? 0}/${quality.totalVideos} 份${quality.partialVideos?.length ? `，其中部分转写的视频序号：${quality.partialVideos.join("、")}` : ""}；未取得转写的视频序号：${quality.missingVideos?.join('、') || '无'}。不代表已理解全部视频画面或其他附件。`;
  if (quality.totalPages !== undefined) return `⚠️ 图集仅解析 ${quality.processedPages?.length ?? 0}/${quality.totalPages} 页；未解析页：${quality.missingPages?.join('、') || '无'}。以下分析不代表覆盖全部图片。`;
  if (quality.status === 'partial') return '⚠️ 本次仅取得部分逐字稿，转写不完整；以下分析仅覆盖已获取片段。';
  if (quality.status === 'unavailable') return '⚠️ 采集内容或解析质量记录不可用；需核对原始来源，以下分析不能视为完整正文分析。';
  return '⚠️ 本次未取得完整逐字稿，仅根据已获取的简介/元数据分析；不能据此判断源站是否提供字幕。';
}

/** Read only metadata authored by the source writer; malformed coverage fails visibly. */
export function readSavedExtractionQuality(source: string): ExtractionQuality | undefined {
  const front=source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const raw=front.match(/^extraction_quality:\s*(.+)$/m)?.[1];
  if(raw){
    try {
      const q=JSON.parse(raw);
      if(!['complete','partial','metadata_only','unavailable'].includes(q?.status)||!Array.isArray(q.reasons)||!q.reasons.every((x:unknown)=>typeof x==='string'))throw new Error('invalid');
      if (q.partialVideos !== undefined &&
          (!Array.isArray(q.partialVideos) || !q.partialVideos.length || q.status !== 'partial' ||
           !Array.isArray(q.processedVideos) || new Set(q.partialVideos).size !== q.partialVideos.length ||
           !q.partialVideos.every((n: unknown) => Number.isSafeInteger(n) && q.processedVideos.includes(n)))) throw new Error('invalid');
      for (const [totalKey, processedKey, missingKey] of [
        ['totalPages', 'processedPages', 'missingPages'],
        ['totalVideos', 'processedVideos', 'missingVideos'],
      ]) {
        const total = q[totalKey], processed = q[processedKey], missing = q[missingKey];
        if (total === undefined) {
          if (processed !== undefined || missing !== undefined) throw new Error('invalid');
          continue;
        }
        if (!Number.isSafeInteger(total) || total < 0 ||
            ![processed, missing].every(a => Array.isArray(a) && a.every(n => Number.isSafeInteger(n) && n > 0 && n <= total))) throw new Error('invalid');
        const items = [...processed, ...missing];
        if (items.length !== total || new Set(items).size !== total ||
            (q.status === 'complete' && missing.length > 0) ||
            (q.status === 'partial' && (!processed.length || (!missing.length && !(totalKey === 'totalVideos' && q.partialVideos?.length)))) ||
            (q.status === 'unavailable' && processed.length > 0)) throw new Error('invalid');
      }
      return q;
    } catch { return {status:'unavailable',reasons:['invalid_saved_quality']}; }
  }
  if(/^transcript_engine:\s*["']?metadata_only["']?\s*$/m.test(front))return {status:'metadata_only',reasons:['legacy_reason_unknown']};
  return undefined;
}
