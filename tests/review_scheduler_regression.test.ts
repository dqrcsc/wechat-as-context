import './support/isolation.ts';
import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { ContextDatabase } from '../src/db.ts';
import { WeChatContextPipeline } from '../src/pipeline.ts';
import { TaskSchedulerEngine } from '../src/scheduler/engine.ts';
import { parseNaturalScheduleSpec } from '../src/scheduler/time_parser.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-scheduler-'));
  const config = loadConfig({ IGNORE_HOME_DOTENV: 'true', VAULT_ROOT: 'none', WECHAT_CONTEXT_DATA_DIR: root }, root);
  const db = new ContextDatabase(config.dbPath);
  const client = { resolveDefaultRecipient: () => 'fixture-user' } as any;
  return { root, config, db, client };
}

test('explicit 1.5 hours must not collapse to half hour', () => {
  const now = Date.parse('2026-10-30T02:00:00Z');
  const parsed = parseNaturalScheduleSpec('1个半小时后提醒我开会', { nowMs: now, timeZone: 'Asia/Shanghai' });
  console.log('REPRO_DURATION', JSON.stringify({requestedMinutes:90, actualMinutes:(parsed.nextRunAt-now)/60000}));
  expect(parsed.nextRunAt-now).toBe(90*60000);
});

test('missing explicit task name must not match most recent other task', async () => {
  const f = fixture();
  try {
    const task = f.db.createScheduledTask({senderId:'fixture-user',title:'支付房租',nextRunAt:Date.now()+86400000});
    const match = f.db.findScheduledTaskByQuery('取消火星会议', {senderId:'fixture-user', activeOnly:true});
    const result = await (new WeChatContextPipeline(f.config, f.db).agent as any).handleManageSchedule({ senderId: 'fixture-user', decision: { slots: { scheduleSubAction: 'cancel', coreContent: '取消火星会议' } }, unpacked: { userText: '取消火星会议' } });
    console.log('REPRO_WRONG_TARGET', JSON.stringify({request:'取消火星会议',matched:match?.title,id:match?.id,actualStatus:f.db.getScheduledTaskById(task.id)?.status,reply:result.replyText}));
    expect(match).toBeNull();
    expect(f.db.getScheduledTaskById(task.id)?.status).toBe("active");
    expect(result.replyText).toContain("未找到");
  } finally {f.db.db.close();}
});

test('interrupted running reminder must be recoverable after reopening DB', async () => {
  const f = fixture();
  const now = Date.parse('2026-10-30T02:00:00Z');
  const task=f.db.createScheduledTask({senderId:'fixture-user',title:'中断的提醒',nextRunAt:now-3600000});
  f.db.recordScheduledTaskRun({taskId:task.id,scheduledForMs:now-3600000,status:'running',startedAt:new Date(now-3600000).toISOString()});
  f.db.updateScheduledTask(task.id,{status:'running'});
  f.db.db.close();
  const reopened=new ContextDatabase(f.config.dbPath);
  try {
    const engine=new TaskSchedulerEngine(f.config,reopened,f.client);
    const outcomes=await engine.tick({nowMs:now});
    const after=reopened.getScheduledTaskById(task.id);
    console.log('REPRO_CRASH_RECOVERY', JSON.stringify({outcomes:outcomes.length,status:after?.status,nextRunAt:after?.next_run_at}));
    expect(after?.status).not.toBe('running');
  } finally {reopened.db.close();}
});

test('cancelling a running digest must not resurrect future recurring runs', async () => {
  const f=fixture(); const now=Date.parse('2026-10-30T02:00:00Z');
  const task=f.db.createScheduledTask({senderId:'fixture-user',title:'待取消早报',taskKind:'digest',scheduleType:'cron',cronExpr:'0 10 * * *',nextRunAt:now,actionPayload:{executor:'vault_digest',prompt:'fixture'}});
  try {
    const engine=new TaskSchedulerEngine(f.config,f.db,f.client);
    (engine as any).executeDigestOrCollectionTask=async()=>{
      // Represents a user's cancellation committed while the async digest call is in flight.
      f.db.updateScheduledTask(task.id,{status:'cancelled',next_run_at:null});
      return {wechatReply:'fixture output',depositedPath:'',modelUsed:'fixture'};
    };
    await engine.tick({nowMs:now});
    const after=f.db.getScheduledTaskById(task.id);
    console.log('REPRO_CANCEL_RACE',JSON.stringify({requestedStatus:'cancelled',actualStatus:after?.status,nextRunAt:after?.next_run_at}));
    expect(after?.status).toBe('cancelled');
    expect(f.db.db.query("SELECT * FROM reply_outbox").all()).toHaveLength(0);
  } finally {f.db.db.close();}
});

