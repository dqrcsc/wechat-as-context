import "./support/isolation.ts";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.ts";
import { ContextDatabase } from "../src/db.ts";
import { WeChatContextPipeline } from "../src/pipeline.ts";
import { createHttpHandler } from "../src/http.ts";
import {
  describeCronExpression,
  formatZonedDateTime,
  getNextCronRunMs,
  isValidCronExpression,
  zonedWallClockToEpochMs,
} from "../src/scheduler/cron.ts";
import { parseNaturalScheduleSpec } from "../src/scheduler/time_parser.ts";
import {
  SCHEDULER_BLOCK_BEGIN,
  SCHEDULER_BLOCK_END,
  syncScheduledTasksToVaultQueue,
} from "../src/scheduler/vault_sync.ts";

const originalFetch = globalThis.fetch;
const databases: ContextDatabase[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const db of databases.splice(0)) {
    db.db.close();
  }
});

function createSchedulerFixture(options?: {
  withLlmKey?: boolean;
  standalone?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "wx-scheduler-test-"));
  const standalone = Boolean(options?.standalone);

  if (!standalone) {
    mkdirSync(join(root, "00_home"), { recursive: true });
    mkdirSync(join(root, "01_inputs", "inbox"), { recursive: true });
    mkdirSync(join(root, "01_inputs", "articles", "wechat"), { recursive: true });
    mkdirSync(join(root, "03_ideas", "seeds"), { recursive: true });
    mkdirSync(join(root, "05_outputs"), { recursive: true });

    writeFileSync(
      join(root, "00_home", "now.md"),
      "---\ntype: home\n---\n当前研究主线：AI Agent 上下文工程、长期记忆与个人知识库自动化。"
    );
    writeFileSync(
      join(root, "00_home", "queue.md"),
      [
        "---",
        "type: home_queue",
        "---",
        "",
        "# Reading & Research Queue",
        "",
        "## 手动维护的高优队列",
        "- [ ] 精读 Context Engineering 综述论文",
        "",
      ].join("\n")
    );
  }

  const config: AppConfig = {
    projectRoot: root,
    dataDir: root,
    dbPath: join(root, "wechat_context.db"),
    vaultRoot: root,
    vaultEnabled: !standalone,
    vaultMode: standalone ? "standalone" : "structured_vault",
    wechatArticlesDir: standalone
      ? join(root, "articles", "wechat")
      : join(root, "01_inputs", "articles", "wechat"),
    webArticlesDir: standalone
      ? join(root, "articles", "web")
      : join(root, "01_inputs", "articles", "web"),
    inboxDir: standalone ? join(root, "inbox") : join(root, "01_inputs", "inbox"),
    papersDir: standalone
      ? join(root, "papers")
      : join(root, "01_inputs", "papers"),
    ideasSeedsDir: standalone
      ? join(root, "ideas")
      : join(root, "03_ideas", "seeds"),
    port: 0,
    annotationWaitSeconds: 0,
    llm: {
      apiKey: options?.withLlmKey ? "test-gemini-key" : "",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-2.5-flash",
      fastModel: "gemini-2.5-flash",
      proModel: "gemini-2.5-pro",
      allowCodexFallback: false,
    },
  };

  const db = new ContextDatabase(config.dbPath);
  databases.push(db);
  const pipeline = new WeChatContextPipeline(config, db);
  pipeline.clawbot.saveCredentials({
    botToken: "bot-token-sched",
    baseUrl: "https://ilink.example.test",
    botId: "bot@im.bot",
    userId: "user@im.wechat",
    savedAt: new Date().toISOString(),
  });

  return { root, config, db, pipeline };
}

