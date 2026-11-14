import './support/isolation.ts';
import { expect, test } from 'bun:test';
import { chromeProfileArgs } from '../src/extractor/chrome_profile.ts';

for (const platform of ['darwin', 'linux', 'win32'] as const) {
  for (const ephemeral of [true, false]) {
    test(`Chrome profile boundary: ${platform}, ephemeral=${ephemeral}`, () => {
      const profile = '/fixture/anonymous profile';
      const args = chromeProfileArgs(profile, ephemeral, platform);
      expect(args.filter(arg => arg.startsWith('--user-data-dir='))).toEqual([`--user-data-dir=${profile}`]);
      expect(args.includes('--use-mock-keychain')).toBe(platform === 'darwin' && ephemeral);
      expect(args.every(arg => arg === `--user-data-dir=${profile}` || arg === '--use-mock-keychain')).toBe(true);
    });
  }
}

test('a persistent profile is not classified as anonymous by its temporary-looking name', () => {
  expect(chromeProfileArgs('/tmp/wxctx-dy-cdp-existing-session', false, 'darwin')).toEqual([
    '--user-data-dir=/tmp/wxctx-dy-cdp-existing-session',
  ]);
});

test('profile spaces and flag-like text remain a single path argument', () => {
  const profile = '/fixture/Chrome Session --proxy-server=untrusted';
  const args = chromeProfileArgs(profile, true, 'darwin');
  expect(args).toEqual([`--user-data-dir=${profile}`, '--use-mock-keychain']);
  expect(args).not.toContain('--proxy-server=untrusted');
});

test('default platform uses the current runtime while retaining explicit profile ownership', () => {
  expect(chromeProfileArgs('/fixture/profile', true)).toEqual(chromeProfileArgs('/fixture/profile', true, process.platform));
  expect(chromeProfileArgs('/fixture/profile', false)).toEqual(['--user-data-dir=/fixture/profile']);
});
