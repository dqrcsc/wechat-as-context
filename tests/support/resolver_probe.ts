// Executed only by the isolated test runner in a separate guarded Bun process.
import './isolation.ts';
import { mock } from 'bun:test';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import * as childProcess from 'node:child_process';

const scenario = JSON.parse(process.argv[2]);
const binary = join(process.env.TMPDIR!, 'fixture-yt-dlp');
writeFileSync(binary, 'fixture only; never execute');
chmodSync(binary, 0o700);
process.env.YT_DLP_BIN = binary;
Object.assign(process.env, scenario.env || {});
let invocation: any;
mock.module('node:child_process', () => ({ ...childProcess,
  execFile: (bin: string, args: string[], options: any, callback: any) => {
    invocation = { bin, args, options };
    const error = scenario.error ? Object.assign(new Error('synthetic secret error'), scenario.error) : null;
    callback(error, scenario.largeOutput ? '中'.repeat(800000) : scenario.stdout ?? JSON.stringify({ id: 'abcdefghijk', formats: [] }), scenario.stderr || '');
    return {};
  },
}));
const { resolveYouTubeFallbackAudio } = await import('../../src/extractor/youtube_fallback.ts');
let result;
if (scenario.extract) {
  const { setAsrTestRunner } = await import('../../src/extractor/asr.ts');
  const { extractYouTubeVideo } = await import('../../src/extractor/youtube.ts');
  setAsrTestRunner(async () => { throw new Error('synthetic unavailable ASR'); });
  const player = { videoDetails: { title: 'Fixture', shortDescription: 'Public fixture' },
    streamingData: { adaptiveFormats: [{ mimeType: 'audio/mp4', url: 'https://old.googlevideo.com/a' }] } };
  globalThis.fetch = (async () => new Response(`<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`)) as any;
  result = await extractYouTubeVideo('https://youtu.be/abcdefghijk');
} else {
  result = await resolveYouTubeFallbackAudio('abcdefghijk');
}
console.log(JSON.stringify({ result, invocation }));
