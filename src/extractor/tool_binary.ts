import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

type MediaTool = 'yt-dlp' | 'ffmpeg' | 'local-asr';
export class MediaToolError extends Error {
  constructor(public tool: MediaTool, public reason: 'not_found' | 'not_executable' | 'invalid_path') {
    super(`${tool}_${reason}`); // Never include private paths in acquisition diagnostics.
  }
}

/** Explicit overrides are authoritative; relative paths are project-root relative. */
export function findMediaToolBinary(
  tool: MediaTool, override?: string, projectRoot = resolve(import.meta.dir, '../..')
): string | null {
  const raw = override?.trim();
  if (raw?.startsWith('~') && raw !== '~' && !raw.startsWith('~/')) throw new MediaToolError(tool, 'invalid_path');
  const candidates = raw
    ? [raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : resolve(projectRoot, raw)]
    : [join(homedir(), '.local/bin', tool), `/opt/homebrew/bin/${tool}`, `/usr/local/bin/${tool}`, `/usr/bin/${tool}`];
  for (const path of candidates) {
    try {
      if (!statSync(path).isFile()) throw new MediaToolError(tool, 'not_executable');
      accessSync(path, constants.X_OK);
      return path;
    } catch (error: any) {
      if (raw) throw error instanceof MediaToolError ? error : new MediaToolError(tool,
        error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'not_found' : 'not_executable');
    }
  }
  return null;
}
