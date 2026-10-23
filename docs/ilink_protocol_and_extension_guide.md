# WeChat as Context — 微信 iLink 协议全景、CLI 数据流与功能扩展指南

本文档记录了 `wechat_as_context` 的三项核心技术资产：
1. **腾讯微信 `iLink Bot`（`微信ClawBot [AI]`）协议阅读笔记**（共 **9 个 CGI 接口 + 2 个 C2C CDN 加解密端点 = 11 个接口**，以及消息类型与引用协议）；
2. **全局 Skill（`wechat-as-context`）与本地 CLI（`src/cli.ts`）的命令详解与事务级数据流**；
3. **现有能力清单与未来新意图（Intent）/ 多模态功能的扩展开发指南**。

---

## 第一部分：微信 `iLink Bot` 桥接协议阅读记录（11 个端点）

以下为基于 `@tencent-weixin/openclaw-weixin` v2.4.10 的协议阅读记录，不是微信当前接口可用性的联网验收。表中分为 4 个基础收发接口、5 个扩展 CGI 和 2 个 CDN 端点；本项目也已使用部分扩展接口（如 typing 和 upload），具体以 `src/clawbot/client.ts` 为准。

### 1.1 通信网关与公共协议头（Headers & BaseInfo）

- **CGI 主网关**：`https://ilinkai.weixin.qq.com`
  - *注：扫码登录时若触发跨地域机房调度（`scaned_but_redirect`），服务端会返回专属 `redirect_host` / `baseurl`，后续请求切换至该主机。*
- **C2C 媒体 CDN 网关**：`https://novac2c.cdn.weixin.qq.com/c2c`
- **公共 HTTP 请求头**：
  | Header 名称 | 值 / 构造规则 | 说明 |
  | :--- | :--- | :--- |
  | `Content-Type` | `application/json` | 所有 CGI POST 请求固定为 JSON |
  | `AuthorizationType` | `ilink_bot_token` | 固定鉴权类型标识 |
  | `Authorization` | `Bearer <bot_token>` | 扫码确认后获得的专属 Token |
  | `X-WECHAT-UIN` | `base64(String(randomUint32))` | 每次请求随机生成 4 字节无符号整数，转十进制字符串后再做 Base64 |
  | `iLink-App-Id` | `bot` | 固定应用标识 |
  | `iLink-App-ClientVersion` | `132106` | 版本号 `uint32` 编码：`(major << 16) \| (minor << 8) \| patch`（`2.4.10` 即 `132106`） |
  | `SKRouteTag` | 可选字符串 | 灰度路由标签（默认无需携带） |
- **公共请求体字段 `base_info`**：
  每个 POST JSON 请求体顶层均携带：
  ```json
  {
    "base_info": {
      "channel_version": "2.4.10",
      "bot_agent": "OpenClaw"
    }
  }
  ```
- **64 位整数（`uint64`）精度防丢失规则**：
  服务端返回的 JSON 中，`message_id`、`msg_id`、`svr_id` 为 64 位整数原始字面量（超过 JavaScript `Number.MAX_SAFE_INTEGER`），**必须在 `JSON.parse` 之前将其包裹为字符串**（见 `src/clawbot/client.ts` 的大整数 JSON 处理）。

---

### 1.2 接口记录：4 个基础接口 + 5 个扩展 CGI + 2 个 CDN 端点

#### A. 当前已接入的 4 个核心接口（`src/clawbot/client.ts`）

