import './support/isolation.ts';
import { afterEach, expect, test } from 'bun:test';
import { extractDouyinWork, extractXiaohongshuNote, parseDouyinCdpBody, fetchDouyinSeoVideoObject } from '../src/extractor/social_media.ts';
import { setAsrTestRunner } from '../src/extractor/asr.ts';
import { waitForDevToolsEndpoint } from '../src/extractor/cdp.ts';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setAsrTestRunner(null); });

test('Douyin requested work must select matching aweme_id instead of first item', async () => {
 const wanted = '76543210987654321';
 const wrong = { aweme_id: '12345678901234567', desc: 'Unrelated video A', author: { nickname: 'Author A' }, video: {play_addr: {url_list: ['https://media.example.test/a.mp4']}, cover: {url_list: ['https://media.example.test/a.jpg']}} };
 const correct = { aweme_id: wanted, desc: 'Requested video B', author: { nickname: 'Author B' }, video: {play_addr: {url_list: ['https://media.example.test/b.mp4']}, cover: {url_list: ['https://media.example.test/b.jpg']}} };
 const state = {loaderData: {video: {videoInfoRes: {item_list: [wrong, correct]}}}};
 globalThis.fetch = (async () => new Response(`<script>window._ROUTER_DATA = ${JSON.stringify(state)}</script>`)) as unknown as typeof fetch;
 let captured = '';
 setAsrTestRunner(async req => { captured = req.mediaUrl || ''; return {transcript: `Transcript from ${captured}`,engineUsed: 'fixture'}; });
 const result = await extractDouyinWork(`https://www.douyin.com/video/${wanted}`);
 expect(result.title).toBe('Requested video B');
 expect(captured).toBe('https://media.example.test/b.mp4');
});

test('XHS metadata fallback must not accept an explicitly different og:url identity', async () => {
 globalThis.fetch = (async () => new Response('<meta property="og:url" content="https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa"><meta property="og:title" content="Wrong A"><meta property="og:description" content="This is another note, not the requested note"><meta property="og:image" content="https://media.example.test/a.jpg">')) as unknown as typeof fetch;
 await expect(extractXiaohongshuNote('https://www.xiaohongshu.com/explore/bbbbbbbbbbbbbbbbbbbbbbbb')).rejects.toThrow('identity mismatch');
});

const xhsId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const xhsUrl = `https://www.xiaohongshu.com/explore/${xhsId}`;
const dyId = '76543210987654321';
const dyUrl = `https://www.douyin.com/video/${dyId}`;
const otherDyId = '12345678901234567';
function htmlResponse(html: string, url?: string) {
  const response = new Response(html);
  if (url) Object.defineProperty(response, 'url', {value: url});
  return response;
}
function mockHtml(html: string, url?: string) {
  globalThis.fetch = (async () => htmlResponse(html, url)) as unknown as typeof fetch;
}
function dyItem(id: string, name: string) {
  return { aweme_id: id, desc: name, author: { nickname: name }, video: { play_addr: { url_list: [`https://media.example.test/${name}.mp4`] }, cover: { url_list: [`https://media.example.test/${name}.jpg`] } } };
}

for (const identity of [
  `<meta property="og:url" content="${xhsUrl}">`,
  `<link href='/discovery/item/${xhsId}?xsec_token=fixture&amp;source=share' rel='canonical'>`,
  `<link rel = "canonical" href = "${xhsUrl}">`,
]) {
  test(`XHS verified metadata accepts identity: ${identity}`, async () => {
    mockHtml(`${identity}<meta property="og:title" content="Target B"><meta name="description" content="B body"><meta property="og:image" content="https://media.example.test/b.jpg">`);
    const result = await extractXiaohongshuNote(xhsUrl);
    expect(result.title).toBe('Target B');
    expect(result.imageUrls).toEqual(['https://media.example.test/b.jpg']);
  });
}