test('weekday without each must be a one-shot schedule, not daily cron',()=>{
 const now=Date.parse('2026-10-29T02:00:00Z');
 const parsed=parseNaturalScheduleSpec('星期五下午3点提醒我开会',{nowMs:now,timeZone:'Asia/Shanghai'});
 console.log('REPRO_WEEKDAY',JSON.stringify(parsed));
 expect(parsed.scheduleType).toBe('once');
});

function outbox(db: ContextDatabase) { return db.db.query('SELECT * FROM reply_outbox ORDER BY id').all() as any[]; }

for (const phrase of ['1个半小时后', '一个半小时后', '1 个 半 小时 后', '两 个 半 小时后', '半小时后', '半个小时后']) {
  test(`relative time: ${phrase}`, () => {
    const now = Date.parse('2026-10-30T02:00:00Z');
    const minutes = phrase.startsWith('两') ? 150 : phrase.startsWith('半') ? 30 : 90;
    expect(parseNaturalScheduleSpec(`${phrase}提醒我开会`, { nowMs: now }).nextRunAt - now).toBe(minutes * 60000);
  });
}

for (const day of ['星期五', '礼拜五', '周五']) {
  test(`one-shot and recurring weekday remain distinct: ${day}`, () => {
    const now = Date.parse('2026-10-29T02:00:00Z');
    const once = parseNaturalScheduleSpec(`${day}下午3点提醒我开会`, { nowMs: now, llmScheduleTypeHint: 'cron', llmCronHint: '0 15 * * *' });
    expect(once.scheduleType).toBe('once');
    expect(once.nextRunAt).toBe(Date.parse('2026-10-30T07:00:00Z'));
    const recurring = parseNaturalScheduleSpec(`每${day}下午3点提醒我开会`, { nowMs: now });
    expect(recurring.scheduleType).toBe('cron');
    expect(recurring.cronExpr).toBe('0 15 * * 5');
  });
}

test('task selection rejects absent IDs, empty or ambiguous names but allows explicit context', () => {
  const f = fixture();
  try {
    const a = f.db.createScheduledTask({ senderId: 'fixture-user', title: '支付房租', nextRunAt: Date.now() });
    const b = f.db.createScheduledTask({ senderId: 'fixture-user', title: '支付水费', nextRunAt: Date.now() });
    for (const query of ['取消#99999', '取消', '取消火星会议', '取消支付']) expect(f.db.findScheduledTaskByQuery(query)).toBeNull();
    expect(f.db.findScheduledTaskByQuery('取消支付房租')?.id).toBe(a.id);
    expect(f.db.findScheduledTaskByQuery('取消刚才的提醒')?.id).toBe(b.id);
    expect(f.db.findScheduledTaskByQuery('把刚才的提醒推迟1小时')?.id).toBe(b.id);
  } finally { f.db.db.close(); }
});

for (const changedStatus of ['cancelled', 'paused', 'active'] as const) {
  for (const throws of [false, true]) {
    test(`in-flight ${throws ? 'failure' : 'success'} respects ${changedStatus} or rescheduling`, async () => {
      const f = fixture(); const now = Date.now();
      const task = f.db.createScheduledTask({ title: 'digest', taskKind: 'digest', nextRunAt: now });
      try {
        const engine = new TaskSchedulerEngine(f.config, f.db, f.client);
        (engine as any).executeDigestOrCollectionTask = async () => {
          f.db.updateScheduledTask(task.id, { status: changedStatus, next_run_at: changedStatus === 'active' ? now + 86400000 : null });
          if (throws) throw new Error('generation failed');
          return { wechatReply: 'old result', depositedPath: '', modelUsed: 'fixture' };
        };
        await engine.tick({ nowMs: now });
        expect(f.db.getScheduledTaskById(task.id)?.status).toBe(changedStatus);
        expect(f.db.getScheduledTaskById(task.id)?.next_run_at).toBe(changedStatus === 'active' ? now + 86400000 : null);
        expect(outbox(f.db)).toHaveLength(0);
      } finally { f.db.db.close(); }
    });
  }
}