| 序号 | 接口路径 | 方法 | 核心入参 | 核心出参 | 作用说明 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `/ilink/bot/get_bot_qrcode?bot_type=3` | `POST` | `{ "local_token_list": ["<已有token>"] }` | `{ "qrcode": "<hex>", "qrcode_img_content": "https://liteapp.weixin.qq.com/q/..." }` | 申请绑定二维码（`bot_type=3` 对应个人微信可置顶的 `微信ClawBot [AI]`）。 |
| **2** | `/ilink/bot/get_qrcode_status?qrcode=<id>[&verify_code=<code>]` | `GET` | Query: `qrcode`、可选 `verify_code` | `{ "status": "...", "bot_token": "...", "ilink_bot_id": "...@im.bot", "ilink_user_id": "...@im.wechat", "baseurl": "...", "redirect_host": "..." }` | 35 秒长轮询扫码状态。状态机包括：`wait` $\rightarrow$ `scaned` $\rightarrow$ `need_verifycode`（手机屏幕弹数字配对码） $\rightarrow$ `scaned_but_redirect`（IDC 机房切换） $\rightarrow$ `binded_redirect`（已绑定直接复用） $\rightarrow$ `confirmed`（成功发证） / `expired`。 |
| **3** | `/ilink/bot/getupdates` | `POST` | `{ "get_updates_buf": "<上次游标>", "base_info": {...} }` | `{ "ret": 0, "errcode": 0, "msgs": [...], "get_updates_buf": "<新游标>", "longpolling_timeout_ms": 35000 }` | **核心长轮询拉取接口**。服务端挂起连接直至有新消息或超时（35s）。注：若返回 `errcode: -14`（`STALE_TOKEN_ERRCODE`），代表会话失效或被异地顶下线，需冷却暂停请求或重新扫码。 |
| **4** | `/ilink/bot/sendmessage` | `POST` | `{ "msg": { "from_user_id": "", "to_user_id": "...", "client_id": "...", "message_type": 2, "message_state": 2, "context_token": "...", "item_list": [...] }, "base_info": {...} }` | `{ "ret": 0, "message_id": "..." }` | **核心下行发送接口**。向用户微信聊天窗口发送文本、图片、视频、文件或工具执行进度卡。`context_token` 必须原样回传最近收到的会话令牌。 |

---

#### B. 5 个扩展 CGI 接口（含项目已接入能力）

| 序号 | 接口路径 | 方法 | 核心入参 | 核心出参 | 未来扩展价值与应用场景 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **5** | `/ilink/bot/getconfig` | `POST` | `{ "ilink_user_id": "<用户ID>", "context_token": "<会话token>", "base_info": {...} }` | `{ "ret": 0, "typing_ticket": "<Base64票据>" }` | **获取「正在输入」票据**：为指定用户获取 `typing_ticket`（可本地缓存 24 小时），供下一个接口 `sendtyping` 使用。 |
| **6** | `/ilink/bot/sendtyping` | `POST` | `{ "ilink_user_id": "...", "typing_ticket": "...", "status": 1, "base_info": {...} }` | `{ "ret": 0 }` | **控制手机微信顶部显示「对方正在输入...」**：<br>- `status: 1`（`TYPING`）：开启“正在输入...”提示（可每 5s 发一次心跳保持）；<br>- `status: 2`（`CANCEL`）：结束输入提示。<br>*价值：当后台正在抓取长文或调用 LLM 时，让手机微信顶部实时显示“正在输入...”，交互体验拉满！* |
| **7** | `/ilink/bot/getuploadurl` | `POST` | `{ "filekey": "<16字节随机hex>", "media_type": 1\|2\|3\|4, "to_user_id": "...", "rawsize": 1024, "rawfilemd5": "<md5>", "filesize": 1040, "no_need_thumb": true, "aeskey": "<16字节随机hex>", "base_info": {...} }` | `{ "upload_full_url": "https://...", "upload_param": "..." }` | **申请媒体/文件上传通道**：<br>`media_type` 枚举：`1 = IMAGE`、`2 = VIDEO`、`3 = FILE`、`4 = VOICE`。<br>*价值：让 AI 不仅能回文字，还能把生成的知识图谱图片、导出的 Markdown/PDF 精读报告直接作为文件发回你手机微信！* |
| **8** | `/ilink/bot/msg/notifystart` | `POST` | `{ "base_info": {...} }` | `{ "ret": 0 }` | **守护进程上线通知**：在本地服务启动时主动告知微信网关通道已就绪。 |
| **9** | `/ilink/bot/msg/notifystop` | `POST` | `{ "base_info": {...} }` | `{ "ret": 0 }` | **守护进程优雅停机通知**：在进程退出或重启时告知微信网关立即释放挂起的长轮询连接。 |

