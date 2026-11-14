/** Only a caller-owned temporary anonymous profile may avoid the macOS keychain.
 * Persistent profiles can contain cookies encrypted using the real keychain. */
export function chromeProfileArgs(
  profileDir: string,
  ephemeralProfile: boolean,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    ...(ephemeralProfile && platform === 'darwin' ? ['--use-mock-keychain'] : []),
  ];
}
