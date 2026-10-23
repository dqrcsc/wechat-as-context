---
name: wechat-as-context
description: 手机微信 ClawBot 双向桥接工具：查看微信转发的公众号/网页文章收件箱、按需同步或抓取文章、进行文章深读，或将当前会话中的信息、结论摘要、本地图片及文档（支持 MD/HTML/PDF 多格式编译）直接推送到手机微信。无需依赖个人知识库即可独立运行；若已配置知识库则自动联动。适用于“看看我转的公众号文章”“公众号收件箱”“同步微信文章”“深读刚转发的文章”“把这个发到我微信上”“把这篇笔记/报告推送到微信”。
---

# 微信 ClawBot 双向桥接、文章收件箱与可选知识库伴读

项目：`{{PROJECT_ROOT}}`。
CLI：`bun run {{PROJECT_ROOT}}/src/cli.ts <command>`。

## 存储与知识库解耦（三种自适应模式）

本工具**不强制依赖个人知识库**，具体运行模式与落盘路径以 `doctor --json` 返回的 `vaultMode`、`vaultRoot`、`wechatArticlesDir`、`ideasSeedsDir` 为准：

1. **无知识库独立模式（`vaultMode: "standalone"`）**：未配置外部知识库（或设 `VAULT_ROOT=none` / `VAULT_ENABLED=false`）时，工具作为独立的「微信 $\leftrightarrow$ Agent 双向收发通道与本地网页归档器」运行。文章原文、防盗链图片与阅读笔记自动保存在本地归档目录；深读与推送时无需查找外部知识库节点，也无需读取任何知识库治理文件。
2. **通用文件夹模式（`vaultMode: "generic_folder"`）**：`VAULT_ROOT` 指向任意普通 Markdown / Obsidian 文件夹（无需 `00_home` 等编号目录），按需检索该目录下的 `.md` 笔记。
3. **结构化知识库模式（`vaultMode: "structured_vault"`）**：当 `VAULT_ROOT` 下存在 `00_home/`、`AGENTS.md` 等结构化约定文件时，自动联动主线焦点与关联节点。

## 查看与定位：默认不触发同步

用户说“看看我转的文章”“最近有哪些待深读的文章”时，先执行：

```bash
bun run {{PROJECT_ROOT}}/src/cli.ts list --json
bun run {{PROJECT_ROOT}}/src/cli.ts show <id> --json
```

汇报 ID、标题、作者、批注 `user_notes`、处理状态 `status` / `process_level`、分诊 `triage`、关联节点（若有），以及 `error_message`（如有）。列表默认最近 20 篇，可用 `--limit` 调整；不要把这 20 篇称为全部文章。

**不要因怀疑有新消息而自动运行 `sync`。** 查看本地收件箱不会拉取微信、调用模型、写文件或发送回执。没有找到目标时说明当前本地记录范围；用户已明确要求同步时直接执行同步。

## 同步、绑定与手动导入

```bash
# 本地配置自检（查看 vaultMode、落盘路径及收发队列状态）；不会验证 token 当前有效
bun run {{PROJECT_ROOT}}/src/cli.ts doctor --json
# 仅用户要求首次连接或更换绑定时使用，扫码由用户完成
bun run {{PROJECT_ROOT}}/src/cli.ts login
# 用户明确要求同步时执行
bun run {{PROJECT_ROOT}}/src/cli.ts sync --json
# 用户明确要求将公众号或外部网页链接抓取归档并初筛时使用
bun run {{PROJECT_ROOT}}/src/cli.ts ingest "<https://mp.weixin.qq.com/s/...>" --note "<关注点>" --json
```

`sync` 是有副作用的操作：接收消息、推进持久游标、抓取新文章和图片、调用已配置模型、写入本地归档/知识库、向原发送者发送接收/处理回执。对明确的同步请求，这些是该流程的预期动作；不要把它用于仅查看或检查状态的请求。手动 `ingest` 会抓取、分析并落盘，但不发送微信回执。仅要求在聊天里阅读链接时，不据此推定用户要求入库。

后台运行入口为 `src/server.ts`（可通过 `bash scripts/install_daemon.sh` 安装常驻守护服务）。守护进程与 CLI 共用数据库；遇到 `Operation busy: sync` 表示后台正在同步，不要启动更多实例争抢。

Agent 队列另由 `agent_queue` 跨进程锁串行恢复和消费；`list/show/doctor` 不重置进行中的任务。升级前先停止旧 worker，再启动新版，不能与尚未使用该锁的旧版混跑。安装器复制并渲染本 Skill，项目更新后已安装副本不会自动更新。

## 主动推送信息与文件到手机微信（Push）

当用户在 Codex 或 Antigravity 中明确要求“把这个结论/信息发到我微信上”“把这篇笔记/报告/图片推送到微信”“生成 MD/HTML/PDF 发我微信”时，使用 `push`（别名 `send`），**该功能完全独立于知识库**：