---

#### C. 微信 C2C 媒体 CDN 加解密与传输协议（2 个端点）

当你在微信里给 `微信ClawBot [AI]` **发图片、发 PDF/文档文件、发语音**，或者让 Bot **给你发图片/文件**时，媒体字节流不走 `ilinkai.weixin.qq.com`，而是走 **`https://novac2c.cdn.weixin.qq.com/c2c`**，并采用 **`AES-128-ECB`（PKCS#7 Padding，无 IV）** 对称加密：

| 序号 | 端点路径 | 方法 | 加密与传输机制说明 |
| :--- | :--- | :--- | :--- |
| **10** | `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=<param>`<br>*(或直接使用 `media.full_url`)* | `GET` | **下载并解密用户发来的图片/文件/语音/视频**：<br>1. 从入站消息的 `image_item.media` / `file_item.media` / `voice_item.media` 中读取下载 URL 与密钥；<br>2. **密钥解析细节（双格式兼容）**：<br>   - 若 `image_item.aeskey` 存在，直接按 32 字符 `hex` 转为 16 字节 `Buffer`；<br>   - 否则读取 `media.aes_key` 做 Base64 解码：若解码后恰为 16 字节则为原始密钥（常见于图片）；若解码后为 32 字节 ASCII Hex 字符串，需再按 `hex` 解码得到 16 字节密钥（常见于文件/语音/视频）；<br>3. 下载密文二进制流后，用 `createDecipheriv("aes-128-ecb", key, null)` 解密即得原文件！ |
| **11** | `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=<upload_param>&filekey=<filekey>`<br>*(或使用 `getuploadurl` 返回的 `upload_full_url`)* | `POST` | **加密并上传本地图片/文件发回手机微信**：<br>1. 本地生成随机 16 字节 `aeskey` 与 `filekey`，计算原文件 `rawsize`、`rawfilemd5` 及 PKCS#7 填充后密文大小 `filesize = Math.ceil((rawsize + 1) / 16) * 16`；<br>2. 调用接口 **#7 (`getuploadurl`)** 获取 `upload_full_url`；<br>3. 用 `createCipheriv("aes-128-ecb", aeskey, null)` 加密文件 Buffer，以 `Content-Type: application/octet-stream` POST 上传；<br>4. 从 CDN 响应头 **`x-encrypted-param`** 中读取下载凭证 `downloadEncryptedQueryParam`；<br>5. 调用接口 **#4 (`sendmessage`)**，填入 `encrypt_query_param` 与 `aes_key: Buffer.from(aeskeyHex).toString("base64")` 即可送达用户微信！ |

---

### 1.3 消息结构体（`WeixinMessage`）中的隐藏宝藏能力

在 `getupdates` 和 `sendmessage` 的 `item_list` 中，这里列出的协议消息类型包含 以及 **局部引用（`PartialText`）**：

1. **`MessageItemType` 枚举摘录**：
   - `1` (`TEXT`)：纯文本 `{ text_item: { text: "..." } }`
   - `2` (`IMAGE`)：图片 `{ image_item: { media: {...}, mid_size: 12345 } }`
   - `3` (`VOICE`)：语音 `{ voice_item: { media: {...}, playtime: 5000, text: "微信服务端自动转写的文字" } }`
   - `4` (`FILE`)：文件附件 `{ file_item: { media: {...}, file_name: "report.pdf", len: "102400", md5: "..." } }`
   - `5` (`VIDEO`)：视频 `{ video_item: { media: {...}, video_size: 12345 } }`
   - `11` (`TOOL_CALL_START`)：**微信原生工具调用开始卡片** `{ is_completed: false, tool_call_start_item: { tool_name: "extract_article", tool_call_id: "call_1" } }`
   - `12` (`TOOL_CALL_RESULT`)：**微信原生工具调用完成卡片** `{ is_completed: true, tool_call_result_item: { tool_name: "extract_article", tool_call_id: "call_1", status: "completed" } }`
     - *注：`status` 支持 `"completed"` | `"failed"` | `"blocked"` | `"unknown"`，并可通过顶层 `run_id` 串联同一次 Agent 执行！*

