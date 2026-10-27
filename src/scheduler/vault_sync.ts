import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { AppConfig } from "../config.ts";
import type { ContextDatabase, ScheduledTaskRecord } from "../db.ts";
import { describeCronExpression, formatZonedDateTime } from "./cron.ts";

export const SCHEDULER_BLOCK_BEGIN = "<!-- BEGIN_WECHAT_SCHEDULER -->";
export const SCHEDULER_BLOCK_END = "<!-- END_WECHAT_SCHEDULER -->";

function isInsideRoot(rootDir: string, candidatePath: string): boolean {
  const rel = relative(resolve(rootDir), resolve(candidatePath));
  return Boolean(rel && !rel.startsWith("..") && !rel.startsWith("/"));
}

export function renderSchedulerManagedBlock(
  tasks: ScheduledTaskRecord[],
  timezone = "Asia/Shanghai"
): string {
  const activeOnce = tasks.filter(
    (t) =>
      (t.status === "active" || t.status === "running") &&
      t.schedule_type === "once"
  );
  const activeCron = tasks.filter(
    (t) =>
      (t.status === "active" || t.status === "running" || t.status === "paused") &&
      t.schedule_type === "cron"
  );
  const recentCompleted = tasks
    .filter((t) => t.status === "completed")
    .sort((a, b) => (b.last_run_at || b.updated_at).localeCompare(a.last_run_at || a.updated_at))
    .slice(0, 8);

  const lines: string[] = [
    SCHEDULER_BLOCK_BEGIN,
    "## ⏰ 微信待办与定时任务 (WeChat Scheduler)",
    "",
    "### 📌 待处理事项与单次提醒 (Todos & Reminders)",
  ];

  if (activeOnce.length === 0) {
    lines.push("- _暂无待处理单次提醒或待办_");
  } else {
    for (const item of activeOnce) {
      const dueStr = item.next_run_at
        ? formatZonedDateTime(item.next_run_at, item.timezone || timezone)
        : "待定";
      const fallbackTag = item.is_default_time ? " (默认20:00兜底)" : "";
      const articleTag = item.related_article_id
        ? ` · 关联文章 #${item.related_article_id}`
        : "";
      lines.push(
        `- [ ] **#${item.id} ${item.title}** · ⏰ ${dueStr}${fallbackTag}${articleTag}`
      );
    }
  }

  lines.push("", "### 🔄 周期性信息收集与定时任务 (Recurring Digests)");
  if (activeCron.length === 0) {
    lines.push("- _暂无周期性定时任务_");
  } else {
    for (const item of activeCron) {
      const cronDesc = item.cron_expr
        ? describeCronExpression(item.cron_expr)
        : "周期执行";
      const nextStr = item.next_run_at
        ? formatZonedDateTime(item.next_run_at, item.timezone || timezone)
        : "已暂停";
      const statusBadge = item.status === "paused" ? " [已暂停]" : "";
      lines.push(
        `- 🔄 **#${item.id} ${item.title}**${statusBadge} · \`${item.cron_expr}\` (${cronDesc}) · 下次: ${nextStr}`
      );
    }
  }

  lines.push("", "### ✅ 最近已完成 (Recent Completed)");
  if (recentCompleted.length === 0) {
    lines.push("- _暂无最近完成记录_");
  } else {
    for (const item of recentCompleted) {
      const doneIso = item.last_run_at || item.updated_at;
      const doneMs = Date.parse(doneIso);
      const doneStr = Number.isFinite(doneMs)
        ? formatZonedDateTime(doneMs, item.timezone || timezone)
        : doneIso.slice(0, 16).replace("T", " ");
      lines.push(`- [x] **#${item.id} ${item.title}** · 完成于 ${doneStr}`);
    }
  }

  lines.push(SCHEDULER_BLOCK_END);
  return lines.join("\n");
}

/**
 * Synchronize active & recently completed scheduled tasks into `$VAULT_ROOT/00_home/queue.md`
 * (or configured `vaultLayout.queueFile`) inside the managed comment block, preserving all
 * user-authored Markdown outside the block.
 */
export function syncScheduledTasksToVaultQueue(
  config: AppConfig,
  db: ContextDatabase
): string | null {
  if (config.vaultEnabled === false || config.vaultMode === "standalone") {
    return null;
  }

  const configuredRel = config.vaultLayout?.queueFile || "00_home/queue.md";
  const targetPath = join(config.vaultRoot, configuredRel);
  if (!isInsideRoot(config.vaultRoot, targetPath)) {
    return null;
  }

  if (config.vaultMode === "generic_folder") {
    const hasHomeDir = existsSync(join(config.vaultRoot, "00_home"));
    if (!existsSync(targetPath) && !hasHomeDir) {
      return null;
    }
  }

  const allTasks = db.listScheduledTasks({
    status: ["active", "running", "paused", "completed"],
    limit: 150,
  });
  const block = renderSchedulerManagedBlock(allTasks);

  mkdirSync(dirname(targetPath), { recursive: true });

  if (!existsSync(targetPath)) {
    const today = formatZonedDateTime(Date.now(), "Asia/Shanghai").slice(0, 10);
    const starter = [
      "---",
      "type: home_queue",
      `updated: ${today}`,
      "---",
      "",
      "# Queue & Scheduled Tasks",
      "",
      block,
      "",
    ].join("\n");
    writeFileSync(targetPath, starter, "utf-8");
    return targetPath;
  }

  const existing = readFileSync(targetPath, "utf-8");
  const beginIdx = existing.indexOf(SCHEDULER_BLOCK_BEGIN);
  const endIdx = existing.indexOf(SCHEDULER_BLOCK_END);

  let updated: string;
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + SCHEDULER_BLOCK_END.length);
    updated = `${before}${block}${after}`;
  } else {
    const trimmedEnd = existing.replace(/\s+$/, "");
    updated = trimmedEnd ? `${trimmedEnd}\n\n${block}\n` : `${block}\n`;
  }

  if (updated !== existing) {
    writeFileSync(targetPath, updated, "utf-8");
  }
  return targetPath;
}