for (const identity of [
  '',
  '<link rel="canonical">',
  '<meta property="og:url" content="">',
  '<meta property="og:url" content="   ">',
  '<link rel="canonical" href="#note">',
  '<link rel="canonical" href="?source=share">',
  `<link rel="canonical" href="https://evil.example.test/explore/${xhsId}">`,
  `<meta property="og:url" content="${xhsUrl}"><link rel="canonical" href="https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa">`,
  `<meta property="og:url" content="https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa"><link rel="canonical" href="${xhsUrl}">`,
]) {
  test(`XHS refuses unverified/conflicting metadata before media work: ${identity || 'missing'}`, async () => {
    let asrCalls = 0;
    setAsrTestRunner(async () => { asrCalls++; return { transcript: 'unreachable', engineUsed: 'fixture' }; });
    mockHtml(`${identity}<meta property="og:title" content="Wrong"><meta name="description" content="Wrong body"><meta property="og:video" content="https://media.example.test/wrong.mp4">`);
    await expect(extractXiaohongshuNote(xhsUrl)).rejects.toThrow('identity');
    expect(asrCalls).toBe(0);
  });
}

test('XHS malformed state uses only independently verified metadata; arbitrary DOM video is ignored', async () => {
  let calls = 0;
  setAsrTestRunner(async () => { calls++; return { transcript: 'wrong', engineUsed: 'fixture' }; });
  mockHtml(`<script>window.__INITIAL_STATE__={malformed}</script><link rel="canonical" href="${xhsUrl}"><meta property="og:title" content="Target B"><meta property="og:description" content="Target B body"><video src="https://media.example.test/recommendation.mp4"></video>`);
  const result = await extractXiaohongshuNote(xhsUrl);
  expect(result.title).toBe('Target B');
  expect(result.mediaKind).toBe('article');
  expect(calls).toBe(0);
});

test('explicit XHS redirect to a different note fails; short-link redirect to target works', async () => {
  mockHtml('', 'https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa');
  await expect(extractXiaohongshuNote(xhsUrl)).rejects.toThrow('identity changed');
  mockHtml(`<link rel="canonical" href="${xhsUrl}"><meta property="og:title" content="Target"><meta property="og:description" content="Target body">`, xhsUrl);
  expect((await extractXiaohongshuNote('https://xhslink.com/fixture')).title).toBe('Target');
});

for (const branch of ['SSR', 'RENDER_DATA list', 'RENDER_DATA detail', 'malformed SSR then RENDER_DATA']) {
  test(`Douyin selects target across ${branch}, including audio and cover`, async () => {
    const wrong = dyItem(otherDyId, 'A'), correct = dyItem(dyId, 'B');
    const state = branch === 'RENDER_DATA detail' ? { first: {aweme:{detail:wrong}}, second: {aweme:{detail:correct}} } : { first: {videoInfoRes:{item_list:[wrong, correct]}} };
    const html = branch === 'SSR'
      ? `<script>window._ROUTER_DATA = ${JSON.stringify({loaderData:state})}</script>`
      : `${branch.startsWith('malformed') ? '<script>window._ROUTER_DATA = broken</script>' : ''}<script id="RENDER_DATA">${encodeURIComponent(JSON.stringify(state))}</script>`;
    let media: string[] = [];
    setAsrTestRunner(async req => { media = req.mediaUrls || []; return {transcript:'B transcript',engineUsed:'fixture'}; });
    mockHtml(html + '<meta property="og:title" content="A"><meta property="og:video" content="https://media.example.test/unrelated.mp4">');
    const result = await extractDouyinWork(dyUrl);
    expect(result.title).toBe('B');
    expect(result.author).toBe('B');
    expect(result.imageUrls).toEqual(['https://media.example.test/B.jpg']);
    expect(media).toEqual(['https://media.example.test/B.mp4']);
  });
}

test('Douyin mobile share fallback selects target rather than first recommendation', async () => {
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (!String(url).includes('iesdouyin')) return htmlResponse('blocked');
    return htmlResponse(`<script>window._ROUTER_DATA = ${JSON.stringify({loaderData:{video:{videoInfoRes:{item_list:[dyItem(otherDyId,'A'),dyItem(dyId,'B')]}}}})}</script>`, String(url));
  }) as unknown as typeof fetch;
  setAsrTestRunner(async () => ({transcript:'B transcript',engineUsed:'fixture'}));
  expect((await extractDouyinWork(dyUrl)).title).toBe('B');
});