```bash
# 1. 直接推送文本信息、总结或通知（长文本或多行含特殊字符建议用 --stdin）
bun run {{PROJECT_ROOT}}/src/cli.ts push --text "<要发送的文本内容>" --json
cat <<'EOF' | bun run {{PROJECT_ROOT}}/src/cli.ts push --stdin --json
<多行文本或总结内容>
EOF

# 2. 推送任意本地文件或图片（自动识别 .png/.jpg/.jpeg/.gif/.webp 为微信原生图片，其余为微信文件附件，经 C2C AES-128-ECB 加密上传）
bun run {{PROJECT_ROOT}}/src/cli.ts push --file "<文件绝对路径>" [--text "<附带说明>"] --json

# 3. 将任意 Markdown 文件（或 --stdin 内容）自动编译为多格式（md / html / pdf）并一并推送到微信
bun run {{PROJECT_ROOT}}/src/cli.ts push --file "<note.md 绝对路径>" --formats md,html,pdf [--text "<导读说明>"] --json

# 4. 推送收件箱中某篇文章的初筛摘要或伴读笔记（可加 --with-file 或 --formats md,html,pdf）
bun run {{PROJECT_ROOT}}/src/cli.ts push --article <id> [--with-file] [--formats md,html,pdf] --json
```

- **仅在用户明确要求推送微信时执行 `push`**；常规本地查看、深读或问答不要自动向微信发消息。
- `push` 默认通过 `reply_outbox` 持久队列入队并立即尝试发送（若守护进程正占用 `outbox` 锁会自动短暂等待重试），同时在 `conversation_turns` 记录本次推送上下文与文件路径，支持用户随后在手机微信端直接追问或引用刚推送的文件。
- 执行后必须核对 JSON 返回的 `ok`、`sentCount`、`failedCount`、`missingFormats` 与 `items[].status`。若任何条目为 `failed`/`pending` 或缺少请求格式（如本机无 Chromium 导致 `pdf` 未生成），必须如实报告，不得宣称“已全部成功发送到微信”。
- v0.2.3 起，媒体入队保存内容快照，发送前核验摘要；旧版无摘要的待发媒体需重新入队，不能靠改源文件修复已入队内容。快照保存在数据库同目录的 `outbox_media/`，不会自动清理；不要让旧版与新版共用数据库发送媒体。
- `push` 显式提供的历史文件仍保留在发送列表，即使同时生成当前版本；只需当前版本时仅传当前 Markdown。此历史文件约定未变更。
- 文件追问必须定位到会话产物、明确文章或查询结果，不能拿当天目录里看似相关的文件代替。多份 Markdown 的显式格式请求逐份处理；已有 Markdown 与另传正文不一致时拒绝导出，应提供新的源文件。
- CLI 超时或非零退出，即使有日志或产物也视为失败。任务业务失败记录为 `failed`；部分格式完成仍为 `done`，但阶段和 `missingFormats` 标明缺失，不能把它表述为全部完成。PDF 只经过头尾基本完整性检查，仍需独立查看排版效果。

## 文件保护与重试语义

- **已有原文和伴读笔记不自动覆盖、不移动、不批量改名。** 数据库已有路径继续沿用；新文章通过 URL 稳定标识区分，避免同日中文标题或模型 slug 重名覆盖。
- 重复投递、重新 `ingest`、补充文字或语音批注，会保留已有文件与深读状态。批注保存在数据库 `user_notes`，不自动重新生成 `_note.md`。深读时应同时读取批注。
- 每次 CLI `idea [<id>] "<想法>"` 创建独立文件。手机“想法：...”使用消息标识去重，重放同一条消息不会重复创建想法。
- 消息批次与下一游标在同一 SQLite 事务中保存，随后处理持久收件箱。处理失败的消息保留并在后续同步重试，不能承诺服务端永久保留消息或任何情况下绝不丢失。
- 微信回执使用独立持久发送队列，最多自动尝试 3 次，重试复用同一客户端 ID。网络中断可能使远端送达结果不确定；不要宣称端到端严格只发送一次。`doctor --json` 的 `deliveryErrors`、`inboxErrors`、`lastPoll` 可查看失败记录；凭证 `configured` 不等于已联网验证。
- 抓取/分析失败的文章保留 `failed` 和错误，可在排除原因后对原 URL 再次 `ingest`；不要删除文章文件来“重试”。已完成或已有笔记的文章不会由此重写。
- 入站附件路径包含原名与内容 SHA-256：同名不同内容分别保存，相同内容重放复用。不要自行按原始文件名猜测已存路径。
- Markdown 导出的 HTML/PDF 路径含内容版本摘要；正文或嵌入的本地图片变化会生成新版本，旧导出保留。请求多格式时逐项补齐，已有 MD 不表示 HTML/PDF 已满足；PDF 生成失败不能用旧 PDF 冒充当前结果，核对返回的 `missingFormats` 和用户可见提示。显式指定历史导出时只配对同一版本，不附带已改写的当前 MD。
- AGY 生图只收集明确返回或本次预期路径的文件，真实路径须在允许的生成目录或知识库内；不扫描共享 generated/brain 目录。AGY 应将图片复制到提示指定路径，超时、非零退出或生图没有可归属图片均按失败处理。未知模型去掉 `--model` 重试后标记 default/unknown，不能宣称仍是原模型。
- `TASK_HEARTBEAT_SECONDS=0` 关闭定时进度，阶段通知仍保留；显式秒配置优于旧 `TASK_HEARTBEAT_MS`。普通启动、重载和配置工作台统一项目 `.env` > 进程环境 > home `.env`，`IGNORE_HOME_DOTENV=true` 仅跳过 home 文件。
- Agent 任务 `done` 表示执行完成、回执入队，不代表微信已送达。恢复中断任务可能重试已发生的外部动作，不能宣称严格只执行一次。
- 本地 HTTP 仅监听 `127.0.0.1`，校验 Host/Origin 和 URL。外部抓取拒绝已覆盖的私网 IP 字面量及重定向目标，但没有 DNS 地址绑定，不能视为完整的 SSRF 隔离。不要自行改成全网监听。

