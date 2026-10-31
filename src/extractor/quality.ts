/** Coverage describes acquired material, not semantic accuracy or source authenticity. */
export interface ExtractionQuality {
  status: 'complete' | 'partial' | 'metadata_only' | 'unavailable';
  reasons: string[];
  totalPages?: number;
  processedPages?: number[];
  missingPages?: number[];
}
export function extractionNotice(quality?: ExtractionQuality): string {
  if (!quality || quality.status === 'complete') return '';
  if (quality.totalPages !== undefined) return `⚠️ 图集仅解析 ${quality.processedPages?.length ?? 0}/${quality.totalPages} 页；未解析页：${quality.missingPages?.join('、') || '无'}。以下分析不代表覆盖全部图片。`;
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
      if(q.totalPages!==undefined && (!Number.isSafeInteger(q.totalPages)||q.totalPages<0||![q.processedPages,q.missingPages].every(a=>Array.isArray(a)&&a.every((n:unknown)=>Number.isSafeInteger(n)&&Number(n)>0&&Number(n)<=q.totalPages))))throw new Error('invalid');
      if (q.totalPages !== undefined) {
        const pages = [...q.processedPages, ...q.missingPages];
        if (pages.length !== q.totalPages || new Set(pages).size !== q.totalPages ||
            (q.status === 'complete' && q.missingPages.length > 0)) throw new Error('invalid');
      }
      return q;
    } catch { return {status:'unavailable',reasons:['invalid_saved_quality']}; }
  }
  if(/^transcript_engine:\s*["']?metadata_only["']?\s*$/m.test(front))return {status:'metadata_only',reasons:['legacy_reason_unknown']};
  return undefined;
}
