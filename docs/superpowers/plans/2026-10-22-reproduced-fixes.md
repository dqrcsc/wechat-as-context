# Reproduced Reliability Fixes Implementation Plan

**Goal:** 修复 26dc3c7 分析中已复现的问题，优先保障任务、附件和 PDF 输入的正确性。

**Architecture:** 保留 Bun/SQLite/现有 handler 结构。复用数据库 operation_locks 串行领取和恢复 Agent 队列；媒体使用内容地址和独占发布；缺少 API 可读内容时停止该降级分支。其余修改限定在已复现的路由、批注、导出、产物和接口契约。

**Tech Stack:** Bun、TypeScript、SQLite、bun:test。

**Spec:** 基于 26dc3c7 的问题复现与修复范围，详见 [修复说明与验收](../../reliability-fixes.md)。

## Global Constraints

- 不修改真实凭据、知识库、全局 Skill 或运行中的守护服务；不发送真实微信，不运行真实 Agent。
- 不批量删除，不做无关重构；历史分析保留固定提交结论。
- 升级必须先停止旧 worker；旧版没有 Agent 队列锁，不能与新版混跑。
- 不把模拟测试当真实服务验收；不承诺崩溃后的外部动作 exactly-once。

## 执行与验收

- [x] `tests/fixes.test.ts`：先写失败回归，使用临时 SQLite、mock 网络/CLI；验证查看命令不重置活任务、第二 worker 不重复处理、失活 worker 可恢复。
- [x] `pipeline.ts`：移除构造恢复；`drainAgentQueue` 在 `withLock('agent_queue')` 内恢复和消费，锁忙返回 0；完成标识描述执行结果而非远端送达。
- [x] `media.ts/storage.ts`：内容 SHA-256 参与附件路径，原子独占写二进制；不同内容不同路径，相同内容重试复用，旧文件不覆盖。
- [x] `runtime.ts/subagent_cli.ts`：无法提交正文的附件禁止 API fallback，保留归档并反馈未解析；测试 PDF、混合附件、CLI 成功及普通图片/文本对照。
- [x] 修复已复现的无 Key CLI 漏路由、引用批注目标、旧 HTML/PDF 缓存、图片渲染和产物误归属，并逐项增加回归。
- [x] 修正 URL 校验遗漏、第三方抓取披露、模型搜索/图像组合与 CLI/HTTP 文档契约；不为 README 虚构端点扩展无关功能。
- [x] 更新 README、协议指南与仓库 Skill 的准确行为及升级说明。
- [x] 运行新增回归、全量 `bun test`、`bun run typecheck`、`git diff --check`；检查变更范围并记录未验收边界。