test('Douyin image albums retain only the matching work images', async () => {
  const state = {loaderData:{video:{videoInfoRes:{item_list:[{aweme_id:otherDyId,desc:'A',images:[{url_list:['https://media.example.test/a.jpg']}]},{aweme_id:dyId,desc:'B',images:[{url_list:['https://media.example.test/b.jpg']}]}]}}}};
  mockHtml(`<script>window._ROUTER_DATA = ${JSON.stringify(state)}</script>`);
  const result = await extractDouyinWork(dyUrl);
  expect(result.sourceType).toBe('douyin_note');
  expect(result.imageUrls).toEqual(['https://media.example.test/b.jpg']);
});

for (const state of [{}, {loaderData:{video:{videoInfoRes:{item_list:[dyItem(otherDyId,'A')]}}}}, {loaderData:{video:{videoInfoRes:{item_list:[{...dyItem(dyId,'B'),aweme_id:undefined}]}}}}]) {
  test(`Douyin cannot turn unverified state into a successful source: ${JSON.stringify(state)}`, async () => {
    mockHtml(`<script>window._ROUTER_DATA = ${JSON.stringify(state)}</script><meta property="og:title" content="Wrong"><meta property="og:video" content="https://media.example.test/wrong.mp4">`);
    let calls = 0; setAsrTestRunner(async () => {calls++; return {transcript:'wrong',engineUsed:'fixture'};});
    await expect(extractDouyinWork(dyUrl)).rejects.toThrow('identity');
    expect(calls).toBe(0);
  });
}

test('Douyin verified metadata fallback excludes unrelated raw DOM video', async () => {
  mockHtml(`<link rel="canonical" href="${dyUrl}"><meta property="og:title" content="B"><meta property="og:image" content="https://media.example.test/B.jpg"><video src="https://media.example.test/A.mp4"></video>`);
  let calls=0; setAsrTestRunner(async()=>{calls++;return {transcript:'wrong',engineUsed:'fixture'};});
  const result = await extractDouyinWork(dyUrl);
  expect(result.title).toBe('B'); expect(result.transcriptEngine).toBe('metadata_only'); expect(calls).toBe(0);
});

for (const base64Encoded of [false, true]) {
  test(`CDP body identity verified before accepting media, base64=${base64Encoded}`, () => {
    const encode = (value: unknown) => {const json=JSON.stringify(value);return {body:base64Encoded?Buffer.from(json).toString('base64'):json,base64Encoded};};
    expect(parseDouyinCdpBody(encode({aweme_detail:dyItem(otherDyId,'A')}),dyId)).toBeNull();
    expect(parseDouyinCdpBody(encode({aweme_detail:{desc:'Unknown',video:dyItem(dyId,'B').video}}),dyId)).toBeNull();
    expect(parseDouyinCdpBody(encode({aweme_detail:dyItem(dyId,'B')}),dyId)?.desc).toBe('B');
    expect(parseDouyinCdpBody({body:'broken'},dyId)).toBeNull();
  });
}

