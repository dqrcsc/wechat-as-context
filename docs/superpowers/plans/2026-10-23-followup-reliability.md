# Follow-up Reliability Implementation Plan

**Goal:** 修复 2cae4fe 上复现的 7 个问题，验收后提交并发布。

**Architecture:** 移除共享图片扫描，只接受明确返回/预期路径；文件交付共用当前源版本解析，显式历史导出保持原 revision；HTML 源摘要支持自定义标题核验；配置优先级与心跳有效值在所有入口一致。复用已有 SQLite、导出器与 CLI 执行流程。

**Tech Stack:** Bun、TypeScript、SQLite、bun:test。

**Spec:** 本次用户批准的七项修复及 [行为与验收说明](../../followup-reliability-fixes.md)。不进行整仓重构。

## Global Constraints

- 不安装、启动、停止或重启本机服务；不读真实 brain、凭据、知识库，不发真实微信。
- CLI、计时器与 PDF 测试使用替身；全量 HTTP 测试仅监听本机临时端口。
- 保留旧附件/导出文件；不改变原文，不进行数据库迁移。

## Tasks

- [x] tests/followup_fixes.test.ts 和 tests/fixtures：将图片误归属、重试归因、旧导出、部分格式、状态提示、0覆盖与配置入口不一致改为失败回归；增加正确产物与显式历史版本对照。
- [x] subagent_cli.ts：删除 findRecentImagesInDirs；AGY 超时/非零退出明确失败，无图片不冒充生图成功；移除通用 brain 白名单，要求复制到授权目录；默认模型回退记录 default/unknown。
- [x] doc_exporter.ts/context.ts/runtime.ts：共享源版本计算；不按 mtime 混选；各 send_file 入口共用解析与 missingFormats，已声明旧版本仅返回该 revision。
- [x] config.ts/progress.ts/pipeline.ts：普通加载统一项目.env优先；customEnv 显式注入优先；IGNORE_HOME_DOTENV 只影响 home 文件；明确配置(含0)优于旧心跳变量，两个状态入口传相同有效值。
- [x] 将原复合文档测试的浏览器换成局部替身，保留 PDF 成功/失败回归，避免测试总超时短于外部进程超时。
- [x] 同步 README、Skill、修复说明和 changelog；运行定向回归、全量测试、typecheck、diff/link检查。
- 发布验收：创建修复及版本提交，推送 main；GitHub CI 对应提交成功后创建注释标签与 Release，回读确认（远端结果记录于 Release）。
