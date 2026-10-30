# v0.4.0：2026-10-30 审查修复与验收

基线为 `e79a53e`。原研究工作区未提交修改保持原样；在独立工作树完成修复。此次发布纳入 v0.3.0 后的六个功能/修复提交，因此版本升级为 v0.4.0。发布不等于部署。

## 11 项问题与回归对应

| 编号 | 修复行为 | 主要回归文件 |
|---|---|---|
| C1 / P1 | 最终 URL ID 与桌面/移动页面状态相符；目标笔记不混入全页其他内容与媒体；缺失/冲突明确失败 | `tests/review_extractor_regression.test.ts` |
| C2 / P1 | 当前笔记 + 生成指纹共同判定；旧摘要不决定可覆盖；人工编辑/无指纹需 force；生成期间变更拒绝覆盖 | `tests/review_data_regression.test.ts`、`tests/article_analysis.test.ts` |
| C3 / P1 | 所有媒体下载走同一逐跳校验流式实现；禁止私网字面量/非法协议跳转、循环、超限及不完整文件 | `tests/review_transport_regression.test.ts` |
| C4 / P1 | CDP 连接/请求超时；整体截止时间；close/error/协议错误拒绝 pending 并清理 | `tests/review_transport_regression.test.ts` |
| C5 / P2 | 重抓旧原文时 assets 以实际 Markdown 目录定位 | `tests/review_extractor_regression.test.ts` |
| C6 / P2 | 日志 copy/truncate 保留追加描述符；连续轮转后新内容仍写入 active 文件 | `tests/review_data_regression.test.ts` |
| S1 / P1 | 未知名称/ID、歧义不猜测目标；支持唯一名称改期与明确“刚才”指代 | `tests/review_scheduler_regression.test.ts` |
| S2 / P1 | 中断恢复、生成检查点、稳定归档路径/出站ID、原子入队/状态；历史失败不重试；过期运行记录转终态 | `tests/review_scheduler_regression.test.ts` |
| S3 / P1 | 取消/暂停/改期后的旧结果不入队、不中止新安排、不复活旧任务；锁被替换后旧 owner 失效 | `tests/review_scheduler_regression.test.ts` |
| S4 / P2 | 优先解析“整数个半小时”，数字/中文/空白均测试，半小时保持30分钟 | `tests/review_scheduler_regression.test.ts` |
| S5 / P2 | 单次星期提醒与明确每周周期区分；错误模型 cron hint 不覆盖明确单次星期 | `tests/review_scheduler_regression.test.ts` |

## 数据与恢复语义

- 数据库添加两个字段：`scheduled_tasks.revision`（默认0）和 `scheduled_task_runs.prepared_result`（默认空字符串）。打开数据库时自动添加；本次未打开真实部署库执行迁移。
- 状态更新递增 revision。调度完成前核验 revision 和锁所有权；发送消息与任务/run终态在同一 SQLite 事务提交。
- 调度锁15分钟有效、每5分钟续租；死进程或过期锁可被回收。续租写入失败停止续租并使当前 owner 无效，旧执行者不会在失去所有权后入队。
- 摘要完整生成结果先入数据库检查点，再以任务+运行时刻确定文件名写入。重启复用检查点；已有文件不覆盖，如内容被改动则拒绝发送旧版本。检查点前崩溃可能重新调用模型，不承诺所有外部动作严格一次。
- 已有 outbox 正文记录（含 failed）只用来判定已入队，不改变它的状态、内容或重试次数。旧版本只有附件、无正文出站记录时，任务暂停并提示人工核对。
- 取消/暂停/改期发生在归档之后时，已经生成的文档保留；尚未入队的旧结果被阻止。已经入队或已经送达的消息不由此撤回。
- 新伴读 frontmatter 增加 `generated_content_sha256`，覆盖除该字段自身之外的完整文件。仅指纹匹配且仍为降级笔记时可无 force 重分析；人工编辑和旧版无指纹文件均需核对后显式 force。deep/synthesis 无论 force 与否都保护。旧笔记不迁移、不补写指纹。

## 超时、资源与兼容边界

- 媒体：最多5次重定向；单候选75秒、128 MiB，流式落盘，不将部分失败文件交给 ASR。目标 URL 每跳检查，仍未绑定 DNS 解析地址。
- CDP：打开连接5秒、单请求5秒，提取整体60秒信号；任何断连/超时清理 pending 和浏览器。真实平台登录、反爬及网络可用性未作实机验证。
- 日志：保留一个 `.1` 备份，原文件 copy/truncate 以保持 launchd 的 O_APPEND 描述符。复制与截断之间的并发写入可能丢失，属于诊断保留策略，不是无损审计系统。
- 新下载与轮转使用的 `writeSync`、`truncateSync` 同步纳入测试隔离守卫；不允许写未登记描述符或截断边界外文件。
- push 显式历史文件约定不变；ffmpeg/local-asr 异步化属于后续优化，没有扩展到本次修复。

## 验证

使用 `bun --no-env-file run test` 和 `bun --no-env-file run test:isolation`。测试入口复制不含 .env/data/.git 的源码至临时目录，使用合成数据和网络替身；不得直接在部署目录执行探针。

- 全量：236项通过、0失败，1277断言；相对基线186项新增50项回归（含1项隔离守卫验收）。
- 独立隔离审计：7项通过、39断言；合成外部哨兵数据库及侧文件、项目/home配置不变，裸测试与越界ATTACH拒绝。
- 类型检查：本机缓存TypeScript 5.9.3以 `tsc -p tsconfig.json --noEmit` 通过；原 `bun x tsc` 依赖在线解析，本次不把缓存编译器通过描述为该在线入口已验证。
- 差异空白、文档链接与技能模板同步检查通过。Standards与Spec分别复核，反例已纳入正式回归；续租写入故障采用SQLite触发器注入验证。
- 未执行真实平台采集、模型语义或微信实机送达测试；不以合成回归证明这些外部能力始终可用。

本次不升级或重启服务，不读取真实数据库或 #24 材料，不调用外部模型，不发送微信。3条真实历史失败记录保留、不重试。全局 Skill 更新只更新说明和行为约束，保留原部署路径，不代表新版代码已启用。
