import './support/isolation.ts';
import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextDatabase } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { WeChatContextPipeline } from '../src/pipeline.ts';
import { TaskSchedulerEngine } from '../src/scheduler/engine.ts';
import { parseNaturalScheduleSpec } from '../src/scheduler/time_parser.ts';
import { createHttpHandler } from '../src/http.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'v041-scheduler-'));
  const config = loadConfig({ IGNORE_HOME_DOTENV: 'true', VAULT_ROOT: 'none', WECHAT_CONTEXT_DATA_DIR: root }, root);
  const db = new ContextDatabase(config.dbPath);
  return { root, config, db };
}
function manage(pipeline: WeChatContextPipeline, action: string, text: string) {
  return (pipeline.agent as any).handleManageSchedule({ senderId: 'fixture', decision: { slots: { scheduleSubAction: action, coreContent: text } }, unpacked: { userText: text } });
}
function outboxSize(db: ContextDatabase) {
  return (db.db.query('SELECT COUNT(*) n FROM reply_outbox').get() as any).n;
}

for (const title of ['AI日报', 'AI早报', 'AI提醒', 'AI任务', '提醒1', 'AI推迟计划', 'AI改到计划', 'AI改到今天计划', 'AI推迟到每周五计划']) {
  for (const action of ['cancel', 'complete', 'update']) {
    test(`complete title ${title} selects only the intended task for ${action}`, async () => {
      const { config, db } = fixture();
      try {
        const short = db.createScheduledTask({ senderId: 'fixture', title: 'AI', nextRunAt: 2000000000000 });
        const exact = db.createScheduledTask({ senderId: 'fixture', title, nextRunAt: 2000000000000 });
        const command = action === 'update' ? `把${title}改到明天上午9点` : `${action === 'cancel' ? '取消' : '完成'}${title}`;
        const result = await manage(new WeChatContextPipeline(config, db), action, command);
        expect(result.replyText).toContain(`「${title}」`);
        expect(db.getScheduledTaskById(short.id)?.status).toBe('active');
        expect(db.getScheduledTaskById(short.id)?.next_run_at).toBe(2000000000000);
        if (action === 'update') {
          const expected = parseNaturalScheduleSpec('明天上午9点', { nowMs: Date.now(), timeZone: 'Asia/Shanghai' });
          expect(db.getScheduledTaskById(exact.id)?.next_run_at).toBe(expected.nextRunAt);
          expect(db.getScheduledTaskById(exact.id)?.schedule_type).toBe('once');
        }
        else expect(db.getScheduledTaskById(exact.id)?.status).toBe(action === 'cancel' ? 'cancelled' : 'completed');
      } finally { db.db.close(); }
    });
  }
}

test('title wrappers, duplicate names, unknown titles and explicit IDs are unambiguous', () => {
  const { db } = fixture();
  try {
    const a = db.createScheduledTask({ senderId: 'fixture', title: 'AI日报' });
    db.createScheduledTask({ senderId: 'fixture', title: 'AI早报' });
    const options = { senderId: 'fixture', activeOnly: true };
    expect(db.findScheduledTaskByQuery('取消「AI日报」', options)?.id).toBe(a.id);
    expect(db.findScheduledTaskByQuery('取消AI日报的任务', options)?.id).toBe(a.id);
    expect(db.findScheduledTaskByQuery('取消AI', options)).toBeNull();
    expect(db.findScheduledTaskByQuery('把AI推迟计划改到明天9点', options)).toBeNull();
    expect(db.findScheduledTaskByQuery('取消火星日报', options)).toBeNull();
    expect(db.findScheduledTaskByQuery('取消#999999', options)).toBeNull();
    expect(db.findScheduledTaskByQuery(`把 #${a.id} 改到明天9点`, options)?.id).toBe(a.id);
    db.createScheduledTask({ senderId: 'fixture', title: 'AI日报' });
    expect(db.findScheduledTaskByQuery('取消AI日报', options)).toBeNull();
    expect(db.findScheduledTaskByQuery('把AI日报改到明天9点', options)).toBeNull();
    expect(db.findScheduledTaskByQuery(`取消 #${a.id}`, options)?.id).toBe(a.id);
  } finally { db.db.close(); }
});