2. **引用与局部涂抹引用（`ref_msg` & `partial_text`）**：
   当你在手机微信里长按 Bot 发给你的初筛卡片，点击 **「引用」**（甚至只选中其中某句话引用）并输入追问时，`item.ref_msg` 会包含：
   ```json
   {
     "title": "被引用的消息摘要",
     "svr_id": "被引用消息的服务端64位ID",
     "message_item": { "type": 1, "text_item": { "text": "被引用全文" } },
     "partial_text": {
       "start": "选中片段开头词",
       "end": "选中片段结尾词",
       "startindex": 12,
       "endindex": 48,
       "quotemd5": "..."
     }
   }
   ```

---

## 第二部分：我们的 Skill 与 CLI（`src/cli.ts`）命令详解及数据流

### 2.1 核心数据库表结构（`data/wechat_context.db`，WAL 模式）

为了保证离线恢复、崩溃安全与文件幂等，SQLite 数据库的主要表包括（定义于 `src/db.ts`）：
1. **`kv_state`**：键值状态表，持久化保存：
   - `clawbot_credentials`（扫码获得的 `botToken`、`botId`、`userId`、`baseUrl`）
   - `clawbot_updates_buf`（`getupdates` 增量同步游标）
   - `clawbot_ctx_<userId>`（每个微信用户的最新 `context_token`，用于回发消息）
   - `clawbot_last_poll`（最近一次长轮询的时间戳与错误状态）
2. **`inbound_messages`**：入站消息持久化收件箱（`sequence`, `message_key`, `payload`, `status`, `error`）。在推进 `clawbot_updates_buf` 游标的**同一个 SQLite 事务**中写入，避免游标已提交但消息未在同一事务保存的窗口；这不保证上游永久保留消息或任意故障下零丢失。
3. **`articles`**：公众号文章主表，维护文章生命周期状态机：
   - `status`: `pending_extract` $\rightarrow$ `extracting` $\rightarrow$ `analyzing` $\rightarrow$ `light_done` / `deep_done`（或 `failed`）
   - `process_level`: `raw` | `light` | `deep`
   - `triage`: `keep_raw` | `reference` | `process_later` | `process_now`
4. **`reply_outbox`**：出站微信回执持久队列（`id`, `recipient`, `text`, `status`, `attempts`, `error`）。最多重试 3 次，每次重试复用同一个幂等 `client_id`。
5. **`operation_locks`**：基于进程 PID 存活探测（`process.kill(pid, 0)`）的跨进程互斥锁表（如 `sync`、`outbox`、`article_<id>`、`agent_queue`），防止后台守护进程与手动 CLI 并发冲突。
6. **`agent_tasks`**：持久 Agent 队列，记录 pending/processing/done/failed、执行阶段及错误。
7. **`conversation_turns`**：对话上下文、执行模型、关联文章和产物路径。

---

### 2.2 文章流程常用 CLI 命令（命令、参数、数据流与微信交互）

所有命令统一通过以下入口调用：
```bash
bun run src/cli.ts <command> [options]
```