for (const structure of ['scripts','array','graph']) {
  test(`SEO JSON-LD ${structure} selects target object and rejects unbound metadata`, async () => {
    const objects=[{'@type':'VideoObject',url:`https://www.douyin.com/video/${otherDyId}`,name:'A'}, {'@type':'VideoObject',name:'Unbound'}, {'@type':'VideoObject',url:dyUrl,name:'B',creator:{name:'Author B'},thumbnailUrl:['https://media.example.test/b.jpg']}];
    const script=(obj:unknown)=>`<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
    mockHtml(structure==='scripts'?objects.map(script).join(''):script(structure==='array'?objects:{'@graph':objects}));
    expect((await fetchDouyinSeoVideoObject(dyId))?.name).toBe('B');
    mockHtml(script(objects[1])); expect(await fetchDouyinSeoVideoObject(dyId)).toBeNull();
  });
}

test('SEO conflicting page or redirect identity does not contribute metadata', async () => {
  const data=`<script type="application/ld+json">${JSON.stringify({'@type':'VideoObject',url:dyUrl,name:'B'})}</script>`;
  mockHtml(`<link rel="canonical" href="https://www.douyin.com/video/${otherDyId}">${data}`);
  expect(await fetchDouyinSeoVideoObject(dyId)).toBeNull();
  mockHtml(data,`https://www.douyin.com/video/${otherDyId}`);
  expect(await fetchDouyinSeoVideoObject(dyId)).toBeNull();
});

test('CDP startup survives over two seconds of silence and fragmented endpoint output', async () => {
  const encoder=new TextEncoder(); let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({ async start(controller) {
    await new Promise(resolve=>setTimeout(resolve,2100));
    controller.enqueue(encoder.encode('DevTools listening on ws://127.0.0.1:'));
    await new Promise(resolve=>setTimeout(resolve,10));
    controller.enqueue(encoder.encode('9222/devtools/browser/fixture\n'));
  },cancel(){cancelled=true;} });
  expect(await waitForDevToolsEndpoint(stream,AbortSignal.timeout(4000))).toBe('ws://127.0.0.1:9222/devtools/browser/fixture');
  expect(cancelled).toBe(true); expect(stream.locked).toBe(false);
});

test('CDP startup handles EOF, deadline and process read failure without leaked readers', async () => {
  const empty=new ReadableStream<Uint8Array>({start(controller){controller.close();}});
  expect(await waitForDevToolsEndpoint(empty,AbortSignal.timeout(100))).toBeNull(); expect(empty.locked).toBe(false);
  let cancelled=false;
  const quiet=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
  await expect(waitForDevToolsEndpoint(quiet,AbortSignal.timeout(20))).rejects.toThrow();
  expect(cancelled).toBe(true); expect(quiet.locked).toBe(false);
  const failed=new ReadableStream<Uint8Array>({start(controller){controller.error(new Error('browser exited'));}});
  await expect(waitForDevToolsEndpoint(failed,AbortSignal.timeout(100))).rejects.toThrow('browser exited'); expect(failed.locked).toBe(false);
});

test('malformed SSR list cannot block a later matching container or RENDER_DATA', async () => {
  const correct = { videoInfoRes: { item_list: [dyItem(dyId, 'B')] } };
  for (const html of [
    `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: { bad: { videoInfoRes: { item_list: {} } }, good: correct } })}</script>`,
    `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: { bad: { videoInfoRes: { item_list: {} } } } })}</script><script id="RENDER_DATA">${encodeURIComponent(JSON.stringify({ good: correct }))}</script>`,
  ]) {
    mockHtml(html);
    setAsrTestRunner(async () => ({ transcript: 'Target B', engineUsed: 'fixture' }));
    expect((await extractDouyinWork(dyUrl)).title).toBe('B');
  }
});

for (const identity of ['', '<link rel="canonical">', '<meta property="og:url" content=" ">', `<meta property="og:url" content="https://www.douyin.com/video/${otherDyId}">`]) {
  test(`Douyin cannot adopt unbound or contradictory metadata: ${identity}`, async () => {
    mockHtml(`${identity}<meta property="og:title" content="A"><meta property="og:video" content="https://media.example.test/a.mp4">`);
    let calls = 0;
    setAsrTestRunner(async () => { calls++; return { transcript: 'unreachable', engineUsed: 'fixture' }; });
    await expect(extractDouyinWork(dyUrl)).rejects.toThrow('identity');
    expect(calls).toBe(0);
  });
}

for (const url of ['   ', 'http://[', '#video', '?source=share']) {
  test(`SEO invalid identity cannot adopt an object or block a later target: ${url}`, async () => {
    const unbound = { '@type': 'VideoObject', url, name: 'Wrong A' };
    const target = { '@type': 'VideoObject', url: dyUrl, name: 'Target B' };
    mockHtml(`<script type="application/ld+json">${JSON.stringify([unbound])}</script>`);
    expect(await fetchDouyinSeoVideoObject(dyId)).toBeNull();
    mockHtml(`<script type="application/ld+json">${JSON.stringify({ '@graph': [unbound, target] })}</script>`);
    expect((await fetchDouyinSeoVideoObject(dyId))?.name).toBe('Target B');
  });
}