for (const [now, text, expected] of [
  ['2026-10-30T02:00:00Z', '星期五下午3点提醒我开会', '2026-10-30T07:00:00Z'],
  ['2026-10-30T07:00:00Z', '星期五下午3点提醒我开会', '2026-10-30T07:00:00Z'],
  ['2026-10-30T08:00:00Z', '星期五下午3点提醒我开会', '2026-11-06T07:00:00Z'],
  ['2026-10-26T02:00:00Z', '星期 五下午3点提醒我开会', '2026-10-30T07:00:00Z'],
  ['2026-10-26T02:00:00Z', '本周日下午3点提醒我开会', '2026-11-01T07:00:00Z'],
  ['2026-11-01T02:00:00Z', '周一下午3点提醒我开会', '2026-11-02T07:00:00Z'],
  ['2026-11-01T02:00:00Z', '下周一下午3点提醒我开会', '2026-11-02T07:00:00Z'],
  ['2026-10-30T02:00:00Z', '下周五下午3点提醒我开会', '2026-11-06T07:00:00Z'],
  ['2026-12-31T02:00:00Z', '周五下午3点提醒我开会', '2027-01-01T07:00:00Z'],
]) {
  test(`weekday date and label agree: ${now} / ${text}`, () => {
    const parsed = parseNaturalScheduleSpec(text, { nowMs: Date.parse(now), timeZone: 'Asia/Shanghai' });
    expect(parsed.nextRunAt).toBe(Date.parse(expected));
    expect(parsed.scheduleType).toBe('once');
    expect(parsed.humanScheduleLabel).toContain(expected.slice(0, 10));
    expect(parsed.humanScheduleLabel).toContain('15:00');
  });
}
for (const text of ['本周五下午3点提醒我开会', '这星期一上午9点提醒我开会']) {
  test(`explicit past weekday is rejected: ${text}`, () => {
    expect(() => parseNaturalScheduleSpec(text, { nowMs: Date.parse('2026-10-30T08:00:00Z'), timeZone: 'Asia/Shanghai' })).toThrow('已过');
  });
}

