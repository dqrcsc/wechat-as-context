import { randomBytes, randomUUID } from "node:crypto";
import { ContextDatabase } from "../db.ts";
import { extractUrlsFromMixedText } from "../extractor/sanitizer.ts";
import { CDN_BASE_URL, CdnMediaRef, prepareMediaForUpload } from "./media.ts";

const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "2.4.10";
// 2.4.10 -> (2 << 16) | (4 << 8) | 10 = 132106
const ILINK_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 10);

export interface ClawBotCredentials {
  botToken: string;
  baseUrl: string;
  botId: string;
  userId: string;
  savedAt: string;
}

export interface ClawBotMessageItem {
  type?: number; // 1=TEXT, 2=IMAGE, 3=VOICE, 4=FILE, 5=VIDEO, 11=TOOL_CALL_START, 12=TOOL_CALL_RESULT
  msg_id?: string;
  text_item?: { text?: string };
  image_item?: {
    media?: CdnMediaRef;
    thumb_media?: CdnMediaRef;
    aeskey?: string;
    url?: string;
    mid_size?: number;
  };
  voice_item?: {
    media?: CdnMediaRef;
    encode_type?: number;
    playtime?: number;
    text?: string;
  };
  file_item?: {
    media?: CdnMediaRef;
    file_name?: string;
    md5?: string;
    len?: string;
  };
  video_item?: {
    media?: CdnMediaRef;
    video_size?: number;
    play_length?: number;
    video_md5?: string;
  };
  ref_msg?: {
    title?: string;
    svr_id?: string;
    message_item?: ClawBotMessageItem;
    partial_text?: {
      start?: string;
      end?: string;
      startindex?: number;
      endindex?: number;
      quotemd5?: string;
    };
  };
}

export interface UnpackedClawBotMessage {
  userText: string;
  voiceTranscriptions: string[];
  refContext?: {
    title?: string;
    quotedText?: string;
    partialText?: string;
    svrId?: string;
    embeddedUrl?: string;
  };
  urls: string[];
  mediaItems: Array<{
    kind: "image" | "file" | "voice" | "video";
    media: CdnMediaRef;
    hexAesKeyFallback?: string;
    fileName?: string;
    fileLen?: number;
  }>;
}

export interface ClawBotMessage {
  seq?: number;
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  message_type?: number; // 1=USER, 2=BOT
  item_list?: ClawBotMessageItem[];
  context_token?: string;
}

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": ILINK_CLIENT_VERSION,
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

function buildBaseInfo() {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: "OpenClaw",
  };
}

export class WeChatClawBotClient {
  private db: ContextDatabase;

  constructor(db: ContextDatabase) {
    this.db = db;
  }

