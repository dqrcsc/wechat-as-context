import './support/isolation.ts';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextDatabase } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { WeChatContextPipeline } from '../src/pipeline.ts';

const originalFetch = globalThis.fetch;
const dbs: ContextDatabase[] = [];
afterEach(() => { globalThis.fetch = originalFetch; for (const db of dbs.splice(0)) db.db.close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'delivery-diagnostics-'));
  const config = loadConfig({ IGNORE_HOME_DOTENV: 'true', VAULT_ROOT: 'none', WECHAT_CONTEXT_DATA_DIR: root }, root);
  const db = new ContextDatabase(config.dbPath); dbs.push(db);
  const pipeline = new WeChatContextPipeline(config, db);
  pipeline.clawbot.saveCredentials({ botToken: 'PRIVATE_BOT_TOKEN', baseUrl: 'https://ilink.example.test', botId: 'fixture', userId: 'user', savedAt: 'fixture' });
  return { root, config, db, pipeline, client: pipeline.clawbot };
}

for (const media of [false, true]) {
  test(`an old rejected request cannot clear a concurrent newer context, media=${media}`, async () => {
    const f = fixture(); f.client.setContextToken('user', 'old'); const tokens: unknown[] = [];
    const file = join(f.root, 'fixture.txt'); writeFileSync(file, 'PRIVATE_FILE_CONTENT');
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).includes('getuploadurl')) return Response.json({ ret: 0, upload_full_url: 'https://cdn.example.test/upload?secret=PRIVATE_UPLOAD' });
      if (String(url).includes('cdn.example.test')) return new Response('', { headers: { 'x-encrypted-param': 'PRIVATE_CDN_PARAM' } });
      const body = JSON.parse(init.body); tokens.push(body.msg.context_token);
      if (body.msg.context_token === 'old') { f.client.setContextToken('user', 'new'); return Response.json({ ret: -2, errmsg: 'prepare failed' }); }
      return Response.json({ ret: 0 });
    }) as unknown as typeof fetch;
    if (media) await f.client.sendMediaFile('user', file, 'concurrent-media');
    else await f.client.sendTextMessage('user', 'PRIVATE_BODY', 'concurrent-text');
    expect(f.client.getContextToken('user')).toBe('new');
    expect(tokens).toEqual(['old', 'new']);
  });
}

test('failed tokenless fallback is not proof that a cached token must be erased', async () => {
  const f = fixture(); f.client.setContextToken('user', 'old');
  globalThis.fetch = (async () => Response.json({ ret: -2, errmsg: 'prepare failed' })) as unknown as typeof fetch;
  await expect(f.client.sendTextMessage('user', 'body', 'failure')).rejects.toThrow();
  expect(f.client.getContextToken('user')).toBe('old');
});

test('replayed inbound messages cannot roll back a newer token', async () => {
  const f = fixture();
  const poll = async (id: string, token: string, time: number) => {
    globalThis.fetch = (async () => Response.json({ ret: 0, msgs: [{ message_id: id, from_user_id: 'user', context_token: token, create_time_ms: time }], get_updates_buf: id })) as unknown as typeof fetch;
    await f.client.getUpdates();
  };
  await poll('1', 'old', 1000); await poll('2', 'new', 2000); await poll('1', 'old', 1000);
  expect(f.client.getContextToken('user')).toBe('new');
  expect(f.db.pendingMessages()).toHaveLength(2);
});

test('each text chunk reads the latest context instead of retaining the first snapshot', async () => {
  const f = fixture(); f.client.setContextToken('user', 'old'); const tokens: unknown[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    tokens.push(JSON.parse(init.body).msg.context_token); f.client.setContextToken('user', 'new');
    return Response.json({ ret: 0 });
  }) as unknown as typeof fetch;
  await f.client.sendTextMessage('user', 'A'.repeat(1500)+'\n\n'+'B'.repeat(1500), 'chunks');
  expect(tokens).toEqual(['old', 'new']);
});

test('normal repeated drains honor persisted retry backoff instead of exhausting attempts in a burst', async () => {
  const f = fixture(); f.db.queueReply('backoff', 'user', 'body'); let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('', { status: 503 }); }) as unknown as typeof fetch;
  await f.pipeline.flushReplies({ nowMs: 1000 });
  await f.pipeline.flushReplies({ nowMs: 1001 });
  expect(calls).toBe(1);
  expect(f.db.db.query("SELECT attempts,next_retry_at FROM reply_outbox WHERE id='backoff'").get()).toEqual({ attempts: 1, next_retry_at: 6000 });
});

