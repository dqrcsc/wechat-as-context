import { createHash } from 'node:crypto';

export type DeliveryStage = 'queue' | 'outbox' | 'media_prepare' | 'getuploadurl' | 'cdn_upload' | 'sendmessage' | 'sendmessage_media' | 'context';
export type DeliveryCategory = 'network' | 'timeout' | 'http' | 'api_prepare_failed' | 'api_rejected' | 'invalid_response' | 'local_validation' | 'interrupted';
export interface DeliveryEvent {
  stage: DeliveryStage;
  result: 'queued' | 'started' | 'succeeded' | 'failed' | 'retry_new_context' | 'retry_without_context' | 'context_cleared' | 'context_preserved';
  category?: DeliveryCategory;
  failureStage?: DeliveryStage;
  httpStatus?: number;
  ret?: number;
  errcode?: number;
  elapsedMs?: number;
  chunk?: number;
  tokenHash?: string;
  tokenRevision?: string;
  tokenAgeMs?: number;
  tokenPresent?: boolean;
  recipientHash?: string;
}
export type DeliveryReporter = (event: DeliveryEvent) => void;
export const deliveryFingerprint = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

// Observability must not turn an accepted remote send into a retry.
export function reportDelivery(report: DeliveryReporter | undefined, event: DeliveryEvent): void {
  try { report?.(event); } catch { console.warn('[DeliveryDiagnostics] event persistence failed'); }
}

export class DeliveryError extends Error {
  constructor(public stage: DeliveryStage, public category: DeliveryCategory,
    public codes: { httpStatus?: number; ret?: number; errcode?: number } = {}, hint = '') {
    super(`${stage}: ${category}${codes.httpStatus ? ` HTTP ${codes.httpStatus}` : ''}${codes.ret !== undefined ? ` ret=${codes.ret}` : ''}${codes.errcode !== undefined ? ` errcode=${codes.errcode}` : ''}${hint ? ` ${hint}` : ''}`);
  }
}
function code(value: unknown): number | undefined {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+$/.test(value))) return undefined;
  const n = Number(value); return Number.isSafeInteger(n) ? n : undefined;
}
export function apiDeliveryError(data: any, stage: DeliveryStage): DeliveryError | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return new DeliveryError(stage, 'invalid_response');
  const ret = code(data.ret), errcode = code(data.errcode);
  if ((data.ret !== undefined && ret === undefined) || (data.errcode !== undefined && errcode === undefined)) return new DeliveryError(stage, 'invalid_response');
  if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
    const prepare = ret === -2 && data.errmsg === 'prepare failed';
    // Never persist arbitrary response text: it may echo credentials or message content.
    const hint = prepare ? 'prepare failed' : data.errmsg === 'denied' ? 'denied' : 'request rejected';
    return new DeliveryError(stage, prepare ? 'api_prepare_failed' : 'api_rejected', { ret, errcode }, hint);
  }
  return null;
}
export function safeDeliveryError(error: unknown, stage: DeliveryStage): DeliveryError {
  if (error instanceof DeliveryError) return error;
  const name = error instanceof Error ? error.name : '';
  return new DeliveryError(stage, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' :
    stage === 'outbox' || stage === 'media_prepare' ? 'local_validation' : 'network');
}

/** One HTTP exchange. Endpoint stage is stored; URL, headers and bodies never are. */
export async function deliveryRequest(stage: DeliveryStage, request: () => Promise<Response>,
  report?: DeliveryReporter, metadata: Partial<DeliveryEvent> = {}, json = true): Promise<any> {
  const started = Date.now();
  reportDelivery(report, { ...metadata, stage, result: 'started' });
  let status: number | undefined;
  try {
    const response = await request(); status = response.status;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new DeliveryError(stage, 'http', { httpStatus: status });
    }
    let data: any = response;
    if (json) {
      try { data = await response.json(); } catch { throw new DeliveryError(stage, 'invalid_response'); }
      const error = apiDeliveryError(data, stage); if (error) throw error;
    }
    reportDelivery(report, { ...metadata, stage, result: 'succeeded', httpStatus: status, elapsedMs: Date.now() - started });
    return data;
  } catch (error) {
    const safe = safeDeliveryError(error, stage);
    reportDelivery(report, { ...metadata, stage, result: 'failed', category: safe.category, httpStatus: status, ...safe.codes, elapsedMs: Date.now() - started });
    throw safe;
  }
}
