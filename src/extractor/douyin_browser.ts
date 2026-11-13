import { matchingDouyinDetail } from './social_identity.ts';

export interface DouyinBrowserResult {
  awemeDetail: any | null;
  reasons: string[];
}

/** Only target-detail data may supply streams; DOM videos can be unrelated placeholders. */
export function hasDouyinMedia(detail: any): boolean {
  const http = (value: unknown) => typeof value === 'string' && /^https?:\/\//.test(value);
  const some = (items: unknown, predicate: (item: any) => boolean) => Array.isArray(items) && items.some(predicate);
  const video = detail?.video;
  return Boolean(some(detail?.images, image => some(image?.url_list, http)) ||
    some(video?.play_addr?.url_list, http) ||
    some(video?.bit_rate, gear => some(gear?.play_addr?.url_list, http)) ||
    some(video?.bit_rate_audio, gear => http(gear?.audio_meta?.url_list?.main_url) || http(gear?.audio_meta?.url_list?.backup_url)));
}

/** Observe bounded CDP acquisition without exposing raw URLs, response bodies or errors. */
export async function collectDouyinDetail(
  awemeId: string,
  cdp: { call(method: string, params?: Record<string, unknown>): Promise<any> },
  socket: Pick<WebSocket, 'addEventListener' | 'removeEventListener'>,
  options: { signal: AbortSignal; observeMs?: number; reloadAtMs?: number | null; sleep?: (ms: number) => Promise<unknown> },
): Promise<DouyinBrowserResult> {
  const reasons = new Set<string>();
  const pending = new Set<Promise<void>>();
  const detailRequests = new Set<string>(), documents = new Set<string>();
  let detail: any = null, sawDetailRequest = false, sawDetailBody = false;
  let stage = 'setup', listening = true;
  const target = `https://www.douyin.com/video/${awemeId}`;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const isDetailUrl = (raw: unknown) => {
    try { const u = new URL(String(raw)); return u.protocol === 'https:' && u.hostname === 'www.douyin.com' && /^\/aweme\/v1\/web\/aweme\/detail\/?$/.test(u.pathname); }
    catch { return false; }
  };
  const onMessage = (event: Event) => {
    let data: any;
    try { data = JSON.parse(String((event as MessageEvent).data)); } catch { return; }
    const p = data.params || {}, requestId = p.requestId;
    if (typeof requestId !== 'string') return;
    if (data.method === 'Network.requestWillBeSent' || data.method === 'Network.responseReceived') {
      const url = p.request?.url || p.response?.url;
      if (isDetailUrl(url)) { detailRequests.add(requestId); sawDetailRequest = true; }
      if (p.type === 'Document' && url === target) documents.add(requestId);
      const status = p.response?.status;
      if (Number.isInteger(status) && status >= 400 && status <= 599) {
        if (detailRequests.has(requestId)) reasons.add(`douyin_cdp_detail_http_${status}`);
        if (documents.has(requestId)) reasons.add(`douyin_cdp_document_http_${status}`);
      }
    }
    if (data.method === 'Network.loadingFailed') {
      if (detailRequests.has(requestId)) reasons.add('douyin_cdp_detail_network_failed');
      if (documents.has(requestId)) reasons.add(/CERT_|SSL_/.test(String(p.errorText)) ? 'douyin_cdp_document_tls_failed' : 'douyin_cdp_document_network_failed');
    }
    if (data.method === 'Network.loadingFinished' && detailRequests.delete(requestId)) {
      const reading = (async () => {
        try {
          const body = await cdp.call('Network.getResponseBody', { requestId });
          if (!body?.body) { reasons.add('douyin_cdp_detail_empty'); return; }
          sawDetailBody = true;
          let parsed: any;
          try { parsed = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body); }
          catch { reasons.add('douyin_cdp_detail_invalid_json'); return; }
          const candidate = matchingDouyinDetail(parsed?.aweme_detail, awemeId);
          if (!candidate) {
            reasons.add(parsed?.aweme_detail?.aweme_id ? 'douyin_cdp_detail_identity_mismatch' : 'douyin_cdp_detail_missing');
            return;
          }
          // A later restricted response must not replace already acquired usable media.
          if (!detail || !hasDouyinMedia(detail) || hasDouyinMedia(candidate)) detail = candidate;
        } catch { reasons.add('douyin_cdp_detail_body_failed'); }
      })();
      pending.add(reading); void reading.finally(() => pending.delete(reading));
    }
  };
  socket.addEventListener('message', onMessage);
  try {
    options.signal.throwIfAborted();
    await cdp.call('Network.enable');
    await cdp.call('Page.enable');
    stage = 'navigation';
    const navigation = await cdp.call('Page.navigate', { url: target });
    if (navigation?.errorText) {
      reasons.add(/CERT_|SSL_/.test(String(navigation.errorText)) ? 'douyin_cdp_document_tls_failed' : 'douyin_cdp_navigation_failed');
    } else {
      stage = 'observation';
      const observeMs = options.observeMs ?? 25000;
      const reloadAt = options.reloadAtMs === undefined ? 12500 : options.reloadAtMs;
      for (let elapsed = 0; elapsed < observeMs; elapsed += 500) {
        options.signal.throwIfAborted();
        if (hasDouyinMedia(detail)) break;
        await sleep(Math.min(500, observeMs - elapsed));
        if (reloadAt !== null && elapsed < reloadAt && elapsed + 500 >= reloadAt && !sawDetailRequest) {
          stage = 'reload'; await cdp.call('Page.navigate', { url: target }); stage = 'observation';
        }
      }
    }
    socket.removeEventListener('message', onMessage); listening = false;
    // Include a body read started at the observation boundary; CDP has its own deadline.
    await Promise.all([...pending]);
  } catch (error) {
    reasons.add(options.signal.aborted ? 'douyin_cdp_deadline' :
      stage === 'navigation' ? (/timeout/i.test(String(error)) ? 'douyin_cdp_navigation_timeout' : 'douyin_cdp_navigation_failed') :
      stage === 'reload' ? 'douyin_cdp_reload_failed' : stage === 'setup' ? 'douyin_cdp_setup_failed' : 'douyin_cdp_session_failed');
  } finally { if (listening) socket.removeEventListener('message', onMessage); }
  if (!detail) reasons.add(!sawDetailRequest ? 'douyin_cdp_detail_request_missing' : !sawDetailBody ? 'douyin_cdp_detail_response_missing' : 'douyin_cdp_no_matching_detail');
  else if (!hasDouyinMedia(detail)) reasons.add('douyin_cdp_media_missing');
  return { awemeDetail: detail, reasons: [...reasons] };
}