for (const replacement of [undefined, 'new', 'old']) {
  test(`tokenless success clears only its original revision; concurrent replacement=${replacement}`, async () => {
    const f = fixture(); f.client.setContextToken('user', 'old', 2000);
    const secondDb = new ContextDatabase(f.config.dbPath); dbs.push(secondDb);
    const receiver = new WeChatContextPipeline(f.config, secondDb).clawbot;
    let calls = 0; const events: any[] = [];
    globalThis.fetch = (async () => {
      if (++calls === 1) return Response.json({ ret: -2, errmsg: 'prepare failed' });
      if (replacement) receiver.setContextToken('user', replacement, 3000);
      return Response.json({ ret: 0 });
    }) as unknown as typeof fetch;
    await f.client.sendTextMessage('user', 'body', 'cas', e => events.push(e));
    expect(calls).toBe(2);
    expect(f.client.getContextToken('user')).toBe(replacement);
    expect(events.at(-1).result).toBe(replacement ? 'context_preserved' : 'context_cleared');
    // A newly observed but older inbound message cannot restore a retired/stale token.
    f.client.setContextToken('user', 'delayed', 1000);
    expect(f.client.getContextToken('user')).toBe(replacement);
    f.client.setContextToken('other', 'independent', 1);
    expect(f.client.getContextToken('other')).toBe('independent');
  });
}

test('cleanup or observer failure after a remote acknowledgement never replays the send', async () => {
  const f = fixture(); f.client.setContextToken('user', 'old'); let calls = 0;
  (f.client as any).clearContextIfUnchanged = () => { throw new Error('PRIVATE_DB_DETAIL'); };
  globalThis.fetch = (async () => Response.json(++calls === 1 ? { ret: -2 } : { ret: 0 })) as unknown as typeof fetch;
  await f.client.sendTextMessage('user', 'body', 'cleanup', () => { throw new Error('PRIVATE_OBSERVER_DETAIL'); });
  expect(calls).toBe(2); expect(f.client.getContextToken('user')).toBe('old');
});

test('new-context recovery is bounded even when the fresh token is rejected', async () => {
  const f = fixture(); f.client.setContextToken('user', 'old'); const tokens: unknown[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    tokens.push(JSON.parse(init.body).msg.context_token);
    f.client.setContextToken('user', 'new'); return Response.json({ ret: -2 });
  }) as unknown as typeof fetch;
  await expect(f.client.sendTextMessage('user', 'body', 'bounded')).rejects.toThrow();
  expect(tokens).toEqual(['old', 'new']); expect(f.client.getContextToken('user')).toBe('new');
});

test('failed first batch receipt retains context for later receipts and leaves 17 historical failures intact', async () => {
  const f = fixture(); f.client.setContextToken('user', 'batch');
  for (let i = 0; i < 17; i++) f.db.db.query("INSERT INTO reply_outbox(id,recipient,text,status,attempts,error) VALUES(?,?,?,'failed',3,'historical')").run(`history-${i}`, 'user', 'old');
  const before = f.db.db.query("SELECT * FROM reply_outbox WHERE status='failed' ORDER BY id").all();
  f.db.queueReply('first', 'user', 'first'); f.db.queueReply('second', 'user', 'second'); f.db.queueReply('third', 'other', 'third');
  const requests: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    const msg = JSON.parse(init.body).msg; requests.push(msg);
    return Response.json({ ret: msg.client_id === 'first' ? -2 : 0, errmsg: 'prepare failed' });
  }) as unknown as typeof fetch;
  await f.pipeline.flushReplies({ nowMs: 1000 });
  expect(requests.map(x => [x.client_id, x.context_token])).toEqual([['first','batch'], ['first',undefined], ['second','batch'], ['third',undefined]]);
  expect(f.db.db.query("SELECT id,status,attempts FROM reply_outbox WHERE id IN ('first','second','third') ORDER BY id").all()).toEqual([
    {id:'first',status:'pending',attempts:1}, {id:'second',status:'sent',attempts:1}, {id:'third',status:'sent',attempts:1}
  ]);
  f.client.setContextToken('user', 'fresh');
  await f.pipeline.flushReplies({ nowMs: 1001 });
  expect(requests).toHaveLength(4);
  expect(f.db.db.query("SELECT * FROM reply_outbox WHERE status='failed' ORDER BY id").all()).toEqual(before);
  expect(f.db.recentDeliveryEvents('history-0')).toEqual([]);
  const events = f.db.recentDeliveryEvents('first') as any[];
  expect(events.some(e => e.attempt === 1 && e.ret === -2 && e.category === 'api_prepare_failed')).toBe(true);
  expect(events.some(e => e.result === 'context_preserved')).toBe(true);
  expect(events.some(e => e.attempt === 0 && e.result === 'queued' && e.recorded_at)).toBe(true);
});

