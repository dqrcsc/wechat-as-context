# WeChat as Context (`wechat-as-context`)

[![Runtime: Bun >= 1.1](https://img.shields.io/badge/Runtime-Bun_%E2%89%A51.1-f472b6?logo=bun&logoColor=white)](https://bun.sh)
[![Pure BYOK & BYOCLI](https://img.shields.io/badge/Pure_BYOK_%26_BYOCLI-Zero_Model_Lock--in-4f46e5)](./src/config.ts)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Protocol: WeChat ClawBot iLink](https://img.shields.io/badge/WeChat-ClawBot_iLink-07c160?logo=wechat&logoColor=white)](./docs/ilink_protocol_and_extension_guide.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> **把手机微信里的「高频阅读、语音批注与随时闪念」，变成个人知识库与桌面 AI 智能体（Codex / AntiGravity / Claude Code / OpenCode）可随时调用的活上下文（Living Context）。**  
> **坚持「零内置模型锁定」的纯粹开放 BYOK（Bring Your Own Key）与 BYOCLI（Bring Your Own CLI）设计**——只要你手头拥有任意大模型平台的 API Key 或本机已安装的 AI Agent CLI，即可一键打通手机微信与本地第二大脑。

`wechat-as-context` 不是又一个孤立的「稍后读」收藏夹。它通过微信官方 **ClawBot iLink 长轮询协议**，将你个人微信置顶的 **`微信ClawBot [AI]`** 变成连接手机端与本地电脑的**双向智能体上下文网关**：

- 📱 **在手机微信端**：顺手转发公众号文章或外部网页、追加语音/文字批注、记录灵感闪念、发送截图/PDF、向本地知识库提问、或遥控本机 AI Agent（`agy` / `codex` / `opencode` / `claude`）执行深度研究并回传 `.md` / `.html` / `.pdf` 文件或架构配图。
- 💻 **在电脑桌面端**：在 Codex、AntiGravity、Claude Code、OpenCode 中一句指令即可接力深读刚转发的文章，或通过 `bun run push` 将桌面端产出的报告、图表、文档主动推送到手机微信，且自动注入微信对话上下文，手机端直接回复即可无缝追问。

---

**v0.2.1 升级与使用边界声明**：
- **本轮可靠性修复与升级**：见 [修复说明与验收](./docs/reliability-fixes.md)。升级前先停止旧 worker，避免没有 Agent 队列锁的旧版与新版同时运行。
- **BYOK 连通性验证**：配置密钥或选择模型预设不代表该模型的长文本、多模态视觉或实时联网能力已在你的账户下开通；首次配置后请在 Web 配置工作台（`bun run config`）点击 **「⚡ 测试模型连通性」** 做一次真实请求验证。
- **双协议能力差异**：实时联网搜索（Google Search Grounding）原生支持 Google Gemini 协议（`/v1beta/models/*:generateContent`）或具备内置联网能力的本地 CLI（如 `agy` / `codex` / `opencode` / `claude`）；普通纯文本 OpenAI 兼容端点默认基于本地知识库与抓取正文回答，不代表实际执行了联网检索。
- **多模态图片与 PDF 解析**：微信发送图片/截图解析要求所配置的模型支持 Vision 输入（如 `gemini-2.5-flash`、`gpt-4o`、`qwen-vl-max`、`glm-4v-plus`）或启用支持读图的本机 CLI。PDF 和其他未转换为 API 可读正文的附件仅尝试本地 CLI；CLI 禁用或失败时会明确返回「已归档，未解析」，不会把没有正文的 API 回答当成文件摘要。混合附件包含不可读文件时，也不会将局部结果冒充完整分析。
- **本机直连与数据隐私边界**：所有 API Key、微信 `bot_token` 与 SQLite 状态库均 100% 存储在你的本机（`.env` 与 `data/`），本项目**不提供自建中转服务器**。普通网页第三方 Jina Reader 回退默认关闭，显式设置 `ALLOW_JINA_FALLBACK=true` 后，抓取失败时会将完整 URL（含 query）交给 Jina；配置通知 webhook 时还会发送事件摘要。你转发的链接正文、语音转写文本、图片或关联的本地笔记片段会随请求直接发往你所配置的模型 API Endpoint 或本机 CLI 处理。

---

## 📑 目录

- [核心特性](#-核心特性)
- [纯粹开放 BYOK / BYOCLI 理念与多模型协议说明](#-纯粹开放-byok--byocli-理念与多模型协议说明)
  - [核心设计原则：无内置绑定，100% 释放自有 API 与 CLI 潜力](#1-核心设计原则无内置绑定100-释放自有-api-与-cli-潜力)
  - [双协议自适应通信引擎（Gemini 原生协议 + OpenAI 兼容协议）](#2-双协议自适应通信引擎gemini-原生协议--openai-兼容协议)
  - [主流大模型服务商 BYOK 协议与能力速查表](#3-主流大模型服务商-byok-协议与能力速查表)
  - [本机 AI Agent CLI (BYOCLI) 路由与能力速查表](#4-本机-ai-agent-cli-byocli-路由与能力速查表)
- [系统架构与工作流](#-系统架构与工作流)
- [三种知识库存储模式](#-三种知识库存储模式)
- [5 分钟快速开始](#-5-分钟快速开始)
- [手机微信端 8 大交互场景](#-手机微信端-8-大交互场景)
- [电脑端 AI Agent 协同与主动推送 (`push`)](#-电脑端-ai-agent-协同与主动推送-push)
- [可视化配置工作台 (Web Config Studio)](#-可视化配置工作台-web-config-studio)
- [CLI 命令行参考](#-cli-命令行参考)
- [本地 HTTP API 接口](#-本地-http-api-接口)
- [环境变量说明 (`.env`)](#-环境变量说明-env)
- [可靠性与权威存储保障 (Authoritative Storage)](#-可靠性与权威存储保障-authoritative-storage)
- [测试与开发](#-测试与开发)
- [许可证](#-许可证)

---

## ✨ 核心特性

- **🔌 零公网 IP、零反向代理、扫码即用**
  基于微信官方 iLink Bot 协议（`https://ilinkai.weixin.qq.com`）出站长轮询（`getupdates`），无需公网服务器、无需内网穿透、无需申请企业微信或公众号后台密钥。终端运行 `bun run login` 用个人微信扫码即可完成绑定。
- **🧠 两阶段阅读闭环 + 10 秒批注合并窗口**
  转发公众号或外部网页链接后，系统开启可配置的批注等待窗口（默认 `10s`），自动将你紧接着发出的语音（自动提取微信原生语音转写 `voice_item.text`）或文字思考与文章合并：
  - **第一阶段（手机端 10 秒异步初筛）**：净化提取公众号 `#js_content` 正文、自动下载防盗链高清图片至本地 `assets/`、结合你的本地知识库（`now.md`、已有主题笔记与闪念）生成双文件（`<slug>.md` 原文存档 + `<slug>_note.md` 伴读笔记），并在微信回推 **150 字结构化初筛卡**（`💡 为什么值得深读` / `⏭️ 为什么可略读` / `🔥 关联你的动态`）。
  - **第二阶段（电脑端或微信追问深读）**：对某篇文章感兴趣时，可在微信直接「引用回复」该回执追问，或在电脑端对 AI Agent 说 *“深度阅读刚才转发的公众号文章”*，手机追问只返回分析；桌面 Agent 实际更新伴读笔记后，再显式设置 `process_level: deep`。
- **⚡ 四级智能体分层路由链（Router $\rightarrow$ Local CLI $\rightarrow$ Pro $\rightarrow$ Fast）**
  1. **轻量意图路由 (`fastModel`)**：毫秒级识别入站消息意图、槽位参数与任务复杂度（`fast` / `deep`）。
  2. **Tier 1 本机 AI Agent CLI 路由链**：支持自动扫描并按自定义优先级调度本机安装的 `agy` (AntiGravity)、`codex`、`opencode`、`claude` (Claude Code)、`gemini`、`workbuddy` 及自定义 CLI 工具，直接共享本地文件系统与联网/绘图能力。
  3. **Tier 2 深度模型 (`proModel`)**：当本地 CLI 未启用或不可用时，复杂任务自动交由高阶推理模型（如 `gemini-2.5-pro` / `deepseek-reasoner` / `claude-opus-4-6`）执行。
  4. **Tier 3 快速模型兜底 (`fastModel`)**：当高阶模型限流或超时，自动无缝降级至快速模型（如 `gemini-2.5-flash` / `deepseek-chat`）文章初筛另有启发式兜底；其他任务仍可能失败，错误会保留，不能保证所有能力均可降级。
- **🔐 微信 C2C 媒体双向 `AES-128-ECB` 加解密与多格式文档投递**
  完整实现微信 iLink CDN 媒体加解密协议（兼容 16 字节原始密钥与 32 字符 Hex ASCII 双编码格式）：
  - **入站**：手机微信发送截图、照片、PDF、文档，自动解密归档；图片/文本可提交给支持的 API，PDF 需由可读取文件的 CLI 处理，失败则明确保留为未解析；
  - **出站**：支持将知识库笔记或即时生成的报告一键渲染导出为 **Markdown (`.md`) + 现代排版网页 (`.html`) + 印刷级矢量 PDF (`.pdf`)**，加密上传后直接发回你的手机微信聊天框。
- **⏳ 长耗时任务实时心跳播报与并发进度查询**
  当本机 Agent 执行耗时较长的深度调研或长文生成时，微信端自动维护「对方正在输入...」状态（`sendtyping`），每隔固定周期主动推送阶段性进展心跳，且支持随时发送 *“还在跑吗”*、*“进度”* 查看已运行耗时与当前阶段。异步 Agent 队列与长轮询分开调度，但同步浏览器抓取、文件扫描仍可能短暂阻塞事件循环。

---

## 🔑 纯粹开放 BYOK / BYOCLI 理念与多模型协议说明

### 1. 核心设计原则：无内置绑定，100% 释放自有 API 与 CLI 潜力

在实际科研、开发与知识管理中，每位用户手头的模型订阅各不相同：
- 有的用户在 **DeepSeek**、**阿里云百炼 (DashScope)**、**硅基流动 (SiliconFlow)**、**Moonshot (Kimi)** 或 **智谱 GLM** 拥有高性价比的国产大模型 API Key；
- 有的用户在 **Google AI Studio (Gemini)**、**OpenAI**、**OpenRouter**、**Anthropic** 或 **OpenCode Go / Zen** 拥有多模态与海外旗舰模型额度；
- 有的开发者已经在桌面端安装并登录了 **AntiGravity (`agy`)**、**Codex (`codex`)**、**Claude Code (`claude`)**、**OpenCode (`opencode`)** 等本地 AI Agent CLI；
- 还有的团队在本地或内网部署了 **OneAPI / NewAPI / LiteLLM / Ollama / vLLM** 私有聚合网关。

因此，本项目在 [`src/config.ts`](./src/config.ts) 与 [`src/agent/llm.ts`](./src/agent/llm.ts) 中确立了四条核心 **BYOK (Bring Your Own Key) & BYOCLI (Bring Your Own CLI)** 准则：

1. **零供应商锁定（Zero Vendor Lock-in）**：内置 11 组主流服务商连接模板与 6 大本地 CLI 探针，仅预填官方通信协议与默认 Base URL，用户可随时自由切换、修改 Base URL 或手动输入任意私有/微调模型 ID。
2. **本机已有密钥自动探测复用**：若你的系统环境变量或 `~/.env` 中已配置过 `GEMINI_API_KEY`、`DEEPSEEK_API_KEY`、`OPENCODE_API_KEY`、`OPENAI_API_KEY`、`OPENROUTER_API_KEY` 等，启动时会自动检测并挂载，免去重复粘贴。
3. **跨服务商 Fast / Pro 异构模型自由混搭（`<providerId>::<modelId>` 协议）**：支持在 `LLM_PROVIDERS_CONFIG` 中同时保存多家服务商的独立 API Key 快照，并通过 `<providerId>::<modelId>` 语法将不同厂商组合进同一工作流——例如：
   - **轻量路由与日常初筛 (`LLM_FAST_MODEL`)**：配置 `deepseek::deepseek-chat` 或 `gemini::gemini-2.5-flash`，实现毫秒级低成本意图识别与文章初筛；
   - **深度推理与跨笔记综合 (`LLM_PRO_MODEL`)**：配置 `gemini::gemini-2.5-pro`、`deepseek::deepseek-reasoner` 或 `openrouter::anthropic/claude-3.7-sonnet`，专门处理高复杂度知识库推演。
4. **从本机连接所选服务**：API Key 可来自本机 `.env` 或环境变量，请求由 Bun 发往配置的 API Endpoint；项目不提供自建模型中转。是否经过第三方网关取决于所选服务商和 Base URL。外部网页的 Jina 兜底另由 `ALLOW_JINA_FALLBACK` 控制。

---

### 2. 双协议自适应通信引擎（Gemini 原生协议 + OpenAI 兼容协议）

底层模型调用引擎（[`src/agent/llm.ts`](./src/agent/llm.ts)）同时实现了 **OpenAI 兼容协议** 与 **Google Gemini 原生协议**，并根据任务需求自动切换与降级：

- **协议 A：OpenAI 兼容协议 (`POST {baseUrl}/chat/completions`)**
  - **适用范围**：全部 11 家内置服务商预设（含 Gemini 的 `/v1beta/openai` 兼容层、DeepSeek、OpenCode Go、OpenAI、OpenRouter、百炼、硅基流动、Kimi、智谱、Anthropic 兼容层及自定义 OneAPI / Ollama 网关）。
  - **结构化 JSON 路由 (`jsonMode`)**：在意图识别（[`src/agent/router.ts`](./src/agent/router.ts)）阶段自动注入 `response_format: { type: "json_object" }`，并内置 `parseJsonSafe` 自动剥离部分模型包裹的 ```` ```json ... ``` ```` 代码块。
  - **多模态图像理解 (`images`)**：当用户在微信发送图片或截图时，自动将解密后的本地图片编码为标准 OpenAI Vision `image_url`（`data:image/jpeg;base64,...`）多模态消息负载。
- **协议 B：Google Gemini 原生 Grounding 协议 (`POST /v1beta/models/{model}:generateContent`)**
  - **适用范围**：当检测到当前端点为 Google Gemini（`providerId === "gemini"` 或 `generativelanguage.googleapis.com`）且任务需要实时外部信息（`enableSearch: true`）时自动激活。
  - **原生联网搜索 (`google_search`)**：自动剥离 `/openai` 后缀切换至 Gemini 原生 `generateContent` 接口，挂载 `tools: [{ google_search: {} }]`，并从响应的 `groundingMetadata` 中提取真实搜索词（`webSearchQueries`）与参考网页标题及链接（`groundingChunks`），附加在微信回复末尾；若原生联网接口受限，deep 请求可降至 fast 模型重试搜索；仍失败则报告错误，不静默变成没有搜索证据的回答。搜索请求会保留图像输入。

---

### 3. 主流大模型服务商 BYOK 协议与能力速查表

下表整理了内置 11 大服务商模板（详见 [`LLM_PROVIDER_PRESETS`](./src/config.ts)）的接口协议、默认 Base URL、自动识别的环境变量名、推荐模型示例及支持能力范围：

| 服务商 ID (`LLM_PROVIDER`) | 接口通信协议 | 默认 API Base URL | 专属环境变量名（自动探测） | Fast / Pro 模型填写示例 | 文章初筛 / 知识库问答 / 意图路由 | 微信图片/截图多模态解析 | 原生实时联网搜索 (Grounding) |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: |
| **`gemini`** (Google Gemini) | OpenAI 兼容 + Gemini 原生双协议 | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `gemini-2.5-flash` / `gemini-2.5-pro` | ✅ 支持 | ✅ 原生多模态 | ✅ 原生 `google_search` |
| **`deepseek`** (深度求索) | OpenAI 兼容协议 | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | `deepseek-chat` / `deepseek-reasoner` | ✅ 支持 | ⚠️ 纯文本模型不支持看图 | 需配合本机 CLI |
| **`opencode`** (OpenCode Go / Zen) | OpenAI 兼容协议 | `https://opencode.ai/zen/v1` | `OPENCODE_API_KEY` / `OPENCODE_GO_API_KEY` | `glm-5.1` / `claude-sonnet-4-5` / `kimi-k2.5` | ✅ 支持 | 视所选模型而定 | 视所选模型/CLI而定 |
| **`openai`** (OpenAI 官方) | OpenAI 兼容协议 | `https://api.openai.com/v1` | `OPENAI_API_KEY` | `gpt-4o-mini` / `gpt-4o` / `gpt-4.1` | ✅ 支持 | ✅ 视觉模型支持 | 需配合本机 CLI |
| **`openrouter`** (OpenRouter) | OpenAI 兼容协议 | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `google/gemini-2.5-flash` / `anthropic/claude-3.7-sonnet` | ✅ 支持 | ✅ 选视觉模型支持 | 选 `:online` 模型或配合 CLI |
| **`dashscope`** (阿里云百炼) | OpenAI 兼容协议 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | `qwen-plus` / `qwen-max` / `qwq-plus` | ✅ 支持 | ✅ 选 `qwen-vl-*` 支持 | 需配合本机 CLI |
| **`siliconflow`** (硅基流动) | OpenAI 兼容协议 | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` | `deepseek-ai/DeepSeek-V3` / `deepseek-ai/DeepSeek-R1` | ✅ 支持 | ✅ 选 `Qwen2.5-VL` 支持 | 需配合本机 CLI |
| **`moonshot`** (Kimi 开放平台) | OpenAI 兼容协议 | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | `kimi-k2-0711-preview` / `kimi-thinking-preview` | ✅ 支持 | ✅ 选 Vision 模型支持 | 需配合本机 CLI |
| **`zhipu`** (智谱 BigModel) | OpenAI 兼容协议 | `https://open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` | `glm-4-flash` / `glm-4-plus` | ✅ 支持 | ✅ 选 `glm-4v-*` 支持 | 需配合本机 CLI |
| **`anthropic`** (Claude 兼容层) | OpenAI 兼容协议 | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | `claude-3-5-haiku-latest` / `claude-3-7-sonnet-latest` | ✅ 支持 | ✅ 原生支持 Vision | 需配合本机 CLI |
| **`custom`** (OneAPI / Ollama 等) | OpenAI 兼容协议 | 自定义（如 `http://localhost:11434/v1`） | `LLM_API_KEY` | 填写网关或本地部署的任意模型名 | ✅ 支持 | 视具体模型而定 | 视具体网关而定 |

---

### 4. 本机 AI Agent CLI (BYOCLI) 路由与能力速查表

除了直接调用 HTTP LLM API，本项目还独创了 **Tier 1 本机 AI Agent CLI 路由链**（[`src/agent/subagent_cli.ts`](./src/agent/subagent_cli.ts)）。只要你本机安装了以下任一 CLI 工具，即可在 `CLI_ROUTING_CHAIN` 中按优先级组合调用，一旦首选 CLI 超时或离线，自动平滑顺延至链条中的下一个 CLI：

| CLI 标识 (`id`) | 工具名称 | 默认探测命令 | 路径覆盖环境变量 | 核心能力与适用场景 |
| :--- | :--- | :--- | :--- | :--- |
| **`agy`** | Google AntiGravity CLI | `agy` | `AGY_BIN` | 支持子智能体生图 (`image-generator`)、跨文件深度推理、实时联网检索与多模态读图 |
| **`codex`** | OpenAI Codex CLI | `codex` (`exec --skip-git-repo-check`) | `CODEX_BIN` | 支持本地知识库批量巡检、跨目录笔记重构、脚本执行与自动化归档 |
| **`opencode`** | OpenCode CLI | `opencode` (`run --format json`) | `OPENCODE_BIN` | 支持结构化 JSON 事件流输出、长程知识库分析与多工具协同 |
| **`claude`** | Anthropic Claude Code CLI | `claude` (`-p --permission-mode bypassPermissions`) | `CLAUDE_BIN` | 擅长深度文章批判拆解、长文写作与复杂结构化文档合成 |
| **`gemini`** | Google Gemini CLI | `gemini` (`-p`) | `GEMINI_BIN` | 轻量快速的本地命令行问答与搜索增强 |
| **`workbuddy`** | WorkBuddy / CodeBuddy CLI | `workbuddy` / `codebuddy` / `cbc` | `WORKBUDDY_BIN` | 兼容桌面端 WorkBuddy.app 内置 CLI 通道与本地工作区分析 |
| **自定义 CLI** | 任意命令行 Agent (`CUSTOM_CLI_AGENTS`) | 用户自定义可执行文件路径 | 在 Web 配置台添加 | 支持通过 `{{prompt}}`、`{{model}}`、`{{workdir}}` 模板占位符接入任意自研 CLI |

---

## 🏗 系统架构与工作流

```mermaid
flowchart TB
    subgraph Mobile["📱 手机个人微信 (微信ClawBot [AI])"]
        M1["转发公众号 / 外部网页链接\n+ 10秒内追加语音/文字批注"]
        M2["随时发语音 / 文字记录闪念\n或向本地知识库提问"]
        M3["发送图片 / 截图 / PDF\n或要求生成图表与 MD/HTML/PDF 报告"]
    end

    subgraph Gateway["⚙️ wechat-as-context 本地常驻服务 (Bun + SQLite WAL)"]
        C1["ClawBot iLink Client\ngetupdates 长轮询 | sendtyping 状态\nC2C CDN AES-128-ECB 双向加解密"]
        DB[("SQLite 状态库\ninbound_messages\narticles | agent_tasks\nreply_outbox\nconversation_turns")]
        R1["双层意图路由器 (src/agent/router.ts)\n8 大核心意图识别 + 复杂度评估"]
        T1["四级分层执行引擎 (src/agent/subagent_cli.ts)\nTier 1: 本机 CLI 路由链 (agy -> codex -> opencode -> claude)\nTier 2: Pro 深度模型 | Tier 3: Fast 快速模型"]
    end

    subgraph Storage["📂 本地权威存储 (三种模式自适应)"]
        V1["模式 A: 独立模式 (VAULT_ROOT=none)\ndata/archive/{wechat,ideas,inbox}"]
        V2["模式 B: 通用文件夹模式\n任意 Obsidian / Markdown 目录"]
        V3["模式 C: 结构化第二大脑模式\n00_home | 01_inputs | 03_ideas | 04_topics"]
    end

    subgraph Desktop["💻 桌面端 AI Agents (Codex / AntiGravity / Claude Code / OpenCode)"]
        D1["全局 Skill: wechat-as-context\n深读接力 / 批次初筛 / 跨笔记综合"]
        D2["主动推送 CLI / HTTP API\nbun run push / POST /api/push"]
    end

    M1 & M2 & M3 <-->|"iLink HTTPS 长轮询 & 加密媒体传输"| C1
    C1 <-->|"原子事务入库 & 幂等回执队列"| DB
    DB --> R1 --> T1
    T1 <-->|"检索上下文 [[WikiLink]] & 幂等写入原文/伴读笔记"| V1 & V2 & V3
    D1 <-->|"读取原文/高清配图 & 升级 _note.md"| V1 & V2 & V3
    D2 -->|"推送文本/图片/MD/HTML/PDF 并同步对话历史"| C1
```

---

## 🗂 三种知识库存储模式

本项目**不强制绑定任何特定目录结构**，支持根据你的使用习惯自由选择三种模式（可在 Web 配置工作台中一键切换）：

| 模式 | 配置方式 | 适用人群与行为说明 |
| :--- | :--- | :--- |
| **1. 无知识库独立模式 (`standalone`)** | `VAULT_ROOT=none`（或 `VAULT_ENABLED=false`） | 无需 Obsidian 或外部知识库。资料默认归档在 `data/archive/{wechat,web,ideas,inbox,papers}/`；模型、CLI 与 PDF 浏览器能力仍取决于本机配置。 |
| **2. 通用文件夹模式 (`generic_folder`)** | `VAULT_ROOT=/path/to/any/folder` | **适配任意现有 Obsidian 库或普通笔记目录**：无需 `00_home`、`01_inputs` 等编号子目录。系统直接在你指定的文件夹下按需检索 `.md` 上下文，不会强行改写你原有的目录结构。 |
| **3. 结构化知识库模式 (`structured_vault`)** | `VAULT_ROOT=./vault`（或指向含编号体系的知识库） | **深度第二大脑工作流**：支持 `00_home/now.md`（近期主线）、`01_inputs/articles/{wechat,web}/`、`01_inputs/inbox/`、`03_ideas/seeds/`、`04_topics/`、`05_outputs/` 等分层结构，自动提取近期关注主题词并生成双向 `[[WikiLink]]` 关联。 |

---

## 🚀 5 分钟快速开始

### 前置要求

- **操作系统**：macOS 或 Linux（Windows 可通过 WSL2 运行）
- **运行时**：[Bun](https://bun.sh) `>= 1.1.0`
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

### 第一步：克隆仓库与一键初始化

```bash
git clone https://github.com/dqrcsc/wechat-as-context.git
cd wechat-as-context
bun install

# 一键初始化：自动生成 .env、按需初始化目录、安装全局 Agent Skill、扫描本机 CLI 并打开可视化配置台
bun run setup
```

> 💡 如果在无图形界面的服务器或终端环境下运行，可使用 `bun run setup -- --no-open` 仅在命令行完成初始化。

### 第二步：扫码绑定个人微信 `微信ClawBot [AI]`

```bash
bun run login
```

终端会直接渲染二维码，打开**手机个人微信扫一扫**确认授权：
- 凭据会自动安全保存在本地 SQLite `data/wechat_context.db` 的 `kv_state.clawbot_credentials`（已列入 `.gitignore`）；
- 你的微信聊天列表中会出现置顶的 **`微信ClawBot [AI]`** 对话框。

### 第三步：自检并启动常驻服务

```bash
# 检查本地配置、队列与凭据是否存在；不会验证 API 或微信连接
bun run doctor

# 前台启动服务（默认监听 127.0.0.1:8787 并开启微信长轮询）
bun run start
```

如果你使用的是 **macOS**，推荐一键安装为用户级 `launchd` 登录启动后台守护进程（崩溃自动拉起）：

```bash
bash scripts/install_daemon.sh
```

---

## 📱 手机微信端 8 大交互场景

绑定完成后，直接打开手机微信里的 **`微信ClawBot [AI]`** 即可使用以下全部能力（处理期间微信顶部会实时显示 **「对方正在输入...」**）：

### 1. 转发公众号或外部网页 + 语音/文字批注 (`ingest_link`)
- **操作**：在微信看到好文章 $\rightarrow$ 转发给 `微信ClawBot [AI]`（支持 `mp.weixin.qq.com` 公众号链接，以及 ArXiv、Substack、技术博客、X/Twitter 等任意外部网页 URL）$\rightarrow$ **10 秒内可紧接着发一条语音或文字批注**（如 *“这篇文章对 Agent 记忆架构的拆解很值得参考”*）。
- **效果**：
  1. 自动清洗广告与无关脚本，将正文与全部防盗链图片下载至本地 `<slug>.md` 及 `assets/`；
  2. 将你的语音/文字批注置顶写入 `<slug>_note.md` 的 `## 我的转发批注`；
  3. 结合你的本地知识库上下文，在微信回复一张 **150 字高信息密度初筛卡**（含文章编号 `#N`、核心论点、为什么值得深读/可略读、与你当前研究的关联点）。

### 2. 随时语音/文字记录灵感闪念 (`capture_idea`)
- **操作**：直接发送自然语言灵感（如 *“我突然想到可以用知识图谱约束 Agent 的长程状态漂移”*）或带前缀（`💡 ...`、`想法：...`）。
- **效果**：自动提取标题、标签与关联文章，生成独立 Markdown 种子文件存入 `03_ideas/seeds/`（或独立模式下的 `data/archive/ideas/`），绝不相互覆盖。

### 3. 快速碎片备忘归档 (`capture_inbox`)
- **操作**：发送 `记录：...`、`备忘：...` 或转发无链接纯文本片段。
- **效果**：自动归档至 `01_inputs/inbox/` 并返回入库确认。

### 4. 手机微信直接检索个人知识库与联网问答 (`vault_query`)
- **操作**：直接用自然语言提问，例如：
  - *“我之前关于本体论与上下文工程的笔记写到哪了？”*
  - *“帮我结合知识库和最新网页搜索，对比一下 GraphRAG 和 LLM Wiki 的优劣”*
- **效果**：自动穿透检索本地知识库相关笔记与 SQLite 文章索引，按需触发实时联网搜索（Google Search Grounding / Web Search），返回带 `[[WikiLink]]` 真实笔记引用的深度解答。

### 5. 微信「引用消息」精准追问与笔记升级 (`article_followup`)
- **操作**：在微信中**长按引用**之前的某条文章初筛回执（支持微信原生“引用部分文字” `partial_text`），或发送 *“详细拆解一下第 #12 篇的实验部分”*。
- **效果**：精准定位对应文章本地原文与你的知识库笔记进行深度解答，返回微信分析；不会自动改写 `_note.md`。笔记升级由桌面 Agent 在实际编辑后显式标记。

### 6. 发送图片/截图/PDF 自动解密入库与视觉解析 (`multimodal_ingest`)
- **操作**：在微信里直接发送白板照片、论文截图、架构图或 PDF 文档（可附带指令）。
- **效果**：自动通过 `AES-128-ECB` 解密微信 CDN 媒体文件，归档至本地 `assets/` 或 `papers/`，图片可调用支持 Vision 的后端；PDF 需由可读取文件的 CLI 处理，失败则明确报告已归档但未解析。

### 7. 多格式报告生成与文件直传微信 (`send_file` & `doc_exporter`)
- **操作**：在微信里发送：
  - *“把刚才那篇公众号文章的原件发给我”*
  - *“帮我整理一份个人知识库新手构建指南，生成 md、html 和 pdf 三种格式的文件发给我”*
- **效果**：内置文档排版引擎（[`src/agent/doc_exporter.ts`](./src/agent/doc_exporter.ts)）将 Markdown 子集渲染为带 CSS 样式的 `.html` 与印刷级 `.pdf`（调用本机 Chrome / Chromium / Edge / Brave；无可用浏览器时 PDF 可能缺失，需检查返回的 `missingFormats`），加密上传后直接作为微信原生文件卡片发回你的手机！

### 8. 遥控本机 AI Agent CLI 绘图与深度委托 (`generate_image` / `delegate_subagent`)
- **操作**：
  - *“帮我画一张知识工程三层架构图发给我”*
  - *“让 codex 帮我扫描整理一下知识库最近的闪念种子”*
- **效果**：自动唤醒本机配置的 CLI 路由链（如 `agy` / `codex` / `opencode` / `claude`），生成的 PNG/JPG 图片或新建的笔记文件会自动加密回传至手机微信。

---

## 💻 电脑端 AI Agent 协同与主动推送 (`push`)

### 1. 全局 Skill 自动集成 (`wechat-as-context`)
运行 `bun run setup` 时，系统会自动将 [`skills/wechat-as-context/SKILL.md`](./skills/wechat-as-context/SKILL.md) 替换项目路径占位符后复制至 `~/.codex/skills/wechat-as-context`；更新仓库不会自动更新已安装副本。
当你在桌面端使用 **Codex / AntiGravity / Claude Code / OpenCode** 时，可以直接对 Agent 说：
- *“看看我今天在微信转发了哪些公众号文章，帮我做个主题汇总”*
- *“深度精读第 #3 篇公众号文章，结合我知识库里的笔记更新 `_note.md`”*

### 2. 电脑端主动推送到手机微信 (`bun run push` / `POST /api/push`)
任何桌面端脚本或 AI Agent 都可以随时把消息、图片或文档主动推向你的手机微信，并**自动写入 `conversation_turns` 对话上下文**（你在手机微信收到后直接打字回复，Agent 就能认出你在回复刚才推送的内容）：

```bash
# 1. 主动推送一条文本汇报到手机微信
bun run push -- "已完成今日 5 篇论文综述，核心结论已写入 04_topics/"

# 2. 将一份本地 Markdown 笔记同时渲染为 .md + .html + .pdf 三种格式发到手机微信
bun run push -- "这是刚整理好的架构设计文档，请查收" --file ./vault/05_outputs/arch_guide.md --formats md,html,pdf

# 3. 推送本地图片或任意附件到手机微信
bun run push -- "最新实验结果对比图" --image ./charts/benchmark.png
```

---

## 🎛 可视化配置工作台 (Web Config Studio)

无需手改复杂的环境变量，随时运行以下命令即可在浏览器打开本地可视化配置工作台（默认 `http://127.0.0.1:8787/config`）：

```bash
bun run config
```

Web 配置工作台支持：
- **多供应商模型池管理**：内置 Google Gemini、DeepSeek、OpenCode Go / Zen、OpenAI、OpenRouter、阿里云百炼 (DashScope)、SiliconFlow、Moonshot (Kimi)、智谱 GLM、Anthropic Claude 及自定义 OpenAI 兼容端点预设，自动检测本机已有环境变量（如 `GEMINI_API_KEY`、`DEEPSEEK_API_KEY`、`OPENCODE_API_KEY`、`OPENAI_API_KEY`）。
- **跨供应商 Fast / Pro 模型混搭**：例如使用 `deepseek::deepseek-chat` 作为极速路由模型，同时使用 `gemini::gemini-2.5-pro` 作为深度分析模型。
- **一键真实连通性测试**：在页面上直接点击「⚡ 测试模型连通性」，实时验证 API Key 与模型响应延迟。
- **本机 AI Agent CLI 自动探测与拖拽排序**：一键扫描本机安装的 `agy`、`codex`、`opencode`、`claude`、`gemini`、`workbuddy` 等 CLI 可执行文件路径，自由勾选并调整 Tier 1 降级路由顺序，或添加自定义 CLI 模板（支持 `{{prompt}}`、`{{model}}`、`{{workdir}}` 占位符）。
- **系统原生文件夹选择器 & 一键安全补全子目录**：点击「📂 选择文件夹」直接唤起 macOS Finder / 系统文件夹选择窗口；点击「✨ 一键安全补全缺失子目录」仅创建缺失目录，不覆盖已有笔记文件。

---

## 🛠 CLI 命令行参考

你可以通过 `bun run src/cli.ts <command>`（或全局链接后的 `wx-ctx <command>`）执行以下操作：

| 命令 | 示例 | 功能说明 |
| :--- | :--- | :--- |
| `init` / `setup` | `bun run setup` | 一键初始化 `.env`、按需创建目录、安装全局 Skill、扫描本机 CLI 并打开配置网页（加 `--no-open` 可跳过打开浏览器） |
| `config` | `bun run config` | 启动并打开本地可视化配置工作台 (`http://127.0.0.1:8787/config`) |
| `scan-cli` | `bun run scan-cli` | 扫描本机已安装的 AI Agent CLI 工具并显示当前 Tier 1 路由链（支持 `--json`） |
| `login` | `bun run login` | 在终端生成微信 iLink 授权二维码，手机微信扫码绑定 `微信ClawBot [AI]` |
| `doctor` | `bun run doctor` | 全面诊断知识库状态、LLM 配置、SQLite 队列计数与微信绑定状态（支持 `--json`） |
| `list` | `bun run src/cli.ts list --status light_done` | 列出已抓取的文章列表（支持 `--status pending_extract\|extracting\|analyzing\|light_done\|deep_done\|failed` 与 `--limit N`） |
| `show` | `bun run src/cli.ts show 1` | 查看元数据、伴读笔记和原文路径；需要全文时读取返回的 `source_md_path` |
| `ingest` | `bun run src/cli.ts ingest "https://mp.weixin.qq.com/s/..." --note "批注"` | 从命令行抓取文章并生成伴读笔记；展示回执预览，不发送微信回执 |
| `sync` | `bun run src/cli.ts sync` | 手动触发一次微信入站消息拉取、队列处理与回执发送 |
| `push` | `bun run push -- "消息内容" --file ./note.md --formats md,html,pdf` | 从电脑端主动向手机微信推送文本、图片 (`--image`)、文件 (`--file`) 或多格式渲染文档 (`--file` + `--formats`) |
| `triage` | `bun run src/cli.ts triage 1 process_now --level deep` | 更新分诊 `keep_raw/reference/process_later/process_now` 和可选加工深度 `raw/light/deep`，不执行深读；保留正文 |
| `idea` | `bun run src/cli.ts idea 1 "我的新想法"` | 从命令行快速记录一条个人闪念种子（可选关联某篇文章 `#ID`） |

---

## 🌐 本地 HTTP API 接口

常驻服务默认仅绑定回环地址 `127.0.0.1:8787`，并内置严格的 **Host Header 校验与跨源 (`Origin`) 拦截保护**，防止浏览器 DNS Rebinding 或跨站请求伪造（CSRF）攻击。

| 方法与路径 | 说明 |
| :--- | :--- |
| `GET /health` | 返回服务健康状态、统计计数、知识库模式与微信配置状态 |
| `GET /config` | 打开可视化 Web 配置工作台页面 |
| `GET /api/config` | 获取配置、供应商、子目录与 CLI 扫描结果；当前响应含完整密钥，仅供受信本机管理界面使用 |
| `POST /api/config` | 更新 `.env` 并刷新模型等内存配置；端口/数据目录变更需重启或迁移，保留原有注释与排版 |
| `POST /api/config/test-llm` | 实时测试指定模型供应商与 Model ID 的 API 连通性及响应耗时 |
| `GET /api/config/scan-cli` | 实时重新扫描本机已安装的 AI Agent CLI 工具 |
| `POST /api/ingest` | 提交公众号链接抓取任务：`{"url": "https://mp.weixin.qq.com/s/...", "note": "可选批注"}` |
| `POST /api/push` | 主动向手机微信推送消息与多格式文件：`{"text": "...", "files": ["/absolute/note.md"], "formats": ["md","html","pdf"]}` |

---

## ⚙️ 环境变量说明 (`.env`)

复制 [`.env.example`](./.env.example) 为 `.env`（或直接运行 `bun run config` 在网页界面配置）：

```ini
# 1. LLM API 配置（支持 gemini | deepseek | opencode | openai | openrouter | dashscope | siliconflow | moonshot | zhipu | anthropic | custom）
LLM_PROVIDER=gemini
LLM_API_KEY=
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=gemini-2.5-flash
LLM_FAST_MODEL=gemini-2.5-flash
LLM_PRO_MODEL=gemini-2.5-pro

# 2. 本机 AI Agent CLI 路由链配置（Tier 1 本地子智能体优先级顺序）
CLI_ROUTING_CHAIN=agy,codex,opencode,claude,workbuddy
CUSTOM_CLI_AGENTS=[]
ALLOW_CODEX_FALLBACK=true

# 3. 本地服务与知识库模式
PORT=8787
ANNOTATION_WAIT_SECONDS=10
# 默认关闭第三方抓取；启用会将完整原 URL 发送给 Jina
ALLOW_JINA_FALLBACK=false
# 填 `none` 开启无知识库独立模式；填任意路径指向 Obsidian 库或结构化知识库
VAULT_ROOT=./vault

# 4. 可选：外部通知 Webhook（支持飞书 / 钉钉 / 通用 JSON Webhook）
NOTIFY_WEBHOOK_URL=
NOTIFY_ON_EVENTS=article,idea,plan
```

---

## 🛡️ 可靠性与权威存储保障 (Authoritative Storage)

本项目针对个人知识库场景设计了严格的工程安全边界（详见 [`tests/reliability.test.ts`](./tests/reliability.test.ts)）：

1. **绝不静默覆盖人工笔记**：
   - 原文存档（`<slug>.md`）与伴读笔记（`<slug>_note.md`）落盘采用独占原子发布（临时文件 `wx` + `fsync` + `link`，不替换已有目标）；
   - 一旦文件已存在（尤其是你已经手动编辑或升级为 `deep` 状态的笔记），后台自动任务或重复转发**绝不覆盖已有正文分毫**；
   - `triage` 状态变更仅精确替换 YAML Frontmatter 中的 `triage` 与可选 `process_level` 字段，100% 保留正文全部字节。
2. **同日同名中文标题防碰撞**：
   - 当不同文章清洗后的 Slug 相同时，自动追加确定性 URL 短哈希后缀（如 `2026_10_22_人工智能综述_a1b2c3.md`），彻底杜绝覆盖。
3. **原子游标推进与跨进程写锁**：
   - 微信 `getupdates` 批次消息入库与游标 `get_updates_buf` 更新在同一 SQLite 事务中原子提交；
   - 内置 `operation_locks` 进程存活锁；Agent worker 必须先拿到 `agent_queue` 锁，才能恢复并消费任务。查看命令不恢复任务；活 worker 持锁时其他实例返回，只有锁持有进程退出后才允许恢复。锁没有超时抢占，不是租约。
4. **有界幂等回执队列 (`reply_outbox`)**：
   - 微信回执发送使用确定性 `client_id` 幂等重试（最多 3 次）；若最后一次尝试因网络中断状态未知，记录为 `failed` 并保留送达结果不确定的错误信息，不无限重发。任务 `done` 只表示执行完成、回执已入队，最终送达另看 outbox。

---

同名媒体按文件内容 SHA-256 分别保存，重试相同内容复用路径，旧版附件不迁移或覆盖。HTML/PDF 派生文件以源 Markdown 和嵌入图片的版本哈希命名；修改原文或图片后生成新版本，保留旧导出。图片导出支持 `<img>` 和文档目录内的本地图片嵌入，复杂 Markdown 排版仍是子集实现。

## 🧪 测试与开发

项目配备完整的单元测试与端到端可靠性测试套件（覆盖 AES-128-ECB 双格式加解密、iLink 消息解包、四级模型降级链路、Web 配置工作台 API、多格式文档渲染导出、并发锁与崩溃恢复及本轮修复回归测试）：

```bash
# 运行全部单元与可靠性测试
bun test

# 运行 TypeScript 严格类型检查
bun run typecheck

# 开发模式启动（代码变更自动热重载）
bun run dev
```

更多关于微信 iLink 协议细节与架构扩展的说明，请参考：
- 📄 [微信 ClawBot iLink 协议机制与扩展指南 (`docs/ilink_protocol_and_extension_guide.md`)](./docs/ilink_protocol_and_extension_guide.md)
- 🧩 [桌面端 AI Agent 协同 Skill 定义 (`skills/wechat-as-context/SKILL.md`)](./skills/wechat-as-context/SKILL.md)

---

## 📄 许可证

本项目基于 [MIT License](./LICENSE) 开源。
