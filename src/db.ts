import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { decodeArtifactPaths, writeNewFile } from "./storage.ts";

export type ArticleStatus =
  | "pending_extract"
  | "extracting"
  | "analyzing"
  | "light_done"
  | "deep_done"
  | "failed";

export type TriageLevel =
  | "keep_raw"
  | "reference"
  | "process_later"
  | "process_now";

export interface ArticleRecord {
  id: number;
  msgid: string;
  url: string;
  title: string;
  author: string;
  digest: string;
  user_notes: string;
  sender_id: string;
  open_kfid: string;
  channel: string; // "clawbot" | "cli"
  status: ArticleStatus;
  triage: TriageLevel;
  process_level: "raw" | "light" | "deep";
  source_md_path: string;
  note_md_path: string;
  short_summary: string;
  related_vault_nodes: string; // JSON string array of wiki links / paths
  error_message: string;
  created_at: string;
  updated_at: string;
  ready_after: number; // unix epoch ms after which annotation coalescing window closes
}

export interface ConversationTurnRecord {
  id: number;
  message_key: string;
  sender_id: string;
  user_text: string;
  ref_text: string;
  media_summary: string;
  intent: string;
  complexity: "fast" | "deep";
  model_used: string;
  related_article_id: number | null;
  deposited_path: string;
  assistant_reply: string;
  created_at: string;
}

export interface AgentTaskRecord {
  id: number;
  message_key: string;
  sender_id: string;
  raw_payload: string;
  status: "pending" | "processing" | "running" | "done" | "completed" | "failed";
  stage: string;
  started_at: string;
  heartbeat_at: string;
  error: string;
  created_at: string;
  updated_at: string;
}

export type ScheduledTaskKind = "reminder" | "todo" | "digest" | "agent_task";

export type ScheduledTaskStatus =
  | "active"
  | "running"
  | "completed"
  | "paused"
  | "cancelled";

export interface ScheduledActionPayload {
  executor:
    | "reminder_push"
    | "web_search_digest"
    | "vault_digest"
    | "agent_delegate";
  prompt: string;
  searchQueries?: string[];
  includeVaultNow?: boolean;
  includeRecentArticlesHours?: number;
  archiveToVault?: boolean;
  relatedArticleId?: number;
  deliverables?: Array<"markdown" | "docx" | "pptx">;
}

export interface ScheduledTaskRecord {
  revision: number;
  id: number;
  sender_id: string;
  title: string;
  task_kind: ScheduledTaskKind;
  schedule_type: "once" | "cron";
  cron_expr: string;
  timezone: string;
  next_run_at: number | null;
  is_default_time: number;
  action_payload: string; // JSON string of ScheduledActionPayload
  status: ScheduledTaskStatus;
  run_count: number;
  last_run_at: string;
  last_result_summary: string;
  last_error: string;
  related_article_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRunRecord {
  prepared_result: string;
  id: number;
  task_id: number;
  scheduled_for_ms: number;
  started_at: string;
  finished_at: string;
  status: "running" | "succeeded" | "failed" | "skipped_misfire";
  output_summary: string;
  deposited_path: string;
  error: string;
}

export class ContextDatabase {
  public db: Database;

  constructor(private dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.init();
  }

  private init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS kv_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        msgid TEXT UNIQUE,
        url TEXT NOT NULL,
        title TEXT DEFAULT '',
        author TEXT DEFAULT '',
        digest TEXT DEFAULT '',
        user_notes TEXT DEFAULT '',
        sender_id TEXT DEFAULT '',
        open_kfid TEXT DEFAULT '',
        channel TEXT DEFAULT 'cli',
        status TEXT DEFAULT 'pending_extract',
        triage TEXT DEFAULT 'process_later',
        process_level TEXT DEFAULT 'raw',
        source_md_path TEXT DEFAULT '',
        note_md_path TEXT DEFAULT '',
        short_summary TEXT DEFAULT '',
        related_vault_nodes TEXT DEFAULT '[]',
        error_message TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ready_after INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
      CREATE INDEX IF NOT EXISTS idx_articles_sender ON articles(sender_id, created_at);