test('recovery reuses checkpoint, archives once and queues once across repeated ticks', async () => {
  const f = fixture(); const now = Date.now();
  const task = f.db.createScheduledTask({ title: 'checkpoint digest', taskKind: 'digest', nextRunAt: now });
  const path = join(f.root, 'digests', 'checkpoint.md');
  const run = f.db.recordScheduledTaskRun({ taskId: task.id, scheduledForMs: now })!;
  const prepared = { inputKey: JSON.stringify([task.title, task.action_payload, task.schedule_type, task.cron_expr, task.timezone]),
    wechatReply: 'saved result', depositedPath: path, modelUsed: 'fixture', archiveContent: '# saved result' };
  f.db.updateScheduledTaskRun(run.id, { prepared_result: JSON.stringify(prepared) });
  f.db.updateScheduledTask(task.id, { status: 'running' });
  f.db.db.close();
  const db = new ContextDatabase(f.config.dbPath);
  try {
    const engine = new TaskSchedulerEngine(f.config, db, f.client);
    (engine as any).executeDigestOrCollectionTask = () => { throw new Error('must not regenerate'); };
    expect((await engine.tick({ nowMs: now + 1 }))).toHaveLength(1);
    expect((await engine.tick({ nowMs: now + 2 }))).toHaveLength(0);
    expect(readFileSync(path, 'utf8')).toBe('# saved result');
    expect(outbox(db)).toHaveLength(1);
    expect(outbox(db)[0].text).toBe('saved result');
    expect(db.getScheduledTaskById(task.id)?.run_count).toBe(1);
    expect(db.getScheduledTaskRuns(task.id)[0].status).toBe('succeeded');
  } finally { db.db.close(); }
});

test('recovery never requeues existing legacy failed delivery or unrelated historical failures', async () => {
  const f = fixture(); const now = Date.now();
  try {
    const task = f.db.createScheduledTask({ title: 'legacy reminder', nextRunAt: now });
    f.db.recordScheduledTaskRun({ taskId: task.id, scheduledForMs: now });
    f.db.updateScheduledTask(task.id, { status: 'running' });
    f.db.queueReply(`sched_${task.id}_${now}`, 'fixture-user', 'already queued');
    for (let i = 0; i < 3; i++) f.db.queueReply(`historical_${i}`, 'fixture-user', 'failed fixture');
    f.db.db.query("UPDATE reply_outbox SET status = 'failed', attempts = 3, error = 'fixture failure'").run();
    const before = JSON.stringify(outbox(f.db));
    await new TaskSchedulerEngine(f.config, f.db, f.client).tick({ nowMs: now });
    expect(JSON.stringify(outbox(f.db))).toBe(before);
    expect(f.db.getScheduledTaskById(task.id)?.status).toBe('completed');
  } finally { f.db.db.close(); }
});

test('legacy partial attachment enqueue is paused without retrying ambiguous delivery', async () => {
  const f = fixture(); const now = Date.now();
  try {
    const task = f.db.createScheduledTask({ title: 'legacy partial digest', nextRunAt: now });
    f.db.recordScheduledTaskRun({ taskId: task.id, scheduledForMs: now });
    f.db.updateScheduledTask(task.id, { status: 'running' });
    f.db.queueReply(`sched_media_${task.id}_${now}_legacy`, 'fixture-user', 'attachment placeholder');
    const before = JSON.stringify(outbox(f.db));
    await new TaskSchedulerEngine(f.config, f.db, f.client).tick({ nowMs: now });
    expect(JSON.stringify(outbox(f.db))).toBe(before);
    expect(f.db.getScheduledTaskById(task.id)?.status).toBe('paused');
    expect(f.db.getScheduledTaskById(task.id)?.last_error).toContain('需人工核对');
  } finally { f.db.db.close(); }
});

test('enqueue and completion roll back together if the completion write fails', async () => {
  const f = fixture(); const now = Date.now();
  try {
    const task = f.db.createScheduledTask({ title: 'atomic reminder', nextRunAt: now });
    f.db.db.exec(`CREATE TRIGGER fail_completion BEFORE UPDATE ON scheduled_tasks WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture completion failure'); END;`);
    const result = await new TaskSchedulerEngine(f.config, f.db, f.client).tick({ nowMs: now });
    expect(result[0].status).toBe('failed');
    expect(outbox(f.db)).toHaveLength(0);
    expect(f.db.getScheduledTaskById(task.id)?.status).toBe('active');
  } finally { f.db.db.close(); }
});

test('another live scheduler cannot reclaim a long-running owner or queue twice', async () => {
  const f = fixture(); const now = Date.now();
  const second = new ContextDatabase(f.config.dbPath);
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  try {
    f.db.createScheduledTask({ title: 'slow digest', taskKind: 'digest', nextRunAt: now });
    const first = new TaskSchedulerEngine(f.config, f.db, f.client);
    (first as any).executeDigestOrCollectionTask = async () => { entered(); await wait; return { wechatReply: 'once', depositedPath: '', modelUsed: 'fixture' }; };
    const ticking = first.tick({ nowMs: now });
    await ready;
    expect(await new TaskSchedulerEngine(f.config, second, f.client).tick({ nowMs: now })).toEqual([]);
    release(); await ticking;
    expect(outbox(f.db)).toHaveLength(1);
  } finally { release?.(); second.db.close(); f.db.db.close(); }
});


