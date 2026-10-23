# Test Isolation Implementation Plan

**Goal:** 测试及 CLI 子进程不能连接真实数据库或向微信发送请求，修复并发布 v0.2.4，不操作部署服务或历史失败记录。

**Architecture:** 正式配置优先级不变。测试入口只复制源码、测试和所需模板到新临时目录，使用空 HOME 与白名单环境。测试预加载在父子进程中检查数据库边界、拒绝默认网络和外部命令；未隔离的直接测试提前退出。

**Tech Stack:** Bun、TypeScript、bun:test、SQLite；不新增依赖。

**Spec:** 当前用户请求与上轮三条离线入队测试污染真实 outbox 的只读诊断。`--queue-only` 不代表与后台发送队列隔离。

## Global Constraints

- 仅在研究仓库修改和验证；不操作本机服务、真实数据库、凭据或三条历史失败记录。
- 保留生产配置顺序及 push 历史文件约定；不新增生产测试开关。
- 不批量删除目录；临时测试目录保留供排查，不复制 `.env`、`data/`、`.git/`。

## Tasks

- [x] 建立失败回归：假部署 `.env` 指向哨兵数据库，测试 CLI 环境指定临时库时不得污染哨兵；无 mock 的发送必须在 fetch 前拒绝。
- [x] 新增 `tests/support/workspace.ts` 与 `tests/run.ts`：白名单复制、清理继承环境、独立 HOME/TMPDIR、传递过滤参数。
- [x] 新增 `tests/support/isolation.ts` 与 bunfig preload：未隔离启动拒绝；SQLite 路径及符号链接检查；默认 fetch 拒绝；Bun 子进程强制继承隔离并禁止真实外部命令。
- [x] 为现有测试与探针接入守卫，补 CLI 测试对目标数据库记录的断言；增加哨兵、子进程、网络和正常 mock 对照。
- [x] 更新 package/CI/README/Skill/验收文档，运行定向、全量、类型及差异检查；执行 Spec 与 Standards 两轴复核。
- [ ] 验证后提交与推送，精确发布提交 CI 通过后发布注释标签及 GitHub Release。
