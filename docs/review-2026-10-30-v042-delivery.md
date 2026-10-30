# v0.4.2 发送可靠性修复与验收

## 目标与边界

继续排查发送失败，重点是会话令牌更新、清理、批量回执和诊断。修复须有隔离回归，代码、Skill 与文档同步后提交发布。原工作区未提交修改保留；本轮不操作部署服务、真实数据库或真实微信，不重试或清理 17 条历史失败记录。

成功标准：并发新令牌不被旧请求清除；重复/时间较旧的入站消息不回退令牌；每个文本分段和媒体最终发送使用当时最新快照；正常队列入口遵守持久重试间隔；失败可定位阶段且诊断不泄露凭证、正文、文件路径、签名 URL；批量中单条失败不阻断其他条；历史失败不因升级或新消息自动重试。

## 已确认缺陷和改动

| 问题 | 修复与验收 |
| --- | --- |
| 旧请求 ret=-2 时无条件删除用户当前令牌，可误删并发收到的新令牌 | 记录请求的令牌及随机 revision；失败时若缓存已更新，最多用最新快照补一次；文本和媒体共用处理。 |
| 无令牌补发也失败时仍把原令牌当作无效清理 | 原令牌保留；仅无令牌补发成功后尝试清理，而且必须匹配原值和 revision。清理失败不得把已接受的发送变成再次重试。 |
| 重复消息或迟到旧消息会覆盖新令牌 | 只为首次持久入库的消息更新令牌；有有效 create_time_ms 时拒绝较旧时间。清理保留时间高水位；未知时间按接收顺序处理，不宣称能恢复服务端完整顺序。 |
| 多段正文整次发送只读取一次令牌 | 每个实际发送分段重新读取；保留原有分段检查点、稳定 client_id。 |
| 常规 flush 不强制 next_retry_at，多个触发者可能快速耗尽次数 | 默认检查持久截止时间，间隔从失败完成时刻计算，慢请求不吞掉等待；仍最多 3 次队列尝试，第一次失败后至少5秒、第二次失败后至少15秒。只有内部显式 enforceRetryBackoff:false 才绕过等待；正常 CLI/轮询不使用此选项。 |
| 只有最终 error，无法区分上传、最终发送及恢复分支 | 增加独立 delivery_events 表和 doctor 输出；错误消息只保留受控分类和数字码。 |

每个文本分段或媒体消息在一次队列尝试中最多两次 sendmessage 请求（初始请求 + 一次恢复）。有新令牌时优先尝试新令牌；否则保留原有无令牌兼容回退。无令牌请求被拒绝时不再补发，其他 HTTP、网络或业务错误不走 ret=-2 专属恢复。媒体同次恢复复用已上传内容，不重新上传。不同队列条目各自记录结果；并未假设账号发送配额，也没有加入未经证实的固定令牌 TTL。

## 诊断与排障

`bun run src/cli.ts doctor --json` 增加 `deliveryDiagnostics`：最近50个事件，按事件 ID 倒序。内部 `recentDeliveryEvents(outboxId, limit)` 可按 outbox ID 读取，最多3000个。

- 关联：outbox_id、外层 attempt、recorded_at。新入队为 attempt=0 / queue / queued；重复入队不制造新时间；历史行没有补造过去事件。
- 阶段：outbox、media_prepare、getuploadurl、cdn_upload、sendmessage、sendmessage_media、context。
- 请求：started/succeeded/failed、耗时、HTTP状态、数字 ret/errcode、chunk；外层失败另有 failureStage。
- 令牌：仅保存 SHA-256 截短指纹、revision 指纹、是否存在，以及本地最后观察时间到发送时的毫秒差 tokenAgeMs。该年龄不是服务端有效期。
- 恢复：retry_new_context、retry_without_context、context_cleared、context_preserved。失败分类区分 network、timeout、http、api_prepare_failed、api_rejected、invalid_response、local_validation、interrupted（最后一次尝试中断，结果未知）。
- 不保存 bot_token、context_token 原文、正文、附件内容/路径、请求 URL 或任意服务端 errmsg。旧 reply_outbox.error 不回写脱敏；doctor 原有字段仍可能包含历史内容，分享报告前需检查。
- 全库保留最近3000个事件，独立于业务队列保留策略；超量时旧诊断会被淘汰。诊断写入失败仅固定提示，不把已成功发送变成失败。该日志是排障线索，不是完整审计。

排查时先看 outbox 最终状态，再按同一 ID / attempt 的时间和阶段查上下文。getuploadurl 成功不等于 CDN 上传成功；上传成功不等于最终 sendmessage 成功；服务器成功响应也不是用户已读。网络中断可能已被远端接受，稳定 client_id 不构成端到端 exactly-once 保证。不要按失败列表直接批量重发。

17 条历史失败缺少新事件，不能从现存最终错误反推当时请求采用了哪个令牌、其年龄或是否发生并发覆盖。本轮只证明客户端问题及修复，不宣称已经确定每条旧失败的服务器根因。

腾讯官方协议说明也明确客户端行为并非完整服务端契约：可选 context_token 不意味着服务端一定接受无令牌请求。参考 [Tencent/openclaw-weixin 协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)。ret=-2 / prepare failed 不作为“令牌过期”“额度耗尽”的确定证据。

## 升级与兼容

首次打开新版本数据库新增 delivery_events 表和索引，不重置旧 outbox 或改写失败内容。接收新消息时增加 clawbot_context_meta_* 状态，旧 clawbot_ctx_* 值继续可读。发布与 Skill 同步不代表已部署；仅部署新代码后才有新诊断，不需清空数据或重新登录来完成迁移。

doctor 不发送网络请求、不消费队列，但启动 ContextDatabase 会执行兼容建表；要求严格只读取证时应使用 SQLite mode=ro，不能把普通 CLI 当作零数据库写入工具。

## 回归矩阵

所有验证经隔离入口，临时 HOME/数据库/附件和模拟 fetch。禁止部署目录探针、真实模型或微信调用。

- 文本/媒体并发新令牌，跨 SQLite 连接、同值新 revision 的 ABA 保护。
- 失败无令牌回退保留令牌；成功清理、清理后的迟到消息、用户隔离。
- 重复入站不回滚、分段读取新快照、恢复最多两次请求。
- 批量首条失败与后续成功并存、默认退避、17条模拟历史失败逐字段不变且不生成虚假历史事件。
- HTTP/网络/超时/JSON/数字码/接口拒绝分类（含响应头已到达后的正文断流/超时）、敏感错误正文脱敏。
- 媒体准备、上传 URL、CDN、最终发送分别定位；诊断存储和清理故障不重发已接受消息。
- 诊断保留上限、跨连接并发重复媒体入队不新增时间、doctor 输出、原有分段恢复和媒体快照保护。

验证结果：新增31项回归；全量 **365通过、0失败、1760断言**，隔离审计 **7通过、0失败、40断言**。缓存 TypeScript 5.9.3 类型检查和 git diff --check 通过。隔离审计确认模拟部署数据库及 sidecar、项目/home 环境文件未变，直接测试入口和 ATTACH 绕过均被拒绝。

Standards 与 Spec 双轴复核各报告相同的2项 P2（响应正文读取分类、并发媒体入队事件），均通过先失败再通过的回归完成修复，复核未发现遗留问题。另以慢请求反例修正退避起点。未对真实微信做发送验收，因此没有真实发送恢复成功率的结论。
