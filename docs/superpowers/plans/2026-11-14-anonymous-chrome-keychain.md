# Anonymous Chrome Keychain Implementation Plan

**Goal:** Prevent macOS temporary anonymous Chromium acquisition from blocking on the real keychain, without changing persistent/login profiles.

**Architecture:** A small shared profile-argument function returns the existing user-data-dir argument and conditionally adds `--use-mock-keychain` for explicitly ephemeral profiles on Darwin. The Douyin CDP launcher passes true after mkdtemp; the existing DOM renderer passes its ephemeralProfile flag. Other launchers remain unchanged because they do not explicitly own an anonymous profile.

**Tech Stack:** Bun / TypeScript / Chromium CDP.

**Spec:** User-approved minimal fix from the #80 navigation diagnosis: paired controls stalled during Cookie persistent-store initialization; mock-keychain cases recovered the matching 795-character description and media. Restoring all navigation/proxy defaults with only mock-keychain retained succeeded twice. This evidence is scoped to the isolated environment, not a universal recovery guarantee.

## Constraints

Preserve production v0.4.14, installed skill, private background, original notes, dirty original workspace and 17 historical failed rows. No server operations, sends, retries, ASR or model calls. Keep TLS checks, proxy inheritance and existing deadlines. Never add diagnostic --no-sandbox, fixed proxy or mock-keychain to persistent profiles.

## Task 1: Regression and minimal implementation

Files: create `src/extractor/chrome_profile.ts`, `tests/chrome_profile.test.ts`; modify `src/extractor/social_media.ts`.

- [x] Add table-driven tests: Darwin ephemeral/persistent, Linux ephemeral/persistent, Windows ephemeral/persistent. Preserve a profile path containing spaces and flag-like text as one argv item. A temporary-looking path with ephemeral=false must stay persistent; the default platform must match process.platform. Only user-data-dir plus the allowed mock flag may be produced.
- [x] Run `bun run test tests/chrome_profile.test.ts` before implementation to confirm the missing-module failure.
- [x] Implement `chromeProfileArgs(profileDir: string, ephemeralProfile: boolean, platform: NodeJS.Platform = process.platform): string[]` with `['--user-data-dir='+profileDir, ...(ephemeralProfile && platform==='darwin' ? ['--use-mock-keychain'] : [])]`.
- [x] Replace the two existing user-data-dir entries with that function: true for mkdtemp-owned Douyin CDP; actual ephemeralProfile for the DOM renderer. Leave credential-copying and browser cleanup unchanged.
- [x] Run focused tests and review the scope diff.

## Task 2: Public isolated replay and release

- [x] Copy current source into an isolated folder. Deny private/home application reads, use anonymous temporary Chrome profiles, omit credentials and models. Only adapt the diagnostic browser sandbox and retain temp files; do not inject the fix separately from product code.
- [x] Call the updated real CDP acquisition twice for public #80 with production navigation/proxy defaults. Verify target ID, 795-character description, media candidates and controlled reasons. Download an audio candidate from a fresh matching response, compare response length, probe duration and decode the complete file.
- [x] Run full `bun run test`, `bun run test:isolation`, TypeScript and diff checks. Use the existing isolated launcher; local typecheck excludes only pre-existing untracked probe files.
- [x] Update repository skill, README, recovery guide and release verification document. Bump package/changelog to v0.4.15 after successful validation. Installed skill remains unchanged.
- [ ] Compare protected hashes and failed rows; stage only explicit task files, commit, fast-forward push main, wait for exact-SHA CI, then annotate/tag/release and verify remote refs.