| 命令 | 语法与参数 | 是否与微信服务器网络交互？ | 完整数据处理流程 |
| :--- | :--- | :--- | :--- |
| **`login`** | `bun run src/cli.ts login` | **是（交互式扫码）** | 1. 读取 `kv_state` 中旧 token（如有）放入 `local_token_list`；<br>2. POST `/ilink/bot/get_bot_qrcode?bot_type=3` 获取二维码内容；<br>3. 在终端渲染 ASCII 二维码并打印备用 URL；<br>4. 循环 GET `/ilink/bot/get_qrcode_status`（处理扫码提示、数字配对码 `need_verifycode`、IDC 机房跳转 `scaned_but_redirect`）；<br>5. 用户在手机点击确认后，将返回的 `bot_token`、`botId`、`userId`、`baseUrl` 写入 `kv_state.clawbot_credentials`。 |
| **`doctor`** | `bun run src/cli.ts doctor [--json]` | **否（纯本地只读诊断）** | 1. 检查 `VAULT_ROOT` 目录是否存在；<br>2. 检查 LLM API Key 与模型配置；<br>3. 读取 `kv_state` 中的 `clawbot_credentials` 与 `clawbot_last_poll`；<br>4. 聚合统计 `reply_outbox` 发送状态、`deliveryErrors` 与 `inbound_messages` 错误日志并输出。 |
| **`sync`** | `bun run src/cli.ts sync [--json]` | **是（拉取消息 + 发送回执）** | 1. 获取跨进程锁 `withLock("sync")`；<br>2. 先处理 `inbound_messages` 中上次未完成的 `pending` 记录；<br>3. POST `/ilink/bot/getupdates`（携带 `clawbot_updates_buf`），在**单个 SQLite 事务**内将新消息写入 `inbound_messages`、更新 `context_token` 并推进 `clawbot_updates_buf`；<br>4. 调用 `processPendingMessages()` 进行意图路由（识别「想法：...」、公众号 URL、「深读」或补充批注），将确认回执写入 `reply_outbox`；<br>5. 调用 `drainReadyQueue()`，对已过等待窗口的文章执行：**网页抓取 + 图片防盗链下载 + 知识库检索 + LLM 初筛 + 原子化落盘 `.md` 与 `_note.md`**，并将初筛卡片写入 `reply_outbox`；<br>6. 调用 `flushReplies()`，POST `/ilink/bot/sendmessage` 把所有待发回执推送到用户手机微信。 |
| **`list`** | `bun run src/cli.ts list [--status <s>] [--triage <t>] [--limit <n>] [--json]` | **否（纯本地只读）** | 从 SQLite `articles` 表按条件（如 `--triage process_now`）倒序查询文章列表，返回 ID、标题、作者、`process_level`、`triage`、用户批注、关联知识库节点及本地 Markdown 路径。**严守无副作用原则，不触发网络同步。** |
| **`show`** | `bun run src/cli.ts show <id> [--json]` | **否（纯本地只读）** | 1. 查询 `articles` 表中指定 `<id>` 的完整元数据；<br>2. 读取磁盘上 `note_md_path` 对应的伴读笔记 Markdown 全文并一并返回，供 Agent 或用户检视。 |
| **`ingest`** | `bun run src/cli.ts ingest "<url>" [--note "批注"] [--title "标题"] [--json]` | **不发送微信；会联网抓取与调用模型** | 1. 校验并归一化公众号或支持的外部网页链接；<br>2. 在 `articles` 表入队（`channel: "cli"`, `waitSeconds: 0`）；<br>3. 立即调用 `processArticleById(id, { sendWeChatReply: false })`：完成公众号正文提取、防盗链图片下载、知识库节点检索、LLM 初筛笔记生成与落盘，并在终端打印结果。 |
| **`triage`** | `bun run src/cli.ts triage <id> <keep_raw\|reference\|process_later\|process_now> [--level raw\|light\|deep]` | **否（本地数据库 + Markdown frontmatter 更新）** | 1. 校验原文 `source_md_path` 与伴读卡 `note_md_path` 均存在；<br>2. 仅精准更新这两个文件的 YAML Frontmatter 中的 `triage:` 和 `process_level:` 字段，**保留文件正文（包括人工或深读编辑内容）**；<br>3. 同步更新 SQLite `articles` 表的 `triage`、`process_level` 与 `status`。 |
| **`idea`** | `bun run src/cli.ts idea [<id>] "你的想法内容" [--slug <slug>]` | **否（本地写入配置的 `ideasSeedsDir`）** | 1. 读取文章 `#<id>` 的路径、URL 与关联知识库节点 `related_vault_nodes`；<br>2. 调用 `createIdeaSeedInVault` 在配置的 `ideasSeedsDir` 下原子化创建一篇带标准 Frontmatter（`type: idea`, `status: seed`）的个人想法笔记，并自动挂载来源文章与关联节点双链。 |

