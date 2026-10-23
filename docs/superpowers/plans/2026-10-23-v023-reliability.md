# v0.2.3 Reliability Implementation Plan

**Goal:** 修复 v0.2.2 复查确认的十项问题，验证后发布，不改变 push 历史文件约定。

**Architecture:** 在现有模块内修正产物选择与错误传播；outbox 使用内容快照；配置来源统一。沿用 SQLite 和 Bun，不新增依赖。

**Tech Stack:** TypeScript、Bun、SQLite、bun:test。

**Spec:** [已批准修复设计](../../plans/2026-10-23-v023-reliability-design.md)。

## Global Constraints

- 不操作本机服务，不调用真实微信、Agent CLI 或浏览器；测试仅使用临时数据和替身。
- 不删除用户文件；不改变 push 对显式历史文件的选择语义，不进行无关重构。
- 在当前会话按以下步骤实施；沿用已有验收与发布流程，不安装新的实施技能。

## Tasks

- [x] 在 tests/review_fixes.test.ts 和 tests/fixtures 添加十项失败回归及快照/CLI/PDF/配置子进程探针；运行 `bun test tests/review_fixes.test.ts` 记录修复前失败。
- [x] F01/F06/F07：src/agent/runtime.ts 移除当日猜测；src/storage.ts 提供 JSON 路径编解码；src/db.ts 和 src/pipeline.ts 写入结构化路径；覆盖两份文档、逗号路径、旧记录兼容与无关联文件。
- [x] F02：src/db.ts 入队时复制并校验快照，新增 media_sha256；src/pipeline.ts 发送前拒绝无快照/摘要失配；覆盖入队后编辑、重复入队、重试和旧队列。
- [x] F03：src/agent/subagent_cli.ts 统一 `if (timedOut)` 与 `if (exitCode !== 0)`；各后端失败日志、超时产物与后续路由均用进程替身覆盖。
- [x] F04/F05：src/agent/doc_exporter.ts 检查正文冲突、验证 PDF、临时文件原子发布；src/vault/context.ts 复用 PDF 校验；修改旧测试中的伪 PDF 夹具以满足头尾边界。
- [x] F08/F10：runtime 业务错误携带 outcome，pipeline 按结果记录；刷新纳入 finally；测试真实无 CLI/API 生图失败、部分格式与配置故障恢复。
- [x] F09：src/config.ts 统一普通加载与 Key 检测来源规则；临时 home 测试 IGNORE 开关、项目/进程/home 顺序，并验证 Web 预设实际保存。
- [x] 同步 README、协议、Skill 模板和修复说明，定向/全量/typecheck/diff/link检查通过；执行 Standards 与 Spec 两轴复核。
- [ ] 提交修复、版本与 changelog，推送 main；精确提交 GitHub CI 成功后推送注释标签并发布 Release，回读确认。
