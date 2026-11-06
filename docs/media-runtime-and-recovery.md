# 媒体工具与渠道恢复（v0.4.9）

本次修复 v0.4.8 审查中的代理环境丢失、默认强制覆盖示例和工具路径问题。更新代码/Skill 不会升级服务、安装下载器、重发历史 failed 或重新处理历史文章。

## 工具路径与网络配置

`YT_DLP_BIN`、`FFMPEG_BIN`、`LOCAL_ASR_BIN` 是启动进程的环境变量。支持绝对路径、`~/` 和相对**项目根目录**的路径（不依赖调用 CLI 的当前目录）。显式路径需为普通可执行文件，缺失、目录或无执行权限均报错，不静默选用其他版本。支持指向可执行文件的符号链接；不支持 `~otheruser`。空值视为未指定。

未指定时三个工具统一依次检查 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`。不安装依赖，不从任意 PATH 位置猜测下载器版本。修改工具环境后须在用户授权的服务维护中重启；配置工作台的模型热更新不等于这些工具变量热更新。

yt-dlp 子进程保留 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY、NO_PROXY 及小写版本，保留空值及上下游客户端的优先级。继续采用白名单，不传模型密钥、NODE_OPTIONS、PYTHONPATH 或 SSLKEYLOGFILE。代理可能包含凭据，日志和报告不得输出其原始值。解析后媒体下载仍走现有公网上下文/文件完整性检查，不改为下载器直接归档。

## 证书的实际边界

有 `/etc/ssl/cert.pem` 且未指定 SSL_CERT_FILE 时仍注入此路径；显式 SSL_CERT_FILE/SSL_CERT_DIR 优先保留。**变量传入不等于已被采用**：yt-dlp 默认有 certifi 时加载其 bundle，无 certifi 时才使用 Python/OpenSSL 默认 CA 路径。参考 [固定版本官方实现](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/yt_dlp/networking/_helper.py#L21)。本次不改变上游信任策略，也不关闭证书校验。

普通 Bun 回归检查变量选择与实际 execFile 接线。独立 Python 测试使用真实 yt-dlp/OpenSSL SSLContext，验证 certifi 存在/不存在、自定义 CA、替代 bundle、CA 文件不存在时仍启用校验。仅“缺依赖”分支通过替换可选依赖引用模拟；证书加载本身不模拟。测试阻断 socket 连接，不读取应用配置、数据库或真实材料，不声称验证了真实站点 TLS 握手。

```bash
python3 -m venv /tmp/wxctx-ca-check
/tmp/wxctx-ca-check/bin/python -m pip install --isolated --index-url https://pypi.org/simple -r tests/integration/youtube-ca-requirements.txt
/tmp/wxctx-ca-check/bin/python tests/integration/youtube_ca_test.py
```

测试依赖固定版本，仅装在临时环境；CI 有独立离线 CA 作业。`test-ca.pem` 只含专用测试 CA 公钥证书，不含私钥，也不安装到系统信任库。临时目录保留，不递归清理。

## 失败诊断

| reason | 观察到的失败 | 处理方向 |
| --- | --- | --- |
| resolver_not_installed | 默认未找到工具或执行时 ENOENT | 核对安装/解释器，不自动安装 |
| resolver_tool_not_found / resolver_tool_not_executable / resolver_tool_invalid_path | 显式路径无效 | 核对配置位置、权限、路径写法 |
| resolver_not_executable | 启动时权限/可执行格式拒绝 | 核对文件和执行环境 |
| resolver_timeout / resolver_output_limit | 期限/输出上限触发 | 检查耗时及异常输出，不解除现有界限 |
| resolver_certificate_error / resolver_proxy_error / resolver_network_error | stderr 含相应错误特征 | 核对 CA、代理或连接，不能仅凭分类断定全部根因 |
| resolver_http_NNN | 观察到 HTTP 错误状态 | 按具体状态分析限制，不自动重试历史发送 |
| resolver_invalid_output / resolver_identity_mismatch / resolver_no_audio | 无效 JSON、作品身份不符、无合规音频 | 不伪造正文或使用其他作品 |
| resolver_failed | 无法归类的子进程失败 | 单独授权诊断工具环境，不将原始 stderr 入库 |

只有固定 reason 和整数 exitCode 从错误分支返回；外部 YouTube 原文的 `extraction_quality.reasons` 额外记录 `resolver_exit_code_N`。stderr 只在内存中作有限分类，不返回或记录其正文。成功回退可保留之前失败的诊断，不等于最终提取失败；最终以质量状态与取得的内容共同判断。

## 渠道恢复矩阵

| 入口 | 定位与成功边界 | 恢复方式 |
| --- | --- | --- |
| 公众号、Medium、普通网页链接 | `list/show <id>`，articles ID、原文/伴读路径；原文获取不等于模型初筛成功 | 模型降级且笔记未编辑时 `reanalyze <id> --json`；已有人工/完整 light 内容先核对覆盖范围。抓取失败的原 URL 可在明确授权后 ingest，已有文件仍按保护规则处理 |
| YouTube、小红书、抖音链接 | articles ID；核对 extraction_quality、缺失页及实际转写 | 普通 reanalyze 复用原文；仅显式 `--force` 且原文缺失或带 metadata_only 标记等已支持条件时重抓。partial 图集不因 force 自动变为完整重抓；先核对原因与证据 |
| 微信原生视频及混合消息中的视频 | `recent/inbox`、会话与 Markdown 归档；无 articles ID；视频临时文件在处理后清理，失败也不长期保留 | 不支持 `reanalyze <id>`。已有转写可复核文字；缺失转写或需核对画面/口播时，须取得用户提供的原视频，或由用户明确重新发送形成新消息后按授权处理。不得假定旧临时视频仍在；同消息重放可能被幂等去重 |
| 微信原生图片、PDF/PPTX、个人文字 | 会话、归档路径；下载/归档不代表视觉或文档正文解析成功 | 按材料类型及权限使用合适工具单独解析；没有通用 articles-ID 补跑。私人内容不可由“排查/修复”推定可外发模型 |
| 微信原生语音 | 仅当接口提供 voice_item.text 时可读转写；不等于原生音频 ASR 已实现 | 核对接口转写和原始证据，未实现的解析如实说明 |
| 出站回执 | outbox 的成功/失败不同于抓取、解析、模型分析完成 | 历史 failed 保留、不自动重试；重新分析不授权补发，`--send` 须有明确发送授权 |

常用示例：`bun run src/cli.ts reanalyze 1 --json`。只有阅读原文/伴读并确认可以替换后才加 `--force`：它可能覆盖人工编辑的 light 笔记；deep/synthesis 仍拒绝覆盖，分析期间文件改动也会停止写回。`--force` 不授予发送权限，`--send` 是另一个独立选项。

## 验收

回归涵盖实际子进程代理传递/密钥剔除、路径展开和错误覆盖、失败脱敏与输出上限，以及既有人工笔记保护和跨视频入口质量测试。运行 `bun run test`、`bun run test:isolation`、TypeScript 检查及上述离线 CA 测试；测试禁止访问真实微信、模型和数据库。不把隔离测试通过写成真实各平台全链路成功。