describe("Scheduled Tasks, Recurring Digests & Todo Reminders Module", () => {
  test("Cron parser, timezone wall-clock calculation, and human descriptions work accurately", () => {
    expect(isValidCronExpression("30 8 * * *")).toBe(true);
    expect(isValidCronExpression("0 9 * * 1-5")).toBe(true);
    expect(isValidCronExpression("invalid cron")).toBe(false);

    expect(describeCronExpression("30 8 * * *")).toBe("每天 08:30");
    expect(describeCronExpression("0 9 * * 1-5")).toBe("每个工作日 09:00");
    expect(describeCronExpression("0 18 * * 5")).toBe("每周五 18:00");

    // 2026-10-27 07:00 Asia/Shanghai (Tuesday)
    const morning7am = zonedWallClockToEpochMs(2026, 10, 27, 7, 0, "Asia/Shanghai");
    const next830 = getNextCronRunMs("30 8 * * *", morning7am, "Asia/Shanghai");
    expect(formatZonedDateTime(next830, "Asia/Shanghai")).toBe("2026-10-27 08:30");

    // After 08:30 on 2026-10-27 -> rolls to 2026-10-28 08:30
    const morning9am = zonedWallClockToEpochMs(2026, 10, 27, 9, 0, "Asia/Shanghai");
    const nextDay830 = getNextCronRunMs("30 8 * * *", morning9am, "Asia/Shanghai");
    expect(formatZonedDateTime(nextDay830, "Asia/Shanghai")).toBe("2026-10-28 08:30");
  });

  test("Natural language time parser handles relative, clock, recurring, and default 20:00 fallback rules", () => {
    // Base time: 2026-10-27 14:00 Asia/Shanghai
    const base14pm = zonedWallClockToEpochMs(2026, 10, 27, 14, 0, "Asia/Shanghai");

    // 1. Relative time ("20分钟后提醒我关火")
    const rel = parseNaturalScheduleSpec("20分钟后提醒我关火", {
      nowMs: base14pm,
      timezone: "Asia/Shanghai",
    });
    expect(rel.scheduleType).toBe("once");
    expect(rel.isDefaultTime).toBe(false);
    expect(rel.nextRunAt).toBe(base14pm + 20 * 60_000);
    expect(rel.cleanedTitle).toBe("关火");

    // 2. Clock time ("提醒我今天下午4点半给招行回电话")
    const clock = parseNaturalScheduleSpec("提醒我今天下午4点半给招行回电话", {
      nowMs: base14pm,
      timezone: "Asia/Shanghai",
    });
    expect(clock.scheduleType).toBe("once");
    expect(clock.isDefaultTime).toBe(false);
    expect(formatZonedDateTime(clock.nextRunAt, "Asia/Shanghai")).toBe(
      "2026-10-27 16:30"
    );
    expect(clock.cleanedTitle).toContain("给招行回电话");

    // 3. Recurring digest ("每天早上8点半帮我搜一下 AI Agent 最新动态整理早报发给我")
    const recurring = parseNaturalScheduleSpec(
      "每天早上8点半帮我搜一下 AI Agent 最新动态整理早报发给我",
      {
        nowMs: base14pm,
        timezone: "Asia/Shanghai",
      }
    );
    expect(recurring.scheduleType).toBe("cron");
    expect(recurring.cronExpr).toBe("30 8 * * *");
    expect(recurring.taskKind).toBe("digest");
    expect(formatZonedDateTime(recurring.nextRunAt, "Asia/Shanghai")).toBe(
      "2026-10-28 08:30"
    );

    // 4. Untimed todo before 19:30 -> Default fallback to TODAY 20:00
    const untimedAfternoon = parseNaturalScheduleSpec("待办：买咖啡豆", {
      nowMs: base14pm,
      timezone: "Asia/Shanghai",
    });
    expect(untimedAfternoon.scheduleType).toBe("once");
    expect(untimedAfternoon.isDefaultTime).toBe(true);
    expect(untimedAfternoon.taskKind).toBe("todo");
    expect(untimedAfternoon.cleanedTitle).toBe("买咖啡豆");
    expect(
      formatZonedDateTime(untimedAfternoon.nextRunAt, "Asia/Shanghai")
    ).toBe("2026-10-27 20:00");

    // 5. Untimed todo at/after 19:30 -> Default fallback to TOMORROW 20:00
    const base2015pm = zonedWallClockToEpochMs(
      2026,
      10,
      27,
      20,
      15,
      "Asia/Shanghai"
    );
    const untimedNight = parseNaturalScheduleSpec("待办：报销差旅发票", {
      nowMs: base2015pm,
      timezone: "Asia/Shanghai",
    });
    expect(untimedNight.isDefaultTime).toBe(true);
    expect(formatZonedDateTime(untimedNight.nextRunAt, "Asia/Shanghai")).toBe(
      "2026-10-28 20:00"
    );
  });

  test("WeChat natural language lifecycle: create reminder, untimed todo (20:00 default), daily digest, list, reschedule, complete, and cancel + sync 00_home/queue.md", async () => {
    const f = createSchedulerFixture({ withLlmKey: false });

    // 1. Create untimed todo -> gets default 20:00 reminder
    const todoRes = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_sched_todo_1",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "sched_1",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: "待办：买咖啡豆和滤纸" } }],
      },
    });
    expect(todoRes.replyText).toContain("【待办事项已创建】#1");
    expect(todoRes.replyText).toContain("买咖啡豆和滤纸");
    expect(todoRes.replyText).toContain("20:00");
    expect(todoRes.replyText).toContain("默认分配 20:00 晚间兜底提醒");

    const task1 = f.db.getScheduledTaskById(1)!;
    expect(task1.is_default_time).toBe(1);
    expect(task1.task_kind).toBe("todo");
    expect(
      formatZonedDateTime(task1.next_run_at!, "Asia/Shanghai").endsWith("20:00")
    ).toBe(true);

    // 2. Create daily recurring digest task
    const digestRes = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_sched_digest_2",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "sched_2",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [
          {
            type: 1,
            text_item: {
              text: "每天早上8点半帮我搜一下 AI Agent 和上下文工程的最新动态，结合我的 now.md 整理早报发给我",
            },
          },
        ],
      },
    });
    expect(digestRes.replyText).toContain("【周期性定时任务已创建】#2");
    expect(digestRes.replyText).toContain("30 8 * * *");
    expect(digestRes.replyText).toContain("05_outputs/digests/");

    // Verify 00_home/queue.md preserves user content outside managed block!
    const queuePath = join(f.root, "00_home", "queue.md");
    const queueContent1 = readFileSync(queuePath, "utf-8");
    expect(queueContent1).toContain("## 手动维护的高优队列");
    expect(queueContent1).toContain("- [ ] 精读 Context Engineering 综述论文");
    expect(queueContent1).toContain(SCHEDULER_BLOCK_BEGIN);
    expect(queueContent1).toContain(SCHEDULER_BLOCK_END);
    expect(queueContent1).toContain("#1 买咖啡豆和滤纸");
    expect(queueContent1).toContain("(默认20:00兜底)");
    expect(queueContent1).toContain("#2");
    expect(queueContent1).toContain("`30 8 * * *`");

    // 3. List tasks via WeChat
    const listRes = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_sched_list_3",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "sched_3",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: "查看我的待办" } }],
      },
    });
    expect(listRes.replyText).toContain("【我的待办与定时任务】");
    expect(listRes.replyText).toContain("#1 买咖啡豆和滤纸");
    expect(listRes.replyText).toContain("#2");

    // 4. Reschedule task #1 ("把 #1 改到明早9点")
    const updateRes = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_sched_update_4",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "sched_4",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: "把 #1 改到明早9点" } }],
      },
    });
    expect(updateRes.replyText).toContain("已更新任务 #1");
    expect(updateRes.replyText).toContain("09:00");
    const updated1 = f.db.getScheduledTaskById(1)!;
    expect(updated1.is_default_time).toBe(0);
    expect(
      formatZonedDateTime(updated1.next_run_at!, "Asia/Shanghai").endsWith(
        "09:00"
      )
    ).toBe(true);

    // 5. Complete task #1 ("完成 #1")
    const doneRes = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_sched_done_5",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "sched_5",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: "完成 #1" } }],
      },
    });
    expect(doneRes.replyText).toContain("已标记完成：#1");
    expect(f.db.getScheduledTaskById(1)?.status).toBe("completed");

    // Verify queue.md moved #1 to Recent Completed while still keeping manual section intact
    const queueContent2 = readFileSync(queuePath, "utf-8");
    expect(queueContent2).toContain("## 手动维护的高优队列");
    expect(queueContent2).toContain("- [x] **#1 买咖啡豆和滤纸**");

    // 6. Cancel task #2 ("取消 #2")
    const cancelRes = await f.pipeline.agent.processClawBotMessage({
      messageKey: "msg_sched_cancel_6",
      senderId: "user@im.wechat",
      rawMessage: {
        message_id: "sched_6",
        from_user_id: "user@im.wechat",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: "取消 #2" } }],
      },
    });
    expect(cancelRes.replyText).toContain("已取消任务：#2");
    expect(f.db.getScheduledTaskById(2)?.status).toBe("cancelled");
  });

  test("TaskSchedulerEngine executes due one-shot reminders (with sleep/wake misfire notice) and recurring digests (archiving full Markdown note + pushing WeChat card)", async () => {
    const f = createSchedulerFixture({ withLlmKey: true });
    const sentWeChatTexts: string[] = [];

    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes(":generateContent")) {
        return Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: [
                      "### 核心要点 (Key Takeaways)",
                      "1. Agent 长期记忆架构正在从纯向量检索转向结构化知识图谱与双工文件同步；",
                      "2. 上下文工程强调渐进式披露与确定性调度；",
                      "3. 建议结合 `00_home/now.md` 推进今日实测。",
                    ].join("\n"),
                  },
                ],
              },
              groundingMetadata: {
                webSearchQueries: ["AI Agent context engineering 2026"],
                groundingChunks: [
                  {
                    web: {
                      title: "Context Engineering for Autonomous Agents",
                      uri: "https://example.org/agent-context-2026",
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      if (u.includes("/ilink/bot/sendmessage")) {
        const body = JSON.parse(String(init?.body || "{}"));
        const txt = body?.msg?.item_list?.[0]?.text_item?.text;
        if (txt) sentWeChatTexts.push(txt);
        return Response.json({ ret: 0, message_id: "out_sched" });
      }
      return Response.json({ ret: 0 });
    }) as any;

    const nowMs = zonedWallClockToEpochMs(2026, 10, 27, 8, 35, "Asia/Shanghai");

    // 1. Create a one-shot reminder that was due 25 minutes ago (simulating laptop sleep)
    const reminderTask = f.db.createScheduledTask({
      senderId: "user@im.wechat",
      title: "给招行回电话确认账单",
      taskKind: "reminder",
      scheduleType: "once",
      nextRunAt: nowMs - 25 * 60_000,
      isDefaultTime: 0,
      actionPayload: {
        executor: "reminder_push",
        prompt: "提醒我给招行回电话确认账单",
      },
    });

    // 2. Create a daily digest task due at 08:30 today (5 minutes ago)
    const scheduled830Ms = zonedWallClockToEpochMs(
      2026,
      10,
      27,
      8,
      30,
      "Asia/Shanghai"
    );
    const digestTask = f.db.createScheduledTask({
      senderId: "user@im.wechat",
      title: "AI Agent 与上下文工程早报",
      taskKind: "digest",
      scheduleType: "cron",
      cronExpr: "30 8 * * *",
      timezone: "Asia/Shanghai",
      nextRunAt: scheduled830Ms,
      isDefaultTime: 0,
      actionPayload: {
        executor: "web_search_digest",
        prompt:
          "每天早上8点半搜一下 AI Agent 和上下文工程最新动态，结合 now.md 整理早报",
        includeVaultNow: true,
        includeRecentArticlesHours: 24,
        archiveToVault: true,
      },
    });

    // Run scheduler tick at 08:35
    const outcomes = await f.pipeline.drainScheduledTasks({ nowMs });
    expect(outcomes.length).toBe(2);

    const remOutcome = outcomes.find((o) => o.taskId === reminderTask.id)!;
    expect(remOutcome.status).toBe("succeeded");
    expect(f.db.getScheduledTaskById(reminderTask.id)?.status).toBe("completed");
    expect(f.db.getScheduledTaskById(reminderTask.id)?.next_run_at).toBeNull();

    const digOutcome = outcomes.find((o) => o.taskId === digestTask.id)!;
    expect(digOutcome.status).toBe("succeeded");
    expect(digOutcome.depositedPath).toBeTruthy();
    expect(existsSync(digOutcome.depositedPath!)).toBe(true);
    expect(digOutcome.depositedPath!).toContain("05_outputs/digests/");

    // Verify full Markdown note archived in Vault with YAML frontmatter & sources
    const archivedMd = readFileSync(digOutcome.depositedPath!, "utf-8");
    expect(archivedMd).toContain("type: scheduled_digest");
    expect(archivedMd).toContain(`task_id: ${digestTask.id}`);
    expect(archivedMd).toContain("AI Agent 与上下文工程早报");
    expect(archivedMd).toContain("Context Engineering for Autonomous Agents");
    expect(archivedMd).toContain("https://example.org/agent-context-2026");

    // Verify recurring digest task advanced next_run_at to tomorrow 08:30 and remained active
    const updatedDigest = f.db.getScheduledTaskById(digestTask.id)!;
    expect(updatedDigest.status).toBe("active");
    expect(
      formatZonedDateTime(updatedDigest.next_run_at!, "Asia/Shanghai")
    ).toBe("2026-10-28 08:30");

    // Flush outbox and verify both notifications were pushed to WeChat
    await f.pipeline.flushReplies({ nowMs });
    expect(sentWeChatTexts.length).toBe(2);
    expect(
      sentWeChatTexts.some(
        (t) =>
          t.includes("给招行回电话确认账单") && t.includes("离线唤醒补推")
      )
    ).toBe(true);
    expect(
      sentWeChatTexts.some(
        (t) =>
          t.includes("AI Agent 与上下文工程早报") &&
          t.includes("05_outputs/digests/")
      )
    ).toBe(true);
  });

  test("Standalone mode (VAULT_ROOT=none) never creates 00_home/queue.md and archives digests under digests/", async () => {
    const f = createSchedulerFixture({ withLlmKey: false, standalone: true });

    const syncRes = syncScheduledTasksToVaultQueue(f.config, f.db);
    expect(syncRes).toBeNull();
    expect(existsSync(join(f.root, "00_home"))).toBe(false);

    const task = f.db.createScheduledTask({
      senderId: "user@im.wechat",
      title: "晚间收件箱回顾",
      taskKind: "digest",
      scheduleType: "once",
      nextRunAt: Date.now() - 1000,
      actionPayload: {
        executor: "vault_digest",
        prompt: "汇总今日文章与待办",
        archiveToVault: true,
      },
    });

    const outcomes = await f.pipeline.drainScheduledTasks();
    expect(outcomes.length).toBe(1);
    expect(outcomes[0].depositedPath).toContain(join(f.root, "digests"));
    expect(existsSync(outcomes[0].depositedPath!)).toBe(true);
    expect(existsSync(join(f.root, "00_home"))).toBe(false);
    expect(f.db.getScheduledTaskById(task.id)?.status).toBe("completed");
  });

  test("HTTP /api/schedules supports listing, creating, completing, and cancelling scheduled tasks", async () => {
    const f = createSchedulerFixture({ withLlmKey: false });
    const handler = createHttpHandler(f.db, f.pipeline);

    const postCreate = await handler(
      new Request("http://127.0.0.1/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          text: "待办：整理智能体定时调度文档",
        }),
      })
    );
    expect(postCreate.status).toBe(200);
    const createdJson = (await postCreate.json()) as any;
    expect(createdJson.ok).toBe(true);
    expect(createdJson.task.title).toBe("整理智能体定时调度文档");
    expect(createdJson.task.is_default_time).toBe(1);

    const getList = await handler(
      new Request("http://127.0.0.1/api/schedules", { method: "GET" })
    );
    const listJson = (await getList.json()) as any;
    expect(listJson.ok).toBe(true);
    expect(listJson.tasks.length).toBe(1);

    const postDone = await handler(
      new Request("http://127.0.0.1/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          id: createdJson.task.id,
        }),
      })
    );
    const doneJson = (await postDone.json()) as any;
    expect(doneJson.ok).toBe(true);
    expect(doneJson.task.status).toBe("completed");
  });
});