---

## 第三部分：现有能力矩阵与未来扩展开发指南

### 3.1 主要能力与使用边界

1. **手机微信发公众号链接 $\rightarrow$ 自动抓取 + 图片防盗链本地化 + 知识库初筛回执**：
   - 支持纯链接，也支持「链接 + 一句话关注点」一起发。
2. **10 秒滑动窗口追加批注（文字或语音）**：
   - 发完链接后紧跟发一条文字或**微信语音**（微信云端自动转成文字），会自动合并进该文章的 `user_notes`。
3. **手机端一句话捕捉闪念（`想法：...` / `灵感：...` / `观点：...` / `我有一个想法：...`）**：
   - 直接在 `微信ClawBot [AI]` 发送以这些词开头的文字或语音，在配置的 `ideasSeedsDir` 生成种子笔记，并自动关联你最近刚看的那篇公众号文章。
4. **手机端一键标记优先深读（发送 `深读` / `精读` / `优先`）**：
   - 路由取决于配置与上下文：规则路径可把最近文章标为 `process_now`；Agent 的 `deepen` 路径生成回答，不自动更新 `_note.md` 或把 `process_level` 设为 `deep`。
5. **电脑端跨 Agent（Codex / AntiGravity / OpenCode）无缝接力第二阶段深读**：
   - 对 Agent 说“深度阅读刚刚我转发的公众号文章”，Agent 自动定位文章、读取本地原文与高清配图、穿透查阅你的 `03_ideas/` 与 `04_topics/` 笔记、将 `_note.md` 升级为 `deep`。
6. **严格的知识库安全保护（Authoritative Storage）**：
   - 已有原文和伴读笔记永不被后台任务静默覆盖；游标推进与消息入库同事务；回执发送具备 3 次幂等重试。

---

### 3.2 V2 双模型个人助理 Agent 架构与 6 大扩展场景落地实现

后台常驻服务已升级为 **双模型驱动的可扩展 Agent 意图网关**：
- **双层模型调度（[`src/agent/llm.ts`](../src/agent/llm.ts)）**：
  - `fastModel`（默认 `gemini-2.5-flash`）：负责全量入站消息的语义意图识别、参数提取、复杂度评估（`complexity: "fast" | "deep"`）及快速任务执行；
  - `proModel`（默认 `gemini-2.5-pro`）：当评估为高复杂度任务（`complexity = "deep"`，如跨笔记深度综合、文章逻辑批判拆解、复杂推理规划）时自动接管执行，并具备自动降级回 `fastModel` 的容错保护。
- **意图识别器（[`src/agent/router.ts`](../src/agent/router.ts)）与可插拔执行引擎（[`src/agent/runtime.ts`](../src/agent/runtime.ts)）**：
  默认注册 11 类意图（`capture_idea`, `capture_inbox`, `ingest_link`, `article_followup`, `vault_query`, `web_search`, `multimodal_ingest`, `generate_image`, `delegate_subagent`, `send_file`, `general_assistant`），并可通过 `pipeline.agent.registerIntentHandler(intent, fn)` 动态扩展新意图。

#### 已实装落地的 6 大扩展场景：
1. **场景 1：手机微信直接向个人知识库提问与检索（`vault_query`）**
   - 直接在微信用自然语言提问（如 *“我之前关于本体论的大纲写到哪了？”*），自动检索 `00_home/`、`01_inputs/`、`03_ideas/`、`04_topics/`、`05_outputs/` 与 SQLite `articles`，由 `gemini-2.5-flash` 或 `gemini-2.5-pro` 结合真实笔记证据（附 `[[WikiLink]]`）回答。