test('manual WeChat and HTTP runs report lock contention without runs or queued replies', async () => {
  const { config, db } = fixture();
  try {
    const task = db.createScheduledTask({ senderId: 'fixture', title: '重要摘要', nextRunAt: Date.now() + 86400000 });
    const pipeline = new WeChatContextPipeline(config, db);
    const handler = createHttpHandler(db, pipeline);
    await db.withLock('scheduler', async () => {
      const result = await manage(pipeline, 'run_now', `立即执行#${task.id}`);
      expect(result.replyText).toContain('本次未执行');
      expect(result.replyText).not.toContain('已触发');
      const response = await handler(new Request('http://127.0.0.1/api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'run', id: task.id }) }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ ok: false, code: 'busy' });
    });
    expect(db.getScheduledTaskRuns(task.id)).toHaveLength(0);
    expect(outboxSize(db)).toBe(0);
  } finally { db.db.close(); }
});

test('same engine concurrency rejects manual calls while background polling stays quiet', async () => {
  const { config, db } = fixture();
  try {
    const task = db.createScheduledTask({ senderId: 'fixture', title: '提醒', nextRunAt: 1 });
    const engine = new TaskSchedulerEngine(config, db, {} as any);
    const first = engine.tick();
    await expect(engine.tick({ forceTaskId: task.id })).rejects.toThrow('繁忙');
    await expect(engine.tick({ manual: true })).rejects.toThrow('繁忙');
    expect(await engine.tick()).toEqual([]);
    expect((await first)[0]?.status).toBe('succeeded');
    expect(outboxSize(db)).toBe(1);
  } finally { db.db.close(); }
});

test('forced missing, already processed, failed and successful runs have distinct outcomes', async () => {
  const { config, db } = fixture();
  try {
    const task = db.createScheduledTask({ senderId: 'fixture', title: '提醒', nextRunAt: 1 });
    const engine = new TaskSchedulerEngine(config, db, {} as any);
    await expect(engine.tick({ forceTaskId: 999 })).rejects.toThrow('不存在');
    const now = Date.now();
    expect((await engine.tick({ forceTaskId: task.id, nowMs: now }))[0]?.status).toBe('succeeded');
    await expect(engine.tick({ forceTaskId: task.id, nowMs: now })).rejects.toThrow('本次未执行');
    expect(outboxSize(db)).toBe(1);
    const originalQueue = db.queueReply;
    db.queueReply = () => { throw new Error('injected queue failure'); };
    try {
      const failed = await engine.tick({ forceTaskId: task.id, nowMs: now + 1 });
      expect(failed[0]?.status).toBe('failed');
      expect(outboxSize(db)).toBe(1);
    } finally { db.queueReply = originalQueue; }
  } finally { db.db.close(); }
});

test('HTTP reports real success, failure, empty result and missing ID honestly', async () => {
  const { config, db } = fixture();
  try {
    const task = db.createScheduledTask({ senderId: 'fixture', title: '提醒', nextRunAt: 1 });
    const pipeline = new WeChatContextPipeline(config, db);
    const handler = createHttpHandler(db, pipeline);
    const run = (id = task.id) => handler(new Request('http://127.0.0.1/api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'run', id }) }));
    expect((await run(999)).status).toBe(404);
    const success = await run();
    expect(success.status).toBe(200);
    expect((await success.json() as any).outcomes[0].status).toBe('succeeded');
    for (const outcomes of [[], [{ taskId: task.id, title: task.title, status: 'failed' }], [{ taskId: task.id, title: task.title, status: 'skipped_misfire' }]]) {
      pipeline.drainScheduledTasks = async () => outcomes as any;
      const response = await run();
      expect(response.status).toBe(409);
      expect((await response.json() as any).ok).toBe(false);
    }
    expect(outboxSize(db)).toBe(1);
  } finally { db.db.close(); }
});

test('WeChat run receipt distinguishes successful queueing from execution failure', async () => {
  const { config, db } = fixture();
  try {
    const task = db.createScheduledTask({ senderId: 'fixture', title: '提醒', nextRunAt: 1 });
    const pipeline = new WeChatContextPipeline(config, db);
    const success = await manage(pipeline, 'run_now', `立即执行#${task.id}`);
    expect(success.replyText).toContain('回执已入队');
    expect(success.replyText).toContain('尚不代表微信送达');
    const second = db.createScheduledTask({ senderId: 'fixture', title: '失败提醒', nextRunAt: 1 });
    db.queueReply = () => { throw new Error('injected queue failure'); };
    const failed = await manage(pipeline, 'run_now', `立即执行#${second.id}`);
    expect(failed.replyText).toContain('未成功执行');
    expect(failed.replyText).not.toContain('已触发');
    expect(outboxSize(db)).toBe(1);
  } finally { db.db.close(); }
});

for (const withId of [true, false]) {
  test(`CLI manual run reports busy with nonzero exit, withId=${withId}`, async () => {
    const { root, db } = fixture();
    try {
      const task = db.createScheduledTask({ senderId: 'fixture', title: '提醒', nextRunAt: 1 });
      await db.withLock('scheduler', async () => {
        const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'schedule', 'run', ...(withId ? [String(task.id)] : []), '--json'], { env: { ...process.env, WECHAT_CONTEXT_DATA_DIR: root, VAULT_ROOT: 'none' } });
        expect(proc.exitCode).toBe(1);
        expect(proc.stderr.toString()).toContain('本次未执行');
        expect(proc.stdout.toString()).not.toContain('"ok": true');
      });
      expect(db.getScheduledTaskRuns(task.id)).toHaveLength(0);
      expect(outboxSize(db)).toBe(0);
    } finally { db.db.close(); }
  });
}

for (const action of ['cancel', 'complete', 'update']) {
  test(`router ID and shortened title cannot override explicit user target for ${action}`, async () => {
    const { config, db } = fixture();
    try {
      const other = db.createScheduledTask({ senderId: 'fixture', title: 'AI', nextRunAt: 2000000000000 });
      const target = db.createScheduledTask({ senderId: 'fixture', title: 'AI日报', nextRunAt: 2000000000000 });
      const text = action === 'update' ? '把AI日报改到明天9点' : `${action === 'cancel' ? '取消' : '完成'}AI日报`;
      await (new WeChatContextPipeline(config, db).agent as any).handleManageSchedule({ senderId: 'fixture', decision: { slots: { scheduleSubAction: action, targetTaskId: other.id, coreContent: 'AI' } }, unpacked: { userText: text } });
      expect(db.getScheduledTaskById(other.id)?.status).toBe('active');
      expect(db.getScheduledTaskById(other.id)?.next_run_at).toBe(2000000000000);
      if (action === 'update') expect(db.getScheduledTaskById(target.id)?.next_run_at).not.toBe(2000000000000);
      else expect(db.getScheduledTaskById(target.id)?.status).toBe(action === 'cancel' ? 'cancelled' : 'completed');
    } finally { db.db.close(); }
  });
}

for (const action of ['cancel', 'complete', 'update']) {
  test(`unknown title containing a scheduling clause cannot mutate shorter title: ${action}`, async () => {
    const { config, db } = fixture();
    try {
      const task = db.createScheduledTask({ senderId: 'fixture', title: 'AI', nextRunAt: 2000000000000 });
      const text = action === 'update' ? '把AI推迟到明天计划改到后天9点' : `${action === 'cancel' ? '取消' : '完成'}AI推迟到明天计划`;
      const result = await manage(new WeChatContextPipeline(config, db), action, text);
      expect(result.replyText).toContain('未找到');
      expect(db.getScheduledTaskById(task.id)?.status).toBe('active');
      expect(db.getScheduledTaskById(task.id)?.next_run_at).toBe(2000000000000);
    } finally { db.db.close(); }
  });
}

test('rescheduling by ID cannot mistake a date in the new time for the task title', async () => {
  const { config, db } = fixture();
  try {
    const task = db.createScheduledTask({ senderId: 'fixture', title: '明天', nextRunAt: 2000000000000 });
    await manage(new WeChatContextPipeline(config, db), 'update', `把 #${task.id} 改到明天上午9点`);
    const expected = parseNaturalScheduleSpec('明天上午9点', { nowMs: Date.now(), timeZone: 'Asia/Shanghai' });
    expect(db.getScheduledTaskById(task.id)?.next_run_at).toBe(expected.nextRunAt);
    expect(db.getScheduledTaskById(task.id)?.schedule_type).toBe('once');
  } finally { db.db.close(); }
});

for (const failed of [false, true]) {
  test(`CLI manual outcome and exit agree with execution, failed=${failed}`, () => {
    const { root, db } = fixture();
    try {
      const task = db.createScheduledTask({ senderId: 'fixture', title: '提醒', nextRunAt: 2000000000000 });
      if (failed) db.db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON reply_outbox BEGIN SELECT RAISE(ABORT, 'injected queue failure'); END");
      const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'schedule', 'run', String(task.id), '--json'], { env: { ...process.env, WECHAT_CONTEXT_DATA_DIR: root, VAULT_ROOT: 'none' } });
      expect(proc.exitCode).toBe(failed ? 1 : 0);
      const body = JSON.parse(proc.stdout.toString());
      expect(body.ok).toBe(!failed);
      expect(body.outcomes[0].status).toBe(failed ? 'failed' : 'succeeded');
      expect(outboxSize(db)).toBe(failed ? 0 : 1);
    } finally { db.db.close(); }
  });
}