for (const mode of ['http', 'network', 'timeout', 'invalid_json', 'invalid_code', 'api', 'prepare'] as const) {
  test(`diagnostics classify ${mode}, redact secrets and avoid unjustified fallback`, async () => {
    const f = fixture(); f.client.setContextToken('user', 'PRIVATE_CONTEXT'); f.db.queueReply('diagnostic', 'user', 'PRIVATE_BODY');
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (mode === 'network') throw new Error('PRIVATE_CONTEXT https://signed.test/?PRIVATE_BOT_TOKEN PRIVATE_BODY /private/file');
      if (mode === 'timeout') throw new DOMException('PRIVATE_BODY', 'TimeoutError');
      if (mode === 'http') return new Response('PRIVATE_BODY', { status: 503 });
      if (mode === 'invalid_json') return new Response('PRIVATE_BODY');
      if (mode === 'invalid_code') return Response.json({ ret: 'PRIVATE_BODY' });
      return Response.json(mode === 'prepare' ? {ret:-2,errmsg:'prepare failed'} : {ret:0,errcode:123,errmsg:'PRIVATE_CONTEXT PRIVATE_BODY PRIVATE_BOT_TOKEN'});
    }) as unknown as typeof fetch;
    await f.pipeline.flushReplies({nowMs:1000});
    const events = f.db.recentDeliveryEvents('diagnostic') as any[];
    const failed = events.find(e => e.stage === 'outbox' && e.result === 'failed');
    expect(failed.category).toBe(({http:'http',network:'network',timeout:'timeout',invalid_json:'invalid_response',invalid_code:'invalid_response',api:'api_rejected',prepare:'api_prepare_failed'} as const)[mode]);
    expect(failed.failureStage).toBe('sendmessage'); expect(calls).toBe(mode === 'prepare' ? 2 : 1);
    const stored = JSON.stringify([events, f.db.db.query('SELECT error FROM reply_outbox').all()]);
    for (const secret of ['PRIVATE_CONTEXT','PRIVATE_BODY','PRIVATE_BOT_TOKEN','signed.test','/private/file']) expect(stored).not.toContain(secret);
    expect(events.some(e => e.stage === 'sendmessage' && e.tokenPresent && e.tokenHash && e.tokenRevision && e.tokenAgeMs >= 0)).toBe(true);
    expect(f.client.getContextToken('user')).toBe('PRIVATE_CONTEXT');
  });
}

for (const stage of ['getuploadurl', 'cdn_upload', 'sendmessage_media', 'media_prepare'] as const) {
  test(`media failure is attributed to ${stage} without exposing bytes or URLs`, async () => {
    const f = fixture(), file = join(f.root, 'PRIVATE_FILENAME.txt'); writeFileSync(file, 'PRIVATE_FILE_CONTENT');
    f.db.queueMediaReply('media', 'user', 'file', file);
    if (stage === 'media_prepare') {
      const row = f.db.db.query("SELECT media_path FROM reply_outbox WHERE id='media'").get() as any;
      writeFileSync(row.media_path, 'TAMPERED');
    }
    const stages: string[] = [];
    globalThis.fetch = (async (url: any) => {
      const current = String(url).includes('getuploadurl') ? 'getuploadurl' : String(url).includes('cdn.example.test') ? 'cdn_upload' : 'sendmessage_media'; stages.push(current);
      if (current === stage) return new Response('PRIVATE_FAILURE', {status:502});
      if (current === 'getuploadurl') return Response.json({ret:0,upload_full_url:'https://cdn.example.test/?PRIVATE_UPLOAD'});
      if (current === 'cdn_upload') return new Response('',{headers:{'x-encrypted-param':'PRIVATE_PARAM'}});
      return Response.json({ret:0});
    }) as unknown as typeof fetch;
    await f.pipeline.flushReplies({nowMs:1000});
    const events = f.db.recentDeliveryEvents('media') as any[];
    expect(events.find(e => e.stage === 'outbox' && e.result === 'failed')?.failureStage).toBe(stage);
    expect(stages).toHaveLength(stage === 'media_prepare' ? 0 : stage === 'getuploadurl' ? 1 : stage === 'cdn_upload' ? 2 : 3);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_');
  });
}

test('diagnostic retention is bounded without deleting outbox rows and duplicate enqueues do not invent timestamps', () => {
  const f = fixture(); f.db.queueReply('retained','user','body'); f.db.queueReply('retained','user','changed');
  expect(f.db.recentDeliveryEvents('retained')).toHaveLength(1);
  for (let i=0;i<3010;i++) f.db.recordDeliveryEvent('retained',1,{stage:'sendmessage',result:'started',chunk:i});
  expect(f.db.recentDeliveryEvents('retained',4000)).toHaveLength(3000);
  expect(f.db.db.query('SELECT count(*) AS n FROM reply_outbox').get()).toEqual({n:1});
});