2. **场景 2：处理期间手机微信顶部实时显示「对方正在输入...」（`withTypingIndicator`）**
   - 在 [`src/clawbot/client.ts`](../src/clawbot/client.ts) 中实现了 `getTypingTicket()`（`/ilink/bot/getconfig`）与 `sendTyping()`（`/ilink/bot/sendtyping`），通过 `withTypingIndicator` 包裹所有异步 Agent 推理与文章抓取流程（每 5 秒自动续期心跳，完成后发送 `status=2` 结束）。
3. **场景 3：支持转发「非微信公众号」的任意外部网页链接（`src/extractor/web.ts`）**
   - 新增 [`extractGeneralWebArticle`](../src/extractor/web.ts) 与 [`saveRawWebArticleToVault`](../src/extractor/web.ts)，尝试抓取技术博客等外部网页并本地化图片。Jina Reader 兜底默认关闭，需显式开启 `ALLOW_JINA_FALLBACK=true`；开启后完整 URL（含查询参数）会发往第三方，来源标记为 `jina_reader`。需要登录、验证码或动态页面不保证成功。落盘路径取决于存储模式。
4. **场景 4：微信发截图/照片/文件自动 `AES-128-ECB` 解密入库与多模态提取（`multimodal_ingest`）**
   - 在 [`src/clawbot/media.ts`](../src/clawbot/media.ts) 中实现 `downloadAndDecryptCdnMedia`，自动兼容微信双格式 AES 密钥，将图片/PDF 解密归档至配置的 inbox/papers 目录，文件名带内容 SHA-256。图片和支持的小型文本可传入 API；PDF 等没有内置正文解析的附件先尝试 CLI，CLI 失败或禁用时只归档并明确“未解析”，不把路径当作正文调用 API。
5. **场景 5：利用微信「引用消息（`ref_msg` & `partial_text`）」精准定位旧文章追问或下达指令（`article_followup`）**
   - 在 [`unpackClawBotMessage`](../src/clawbot/client.ts) 中结构化解析 `ref_msg` 与局部涂抹引用 `partial_text`，支持长按任意历史卡片点「引用」进行全文问答、局部句子深挖、追加批注或修改分诊状态。
6. **场景 6：将伴读笔记 `_note.md` 或知识库任意文件加密回传手机微信（`send_file`）**
   - 在 [`src/clawbot/client.ts`](../src/clawbot/client.ts) 中实现 `sendMediaFile`（调用 `/ilink/bot/getuploadurl` + `c2c/upload` `AES-128-ECB` 加密上传 + `sendmessage` 发送 `type=4` 文件项），在微信中说 *“把伴读笔记发文件给我”* 或 *“把 `00_home/now.md` 发给我”* 即可收到原生文件附件。


### 3.3 可靠性修复后的执行契约

- `agent_queue` 锁覆盖任务恢复、领取和执行。只读 `list/show/doctor` 不恢复任务；存活 worker 持锁期间其他 worker 不消费队列。旧进程退出后，新 worker 可以恢复未完成任务。该锁没有租约超时；升级须先停止旧版 worker。
- 任务执行 `done` 与回执送达是两种状态，送达应检查 `reply_outbox` / `doctor`。崩溃恢复可能重试已经发生的外部动作，不提供端到端 exactly-once。
- 无 API Key 的明确 CLI 指令仍进入 Agent 路由。引用文章批注写入已解析的目标，不写到另一篇最新文章。
- CLI 产物只收集回答中显式给出、位于允许目录且满足修改时间条件的文件；不扫描共享目录中所有新文件。真实路径检查拒绝越界符号链接，这还不是每任务产物清单隔离。
- Markdown 派生 HTML/PDF 采用内容版本文件名，保留旧导出；导出失败不得以旧 PDF 替代。Markdown 图片正常渲染，文档目录内的本地图片可嵌入导出。
- 外部 HTTP 请求校验常见私网 IP 字面量及每跳重定向；未实现 DNS 解析地址绑定，浏览器回退也不是网络隔离沙箱。
- HTTP 入参使用 `note`、`files`、`formats`。旧的 `annotation`、`docPath`、`exportFormats` 返回 400；`/api/sync`、`/api/articles`、`/api/ideas` 未实现，使用 CLI 对应命令。

