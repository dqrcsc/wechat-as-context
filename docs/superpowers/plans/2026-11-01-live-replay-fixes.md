# Live replay fixes implementation plan

Goal: address the six defects observed during the v0.4.5 historical replay, without modifying deployment, historical records, or user edits.

Spec: the user's 2026-11-01 request and the local historical replay report. Public fixtures must be synthetic and contain no private backgrounds, messages, source URLs with tokens, or credentials.

Architecture: retain existing extractors and archive flow. Add bounded source-specific recovery; preserve acquisition errors and unknown/partial quality. Keep one statistical contract for WeChat and companion, and protect business conditions during compression. Extend explicit idea routing and conservative ASR diagnostics only.

## Constraints

- Existing dirty original checkout stays untouched. Reuse review checkout from v0.4.5.
- No service operations, WeChat sends, or retries/changes to the 17 historical failures.
- No additional private images or text sent to Gemini. Tests run through the isolated runner.
- No TLS bypass, inferred content identity, automatic tool installation, or recursive cleanup.
- Real source failures remain visible even when mocks pass.

## Ordered tasks and acceptance

- [x] Transport: only allowlisted Douyin HTTPS GET certificate failures may use system curl with normal verification, no curlrc, no cookies, bounded time/body, manual redirects rechecked by public_url. Preserve network failure before identity checks. Test successful recovery, private redirect, cancellation, non-TLS errors, unsupported hosts/methods and invalid response.
- [x] YouTube: after native transcript acquisition fails, optionally use locally installed yt-dlp to resolve current audio URLs. Ignore config/plugins/cookies, use canonical target only, bounded subprocess and output; verify video ID, pass bytes through existing bounded downloader and ASR. Missing tool/403/empty output remain metadata_only with concrete reasons. Test recovery, mismatched identity, invalid/private URL, timeout and no fallback when native captions succeed.
- [x] WeChat: remove only a recognizable trailing reward panel plus observed navigation lines; retain prose and unknown following content. Add the observed tail structure as a synthetic regression.
- [x] Short analysis: compact the common statistical block without removing definitions/units/threshold confirmation/zero denominators/failure scope; use remaining character budget in compression and retain protected sections. Test equal contract text, relative/percentage-point formulas, successful short reply and unsafe-compression rejection.
- [x] Offline ideas: accept the explicit phrase “我有个想法：” consistently in router and capture normalization; verify actual isolated runtime creates an idempotent seed and unrelated chat stays unarchived.
- [x] ASR: identify bounded exact-text punctuation/number fragments needing human review, with character offsets; never guess words or timestamps, preserve raw evidence. Test social and native rendering branches.
- [x] Sync README, analysis guide, the existing Chinese changelog, repository/global Skill and review document; run full isolation tests, typecheck, Spec/Standards diff review, then patch release with published limitations.

Validation commands: `bun --no-env-file tests/run.ts tests/live_replay.test.ts`, `bun run test`, `bun run test:isolation`, installed TypeScript compiler. Real public-source checks use only isolated directories, never production CLI. Review and release are already authorized by the user; no additional approval gate is introduced.

Completion: 500 isolated tests / 2328 assertions; isolation audit 7 / 40; TypeScript 5.9.3 and both review axes pass. Source acquisition validated with a public YouTube ASR recovery and default Douyin HTTP 200; compact preview 650 characters without changing protected sections. No deployment operations.