test('renewable locks keep live ownership and reclaim stale PID-reused locks', async () => {
  const f = fixture(); const second = new ContextDatabase(f.config.dbPath);
  try {
    await f.db.withLock('lease-test', async ownsLock => {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(ownsLock()).toBe(true);
      await expect(second.withLock('lease-test', async () => {}, {ttlMs: 60})).rejects.toThrow('Operation busy');
    }, { ttlMs: 60, renew: true });
    f.db.db.query('INSERT INTO operation_locks (name,pid,owner,acquired_at) VALUES (?,?,?,?)')
      .run('scheduler', process.pid, 'stale-instance-with-reused-pid', Date.now() - 3600000);
    const task = f.db.createScheduledTask({ title: 'recover stale lease', nextRunAt: Date.now() - 1000 });
    f.db.updateScheduledTask(task.id, { status: 'running' });
    await new TaskSchedulerEngine(f.config, f.db, f.client).tick();
    expect(f.db.getScheduledTaskById(task.id)?.status).toBe('completed');
    expect(outbox(f.db)).toHaveLength(1);
  } finally { second.db.close(); f.db.db.close(); }
});

test('a replaced lease fences the old execution out of enqueue and run completion', async () => {
  const f = fixture(); const now = Date.now();
  try {
    const task = f.db.createScheduledTask({ title: 'fenced digest', taskKind: 'digest', nextRunAt: now });
    const engine = new TaskSchedulerEngine(f.config, f.db, f.client);
    (engine as any).executeDigestOrCollectionTask = async () => {
      f.db.db.query("UPDATE operation_locks SET owner = 'new-owner' WHERE name = 'scheduler'").run();
      return {wechatReply: 'obsolete', depositedPath: '', modelUsed: 'fixture'};
    };
    expect(await engine.tick({nowMs: now})).toHaveLength(0);
    expect(outbox(f.db)).toHaveLength(0);
    expect(f.db.getScheduledTaskRuns(task.id)[0].status).toBe('running');
  } finally { f.db.db.close(); }
});

test('rescheduling by explicit name still selects that task', () => {
 const root=mkdtempSync(join(tmpdir(),'review-name-')); const db=new ContextDatabase(join(root,'db.sqlite'));
 try {
  const task=db.createScheduledTask({title:'支付房租',nextRunAt:Date.now()});
  expect(db.findScheduledTaskByQuery('把支付房租改到明天上午10点')?.id).toBe(task.id);
 }finally{db.db.close()}
});

test('recovered expired cron run must no longer appear running in history', async () => {
 const root=mkdtempSync(join(tmpdir(),'review-expired-'));
 const config=loadConfig({IGNORE_HOME_DOTENV:'true',VAULT_ROOT:'none',WECHAT_CONTEXT_DATA_DIR:root},root);
 const db=new ContextDatabase(config.dbPath), now=Date.now();
 try {
  const task=db.createScheduledTask({title:'expired digest',scheduleType:'cron',cronExpr:'0 8 * * *',nextRunAt:now-86400000});
  db.recordScheduledTaskRun({taskId:task.id,scheduledForMs:now-86400000,status:'running'});
  db.updateScheduledTask(task.id,{status:'running'});
  await new TaskSchedulerEngine(config,db,{resolveDefaultRecipient:()=> 'fixture'} as any).tick({nowMs:now});
  expect(db.getScheduledTaskById(task.id)?.status).toBe('active');
  expect(db.getScheduledTaskRuns(task.id)[0].status).toBe('skipped_misfire');
 } finally{db.db.close()}
});


test('renewal database errors fence the owner without escaping the heartbeat timer', async () => {
  const f = fixture();
  try {
    f.db.db.exec("CREATE TRIGGER fail_lease_update BEFORE UPDATE ON operation_locks BEGIN SELECT RAISE(ABORT, 'fixture renewal failure'); END;");
    await f.db.withLock('lease-failure', async ownsLock => {
      await new Promise(resolve => setTimeout(resolve, 70));
      expect(ownsLock()).toBe(false);
    }, { ttlMs: 60, renew: true });
    expect(f.db.isLockHeld('lease-failure')).toBe(false);
  } finally { f.db.db.close(); }
});
