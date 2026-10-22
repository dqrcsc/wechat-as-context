import { ContextDatabase } from "../db.ts";
import { unpackClawBotMessage } from "../clawbot/client.ts";

export interface TaskProgressOptions {
  db: ContextDatabase;
  messageKey: string;
  senderId: string;
  taskTitle?: string;
  sendProgressCallback?: (senderId: string, text: string) => Promise<void>;
  heartbeatIntervalMs?: number;
  heartbeatIntervalSeconds?: number;
}

/**
 * Detect whether a user message is asking about the live status/progress of running tasks.
 */
export function isTaskStatusQuery(userText: string): boolean {
  const t = userText.trim();
  if (!t || t.length > 40) return false;
  return /^(?:\/status|status|进度|任务进度|当前进度|状态|任务状态|还在跑吗|还在处理吗|处理完没|跑完没|还在执行吗|卡住了吗|挂了吗|到哪一步了)[？?！!。.~～\s]*$/i.test(
    t
  );
}

/**
 * Build a human-readable WeChat status report for active and recently finished tasks.
 */
export function formatLiveTaskStatusReport(
  db: ContextDatabase,
  senderId: string,
  heartbeatSeconds = 25
): string {
  const activeTasks = db.getActiveAgentTasks(senderId);
  const nowMs = Date.now();

  if (activeTasks.length > 0) {
    const lines: string[] = [
      `🟢 **当前有 ${activeTasks.length} 个任务正在后台运行中（未异常中断）**：`,
    ];

    for (const task of activeTasks) {
      let taskDesc = task.message_key;
      try {
        const raw = JSON.parse(task.raw_payload);
        const unpacked = unpackClawBotMessage(raw);
        if (unpacked.userText) {
          taskDesc =
            unpacked.userText.length > 55
              ? `${unpacked.userText.slice(0, 55)}…`
              : unpacked.userText;
        }
      } catch {}

      const startIso = task.started_at || task.created_at;
      const elapsedSec = Math.max(
        1,
        Math.round((nowMs - new Date(startIso).getTime()) / 1000)
      );
      const hbIso = task.heartbeat_at || task.updated_at;
      const hbAgoSec = Math.max(
        0,
        Math.round((nowMs - new Date(hbIso).getTime()) / 1000)
      );

      const statusBadge =
        task.status === "pending" ? "⏸️ 排队等待执行" : "🔄 正在处理中";
      const stageText = task.stage || "正在初始化并分析任务上下文";

      lines.push(
        `\n- **任务 #${task.id}**（${statusBadge}）\n  📝 需求：${taskDesc}\n  📍 当前阶段：${stageText}\n  ⏱️ 已运行：${elapsedSec} 秒（最近心跳：${hbAgoSec} 秒前）`
      );
    }

    if (heartbeatSeconds > 0) {
      lines.push(
        `\n💡 系统每隔 ${heartbeatSeconds} 秒会自动向你推送一次心跳进度，完成后将第一时间回传结果与文件。`
      );
    } else {
      lines.push(`\n💡 任务正在后台持续执行中，完成后将第一时间回传结果与文件。`);
    }
    return lines.join("\n");
  }

  const recentTasks = db.getRecentAgentTasks(senderId, 3);
  if (recentTasks.length === 0) {
    return "📭 当前没有正在运行的历史长任务，系统处于空闲待命状态。";
  }

  const lines: string[] = [
    `✅ **当前无正在运行的长任务（最近 ${recentTasks.length} 个任务状态如下）**：`,
  ];

  for (const task of recentTasks) {
    let taskDesc = task.message_key;
    try {
      const raw = JSON.parse(task.raw_payload);
      const unpacked = unpackClawBotMessage(raw);
      if (unpacked.userText) {
        taskDesc =
          unpacked.userText.length > 45
            ? `${unpacked.userText.slice(0, 45)}…`
            : unpacked.userText;
      }
    } catch {}

    const badge =
      task.status === "done" || task.status === "completed"
        ? "✅ 已完成"
        : task.status === "failed"
        ? `❌ 失败 (${task.error.slice(0, 80)})`
        : `⏳ ${task.status}`;

    lines.push(
      `- **任务 #${task.id}** [${badge}]：${taskDesc}${
        task.stage ? `\n  📍 最后阶段：${task.stage}` : ""
      }`
    );
  }

  return lines.join("\n");
}

/**
 * Manages real-time stage tracking, SQLite heartbeat persistence, and periodic WeChat progress pushes
 * so the user always sees that a long-running task is alive and advancing.
 */
