import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type MediaTool = 'yt-dlp' | 'ffmpeg' | 'local-asr';
export const MEDIA_TOOLS: readonly MediaTool[] = ['yt-dlp', 'ffmpeg', 'local-asr'];
export const MEDIA_TOOL_ENV: Record<MediaTool, string> = {
  'yt-dlp': 'YT_DLP_BIN', ffmpeg: 'FFMPEG_BIN', 'local-asr': 'LOCAL_ASR_BIN',
};

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
  // A bare command name (e.g. `yt-dlp`) is NOT looked up on PATH. If no such file exists in
  // the project root, report it as a path-notation problem rather than a missing install.
  const bareName = Boolean(raw) && raw !== '~' && !raw!.includes('/');
  const candidates = raw
    ? [raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : resolve(projectRoot, raw)]
    : [join(homedir(), '.local/bin', tool), `/opt/homebrew/bin/${tool}`, `/usr/local/bin/${tool}`, `/usr/bin/${tool}`];
  for (const path of candidates) {
    try {
      if (!statSync(path).isFile()) throw new MediaToolError(tool, 'not_executable');
      accessSync(path, constants.X_OK);
      return path;
    } catch (error: any) {
      if (!raw) continue;
      if (error instanceof MediaToolError) throw error;
      const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
      throw new MediaToolError(tool, missing ? (bareName ? 'invalid_path' : 'not_found') : 'not_executable');
    }
  }
  return null;
}

export interface MediaToolStatus {
  tool: MediaTool;
  env: string;
  source: 'override' | 'default';
  status: 'ok' | 'not_installed' | 'invalid_override';
  path?: string;
  reason?: string;
}

/** Read-only local status for `doctor`; never installs, executes or falls back. */
export function describeMediaTools(env: NodeJS.ProcessEnv = process.env, projectRoot?: string): MediaToolStatus[] {
  return MEDIA_TOOLS.map((tool) => {
    const name = MEDIA_TOOL_ENV[tool];
    const override = env[name]?.trim() || undefined;
    const source = override ? 'override' as const : 'default' as const;
    try {
      const path = findMediaToolBinary(tool, override, projectRoot);
      return path
        ? { tool, env: name, source, status: 'ok' as const, path }
        : { tool, env: name, source, status: 'not_installed' as const };
    } catch (error) {
      const reason = error instanceof MediaToolError ? error.message : `${tool}_invalid_path`;
      return { tool, env: name, source, status: 'invalid_override' as const, reason };
    }
  });
}