## 文章深读与观点沉淀（自适应有无知识库）

1. 用 `list/show --json` 定位文章，读取实际 `source_md_path`、`note_md_path` 和最新 `user_notes`。先检查文章是否已成功抓取，不把失败或空路径记录视为完整原文。
2. 原文是证据；正文不改。深读只在用户请求范围内追加/合并伴读笔记（`_note.md`），保留已有分析，不整文件替换。
3. 检查正文引用的关键图片。图片下载可能失败并保留远程链接；无法查看时明确说明，不编造图中信息。
4. **按 `vaultMode` 自适应处理关联上下文**：
   - **无知识库模式（`standalone`）**：直接围绕文章核心论点、关键证据、逻辑局限与用户 `user_notes` 开展深读，无需检索外部知识库节点。
   - **有知识库模式（`generic_folder` / `structured_vault`）**：解析 `related_vault_nodes` JSON 数组并查找实际存在的笔记（不存在的节点不作为证据）；若目标知识库目录中存在 `AGENTS.md` 或目录级 `instruction.md`，先读取并遵守其规范。
5. 区分作者观点、用户既有观点、当前分析与待验证假说。用户确认或讨论形成个人判断后，可执行 `idea [<id>] "<想法>"` 沉淀想法，不要把模型候选观点冒充用户观点。
6. 确认伴读笔记更新成功，再按实际分诊执行：

```bash
bun run {{PROJECT_ROOT}}/src/cli.ts triage <id> <keep_raw|reference|process_later|process_now> --level deep
```

`triage` 会显式修改原文与伴读笔记的 **frontmatter** 和数据库状态，保留正文。`deep` 与 `triage` 是不同维度，不必将每篇深读文章都改成 `reference`。执行后用 `show --json` 与文件内容核对结果；写入失败应报告，不宣称完成。

手机端 `deepen` 的模型回答不会自动重写 `_note.md` 或把 `process_level` 升级为 `deep`；桌面 Agent 应在实际更新笔记后才标记完成。

## 能力与验证边界

ClawBot 接口由本地代码实现；语音仅在接口已提供转写文本时可读。公众号抓取先尝试 HTTP，再尝试本机已有 Chrome 类浏览器；验证码、删除文章、网络异常可能导致失败。外部网页的 Jina Reader 兜底默认关闭；开启 `ALLOW_JINA_FALLBACK=true` 会把包含查询参数的完整 URL 发给第三方，实际来源记录为 `jina_reader`。

图片与受支持的小型文本附件可提供给 API 模型；PDF 等附件目前没有内置正文解析器。先尝试能读取本地附件的 CLI；CLI 不可用或失败时，保留文件和“已归档，未解析”说明，不用只有路径的提示词生成内容提炼。混合附件中只要包含 API 无法读取的文件，也不能声称 API 已分析全部内容。

模型配置按 `LLM_API_KEY`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`GEMINI_API_KEY` 顺序选择。文章初筛失败可使用启发式摘要，其他任务不保证相同降级行为；联网搜索失败可重试 Fast 搜索，仍失败就报告错误，不冒充搜索成功。Gemini 搜索请求保留图片输入。回执长度没有严格的 300 字保证。

回归验证：`bun test {{PROJECT_ROOT}}/tests`。测试使用临时目录/数据库与模拟微信、模型响应，不读取真实知识库、不发送真实微信。监听边界测试需要允许本机随机端口监听。