export class TaskProgressReporter {
  private readonly db: ContextDatabase;
  private readonly messageKey: string;
  private readonly senderId: string;
  private readonly taskTitle: string;
  private readonly sendProgressCallback?: (
    senderId: string,
    text: string
  ) => Promise<void>;
  private readonly heartbeatIntervalMs: number;
  private readonly startMs = Date.now();

  private currentStage = "初始化任务";
  private liveActivityDetail = "";
  private heartbeatCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(options: TaskProgressOptions) {
    this.db = options.db;
    this.messageKey = options.messageKey;
    this.senderId = options.senderId;
    this.taskTitle = options.taskTitle || "复杂任务";
    this.sendProgressCallback = options.sendProgressCallback;

    const envMs = Number(process.env.TASK_HEARTBEAT_MS || "");
    const envSecRaw = process.env.TASK_HEARTBEAT_SECONDS;
    const envSec =
      envSecRaw !== undefined && envSecRaw !== "" ? Number(envSecRaw) : NaN;
    const configuredMs =
      options.heartbeatIntervalMs !== undefined
        ? options.heartbeatIntervalMs
        : options.heartbeatIntervalSeconds !== undefined
        ? options.heartbeatIntervalSeconds * 1000
        : Number.isFinite(envSec) && envSec >= 0
        ? envSec * 1000
        : 25_000;

    this.heartbeatIntervalMs =
      Number.isFinite(envMs) && envMs >= 100 ? envMs : configuredMs;
  }

  public async start(
    initialStage: string,
    initialWeChatMessage?: string
  ): Promise<void> {
    this.stopped = false;
    this.currentStage = initialStage;
    this.persistToDb();

    if (initialWeChatMessage && this.sendProgressCallback) {
      await this.sendProgressCallback(this.senderId, initialWeChatMessage).catch(
        () => {}
      );
    }

    if (!this.timer && this.heartbeatIntervalMs > 0) {
      this.timer = setInterval(() => {
        if (this.stopped) return;
        this.emitPeriodicHeartbeat().catch(() => {});
      }, this.heartbeatIntervalMs);
    }
  }

  public async updateStage(
    stage: string,
    options?: {
      detail?: string;
      pushWeChat?: boolean;
      wechatMessage?: string;
    }
  ): Promise<void> {
    if (this.stopped) return;
    this.currentStage = stage;
    if (options?.detail !== undefined) {
      this.liveActivityDetail = options.detail;
    }
    this.persistToDb();

    if (options?.pushWeChat && this.sendProgressCallback) {
      const elapsedSec = Math.max(
        1,
        Math.round((Date.now() - this.startMs) / 1000)
      );
      const msg =
        options.wechatMessage ||
        `🔄 **${this.taskTitle}进度更新**（已用时 ${elapsedSec}s）：\n📍 ${stage}${
          this.liveActivityDetail ? `\n📊 ${this.liveActivityDetail}` : ""
        }`;
      await this.sendProgressCallback(this.senderId, msg).catch(() => {});
    }
  }

  public updateActivity(detail: string): void {
    if (this.stopped) return;
    this.liveActivityDetail = detail;
    this.persistToDb();
  }

  public stop(finalStage = "任务执行完毕"): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.currentStage = finalStage;
    this.persistToDb();
  }

  private persistToDb(): void {
    try {
      const combined = this.liveActivityDetail
        ? `${this.currentStage} | ${this.liveActivityDetail}`
        : this.currentStage;
      this.db.updateAgentTaskProgressByMessageKey(this.messageKey, combined);
    } catch {}
  }

  private async emitPeriodicHeartbeat(): Promise<void> {
    if (this.stopped) return;
    this.heartbeatCount += 1;
    this.persistToDb();

    if (!this.sendProgressCallback) return;

    const elapsedSec = Math.max(
      1,
      Math.round((Date.now() - this.startMs) / 1000)
    );
    const lines = [
      `⏳ **${this.taskTitle}正在持续处理中**（已运行 ${elapsedSec}s · 第 ${this.heartbeatCount} 次状态同步）`,
      `📍 当前阶段：${this.currentStage}`,
    ];
    if (this.liveActivityDetail) {
      lines.push(`📊 实时动态：${this.liveActivityDetail}`);
    }
    lines.push(`💡 任务运行正常未中断，完成后将立即回传结果。`);

    await this.sendProgressCallback(this.senderId, lines.join("\n")).catch(
      () => {}
    );
  }
}
