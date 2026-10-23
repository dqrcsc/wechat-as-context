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
      CREATE TABLE IF NOT EXISTS operation_locks (name TEXT PRIMARY KEY, pid INTEGER NOT NULL, owner TEXT NOT NULL);

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
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN stage TEXT NOT NULL DEFAULT ''");
    } catch {}
    try {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN started_at TEXT NOT NULL DEFAULT ''");
    } catch {}
    try {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN heartbeat_at TEXT NOT NULL DEFAULT ''");
    } catch {}
  }

  public async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    const owner = randomUUID();
    this.db.transaction(() => {
      const row = this.db.query("SELECT pid FROM operation_locks WHERE name = ?").get(name) as { pid: number } | null;
      if (row) {
        let alive = true;
        try { process.kill(row.pid, 0); } catch (e: any) { if (e.code === "ESRCH") alive = false; }
        if (alive) throw new Error(`Operation busy: ${name}`);
      }
      this.db.query("INSERT OR REPLACE INTO operation_locks (name, pid, owner) VALUES (?, ?, ?)").run(name, process.pid, owner);
    }).immediate();
    try { return await action(); } finally {
      this.db.query("DELETE FROM operation_locks WHERE name = ? AND owner = ?").run(name, owner);
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
   * are not referenced by any pending outbox entry, and are older than `maxAgeMs`.
   */
  public pruneSentOutboxMedia(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const rows = this.db
      .query(
        `SELECT DISTINCT media_path FROM reply_outbox
         WHERE status = 'sent' AND media_path != ''
           AND media_path NOT IN (
             SELECT media_path FROM reply_outbox WHERE status = 'pending' AND media_path != ''
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
    return this.db
      .query(
        `SELECT * FROM articles
         WHERE status IN ('pending_extract', 'extracting', 'analyzing') AND ready_after <= ?
         ORDER BY id ASC`
      )
      .all(now) as ArticleRecord[];
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
}