  public getCredentials(): ClawBotCredentials | null {
    const raw = this.db.getState("clawbot_credentials");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ClawBotCredentials;
      return parsed.botToken ? parsed : null;
    } catch {
      return null;
    }
  }

  public saveCredentials(creds: ClawBotCredentials): void {
    this.db.setState("clawbot_credentials", JSON.stringify(creds));
  }

  public isConfigured(): boolean {
    return this.getCredentials() !== null;
  }

  public getContextToken(userId: string): string | undefined {
    return this.db.getState(`clawbot_ctx_${userId}`) ?? undefined;
  }

  public setContextToken(userId: string, contextToken: string): void {
    if (!userId || !contextToken) return;
    this.db.setState(`clawbot_ctx_${userId}`, contextToken);
  }

  public clearContextToken(userId: string): void {
    if (!userId) return;
    this.db.db.query("DELETE FROM kv_state WHERE key = ?").run(`clawbot_ctx_${userId}`);
  }

  /**
   * Resolve the target WeChat user ID (`...@im.wechat`) for proactive outbound pushes.
   * Priority: explicit `--to` -> bound `creds.userId` -> latest `conversation_turns.sender_id`
   * -> latest `articles.sender_id` -> latest `clawbot_ctx_*` state key.
   */
  public resolveDefaultRecipient(explicitTo?: string): string | null {
    if (explicitTo?.trim()) {
      return explicitTo.trim();
    }
    const creds = this.getCredentials();
    if (creds?.userId?.trim()) {
      return creds.userId.trim();
    }
    const turnRow = this.db.db
      .query(
        "SELECT sender_id FROM conversation_turns WHERE sender_id != '' ORDER BY id DESC LIMIT 1"
      )
      .get() as { sender_id?: string } | null;
    if (turnRow?.sender_id?.trim()) {
      return turnRow.sender_id.trim();
    }
    const articleRow = this.db.db
      .query(
        "SELECT sender_id FROM articles WHERE sender_id != '' ORDER BY id DESC LIMIT 1"
      )
      .get() as { sender_id?: string } | null;
    if (articleRow?.sender_id?.trim()) {
      return articleRow.sender_id.trim();
    }
    const ctxRow = this.db.db
      .query(
        "SELECT key FROM kv_state WHERE key LIKE 'clawbot_ctx_%' ORDER BY updated_at DESC LIMIT 1"
      )
      .get() as { key?: string } | null;
    if (ctxRow?.key?.startsWith("clawbot_ctx_")) {
      const extracted = ctxRow.key.slice("clawbot_ctx_".length).trim();
      if (extracted) return extracted;
    }
    return null;
  }

  /**
   * Step 1 of QR Login: Request a new QR code from Tencent iLink AI gateway.
   */
  public async fetchLoginQrCode(): Promise<{
    qrcode: string;
    qrcodeUrl: string;
  }> {
    const existing = this.getCredentials();
    const localTokenList = existing?.botToken ? [existing.botToken] : [];

    const resp = await fetch(
      `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
      {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({ local_token_list: localTokenList }),
      }
    );
    if (!resp.ok) {
      throw new Error(`fetchLoginQrCode HTTP ${resp.status}: ${await resp.text()}`);
    }
    const data = (await resp.json()) as {
      qrcode: string;
      qrcode_img_content: string;
    };
    return {
      qrcode: data.qrcode,
      qrcodeUrl: data.qrcode_img_content,
    };
  }

  /**
   * Step 2 of QR Login: Poll until the user scans and confirms on their phone WeChat.
   */
  public async waitForQrConfirmation(
    qrcode: string,
    timeoutMs = 180_000
  ): Promise<ClawBotCredentials> {
    const start = Date.now();
    let currentBaseUrl = FIXED_BASE_URL;
    let printedScanned = false;
    let pendingVerifyCode: string | undefined;

    while (Date.now() - start < timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35_000);
      try {
        const base = currentBaseUrl.endsWith("/")
          ? currentBaseUrl
          : `${currentBaseUrl}/`;
        let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
        if (pendingVerifyCode) {
          endpoint += `&verify_code=${encodeURIComponent(pendingVerifyCode)}`;
        }
        const url = new URL(endpoint, base);
        const resp = await fetch(url.toString(), {
          method: "GET",
          headers: {
            "iLink-App-Id": "bot",
            "iLink-App-ClientVersion": ILINK_CLIENT_VERSION,
          },
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!resp.ok) {
          await Bun.sleep(1500);
          continue;
        }

        const status = (await resp.json()) as {
          status: string;
          bot_token?: string;
          ilink_bot_id?: string;
          baseurl?: string;
          ilink_user_id?: string;
          redirect_host?: string;
        };

        if (status.status === "scaned") {
          pendingVerifyCode = undefined;
          if (!printedScanned) {
            printedScanned = true;
            console.log("📱 已扫码！请在手机微信上点击「确认连接」...");
          }
        } else if (status.status === "need_verifycode") {
          const promptMsg = pendingVerifyCode
            ? "❌ 验证码不匹配，请重新输入手机微信上显示的数字："
            : "🔢 请输入手机微信上显示的验证数字并回车：";
          pendingVerifyCode = await readStdinLine(promptMsg);
          continue;
        } else if (
          status.status === "scaned_but_redirect" &&
          status.redirect_host
        ) {
          currentBaseUrl = status.redirect_host.startsWith("http")
            ? status.redirect_host
            : `https://${status.redirect_host}`;
        } else if (status.status === "confirmed" && status.bot_token) {
          const creds: ClawBotCredentials = {
            botToken: status.bot_token,
            baseUrl: status.baseurl || currentBaseUrl || FIXED_BASE_URL,
            botId: status.ilink_bot_id || "clawbot",
            userId: status.ilink_user_id || "",
            savedAt: new Date().toISOString(),
          };
          this.saveCredentials(creds);
          return creds;
        } else if (status.status === "binded_redirect") {
          const existing = this.getCredentials();
          if (existing) return existing;
          throw new Error(
            "该微信 ClawBot 已绑定到当前实例，但本地未找到旧 token，请重试。"
          );
        } else if (status.status === "expired") {
          throw new Error("二维码已过期，请重新运行 login。");
        }
      } catch (err: any) {
        clearTimeout(timer);
        if (err?.name !== "AbortError") {
          if (String(err?.message).includes("二维码已过期")) throw err;
        }
      }
      await Bun.sleep(1000);
    }

    throw new Error("扫码等待超时（3分钟）。");
  }

  /**
   * Long-poll for new messages sent to 微信ClawBot [AI].
   */
  public async getUpdates(timeoutMs = 35_000): Promise<ClawBotMessage[]> {
    const creds = this.getCredentials();
    if (!creds) return [];

    const syncBuf = this.db.getState("clawbot_updates_buf") ?? "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const base = creds.baseUrl.endsWith("/")
        ? creds.baseUrl
        : `${creds.baseUrl}/`;
      const url = new URL("ilink/bot/getupdates", base);
      const resp = await fetch(url.toString(), {
        method: "POST",
        headers: buildHeaders(creds.botToken),
        body: JSON.stringify({
          get_updates_buf: syncBuf,
          base_info: buildBaseInfo(),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) throw new Error(`getupdates HTTP ${resp.status}`);
      const rawText = await resp.text();
      // Quote uint64 message_id / msg_id / svr_id losslessly
      const safeJson = rawText.replace(
        /"(message_id|msg_id|svr_id)"\s*:\s*(-?\d+)/g,
        '"$1":"$2"'
      );
      const data = JSON.parse(safeJson) as {
        ret?: number;
        errcode?: number;
        errmsg?: string;
        msgs?: ClawBotMessage[];
        get_updates_buf?: string;
      };

      assertApiSuccess(data, "getupdates");
      const msgs = data.msgs ?? [];
      if (!Array.isArray(msgs)) throw new Error("Invalid getupdates messages");
      // The cursor may advance only in the same transaction as the entire durable batch.
      this.db.db.transaction(() => {
        for (const m of msgs) {
          if (!m.message_id) throw new Error("Incoming message has no stable message_id; cursor retained");
          const key = `${creds.botId}:${m.message_id}`;
          this.db.db.query("INSERT OR IGNORE INTO inbound_messages (message_key, payload) VALUES (?, ?)").run(key, JSON.stringify(m));
          if (m.from_user_id && m.context_token) this.setContextToken(m.from_user_id, m.context_token);
        }
        if (data.get_updates_buf && data.get_updates_buf !== syncBuf) {
          this.db.setState("clawbot_updates_buf", data.get_updates_buf);
        }
      })();
      return msgs;
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === "AbortError") {
        return [];
      }
      throw err;
    }
  }

  /**
   * Send a text reply directly back to the user in the pinned 微信ClawBot [AI] chat window.
   * Automatically splits oversized messages (> 2500 chars) at natural paragraph/line boundaries.
   */
  public async sendTextMessage(toUserId: string, text: string, clientId = `wxctx-${randomUUID()}`): Promise<void> {
    const creds = this.getCredentials();
    if (!creds || !toUserId) throw new Error("Missing ClawBot credentials or recipient");

    let contextToken = this.getContextToken(toUserId);
    const base = creds.baseUrl.endsWith("/")
      ? creds.baseUrl
      : `${creds.baseUrl}/`;
    const url = new URL("ilink/bot/sendmessage", base);
    const chunks = splitWeChatTextChunks(text, 2500);
    const progressKey = chunks.length > 1 ? `outbox_chunk_progress_${clientId}` : "";
    const startIndex = progressKey
      ? Math.max(0, Number.parseInt(this.db.getState(progressKey) || "0", 10) || 0)
      : 0;

    for (let i = startIndex; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const chunkClientId = i === 0 ? clientId : `${clientId}_part_${i + 1}`;
      const sendChunk = async (token?: string) => {
        const payload = {
          msg: {
            from_user_id: "",
            to_user_id: toUserId,
            client_id: chunkClientId,
            message_type: 2, // BOT
            message_state: 2, // FINISH
            item_list: [
              {
                type: 1, // TEXT
                text_item: { text: chunkText },
              },
            ],
            ...(token ? { context_token: token } : {}),
          },
          base_info: buildBaseInfo(),
        };

        const resp = await fetch(url.toString(), {
          method: "POST",
          headers: buildHeaders(creds.botToken),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        });

        if (!resp.ok) throw new Error(`sendmessage HTTP ${resp.status}`);
        return resp.json();
      };

      let data = await sendChunk(contextToken);
      if (
        contextToken &&
        data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        Number((data as any).ret) === -2
      ) {
        this.clearContextToken(toUserId);
        contextToken = undefined;
        data = await sendChunk(undefined);
      }
      assertApiSuccess(data, "sendmessage");
      if (progressKey) {
        this.db.setState(progressKey, String(i + 1));
      }
    }

    if (progressKey) {
      this.db.db.query("DELETE FROM kv_state WHERE key = ?").run(progressKey);
    }
  }

  /**
   * Fetch (or return 24h-cached) typing_ticket for a WeChat user via /ilink/bot/getconfig.
   */
  public async getTypingTicket(userId: string): Promise<string | null> {
    const creds = this.getCredentials();
    if (!creds || !userId || creds.baseUrl.includes("example.invalid")) return null;

    const cacheKey = `clawbot_typing_ticket_${userId}`;
    const cachedRaw = this.db.getState(cacheKey);
    if (cachedRaw) {
      try {
        const parsed = JSON.parse(cachedRaw) as { ticket: string; expiresAt: number };
        if (parsed.ticket && parsed.expiresAt > Date.now()) {
          return parsed.ticket;
        }
      } catch {}
    }

    const contextToken = this.getContextToken(userId);
    const base = creds.baseUrl.endsWith("/") ? creds.baseUrl : `${creds.baseUrl}/`;
    const url = new URL("ilink/bot/getconfig", base);
    try {
      const resp = await fetch(url.toString(), {
        method: "POST",
        headers: buildHeaders(creds.botToken),
        body: JSON.stringify({
          ilink_user_id: userId,
          ...(contextToken ? { context_token: contextToken } : {}),
          base_info: buildBaseInfo(),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { ret?: number; typing_ticket?: string };
      if (data.ret === 0 && data.typing_ticket) {
        this.db.setState(
          cacheKey,
          JSON.stringify({
            ticket: data.typing_ticket,
            expiresAt: Date.now() + 20 * 3600 * 1000,
          })
        );
        return data.typing_ticket;
      }
    } catch {}
    return null;
  }

  /**
   * Send "对方正在输入..." indicator (status: 1 = TYPING, 2 = CANCEL) via /ilink/bot/sendtyping.
   */
  public async sendTyping(userId: string, status: 1 | 2 = 1): Promise<boolean> {
    const creds = this.getCredentials();
    if (!creds || !userId || creds.baseUrl.includes("example.invalid")) return false;
    const ticket = await this.getTypingTicket(userId);
    if (!ticket) return false;

    const base = creds.baseUrl.endsWith("/") ? creds.baseUrl : `${creds.baseUrl}/`;
    const url = new URL("ilink/bot/sendtyping", base);
    try {
      const resp = await fetch(url.toString(), {
        method: "POST",
        headers: buildHeaders(creds.botToken),
        body: JSON.stringify({
          ilink_user_id: userId,
          typing_ticket: ticket,
          status,
          base_info: buildBaseInfo(),
        }),
        signal: AbortSignal.timeout(8_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Wrap an async operation with "对方正在输入..." status indicator and automatic 5s keepalive heartbeat.
   */
  public async withTypingIndicator<T>(
    userId: string | undefined,
    action: () => Promise<T>
  ): Promise<T> {
    if (!userId) return action();
    const creds = this.getCredentials();
    if (!creds || creds.baseUrl.includes("example.invalid")) {
      return action();
    }

    await this.sendTyping(userId, 1).catch(() => {});
    const timer = setInterval(() => {
      this.sendTyping(userId, 1).catch(() => {});
    }, 5000);

    try {
      return await action();
    } finally {
      clearInterval(timer);
      await this.sendTyping(userId, 2).catch(() => {});
    }
  }

  /**
   * Encrypt a local file or image with AES-128-ECB, upload to WeChat C2C CDN,
   * and send it as a native WeChat FILE (type=4) or IMAGE (type=2) message.
   */
  public async sendMediaFile(
    toUserId: string,
    filePath: string,
    clientId = `wxctx-media-${randomUUID()}`
  ): Promise<void> {
    const creds = this.getCredentials();
    if (!creds || !toUserId) {
      throw new Error("Missing ClawBot credentials or recipient");
    }

    const prepared = prepareMediaForUpload(filePath);
    const base = creds.baseUrl.endsWith("/") ? creds.baseUrl : `${creds.baseUrl}/`;

    // Step 1: Request upload URL from /ilink/bot/getuploadurl
    const getUploadUrlEndpoint = new URL("ilink/bot/getuploadurl", base);
    const uploadResp = await fetch(getUploadUrlEndpoint.toString(), {
      method: "POST",
      headers: buildHeaders(creds.botToken),
      body: JSON.stringify({
        filekey: prepared.filekey,
        media_type: prepared.mediaType,
        to_user_id: toUserId,
        rawsize: prepared.rawsize,
        rawfilemd5: prepared.rawfilemd5,
        filesize: prepared.filesize,
        no_need_thumb: true,
        aeskey: prepared.aeskeyHex,
        base_info: buildBaseInfo(),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!uploadResp.ok) {
      throw new Error(`getuploadurl HTTP ${uploadResp.status}`);
    }
    const uploadMeta = (await uploadResp.json()) as {
      ret?: number;
      errcode?: number;
      errmsg?: string;
      upload_param?: string;
      upload_full_url?: string;
    };
    assertApiSuccess(uploadMeta, "getuploadurl");

    const c2cUploadUrl =
      uploadMeta.upload_full_url ||
      `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(
        uploadMeta.upload_param || ""
      )}&filekey=${encodeURIComponent(prepared.filekey)}`;

    // Step 2: Upload AES-128-ECB ciphertext to C2C CDN
    const cdnResp = await fetch(c2cUploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(prepared.cipherBuf),
      signal: AbortSignal.timeout(60_000),
    });

    if (!cdnResp.ok) {
      throw new Error(`C2C CDN upload HTTP ${cdnResp.status}`);
    }
    const downloadEncryptedQueryParam =
      cdnResp.headers.get("x-encrypted-param") || uploadMeta.upload_param || "";
    if (!downloadEncryptedQueryParam) {
      throw new Error("C2C CDN upload missing x-encrypted-param header");
    }

    // Step 3: Send message referencing the uploaded media
    const contextToken = this.getContextToken(toUserId);
    const sendEndpoint = new URL("ilink/bot/sendmessage", base);
    const mediaObject: CdnMediaRef = {
      encrypt_query_param: downloadEncryptedQueryParam,
      aes_key: prepared.outboundAesKeyBase64,
      encrypt_type: 1,
    };

    const itemPayload =
      prepared.mediaType === 1
        ? {
            type: 2, // IMAGE
            image_item: {
              media: mediaObject,
              mid_size: prepared.filesize,
            },
          }
        : {
            type: 4, // FILE
            file_item: {
              media: mediaObject,
              file_name: prepared.fileName,
              len: String(prepared.rawsize),
              md5: prepared.rawfilemd5,
            },
          };

    const sendMediaMsg = async (token?: string) => {
      const msgResp = await fetch(sendEndpoint.toString(), {
        method: "POST",
        headers: buildHeaders(creds.botToken),
        body: JSON.stringify({
          msg: {
            from_user_id: "",
            to_user_id: toUserId,
            client_id: clientId,
            message_type: 2, // BOT
            message_state: 2, // FINISH
            item_list: [itemPayload],
            ...(token ? { context_token: token } : {}),
          },
          base_info: buildBaseInfo(),
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!msgResp.ok) {
        throw new Error(`sendmessage (media) HTTP ${msgResp.status}`);
      }
      return msgResp.json();
    };

    let msgData = await sendMediaMsg(contextToken);
    if (
      contextToken &&
      msgData &&
      typeof msgData === "object" &&
      !Array.isArray(msgData) &&
      Number((msgData as any).ret) === -2
    ) {
      this.clearContextToken(toUserId);
      msgData = await sendMediaMsg(undefined);
    }
    assertApiSuccess(msgData, "sendmessage_media");
  }
}

/**
 * Unpack a ClawBotMessage into structured user text, voice transcriptions,
 * quoted reference context (ref_msg & partial_text), URLs, and C2C media items.
 */
export function unpackClawBotMessage(msg: ClawBotMessage): UnpackedClawBotMessage {
  const userTextParts: string[] = [];
  const voiceTranscriptions: string[] = [];
  let refContext: UnpackedClawBotMessage["refContext"] | undefined;
  const urlSet = new Set<string>();
  const mediaItems: UnpackedClawBotMessage["mediaItems"] = [];

  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) {
      const txt = item.text_item.text.trim();
      if (txt) userTextParts.push(txt);
    } else if (item.type === 3 && item.voice_item) {
      if (item.voice_item.text?.trim()) {
        const vTxt = item.voice_item.text.trim();
        voiceTranscriptions.push(vTxt);
        userTextParts.push(vTxt);
      }
      if (item.voice_item.media) {
        mediaItems.push({
          kind: "voice",
          media: item.voice_item.media,
        });
      }
    } else if (item.type === 2 && item.image_item?.media) {
      mediaItems.push({
        kind: "image",
        media: item.image_item.media,
        hexAesKeyFallback: item.image_item.aeskey,
      });
    } else if (item.type === 4 && item.file_item?.media) {
      mediaItems.push({
        kind: "file",
        media: item.file_item.media,
        fileName: item.file_item.file_name,
        fileLen: item.file_item.len ? Number(item.file_item.len) : undefined,
      });
    } else if (item.type === 5 && item.video_item?.media) {
      mediaItems.push({
        kind: "video",
        media: item.video_item.media,
      });
    }

    if (item.ref_msg) {
      const refTitle = item.ref_msg.title?.trim();
      const refQuoted = item.ref_msg.message_item?.text_item?.text?.trim();
      const partial = item.ref_msg.partial_text;
      let partialSlice: string | undefined;
      if (
        partial &&
        refQuoted &&
        typeof partial.startindex === "number" &&
        typeof partial.endindex === "number" &&
        partial.endindex > partial.startindex
      ) {
        partialSlice = refQuoted.slice(partial.startindex, partial.endindex);
      } else if (partial?.start) {
        partialSlice = partial.end
          ? `${partial.start}...${partial.end}`
          : partial.start;
      }

      const rawRefJson = JSON.stringify(item.ref_msg);
      const refUrlMatch = rawRefJson.match(/https?:\/\/[^\s"'<>\\]+/i);

      refContext = {
        title: refTitle,
        quotedText: refQuoted,
        partialText: partialSlice,
        svrId: item.ref_msg.svr_id,
        embeddedUrl: refUrlMatch?.[0],
      };
    }

    // Extract URLs from user text or card XML (excluding internal C2C CDN urls)
    const rawItemWithoutRef = JSON.stringify({ ...item, ref_msg: undefined });
    for (const u of extractUrlsFromMixedText(rawItemWithoutRef)) {
      urlSet.add(u);
    }
  }

  return {
    userText: userTextParts.join("\n").trim(),
    voiceTranscriptions,
    refContext,
    urls: Array.from(urlSet),
    mediaItems,
  };
}

/**
 * Extract text, voice-to-text, or any embedded WeChat article URL from a ClawBotMessage.
 */
export function extractTextFromClawBotMessage(msg: ClawBotMessage): string {
  if (!msg.item_list?.length) return "";
  const parts: string[] = [];
  for (const item of msg.item_list) {
    if (item.type === 1 && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === 3 && item.voice_item?.text) {
      // Voice message automatically transcribed by WeChat!
      parts.push(item.voice_item.text);
    }
    if (item.ref_msg?.title) {
      parts.push(item.ref_msg.title);
    }
    if (item.ref_msg?.message_item?.text_item?.text) {
      parts.push(item.ref_msg.message_item.text_item.text);
    }
    // Fallback: if item contains any nested link/card structure with a public URL, extract it
    const combinedSoFar = parts.join("\n");
    if (!/https?:\/\//i.test(combinedSoFar)) {
      const rawItemWithoutRef = JSON.stringify({ ...item, ref_msg: undefined });
      const cardUrls = extractUrlsFromMixedText(rawItemWithoutRef);
      if (cardUrls.length > 0) {
        parts.push(cardUrls[0]);
      }
    }
  }
  return parts.join("\n").trim();
}

export async function renderQrCodeToTerminal(qrcodeUrl: string): Promise<void> {
  try {
    const qrterm = await import("qrcode-terminal");
    const gen = (qrterm as any).default?.generate || (qrterm as any).generate;
    if (typeof gen === "function") {
      gen(qrcodeUrl, { small: true }, (str: string) => {
        console.log(str);
      });
    }
  } catch {}
  console.log(`\n🔗 若终端二维码显示异常，也可直接在浏览器打开此链接扫码：\n${qrcodeUrl}\n`);
}

function readStdinLine(promptText: string): Promise<string> {
  process.stdout.write(promptText);
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      if (buf.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(buf.trim());
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
  });
}

function assertApiSuccess(data: any, operation: string): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${operation}: invalid response`);
  for (const field of ["ret", "errcode"]) {
    if (data[field] !== undefined && Number(data[field]) !== 0) {
      throw new Error(`${operation}: ${field}=${data[field]} ${String(data.errmsg || "request rejected").slice(0, 200)}`);
    }
  }
}

/**
 * Split oversized WeChat replies into safe chunks (<= maxChars) at paragraph/line boundaries.
 */
export function splitWeChatTextChunks(text: string, maxChars = 2500): string[] {
  if (!text || text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    let splitIdx = window.lastIndexOf("\n\n");
    if (splitIdx < Math.floor(maxChars * 0.4)) {
      splitIdx = window.lastIndexOf("\n");
    }
    if (splitIdx < Math.floor(maxChars * 0.4)) {
      splitIdx = Math.max(
        window.lastIndexOf("。"),
        window.lastIndexOf("！"),
        window.lastIndexOf("？"),
        window.lastIndexOf(". ")
      );
      if (splitIdx > 0) splitIdx += 1;
    }
    if (splitIdx <= 0) {
      splitIdx = maxChars;
    }
    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).replace(/^\r?\n+/, "");
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}
