# ASR 覆盖证据与复核提示实施计划

目标：落实用户确认的修复：非空文本不再自动获得 complete；覆盖证据与准确性分开，疑似错词只提示不纠正。

方案：保留现有质量枚举，以 partial + asr_coverage_unverified 表示已有转写但覆盖未核验；asr_truncated 单独表示已知截断。记录引擎完成状态、可取得的输入/解码秒数、输出段数和字符数，不用它们推算语音覆盖率。所有 ASR 入口统一归一化；字幕/OCR 原规则不扩改。外文词候选与疑似断句分别提示，中文同音词仍声明需要听音。

范围：src/extractor/asr.ts、quality.ts、transcript_text.ts、social_media.ts、youtube.ts、src/agent/runtime.ts；对应跨分支测试；README、仓库技能、恢复文档、CHANGELOG。新建纯函数 asr_quality.ts 负责证据构造及格式化。

- [x] 新增失败测试：未知覆盖/STOP/截断、字段合法性、专名原文位置与不改词。
- [x] 实现 ASR 归一化及本地/云端证据；解码错误不可采用部分 WAV。
- [x] 传播到抖音、小红书、YouTube 及原生视频；存储读回、模型提示与用户输出一致。
- [x] 专项、全量、隔离审计与 TypeScript 验证。
- [x] 公开 #80 音轨离线隔离复验，保留原始/清理正文和证据；核对保护快照。
- [ ] 同步仓库技能文档，发布 v0.4.16；精确提交 CI 通过后打标签/Release。

约束：不写原工作区，不改部署服务/已安装技能/私有配置，不写回原文笔记，不发微信、不重试17条失败；不调用Gemini。复验从干净源码副本启动，禁网、独立HOME，私有目录不可读。所有测试使用 bun run test 隔离入口。
