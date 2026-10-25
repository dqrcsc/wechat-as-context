# Article Analysis Implementation Plan

**Goal:** 微信完整呈现观点与业务碰撞，具体笔记关系留到精读；通过隔离验证后发布，不操作本机服务。

**Architecture:** 用可选本地 JSON 快照补充当前观点和业务背景。读取器校验并选择每个主题的最新有效版本；初筛提示词与降级统一六模块，检索候选保留在元数据中供精读核验。沿用现有数据库、发送队列和分段协议。

**Tech Stack:** Bun / TypeScript / bun:test，无新增依赖。

**Spec:** [已确认设计](../../plans/2026-10-25-article-analysis-design.md)

## Global Constraints

- 不操作部署服务、真实数据库或历史失败记录；push 历史文件约定不变。
- 不批量删除目录；测试仅用 `bun --no-env-file run test` 和 `test:isolation`。
- 公司内部背景不提交到公开仓库；来源内容仅作资料，不作执行指令。

## Tasks

- [ ] `tests/article_analysis.test.ts`：先写失败回归，覆盖路径加载、版本选择、同日冲突、无背景/损坏/过大背景、请求契约、模型返回链接过滤、离线降级、长消息保存与入队。
- [ ] `src/config.ts` 新增可选 `analysisContextFile`；`src/vault/analysis_context.ts` 提供 `loadAnalysisContext(filePath?: string): AnalysisContextSnapshot`（entries / warnings），按 kind/topic 确定性选最新版本。
- [ ] `src/vault/analyzer.ts` 读取快照，统一六模块要求；保留候选检索元数据但不在初筛正文中建立文件链接；失败时明确仅生成摘要。
- [ ] `src/vault/context.ts` 将新伴读文件中的候选链接改为不生成 WikiLink 的溯源元数据；旧文件保留。`src/agent/runtime.ts` 精读获得业务快照与候选资料，标明未核验关系。
- [ ] 运行 `bun --no-env-file run test tests/article_analysis.test.ts`；通过后运行全量、隔离审计与 typecheck，检查回归和未修改范围。
- [ ] README、`.env.example`、通用 JSON 示例、技能模板和使用/验收文档同步；全局 Skill 仅同步文档，保持部署路径；准备未启用的私有背景快照。
- [ ] `git diff --check`，复核契约、边界与语义验收样例。提交功能，升级 v0.3.0、更新 CHANGELOG，推送后等待精确提交 CI，再创建注释标签与 GitHub Release。