升级、测试范围和剩余限制见 [修复说明与验收](./reliability-fixes.md)。


### 3.4 v0.2.2 图片、文件与配置一致性

- AGY 不扫描共享 generated/brain 目录；只接受明确返回或本次预期路径、且真实路径处于允许目录的产物。超时和非零退出均失败；生图任务还必须有可归属图片。未知模型回退到 CLI 默认值后，`modelUsed` 标记 `default/unknown`。
- `send_file` 从 Markdown 请求导出时，按当前正文和嵌入图片的摘要逐项补齐格式；查找不再以 mtime 混选不同版本。显式历史 HTML/PDF 只配对该 revision，缺少格式通过 `missingFormats` 和回复文本说明。
- 普通启动、重载、Web 配置加载统一项目 `.env` > 进程环境 > home `.env`；测试或嵌入调用的 `customEnv` 显式注入优先。`IGNORE_HOME_DOTENV` 只控制 home 文件。
- 显式心跳秒配置（含 0）优于 legacy 毫秒变量；状态快通道使用相同配置。0 仅关闭定时进度，不关闭阶段通知。

逐项复现、回归覆盖和验收边界见 [七项修复说明](./followup-reliability-fixes.md)。

### 3.5 v0.2.3 文件快照与执行结果

- 媒体入队读取文件字节，保存到数据库同目录的 `outbox_media/<sha256>/<basename>`；`reply_outbox.media_path` 指向快照，新增 `media_sha256`。发送前重新核验摘要，重试复用同一快照与消息 ID。原路径后续编辑或移动不改变待发字节。
- schema 在新版打开数据库时增量添加。旧版无摘要的待发媒体和被改坏的快照均拒绝发送，沿用最多三次尝试并保留错误；必须重新入队。文本回执不受影响，原附件不变。旧版与新版不应混跑媒体发送；快照当前不自动清理。
- 新的 `conversation_turns.deposited_path` 使用 JSON 数组；无产物存空串。读取兼容真实存在的旧单路径（含逗号）及各项均存在的旧逗号列表；损坏记录不猜测。文件选择不再使用当天目录兜底，明确文章目标优先于通用“指南”关键词。
- `IntentExecutionResult.outcome` 支持 `success`、`partial`、`failed`。业务失败写入任务 `failed` 与错误；部分交付写入 `done`，阶段明确标注缺失，回执通过 `missingFormats` 说明。缺省结果仍按成功兼容既有处理器，微信送达由 outbox 单独记录。
- 所有 CLI 后端以非零退出或超时判失败；多 Markdown 格式请求逐份处理。已有 Markdown 与显式正文冲突时拒绝处理；PDF 使用临时路径，进程成功且通过头尾检查后原子发布，缓存执行相同检查，损坏的旧 PDF 重命名保留。
- 配置 Key 发现与加载共用来源顺序及 `IGNORE_HOME_DOTENV` 规则；配置刷新失败也会释放 drain 状态，恢复后同实例可以继续消费。
- `push` 对显式历史文件的保留约定不变。详细兼容说明与验收见 [十项修复说明](./v023-reliability-fixes.md)。

### 3.6 v0.2.4 测试运行边界

`bun run test` 在临时源码副本中运行，生产配置加载顺序及服务行为不变。父子进程均加载测试守卫：SQLite 路径只能在隔离根目录内，符号链接越界与 `ATTACH` 等 SQL 文件入口被拒绝；未模拟的 `fetch` 和外部命令被阻止。`bun run test:isolation` 用合成部署目录、HOME 和外部哨兵数据库验证边界，不需要真实微信凭据。

`push --queue-only` 只控制当前调用的立即发送，不控制消费同一数据库的后台服务。测试必须使用隔离入口；不能将真实 outbox 作为“离线”测试库。详细验收及边界见 [测试隔离说明](./test-isolation.md)。
