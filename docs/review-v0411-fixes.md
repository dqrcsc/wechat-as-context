# v0.4.12：v0.4.11 复查修复与验收

基线：v0.4.11 / `5ecce408ed3e63867b6bcd2bb78604d885bc5752`。日期：2026-11-13。

本次按优先级修复复查确认的 8 项问题，不安装依赖、不升级或重启服务、不重跑原文章、不发微信、不操作真实失败记录、不向 Gemini 发送材料。原工作区未提交修改保留。这里只更新代码、仓库技能及文档，不代表部署目录或全局已安装技能已升级。

## 修复与回归映射

| 优先级 / 编号 | 修复行为 | 回归覆盖 |
| --- | --- | --- |
| P1 / R1 | 非 GET/HEAD 禁止自动跟随重定向，默认 error；显式 manual 保留。防止下一跳错误被误判为原始 POST 未发送后再重放 | `system_proxy.test.ts`：直连/粘性代理两条路径；真实 sendTextMessage 控制流 + 模拟重定向策略；POST/PUT/PATCH/DELETE；既有首跳 TLS 回退、流式 body、取消及中途断连保护 |
| P1 / R2 | Web/Android 播放器明确 videoId 冲突时，在合并前弃用整组数据，不保留错误字幕或流地址 | `content_quality.test.ts`：Web 冲突无可靠替代、Android 冲突保留正确 Web 字幕；既有 `live_replay.test.ts` 校验 yt-dlp 身份 |
| P1 / R3 | metadata-only 仅从结构化 frontmatter/旧 engine 字段读取；明确 complete 优先，正文引用不触发重抓 | `review_followups.test.ts`：正文两类标记、complete 与旧字段矛盾、已有逐字稿不刷新 |
| P1 / R4 | 将分析前原文快照传给写入器；写入器进入和图片本地化后分别核对，发现变化拒绝覆盖 | `review_followups.test.ts`：force/非 force × 模型正常/降级 × 编辑/删除；图片下载期间编辑；目标新建冲突；伴读与数据库旧标题保持 |
| P2 / R5 | 忽略 Scoped/接口嵌套字典的 ExceptionsList，只采用全局规则 | `system_proxy.test.ts`：多个接口及嵌套通配规则不污染全局，全局 localhost 仍生效 |
| P2 / R6 | MAX_TOKENS 保留为 partial；缺少完成状态保守标 partial；拒绝/空响应失败；忽略 thought 文本 | `review_followups.test.ts`：各完成状态；`live_replay.test.ts`：YouTube 原生/yt-dlp；`video_entry_consistency.test.ts`：小红书/抖音/微信原生、混合、灵感和多个视频 |
| P2 / R7 | 正常 STOP 的非空转写不再要求超过 10 字 | `review_followups.test.ts`：短中文、短英文及空白对照 |
| P2 / R8 | 来源获取成功与模型成功分别判断；force 取得真实标题或从 metadata-only 恢复转写后，即使模型仍降级也保存成果，保留旧伴读 | `review_followups.test.ts`：force/非 force 的降级保存及上述并发矩阵 |

## 质量与兼容说明

- `AsrTranscriptionResult.extractionQuality` 为可选字段。既有本地引擎行为保留；云端返回明确的 complete/partial。
- `asr_truncated` 表示模型返回 MAX_TOKENS；`asr_finish_reason_missing` 表示有正文但缺少结束状态，不能确认完整性；`cloud_asr_rejected` / `cloud_asr_empty` 是固定脱敏原因，不记录模型原始错误内容。
- 微信原生视频新增可选 `partialVideos`：必须是 `processedVideos` 的非空、不重复子集，且总质量必须为 partial。`processedVideos` 表示取得可用文本，`missingVideos` 表示未取得转写。全部视频都有片段也可能仍然是 partial。
- 部分转写的警示进入模型提示、归档及回复，YouTube 部分转写不再使用“完整字幕 / 逐字稿”标题。旧质量记录没有 partialVideos 时继续按原规则读取，不迁移真实数据库或旧文档。
- 原文保护是乐观快照校验后原子替换，覆盖分析/下载等待期间的编辑；不是对所有不遵守协议的外部文件写入者提供文件系统级比较交换或锁保证。冲突时需先核对当前文件，不自动强制重试。
- Web/Android 缺少 videoId 与明确冲突分开处理；本次拒绝明确错源，不将缺少身份字段说成已核验。yt-dlp 独立校验保持。

## 验证结果

- 全量隔离回归：**595 pass / 0 fail，2800 次断言，25 个文件**。较 v0.4.11 基线增加 46 项测试。
- 隔离专项：**7 pass / 40 次断言**；合成哨兵数据库及 sidecar、项目/HOME 环境文件保持不变；直接绕过隔离及数据库 ATTACH 被拒绝。
- TypeScript 5.9.3 检查通过，覆盖 src 与 tests；只排除审查工作区原先未跟踪的 `*.probe.ts`，未排除正式测试。编译器取自本机已有缓存，无下载。临时 tsconfig 指定现有 @types 路径，避免从临时目录错误解析类型。
- `git diff --check` 通过。
- 首次全量运行的 HTTP 边界用例受沙箱随机端口监听限制；允许临时测试端口后全量通过，数据库、环境及外部网络隔离守卫保持开启。没有启动项目服务。

回归入口为 `bun run test`、`bun run test:isolation`，不得直接 `bun test` 或在部署数据库上运行探针。本轮没有修改证书加载逻辑，既有媒体工具/代理回归包含于全量测试；未重复运行独立 Python CA 集成测试。

本次没有真实网络或模型端到端复验。特别是重定向测试使用合成响应验证传输策略，不证明真实微信服务端当前会重定向，也不证明服务端依据 client_id 严格去重。响应丢失、远端接受后本地落库前崩溃等投递歧义仍需单独处理，不能宣称端到端绝不重复。历史 failed 仍不自动重试。

## 后续优化范围

按传输尝试细化诊断、对结果不明的投递建立更明确的处理流程、合并并发 scutil 检测、按实际模型配置展示云端转写能力，仍是后续优化项。本次不扩大到这些改造。发布不等于部署，本轮不操作本机服务。