test('inbound batch failure rolls token value, revision and cursor back together', async () => {
  const f = fixture(); f.client.setContextToken('user', 'original', 1000);
  const before = f.db.getState('clawbot_context_meta_user'); f.db.setState('clawbot_updates_buf','original-cursor');
  globalThis.fetch = (async () => Response.json({ret:0,msgs:[{message_id:'good',from_user_id:'user',context_token:'new',create_time_ms:2000},{from_user_id:'user',context_token:'bad'}],get_updates_buf:'bad-cursor'})) as unknown as typeof fetch;
  await expect(f.client.getUpdates()).rejects.toThrow('stable message_id');
  expect(f.client.getContextToken('user')).toBe('original');
  expect(f.db.getState('clawbot_context_meta_user')).toBe(before);
  expect(f.db.getState('clawbot_updates_buf')).toBe('original-cursor'); expect(f.db.pendingMessages()).toEqual([]);
});

test('legacy token without metadata remains usable; unknown timestamps use receive order', async () => {
  const f = fixture(); f.db.setState('clawbot_ctx_user','legacy'); const tokens: unknown[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {tokens.push(JSON.parse(init.body).msg.context_token); return Response.json({ret:0});}) as unknown as typeof fetch;
  await f.client.sendTextMessage('user','body','legacy'); expect(tokens).toEqual(['legacy']);
  f.client.setContextToken('user','new',3000); f.client.setContextToken('user','unknown');
  f.client.setContextToken('user','old',2000); expect(f.client.getContextToken('user')).toBe('unknown');
});

test('failed diagnostic persistence does not turn a delivered outbox row into pending', async () => {
  const f = fixture(); f.db.queueReply('storage-failure','user','body');
  f.db.db.query("CREATE TRIGGER reject_diagnostics BEFORE INSERT ON delivery_events BEGIN SELECT RAISE(FAIL,'PRIVATE_DETAIL'); END").run();
  let calls=0; globalThis.fetch = (async () => {calls++;return Response.json({ret:0});}) as unknown as typeof fetch;
  await f.pipeline.flushReplies(); await f.pipeline.flushReplies(); expect(calls).toBe(1);
  expect(f.db.db.query("SELECT status,attempts FROM reply_outbox WHERE id='storage-failure'").get()).toEqual({status:'sent',attempts:1});
});

test('retry delay starts after a slow failed request, not at the beginning of the drain', async () => {
  const f = fixture(); f.db.queueReply('slow','user','body');
  const realNow = Date.now; let clock = 1000;
  Date.now = () => clock;
  globalThis.fetch = (async () => {clock=9000;return new Response('',{status:503});}) as unknown as typeof fetch;
  try {
    await f.pipeline.flushReplies();
    expect(f.db.db.query("SELECT next_retry_at FROM reply_outbox WHERE id='slow'").get()).toEqual({next_retry_at:14000});
  } finally { Date.now = realNow; }
});

for (const mode of ['timeout', 'network'] as const) {
  test(`HTTP 200 headers followed by ${mode} while reading the body retain the transport category`, async () => {
    const f=fixture(); f.db.queueReply('body-read','user','body');
    globalThis.fetch=(async()=>new Response(new ReadableStream({start(controller){controller.error(mode==='timeout'?new DOMException('PRIVATE_BODY_ERROR','TimeoutError'):new TypeError('PRIVATE_BODY_ERROR'));}}))) as unknown as typeof fetch;
    await f.pipeline.flushReplies({nowMs:1000});
    const events=f.db.recentDeliveryEvents('body-read') as any[];
    expect(events).toContainEqual(expect.objectContaining({stage:'sendmessage',result:'failed',category:mode,httpStatus:200}));
    expect(JSON.stringify(events)).not.toContain('PRIVATE_BODY_ERROR');
  });
}

test('concurrent media enqueue records queued only for the insert winner', () => {
  const f=fixture(), file=join(f.root,'race.txt'); writeFileSync(file,'fixture');
  const other=new ContextDatabase(f.config.dbPath); dbs.push(other);
  const query=f.db.db.query.bind(f.db.db); let raced=false;
  f.db.db.query=((sql:string,...args:any[])=>{
    if(!raced && sql.includes('INSERT OR IGNORE INTO reply_outbox')) {
      raced=true; other.queueMediaReply('race','user','file',file);
    }
    return (query as any)(sql,...args);
  }) as typeof f.db.db.query;
  f.db.queueMediaReply('race','user','file',file);
  expect(raced).toBe(true); expect(f.db.recentDeliveryEvents('race')).toHaveLength(1);
  expect(f.db.db.query('SELECT count(*) AS n FROM reply_outbox').get()).toEqual({n:1});
});
