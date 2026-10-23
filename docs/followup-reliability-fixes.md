# v0.2.2 七项可靠性修复与验收

基线：`2cae4fe`。成功标准：七项已复现行为均有回归覆盖，保留正确产物、当前导出和显式历史版本的正向对照；全量测试与类型检查通过后发布。此次操作不安装、启动、停止或重启本机服务。

## 问题、实现与测试

| 问题 | 修复后的行为 | 代码与回归入口 |
| --- | --- | --- |
| S1：AGY 从共享目录捡到其他任务图片，非零退出仍成功 | 删除按时间扫描 generated/brain 的逻辑；真实路径必须位于生成目录或知识库，且来自明确返回路径或本次唯一预期路径。超时、非零退出均失败；生图还必须有可归属图片 | `subagent_cli.ts`；failed/unclaimed/expected 子进程对照 |
| S2：未知模型无参数重试后仍宣称原模型 | `modelUsed` 标记 `agy (default/unknown; fallback from …)`，只确认使用 CLI 默认选择，不猜实际模型 | `subagent_cli.ts`；retry 子进程 |
| F1：同名导出按 mtime 混选旧版本 | 查找和生成共用正文、标题与嵌入图片的版本计算；当前 Markdown 只配当前 revision。显式历史导出只配同 revision，源文件已变时不附带当前 MD | `doc_exporter.ts`、`vault/context.ts`；正文变化、图片变化、自定义标题、历史版本、多文件重发与 `_sources` 文件名对照 |
| F2：请求 MD+HTML，已有 MD 就跳过 HTML | `send_file` 各入口按每个请求格式生成，返回 `missingFormats` 并提示用户；缺 PDF 不用旧 PDF 替代 | `runtime.ts`；recent_generated/latest_note/当日兜底、PDF 失败和成功对照 |
| C1：状态查询仍提示默认 25 秒 | 入站状态快通道传入与任务执行相同的有效心跳配置 | `pipeline.ts`；0 与 60 秒入站查询 |
| C2：旧毫秒变量覆盖显式 0 | 显式配置优先；未设置秒配置时兼容 `TASK_HEARTBEAT_MS`。0 不启动定时器，结束时清理已有定时器 | `config.ts`、`progress.ts`；timer spy 与配置表 |
| C3：忽略 home 时启动与重载读取不同配置 | 普通入口统一项目 `.env` > 进程环境 > home `.env`；显式 `customEnv` 注入仍优先；IGNORE_HOME_DOTENV 只跳过 home 文件 | `config.ts`；虚拟环境 startup/reload/injected 对照 |

源码均位于 [src](../src)，回归见 [followup_fixes.test.ts](../tests/followup_fixes.test.ts) 与 [隔离探针](../tests/fixtures)。

## 使用与兼容边界

- AGY 必须将生图产物写入/复制到提示中的允许路径，再返回路径；只在内部 brain 生成、不导出文件会失败，不再由本项目猜测关联。
- 路径约束没有建立每任务独立产物清单；显式返回路径仍属于受信 CLI 输出契约，不能视为对恶意 CLI 的隔离。
- `send_file` 有当前 Markdown 且请求格式时重建/复用当前版本。只有历史 HTML/PDF 路径时，按历史 revision 配对。无格式要求但记录包含 Markdown 与导出时，按记录中的格式重新解析当前源，避免可变 MD 与旧导出混发；没有源 Markdown 时保留明确记录的历史导出。
- 历史附件和导出保留，不清理用户文件、改写正文或迁移数据库。导出标题参与版本计算，标题不同允许生成不同版本。新 HTML 携带源内容摘要，查找可验证自定义标题版本；没有摘要的旧自定义标题导出无法自动证实属于当前源，须从 Markdown 重新请求导出，或显式指定历史文件。查找多个可验证版本时优先默认标题版本，否则按文件名稳定选择一个 revision，绝不按格式各选一份。
- 心跳有效秒数须为有限非负数且不超过计时器上限；非法显式秒值回到默认 25 秒。0 只关闭定时进度，启动/阶段/结束通知与主动查询仍保留。
- 安装过的 Skill 副本不会随仓库自动更新；本次只修改仓库模板，不修改全局已安装 Skill。

## 验证方法与范围

```bash
env -i PATH="$PATH" IGNORE_HOME_DOTENV=true bun test tests/followup_fixes.test.ts
env -i PATH="$PATH" IGNORE_HOME_DOTENV=true bun test
bun run typecheck
git diff --check
```

新增回归先在未修复代码上验证失败，再验证修复。CLI、模型、配置文件与 PDF 进程均使用临时夹具或替身；全量 HTTP 测试仅监听临时本机端口。原复合文档测试改为受控 PDF 失败，避免 15 秒测试超时先于外部浏览器 35 秒超时。

PDF 成功对照验证调用、版本配对和文件选择；PDF 内容由替身写入，未验证真实浏览器渲染或视觉效果。没有调用真实微信、真实 AI CLI、用户知识库或本机常驻服务。真实送达、CLI 模型选择及 PDF 视觉质量需要独立实机验收。

本地验收：新增 19 项回归通过；全量 83 项测试、450 个断言通过；TypeScript 类型检查和差异检查通过。最终发布记录见 [更新日志](../CHANGELOG.zh.md)。