      CREATE TABLE IF NOT EXISTS inbound_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_key TEXT UNIQUE NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS reply_outbox (
        id TEXT PRIMARY KEY,
        recipient TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        media_type TEXT NOT NULL DEFAULT 'text',
        media_path TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS operation_locks (name TEXT PRIMARY KEY, pid INTEGER NOT NULL, owner TEXT NOT NULL, acquired_at INTEGER NOT NULL DEFAULT 0);

      CREATE TABLE IF NOT EXISTS conversation_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_key TEXT UNIQUE NOT NULL,
        sender_id TEXT NOT NULL,
        user_text TEXT NOT NULL DEFAULT '',
        ref_text TEXT NOT NULL DEFAULT '',
        media_summary TEXT NOT NULL DEFAULT '',
        intent TEXT NOT NULL DEFAULT '',
        complexity TEXT NOT NULL DEFAULT 'fast',
        model_used TEXT NOT NULL DEFAULT '',
        related_article_id INTEGER,
        deposited_path TEXT NOT NULL DEFAULT '',
        assistant_reply TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turns_sender ON conversation_turns(sender_id, id DESC);

      CREATE TABLE IF NOT EXISTS agent_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_key TEXT UNIQUE NOT NULL,
        sender_id TEXT NOT NULL,
        raw_payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        stage TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL DEFAULT '',
        heartbeat_at TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status, id ASC);

      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        task_kind TEXT NOT NULL DEFAULT 'reminder',
        schedule_type TEXT NOT NULL DEFAULT 'once',
        cron_expr TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        next_run_at INTEGER,
        is_default_time INTEGER NOT NULL DEFAULT 0,
        action_payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        run_count INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT NOT NULL DEFAULT '',
        last_result_summary TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        related_article_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
        ON scheduled_tasks(status, next_run_at ASC);

      CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        scheduled_for_ms INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running',
        output_summary TEXT NOT NULL DEFAULT '',
        deposited_path TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        UNIQUE(task_id, scheduled_for_ms)
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task
        ON scheduled_task_runs(task_id, id DESC);
    `);

    try {
      this.db.exec("ALTER TABLE reply_outbox ADD COLUMN media_type TEXT NOT NULL DEFAULT 'text'");
    } catch {}
    try {
      this.db.exec("ALTER TABLE reply_outbox ADD COLUMN media_path TEXT NOT NULL DEFAULT ''");
    } catch {}
    try {
      this.db.exec("ALTER TABLE reply_outbox ADD COLUMN media_sha256 TEXT NOT NULL DEFAULT ''");
    } catch {}
    try {
      this.db.exec("ALTER TABLE reply_outbox ADD COLUMN next_retry_at INTEGER NOT NULL DEFAULT 0");
    } catch {}
    try {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN stage TEXT NOT NULL DEFAULT ''");
    } catch {}
    try {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN started_at TEXT NOT NULL DEFAULT ''");
    } catch {}
    try {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN heartbeat_at TEXT NOT NULL DEFAULT ''");
    } catch {}
    for (const sql of [
      "ALTER TABLE scheduled_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE scheduled_task_runs ADD COLUMN prepared_result TEXT NOT NULL DEFAULT ''",
    ]) { try { this.db.exec(sql); } catch {} }

    try {
      this.db.exec("ALTER TABLE operation_locks ADD COLUMN acquired_at INTEGER NOT NULL DEFAULT 0");
    } catch {}
  }

  public isLockHeld(name: string, ttlMs = 15 * 60 * 1000): boolean {
    const row = this.db
      .query("SELECT pid, acquired_at FROM operation_locks WHERE name = ?")
      .get(name) as { pid: number; acquired_at?: number } | null;
    if (!row) return false;
    if (row.acquired_at && row.acquired_at > 0 && Date.now() - row.acquired_at > ttlMs) {
      return false;
    }
    try {
      process.kill(row.pid, 0);
      return true;
    } catch (e: any) {
      if (e.code === "ESRCH") return false;
      return true;
    }
  }

  public async withLock<T>(
    name: string,
    action: (ownsLock: () => boolean) => Promise<T>,
    options?: { ttlMs?: number; renew?: boolean }
  ): Promise<T> {
    const owner = randomUUID();
    const ttlMs = options?.ttlMs ?? 15 * 60 * 1000;
    const nowMs = Date.now();
    this.db.transaction(() => {
      const row = this.db
        .query("SELECT pid, acquired_at FROM operation_locks WHERE name = ?")
        .get(name) as { pid: number; acquired_at?: number } | null;
      if (row) {
        let alive = true;
        try {
          process.kill(row.pid, 0);
        } catch (e: any) {
          if (e.code === "ESRCH") alive = false;
        }
        const expired =
          Boolean(row.acquired_at && row.acquired_at > 0 && nowMs - row.acquired_at > ttlMs);
        if (alive && !expired) throw new Error(`Operation busy: ${name}`);
      }
      this.db
        .query(
          "INSERT OR REPLACE INTO operation_locks (name, pid, owner, acquired_at) VALUES (?, ?, ?, ?)"
        )
        .run(name, process.pid, owner, nowMs);
    }).immediate();
    let leaseLost = false;
    const ownsLock = () => !leaseLost && Boolean(this.db.query("SELECT owner FROM operation_locks WHERE name = ? AND owner = ? AND acquired_at > ?")
      .get(name, owner, Date.now() - ttlMs));
    const heartbeat = options?.renew ? setInterval(() => {
      try {
        const renewed = this.db.query("UPDATE operation_locks SET acquired_at = ? WHERE name = ? AND owner = ? AND acquired_at > ?")
          .run(Date.now(), name, owner, Date.now() - ttlMs);
        if (!renewed.changes) leaseLost = true;
      } catch {
        // Do not crash the daemon from a timer callback. Fence this owner and
        // let the expired lease be recovered by the next scheduler invocation.
        leaseLost = true;
      }
      if (leaseLost && heartbeat) clearInterval(heartbeat);
    }, Math.max(1, Math.floor(ttlMs / 3))) : undefined;
    heartbeat?.unref();
    try {
      return await action(ownsLock);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.db
        .query("DELETE FROM operation_locks WHERE name = ? AND owner = ?")
        .run(name, owner);
    }
  }

  public pendingMessages(): Array<{ message_key: string; payload: string }> {
    return this.db.query("SELECT message_key, payload FROM inbound_messages WHERE status = 'pending' ORDER BY sequence").all() as any;
  }

  public queueReply(id: string, recipient: string, text: string): void {
    this.db.query("INSERT OR IGNORE INTO reply_outbox (id, recipient, text, media_type, media_path) VALUES (?, ?, ?, 'text', '')").run(id, recipient, text);
  }

  public queueMediaReply(
    id: string,
    recipient: string,
    mediaType: "file" | "image",
    mediaPath: string,
    captionText = ""
  ): void {
    if (this.db.query("SELECT id FROM reply_outbox WHERE id = ?").get(id)) return;
    const content = readFileSync(mediaPath);
    const digest = createHash("sha256").update(content).digest("hex");
    const snapshot = join(dirname(this.dbPath), "outbox_media", digest, basename(mediaPath));
    writeNewFile(snapshot, content);
    if (createHash("sha256").update(readFileSync(snapshot)).digest("hex") !== digest) {
      throw new Error("Outbox media snapshot checksum mismatch");
    }
    this.db
      .query(
        "INSERT OR IGNORE INTO reply_outbox (id, recipient, text, media_type, media_path, media_sha256) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id, recipient, captionText, mediaType, snapshot, digest);
  }

  /**
   * Remove outbox_media snapshot files that have already been sent (`status = 'sent'`),
   * are not referenced by any unsent outbox entry, and are older than `maxAgeMs`.
   */
  public pruneSentOutboxMedia(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const rows = this.db
      .query(
        `SELECT DISTINCT media_path FROM reply_outbox
         WHERE status = 'sent' AND media_path != ''
           AND media_path NOT IN (
             SELECT media_path FROM reply_outbox WHERE status != 'sent' AND media_path != ''
           )`
      )
      .all() as Array<{ media_path: string }>;
    let pruned = 0;
    const now = Date.now();
    for (const { media_path } of rows) {
      try {
        if (!existsSync(media_path)) continue;
        const st = statSync(media_path);
        if (st.isFile() && now - st.mtimeMs >= maxAgeMs) {
          unlinkSync(media_path);
          pruned++;
        }
      } catch {}
    }
    return pruned;
  }

  /**
   * Prune aged terminal state rows (`agent_tasks`, `inbound_messages`, `reply_outbox`)
   * so SQLite tables stay bounded over long-term daemon operation.
   */
  public pruneHistoricalRecords(options?: {
    maxAgeMs?: number;
    nowMs?: number;
    keepRecentInbound?: number;
    keepRecentOutbox?: number;
  }): {
    agentTasksPruned: number;
    inboundPruned: number;
    outboxPruned: number;
  } {
    const nowMs = options?.nowMs ?? Date.now();
    const maxAgeMs = options?.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
    const keepRecentInbound = options?.keepRecentInbound ?? 1000;
    const keepRecentOutbox = options?.keepRecentOutbox ?? 500;
    const cutoffIso = new Date(nowMs - maxAgeMs).toISOString();

    const taskRes = this.db
      .query(
        `DELETE FROM agent_tasks
         WHERE status IN ('done', 'completed', 'failed')
           AND updated_at != ''
           AND updated_at <= ?`
      )
      .run(cutoffIso);

    const inboundRes = this.db
      .query(
        `DELETE FROM inbound_messages
         WHERE status = 'done'
           AND sequence NOT IN (
             SELECT sequence FROM inbound_messages ORDER BY sequence DESC LIMIT ?
           )`
      )
      .run(keepRecentInbound);

    const outboxRes = this.db
      .query(
        `DELETE FROM reply_outbox
         WHERE status = 'sent'
          AND rowid NOT IN (
            SELECT rowid FROM reply_outbox ORDER BY rowid DESC LIMIT ?
          )`
      )
      .run(keepRecentOutbox);

    this.db
      .query(
        `DELETE FROM scheduled_task_runs
         WHERE status IN ('succeeded', 'failed', 'skipped_misfire')
           AND started_at != ''
           AND started_at <= ?`
      )
      .run(cutoffIso);

    return {
      agentTasksPruned: Number(taskRes.changes || 0),
      inboundPruned: Number(inboundRes.changes || 0),
      outboxPruned: Number(outboxRes.changes || 0),
    };
  }

  public hasRunningAgentTask(): boolean {
    const row = this.db
      .query(
        "SELECT 1 FROM agent_tasks WHERE status IN ('processing', 'running') LIMIT 1"
      )
      .get();
    return Boolean(row);
  }

  public countActiveAgentTasksAhead(taskId: number): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) as cnt FROM agent_tasks
         WHERE id < ? AND status IN ('pending', 'processing', 'running')`
      )
      .get(taskId) as { cnt: number } | null;
    return Number(row?.cnt ?? 0);
  }

  public recordConversationTurn(params: {
    messageKey: string;
    senderId: string;
    userText: string;
    refText?: string;
    mediaSummary?: string;
    intent: string;
    complexity: "fast" | "deep";
    modelUsed: string;
    relatedArticleId?: number | null;
    depositedPath?: string;
    assistantReply: string;
  }): void {
    const now = new Date().toISOString();
    const paths = decodeArtifactPaths(params.depositedPath ?? "");
    this.db
      .query(
        `INSERT INTO conversation_turns (
          message_key, sender_id, user_text, ref_text, media_summary,
          intent, complexity, model_used, related_article_id, deposited_path,
          assistant_reply, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_key) DO UPDATE SET
          intent = excluded.intent,
          complexity = excluded.complexity,
          model_used = excluded.model_used,
          related_article_id = excluded.related_article_id,
          deposited_path = excluded.deposited_path,
          assistant_reply = excluded.assistant_reply`
      )
      .run(
        params.messageKey,
        params.senderId,
        params.userText,
        params.refText ?? "",
        params.mediaSummary ?? "",
        params.intent,
        params.complexity,
        params.modelUsed,
        params.relatedArticleId ?? null,
        paths.length ? JSON.stringify(paths) : "",
        params.assistantReply,
        now
      );
  }

  public getRecentConversationTurns(
    senderId: string,
    limit = 6
  ): ConversationTurnRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM conversation_turns
         WHERE sender_id = ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(senderId, limit) as ConversationTurnRecord[];
    return rows.reverse();
  }

  public listConversationTurns(options?: {
    intent?: string;
    limit?: number;
  }): ConversationTurnRecord[] {
    const limit = options?.limit ?? 20;
    if (options?.intent) {
      return this.db
        .query(
          `SELECT * FROM conversation_turns
           WHERE intent = ?
           ORDER BY id DESC LIMIT ?`
        )
        .all(options.intent, limit) as ConversationTurnRecord[];
    }
    return this.db
      .query(
        `SELECT * FROM conversation_turns
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit) as ConversationTurnRecord[];
  }

  public enqueueAgentTask(
    messageKeyOrParams:
      | string
      | {
          messageKey: string;
          senderId: string;
          intent?: string;
          subagentTarget?: string;
          payloadJson: string;
        },
    senderIdArg?: string,
    rawPayloadArg?: string
  ): { id: number } {
    const now = new Date().toISOString();
    const messageKey =
      typeof messageKeyOrParams === "string"
        ? messageKeyOrParams
        : messageKeyOrParams.messageKey;
    const senderId =
      typeof messageKeyOrParams === "string"
        ? senderIdArg || ""
        : messageKeyOrParams.senderId;
    const rawPayload =
      typeof messageKeyOrParams === "string"
        ? rawPayloadArg || ""
        : messageKeyOrParams.payloadJson;

    this.db
      .query(
        `INSERT OR IGNORE INTO agent_tasks (
          message_key, sender_id, raw_payload, status, error, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', '', ?, ?)`
      )
      .run(messageKey, senderId, rawPayload, now, now);

    const row = this.db
      .query("SELECT id FROM agent_tasks WHERE message_key = ?")
      .get(messageKey) as { id: number } | null;
    return { id: row?.id ?? 0 };
  }

  public getPendingAgentTasks(limit = 20): AgentTaskRecord[] {
    return this.db
      .query(
        `SELECT * FROM agent_tasks
         WHERE status = 'pending'
         ORDER BY id ASC LIMIT ?`
      )
      .all(limit) as AgentTaskRecord[];
  }

  public recoverStuckAgentTasks(): number {
    const res = this.db
      .query(
        `UPDATE agent_tasks
         SET status = 'pending', stage = '检测到中断，等待自动恢复重跑', updated_at = ?
         WHERE status IN ('processing', 'running')`
      )
      .run(new Date().toISOString());
    return Number(res.changes || 0);
  }

  public updateAgentTaskStatus(
    id: number,
    status: "pending" | "processing" | "running" | "done" | "completed" | "failed",
    error = "",
    stage?: string
  ): void {
    const now = new Date().toISOString();
    if (status === "processing" || status === "running") {
      this.db
        .query(
          `UPDATE agent_tasks
           SET status = ?,
               error = ?,
               stage = CASE WHEN ? != '' THEN ? ELSE stage END,
               started_at = CASE WHEN started_at = '' THEN ? ELSE started_at END,
               heartbeat_at = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(status, error, stage || "", stage || "", now, now, now, id);
      return;
    }
    this.db
      .query(
        `UPDATE agent_tasks
         SET status = ?,
             error = ?,
             stage = CASE WHEN ? != '' THEN ? ELSE stage END,
             heartbeat_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(status, error, stage || "", stage || "", now, now, id);
  }

  public updateAgentTaskProgressByMessageKey(
    messageKey: string,
    stage: string
  ): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE agent_tasks
         SET stage = ?,
             started_at = CASE WHEN started_at = '' THEN ? ELSE started_at END,
             heartbeat_at = ?,
             updated_at = ?
         WHERE message_key = ?`
      )
      .run(stage, now, now, now, messageKey);
  }

  public getActiveAgentTasks(senderId?: string): AgentTaskRecord[] {
    if (senderId) {
      return this.db
        .query(
          `SELECT * FROM agent_tasks
           WHERE sender_id = ? AND status IN ('processing', 'running', 'pending')
           ORDER BY id ASC`
        )
        .all(senderId) as AgentTaskRecord[];
    }
    return this.db
      .query(
        `SELECT * FROM agent_tasks
         WHERE status IN ('processing', 'running', 'pending')
         ORDER BY id ASC`
      )
      .all() as AgentTaskRecord[];
  }

  public getRecentAgentTasks(senderId?: string, limit = 5): AgentTaskRecord[] {
    if (senderId) {
      return this.db
        .query(
          `SELECT * FROM agent_tasks
           WHERE sender_id = ?
           ORDER BY id DESC LIMIT ?`
        )
        .all(senderId, limit) as AgentTaskRecord[];
    }
    return this.db
      .query(
        `SELECT * FROM agent_tasks
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit) as AgentTaskRecord[];
  }

  public findArticleByQuery(
    query: string,
    senderId?: string
  ): ArticleRecord | null {
    const q = query.trim();
    if (!q) return null;

    // 1. Check explicit #ID (e.g., "#12" or "文章 #12" or "ID: 12")
    const idMatch = q.match(/(?:#|文章\s*#?|ID[:：\s]*)(\d+)\b/i) || q.match(/^(\d+)$/);
    if (idMatch?.[1]) {
      const byId = this.getArticleById(Number(idMatch[1]));
      if (byId) return byId;
    }

    // 2. Check URL match
    const urlMatch = q.match(/https?:\/\/[^\s"'<>\\]+/i);
    if (urlMatch?.[0]) {
      const byUrl = this.findByUrlOrMsgid(urlMatch[0]);
      if (byUrl) return byUrl;
    }

    // 3. Check title / summary substring match
    const cleanQ = q.replace(/[《》"'“”]/g, "").trim();
    if (cleanQ.length >= 2) {
      const pattern = `%${cleanQ.slice(0, 32)}%`;
      const row = this.db
        .query(
          `SELECT * FROM articles
           WHERE title LIKE ? OR short_summary LIKE ? OR user_notes LIKE ?
           ORDER BY id DESC LIMIT 1`
        )
        .get(pattern, pattern, pattern) as ArticleRecord | null;
      if (row) return row;
    }

    if (senderId) {
      return this.db
        .query("SELECT * FROM articles WHERE sender_id = ? ORDER BY id DESC LIMIT 1")
        .get(senderId) as ArticleRecord | null;
    }
    return null;
  }

  public deliveryStatus() {
    return this.db.query("SELECT status, COUNT(*) AS count FROM reply_outbox GROUP BY status").all();
  }

  public getState(key: string): string | null {
    const row = this.db
      .query("SELECT value FROM kv_state WHERE key = ?")
      .get(key) as { value: string } | null;
    return row ? row.value : null;
  }

  public setState(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO kv_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, now);
  }

  public findByUrlOrMsgid(url: string, msgid?: string): ArticleRecord | null {
    if (msgid) {
      const byMsg = this.db
        .query("SELECT * FROM articles WHERE msgid = ?")
        .get(msgid) as ArticleRecord | null;
      if (byMsg) return byMsg;
    }
    const byUrl = this.db
      .query("SELECT * FROM articles WHERE url = ? ORDER BY id DESC LIMIT 1")
      .get(url) as ArticleRecord | null;
    return byUrl;
  }

  public enqueueArticle(params: {
    msgid: string;
    url: string;
    title?: string;
    author?: string;
    digest?: string;
    user_notes?: string;
    sender_id?: string;
    open_kfid?: string;
    channel?: string;
    waitSeconds?: number;
  }): { record: ArticleRecord; isNew: boolean } {
    const existing = this.findByUrlOrMsgid(params.url, params.msgid);
    const nowIso = new Date().toISOString();
    const readyAfter = Date.now() + (params.waitSeconds ?? 0) * 1000;

    if (existing) {
      // If user re-sent or added a note to an existing article, append note
      const combinedNotes = params.user_notes
        ? existing.user_notes
          ? `${existing.user_notes}\n${params.user_notes}`
          : params.user_notes
        : existing.user_notes;
      this.db
        .query(
          `UPDATE articles
           SET user_notes = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(combinedNotes, nowIso, existing.id);
      return {
        record: this.getArticleById(existing.id)!,
        isNew: false,
      };
    }

    const res = this.db
      .query(
        `INSERT INTO articles (
          msgid, url, title, author, digest, user_notes,
          sender_id, open_kfid, channel, status, triage, process_level,
          created_at, updated_at, ready_after
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_extract', 'process_later', 'raw', ?, ?, ?)`
      )
      .run(
        params.msgid,
        params.url,
        params.title ?? "",
        params.author ?? "",
        params.digest ?? "",
        params.user_notes ?? "",
        params.sender_id ?? "",
        params.open_kfid ?? "",
        params.channel ?? "cli",
        nowIso,
        nowIso,
        readyAfter
      );

    return {
      record: this.getArticleById(Number(res.lastInsertRowid))!,
      isNew: true,
    };
  }

  /**
   * Attach a follow-up text message from the same user to their most recent article
   * if sent within a reasonable window (e.g., 10 minutes), and extend/trigger processing.
   */
  public attachUserNoteToRecentArticle(
    senderId: string,
    noteText: string,
    maxAgeMinutes = 10
  ): ArticleRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM articles
         WHERE sender_id = ?
         ORDER BY id DESC LIMIT 1`
      )
      .get(senderId) as ArticleRecord | null;

    if (!row) return null;
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs > maxAgeMinutes * 60 * 1000) return null;

    const updatedNotes = row.user_notes
      ? `${row.user_notes}\n${noteText}`
      : noteText;
    const nowIso = new Date().toISOString();

    // If it was still waiting in pending_extract, mark ready immediately since user just sent their note!
    const newReadyAfter =
      row.status === "pending_extract" ? Date.now() : row.ready_after;

    this.db
      .query(
        `UPDATE articles
         SET user_notes = ?, updated_at = ?, ready_after = ?
         WHERE id = ?`
      )
      .run(updatedNotes, nowIso, newReadyAfter, row.id);

    return this.getArticleById(row.id);
  }

  public getReadyPendingArticles(): ArticleRecord[] {
    const now = Date.now();
    const candidates = this.db
      .query(
        `SELECT * FROM articles
         WHERE status IN ('pending_extract', 'extracting', 'analyzing') AND ready_after <= ?
         ORDER BY id ASC`
      )
      .all(now) as ArticleRecord[];
    return candidates.filter((item) => !this.isLockHeld(`article_${item.id}`));
  }

  public getArticleById(id: number): ArticleRecord | null {
    return this.db
      .query("SELECT * FROM articles WHERE id = ?")
      .get(id) as ArticleRecord | null;
  }

  public listArticles(options?: {
    status?: string;
    triage?: string;
    limit?: number;
  }): ArticleRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options?.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options?.triage) {
      clauses.push("triage = ?");
      params.push(options.triage);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = options?.limit ?? 50;
    params.push(limit);

    return this.db
      .query(
        `SELECT * FROM articles ${whereSql} ORDER BY id DESC LIMIT ?`
      )
      .all(...params) as ArticleRecord[];
  }

  public updateArticle(
    id: number,
    fields: Partial<
      Pick<
        ArticleRecord,
        | "title"
        | "author"
        | "digest"
        | "user_notes"
        | "status"
        | "triage"
        | "process_level"
        | "source_md_path"
        | "note_md_path"
        | "short_summary"
        | "related_vault_nodes"
        | "error_message"
      >
    >
  ): ArticleRecord | null {
    const sets: string[] = ["updated_at = ?"];
    const values: (string | number)[] = [new Date().toISOString()];

    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) {
        sets.push(`${k} = ?`);
        values.push(v);
      }
    }
    values.push(id);

    this.db
      .query(`UPDATE articles SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);

    return this.getArticleById(id);
  }

  // ---------------------------------------------------------------------------
  // Scheduled Tasks & Reminders
  // ---------------------------------------------------------------------------

  public createScheduledTask(params: {
    senderId?: string;
    title: string;
    taskKind?: ScheduledTaskKind;
    scheduleType?: "once" | "cron";
    cronExpr?: string;
    timezone?: string;
    nextRunAt?: number | null;
    isDefaultTime?: boolean | number;
    actionPayload?: ScheduledActionPayload | string;
    status?: ScheduledTaskStatus;
    relatedArticleId?: number | null;
    createdAt?: string;
  }): ScheduledTaskRecord {
    const nowIso = params.createdAt ?? new Date().toISOString();
    const payloadStr =
      typeof params.actionPayload === "string"
        ? params.actionPayload
        : JSON.stringify(
            params.actionPayload ?? {
              executor: "reminder_push",
              prompt: params.title,
            }
          );
    const isDefaultTimeInt = params.isDefaultTime ? 1 : 0;

    const res = this.db
      .query(
        `INSERT INTO scheduled_tasks (
          sender_id, title, task_kind, schedule_type, cron_expr, timezone,
          next_run_at, is_default_time, action_payload, status,
          related_article_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.senderId ?? "",
        params.title.trim() || "未命名提醒",
        params.taskKind ?? "reminder",
        params.scheduleType ?? "once",
        params.cronExpr ?? "",
        params.timezone ?? "Asia/Shanghai",
        params.nextRunAt === undefined ? null : params.nextRunAt,
        isDefaultTimeInt,
        payloadStr,
        params.status ?? "active",
        params.relatedArticleId ?? null,
        nowIso,
        nowIso
      );

    return this.getScheduledTaskById(Number(res.lastInsertRowid))!;
  }

  public getScheduledTaskById(id: number): ScheduledTaskRecord | null {
    return this.db
      .query("SELECT * FROM scheduled_tasks WHERE id = ?")
      .get(id) as ScheduledTaskRecord | null;
  }

  public listScheduledTasks(options?: {
    status?: ScheduledTaskStatus | ScheduledTaskStatus[];
    senderId?: string;
    taskKind?: ScheduledTaskKind | ScheduledTaskKind[];
    scheduleType?: "once" | "cron";
    limit?: number;
  }): ScheduledTaskRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (options?.status) {
      if (Array.isArray(options.status)) {
        if (options.status.length > 0) {
          clauses.push(
            `status IN (${options.status.map(() => "?").join(", ")})`
          );
          params.push(...options.status);
        }
      } else {
        clauses.push("status = ?");
        params.push(options.status);
      }
    }

    if (options?.senderId) {
      clauses.push("(sender_id = ? OR sender_id = '')");
      params.push(options.senderId);
    }

    if (options?.taskKind) {
      if (Array.isArray(options.taskKind)) {
        if (options.taskKind.length > 0) {
          clauses.push(
            `task_kind IN (${options.taskKind.map(() => "?").join(", ")})`
          );
          params.push(...options.taskKind);
        }
      } else {
        clauses.push("task_kind = ?");
        params.push(options.taskKind);
      }
    }

    if (options?.scheduleType) {
      clauses.push("schedule_type = ?");
      params.push(options.scheduleType);
    }

    const whereSql =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = options?.limit ?? 100;
    params.push(limit);

    return this.db
      .query(
        `SELECT * FROM scheduled_tasks ${whereSql}
         ORDER BY
           CASE WHEN status = 'active' THEN 0 WHEN status = 'running' THEN 1 WHEN status = 'paused' THEN 2 ELSE 3 END ASC,
           CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END ASC,
           next_run_at ASC,
           id DESC
         LIMIT ?`
      )
      .all(...params) as ScheduledTaskRecord[];
  }

  public getDueScheduledTasks(
    nowMs = Date.now(),
    limit = 20
  ): ScheduledTaskRecord[] {
    return this.db
      .query(
        `SELECT * FROM scheduled_tasks
         WHERE status = 'active'
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?
         ORDER BY next_run_at ASC, id ASC
         LIMIT ?`
      )
      .all(nowMs, limit) as ScheduledTaskRecord[];
  }

  public updateScheduledTask(
    id: number,
    fields: Partial<
      Pick<
        ScheduledTaskRecord,
        | "title"
        | "task_kind"
        | "schedule_type"
        | "cron_expr"
        | "timezone"
        | "next_run_at"
        | "is_default_time"
        | "action_payload"
        | "status"
        | "run_count"
        | "last_run_at"
        | "last_result_summary"
        | "last_error"
        | "related_article_id"
      >
    >,
    expectedRevision?: number
  ): ScheduledTaskRecord | null {
    const sets: string[] = ["updated_at = ?", "revision = revision + 1"];
    const values: (string | number | null)[] = [new Date().toISOString()];

    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) {
        sets.push(`${k} = ?`);
        values.push(v);
      }
    }
    values.push(id);

    if (expectedRevision !== undefined) values.push(expectedRevision);
    const result = this.db
      .query(`UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id = ?${expectedRevision === undefined ? "" : " AND revision = ?"}`)
      .run(...values);
    if (!result.changes) return null;

    return this.getScheduledTaskById(id);
  }

  public findScheduledTaskByQuery(
    query: string,
    options?: {
      senderId?: string;
      activeOnly?: boolean;
    }
  ): ScheduledTaskRecord | null {
    const trimmed = String(query || "").trim();
    const statuses: ScheduledTaskStatus[] =
      options?.activeOnly === false
        ? ["active", "running", "paused", "completed", "cancelled"]
        : ["active", "running", "paused"];

    const candidates = this.listScheduledTasks({
      status: statuses,
      senderId: options?.senderId,
      limit: 100,
    });

    if (candidates.length === 0) return null;

    // Match complete stored titles before interpreting command words or numeric IDs.
    const targetText = trimmed.replace(
      /^(?:把|将|已完成|完成|做完了|取消|删除|关掉|停用|暂停|恢复|修改|调整|推迟|改期|立即执行|执行|运行)\s*/, ""
    ).trim().toLowerCase();
    const exactFull = candidates.filter(c => c.title.toLowerCase() === targetText ||
      c.title.toLowerCase() === trimmed.toLowerCase());
    if (exactFull.length) return exactFull.length === 1 ? exactFull[0] : null;

    const allowsReschedule = !/^(?:已完成|完成|做完了|取消|删除|关掉|停用|暂停|恢复|立即执行|执行|运行)/.test(trimmed);
    const named = candidates.filter(c => {
      const title = c.title.toLowerCase();
      return [title, `「${title}」`, `“${title}”`, `"${title}"`].some(name => {
        if (!targetText.startsWith(name)) return false;
        const suffix = targetText.slice(name.length).trim();
        return !suffix || /^(?:的(?:待办|提醒|定时任务|任务))$/.test(suffix) ||
          allowsReschedule && suffix.match(/改到|推迟到|推迟|延后|提前到|调整到|改为|设为/g)?.length === 1 &&
          /^(?:改到|推迟到|推迟|延后|提前到|调整到|改为|设为)\s*(?:今天|明天|明早|明晚|明日|后天|大后天|今晚|今早|今晨|本|这|下|周|星期|礼拜|每天|每周|每月|每隔|\d|[一二三四五六七八九十半两]|早上|上午|中午|下午|晚上|凌晨)/.test(suffix);
      });
    }).sort((a, b) => b.title.length - a.title.length);
    if (named.length) {
      const longest = named.filter(c => c.title.length === named[0].title.length);
      return longest.length === 1 ? longest[0] : null;
    }

    const idMatch = targetText.match(/^(?:(?:任务|提醒|待办|日程)\s*#?|#)?(\d+)(?:\s|$|改到|推迟到|延后|提前到|调整到|改为|设为)/i);
    if (idMatch?.[1]) {
      const byId = this.getScheduledTaskById(Number.parseInt(idMatch[1], 10));
      return byId && (!options?.senderId || !byId.sender_id || byId.sender_id === options.senderId) &&
        (options?.activeOnly === false || ["active", "running", "paused"].includes(byId.status)) ? byId : null;
    }

    // A fuzzy title can select only one candidate; never truncate a title at an
    // embedded rescheduling word. Ambiguous phrasing needs an explicit #ID.
    const keyword = targetText.replace(/^[「“"]([\s\S]*)[」”"]$/, "$1").replace(/的(?:待办|提醒|定时任务|任务)$/, "");
    const matches = keyword ? candidates.filter(c => c.title.toLowerCase().includes(keyword)) : [];
    if (matches.length === 1) return matches[0];

    // Only an explicit contextual reference may select the latest task. A missing or
    // ambiguous name/ID must never authorize a mutation of an unrelated task.
    if (/^(?:把|将)?(?:刚才|上一个|最近一个)(?:的|那个)?(?:待办|提醒|定时任务|任务)?(?:推迟|改到|取消|暂停|完成|执行|运行|$)/.test(trimmed) ||
        /^(?:取消|暂停|完成|执行|运行)(?:刚才|上一个|最近一个)(?:的|那个)?(?:待办|提醒|定时任务|任务)?$/.test(trimmed)) {
      return [...candidates].sort((a, b) => b.id - a.id)[0] ?? null;
    }
    return null;
  }

  public recordScheduledTaskRun(params: {
    taskId: number;
    scheduledForMs: number;
    startedAt?: string;
    finishedAt?: string;
    status?: "running" | "succeeded" | "failed" | "skipped_misfire";
    outputSummary?: string;
    depositedPath?: string;
    error?: string;
  }): ScheduledTaskRunRecord | null {
    const startedAt = params.startedAt ?? new Date().toISOString();
    this.db
      .query(
        `INSERT OR IGNORE INTO scheduled_task_runs (
          task_id, scheduled_for_ms, started_at, finished_at,
          status, output_summary, deposited_path, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.taskId,
        params.scheduledForMs,
        startedAt,
        params.finishedAt ?? "",
        params.status ?? "running",
        params.outputSummary ?? "",
        params.depositedPath ?? "",
        params.error ?? ""
      );

    return this.db
      .query(
        `SELECT * FROM scheduled_task_runs
         WHERE task_id = ? AND scheduled_for_ms = ?`
      )
      .get(params.taskId, params.scheduledForMs) as ScheduledTaskRunRecord | null;
  }

  public updateScheduledTaskRun(
    id: number,
    fields: Partial<
      Pick<
        ScheduledTaskRunRecord,
        "finished_at" | "status" | "output_summary" | "deposited_path" | "error" | "prepared_result"
      >
    >
  ): void {
    const sets: string[] = [];
    const values: (string | number)[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) {
        sets.push(`${k} = ?`);
        values.push(v);
      }
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db
      .query(`UPDATE scheduled_task_runs SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  public getScheduledTaskRuns(
    taskId: number,
    limit = 20
  ): ScheduledTaskRunRecord[] {
    return this.db
      .query(
        `SELECT * FROM scheduled_task_runs
         WHERE task_id = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(taskId, limit) as ScheduledTaskRunRecord[];
  }
}
