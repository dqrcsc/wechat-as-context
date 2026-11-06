# Media Runtime Review Fixes Implementation Plan

**Goal:** Resolve the three P2 findings from the v0.4.8 review and complete diagnostics, offline CA tests and channel recovery documentation, then release v0.4.9.

**Architecture:** Preserve the existing extraction and archive flows. Keep a narrow subprocess environment allowlist, share executable discovery across the three existing media tools, and classify child-process errors without retaining stderr. Certificate tests run separately against a pinned optional Python dependency; they do not change production trust policy.

**Tech Stack:** Bun/TypeScript; isolated Bun tests; Python unittest/ssl plus yt-dlp 2026.10.26 and certifi 2026.10.19 for offline CA checks.

**Spec:** User-approved 2026-11-06 review: R1 proxy loss, R2 unsafe default force example, R3 tool paths, O1 diagnostics, O2 actual CA loading, O3 channel recovery boundaries.

## Constraints

Preserve the original dirty checkout. No deployment operations, WeChat sends, historical failed-row retries, private model requests or historical content rewrites. Keep test isolation intact. User has authorized implementation and publication; no additional approval gate is needed. Reuse the existing review checkout. Independent Spec/Standards reviews follow the code-review skill.

## Tasks and acceptance

- [x] Add `tests/media_runtime.test.ts` and isolated child-process fixtures: actual resolver execFile receives upper/lower proxy fields but no model keys; `expect(env.HTTPS_PROXY).toBe(input.HTTPS_PROXY)` must fail before R1 is fixed. Tool tests verify `~/tools/yt-dlp` equals the absolute executable and invalid explicit overrides never silently fall back.
- [x] Add `src/extractor/tool_binary.ts`: `findMediaToolBinary(name, override?, projectRoot?)` expands home/project-relative paths, checks regular executable files, uses the same default directories for yt-dlp/ffmpeg/local-asr and throws a sanitized error on invalid explicit paths. Wire existing call sites without changing test execution guards.
- [x] Update `youtube_fallback.ts` to retain proxy keys, classify size-limit/timeout/not-executable/certificate/proxy/network/HTTP/malformed-output failures, and preserve only finite numeric exit status. Test errors through mocked execFile rather than bypassing subprocess wiring; no raw stderr escapes in results.
- [x] Add `tests/integration/youtube_ca_test.py`, a public test CA fixture and pinned test requirements. Assert actual SSLContext trust stores for certifi present/absent and a custom CA; block networking. Add a separate CI job. No real TLS availability claim follows from certificate-loading tests.
- [x] Remove default `--force` from README; explain ordinary reanalysis, explicit overwrites, original-source re-extraction and optional sending. Document articles-ID versus native attachment recovery in a channel matrix; sync `.env.example`, analysis guide, repository/global Skill and release notes.
- [x] Run `bun run test`, `bun run test:isolation`, TypeScript 5.9.3, Python offline CA suite and `git diff --check`. Review both axes, resolve concrete findings, verify original hashes, commit/tag/push v0.4.9 and verify CI/Release.

The patch is complete only when the bounded runtime behavior, regression suite, documentation and published release agree. Tools remain optional; installing test dependencies does not install them into the running service.

Validation: 522 Bun tests / 2446 assertions; isolation audit 7 / 40; TypeScript 5.9.3; 4 offline CA integration tests. Spec and Standards reviews passed after clarifying native-video temporary-file retention. Publication uses the v0.4.9 tag; final remote CI is checked after push. Original workspace hashes and global Skill rendering are verified independently.
