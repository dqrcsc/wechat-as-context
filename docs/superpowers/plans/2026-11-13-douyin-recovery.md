# Douyin recovery implementation plan

**Goal:** Restore identity-verified SEO excerpts and expose browser acquisition stages; choose proxy/navigation/wait changes from single-factor experiments.

**Architecture:** Preserve the current SSR → SEO → CDP flow and strict target ID matching. Add a conservative page-anchored SEO fallback only for a unique VideoObject with no declared references and a single matching breadcrumb leaf. Browser diagnostics return fixed reason codes, separate from raw errors/URLs. Existing quality serialization carries these reasons and excerpt warnings.

**Tech stack:** Bun / TypeScript, CDP, existing system-proxy parser, isolated Bun tests.

**Spec:** User-approved scope in the #80 diagnostic follow-up; prior findings are summarized in the release verification document, with local evidence kept outside Git.

## Global constraints

Preserve original dirty workspace, deployed service/configuration, original notes and 17 historical failed outbox records. Do not send WeChat, run model calls, copy private context into experiments, or publish private evidence. Do not batch-delete profiles. Keep TLS and identity validation enabled; diagnostic browser sandbox adaptations never enter product defaults.

## Task 1: Single-factor public acquisition experiments

- [x] Use a fixed diagnostic harness with a fresh anonymous profile for each sequential run; outer filesystem isolation, no model/production credentials.
- [x] Repeat anchor and single-factor contrasts twice: explicit system proxy vs inherited, navigation 20s vs 5s, observation 55s vs 25s, reload off vs one reload at 12.5s. Hold other parameters and source ID constant. Record elapsed phases and target-ID/media success; do not infer significance from small samples.
- [x] Persist raw local evidence outside repository; summarize outcomes and limitations in documentation. Retain defaults for changes not supported by evidence.

## Task 2: SEO excerpts

Files: `src/extractor/social_media.ts`, `src/extractor/quality.ts`, `tests/douyin_recovery.test.ts`.

- [x] Regression first: matching canonical + single VideoObject + matching breadcrumb without object URL is accepted; mismatched/empty explicit URLs, multiple objects, absent/conflicting breadcrumb/page identity are rejected.
- [x] Keep explicit matching references compatible. Use name/description as bounded excerpt, remove known template suffix, record `douyin_seo_excerpt` and `douyin_seo_page_identity` when applicable; never claim complete transcript.
- [x] Verify metadata-only and successful-ASR combinations, persisted warnings and meaningful descriptions after empty/template names.

## Task 3: Browser diagnostics and necessary changes

Files: `src/extractor/social_media.ts`, `src/extractor/cdp.ts`, browser helper if needed to test acquisition independently; `tests/douyin_recovery.test.ts`.

- [x] Diagnose browser unavailable, spawn/endpoint/tab/connect/setup/navigation failure, document HTTP/TLS errors, detail request absent/failed/invalid/mismatched/no media, overall deadline, and successful detail. Do not log arbitrary errors, signed URLs or response bodies.
- [x] Test lifecycle with fake CDP and timers, preserving late detail completion, cancellation and resource cleanup. Use protected test hooks for full extractor propagation.
- [x] Implement only factor adjustments supported by experiments; no hardcoded proxy address, no TLS bypass, no login/profile reuse or placeholder DOM-video fallback.

## Task 4: Validation and release

- [x] Run focused isolated regression, full `bun run test`, `bun run test:isolation`, TypeScript and diff checks. Exclude only the existing untracked probe files from the temporary local typecheck.
- [x] Update repository skill, README, recovery diagnostics and changelog; do not update installed skill/deployment this turn.
- [ ] Commit explicit file list, fast-forward push main, wait for exact-commit CI, tag/release v0.4.14, read back refs and release status. Recheck protected hashes and failure rows.
