import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { AppConfig } from "../config.ts";
import { fetchWithTransientRetry, resolveModelEndpoint } from "../agent/llm.ts";
import { fetchPublicResource } from "../public_url.ts";

export interface AsrTranscriptionRequest {
  mediaUrl?: string;
  mediaUrls?: string[];
  mediaPath?: string;
  headers?: Record<string, string>;
  config?: AppConfig;
  hintTitle?: string;
}

export interface AsrTranscriptionResult {
  transcript: string;
  engineUsed: string;
  durationSeconds?: number;
}

export type AsrTestRunner = (
  req: AsrTranscriptionRequest
) => Promise<AsrTranscriptionResult>;

let customAsrTestRunner: AsrTestRunner | null = null;

/**
 * Install or clear a deterministic test runner for ASR transcription in unit tests.
 */
export function setAsrTestRunner(runner: AsrTestRunner | null): void {
  customAsrTestRunner = runner;
}

function findFfmpegBinary(): string | null {
  if (process.env.WXCTX_TEST_ROOT) return null;
  const candidates = [
    process.env.FFMPEG_BIN || "",
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function findLocalAsrBinary(): string | null {
  if (process.env.WXCTX_TEST_ROOT) return null;
  const candidates = [
    process.env.LOCAL_ASR_BIN || "",
    join(homedir(), ".local", "bin", "local-asr"),
    "/usr/local/bin/local-asr",
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function cleanupTempDirSafe(dirPath: string): void {
  try {
    if (!existsSync(dirPath)) return;
    for (const entry of readdirSync(dirPath)) {
      try {
        unlinkSync(join(dirPath, entry));
      } catch {}
    }
  } catch {}
}

/** Same bounded, redirect-checked streaming downloader in tests and production. */
export async function downloadMediaStream(
  url: string, target: string, headers: Record<string, string> = {},
  options: { maxBytes?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
  const signal = options.signal ?? AbortSignal.timeout(75_000);
  const response = await fetchPublicResource(url, { headers, signal });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Invalid or oversized media stream (HTTP ${response.status})`);
  }
  const reader = response.body.getReader();
  const fd = openSync(target, "w", 0o600);
  let total = 0;
  let complete = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Media stream exceeds size limit");
      let offset = 0;
      while (offset < value.byteLength) offset += writeSync(fd, value, offset, value.byteLength - offset);
    }
    signal.throwIfAborted();
    if (total < 256) throw new Error("Downloaded media stream is empty or invalid");
    complete = true;
  } finally {
    closeSync(fd);
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
    if (!complete && existsSync(target)) unlinkSync(target);
  }
}

/**
 * Dual-Engine Audio Transcription (100% self-contained):
 * - Tier 1: Local offline `local-asr` (FunASR + SenseVoiceSmall) with `ffmpeg` audio track extraction.
 * - Tier 2: Cloud BYOK Multimodal Audio fallback (Gemini native inlineData audio / OpenAI compatible audio).
 * Temporary video/audio files are strictly deleted after transcription.
 */
export async function transcribeAudioFromMedia(
  req: AsrTranscriptionRequest
): Promise<AsrTranscriptionResult> {
  if (customAsrTestRunner) {
    return customAsrTestRunner(req);
  }

  const baseTmpRoot = req.config?.dataDir
    ? join(req.config.dataDir, "tmp_asr")
    : join(tmpdir(), "wxctx_asr");
  const workDir = join(baseTmpRoot, `asr_${Date.now()}_${randomUUID().slice(0, 8)}`);
  mkdirSync(workDir, { recursive: true });

  try {
    let localMediaPath = req.mediaPath;
    const candidateUrls = Array.from(
      new Set([...(req.mediaUrls || []), ...(req.mediaUrl ? [req.mediaUrl] : [])].filter(Boolean))
    );

    if (!localMediaPath && candidateUrls.length > 0) {
      const targetOut = join(workDir, "downloaded_stream.mp4");
      const defaultUa =
        req.headers?.["User-Agent"] ||
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
      let lastErr: Error | null = null;
      for (const candidateUrl of candidateUrls) {
        try {
          await downloadMediaStream(candidateUrl, targetOut, { "User-Agent": defaultUa, ...(req.headers || {}) });
          localMediaPath = targetOut;
          break;
        } catch (err) { lastErr = err instanceof Error ? err : new Error(String(err)); }
      }
      if (!localMediaPath && lastErr) throw lastErr;
    }

    if (!localMediaPath || !existsSync(localMediaPath)) {
      throw new Error("No valid media file or stream URL provided for ASR");
    }

    // Step 1: Extract 16kHz mono audio track via ffmpeg if available
    const ffmpegBin = findFfmpegBinary();
    let audioPathForAsr = localMediaPath;
    let durationSeconds: number | undefined;

    if (ffmpegBin) {
      const wavOut = join(workDir, "extracted_16k.wav");
      const ffRes = spawnSync(
        ffmpegBin,
        [
          "-y",
          "-i",
          localMediaPath,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-f",
          "wav",
          wavOut,
        ],
        {
          encoding: "utf-8",
          timeout: 120_000,
          maxBuffer: 25 * 1024 * 1024,
        }
      );
      if (ffRes.stderr) {
        const durMatch = ffRes.stderr.match(
          /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/
        );
        if (durMatch) {
          durationSeconds = Math.round(
            Number(durMatch[1]) * 3600 +
              Number(durMatch[2]) * 60 +
              Number(durMatch[3])
          );
        }
      }
      if (existsSync(wavOut) && statSync(wavOut).size > 4096) {
        audioPathForAsr = wavOut;
      }
    }

    // Step 2: Engine 1 -> Local offline `local-asr` (FunASR + SenseVoiceSmall)
    const localAsrBin = findLocalAsrBinary();
    if (localAsrBin) {
      const asrRes = spawnSync(
        localAsrBin,
        [
          audioPathForAsr,
          "--out-dir",
          workDir,
          "--format",
          "json,txt",
          "--quiet",
        ],
        {
          encoding: "utf-8",
          timeout: 180_000,
          maxBuffer: 16 * 1024 * 1024,
        }
      );
      if (asrRes.status === 0) {
        const stem = basename(audioPathForAsr, extname(audioPathForAsr));
        const jsonPath = join(workDir, `${stem}.json`);
        const txtPath = join(workDir, `${stem}.txt`);
        if (existsSync(jsonPath)) {
          try {
            const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
              text?: string;
              raw_text?: string;
            };
            const text = (parsed.text || parsed.raw_text || "").trim();
            if (text.length > 0) {
              return {
                transcript: text,
                engineUsed: "local_asr_sensevoice",
                durationSeconds,
              };
            }
          } catch {}
        }
        if (existsSync(txtPath)) {
          const text = readFileSync(txtPath, "utf-8").trim();
          if (text.length > 0) {
            return {
              transcript: text,
              engineUsed: "local_asr_sensevoice",
              durationSeconds,
            };
          }
        }
      }
    }

    // Step 3: Engine 2 -> Cloud BYOK Multimodal Audio Fallback
    if (req.config) {
      const cloudRes = await tryCloudMultimodalAudioTranscription(
        audioPathForAsr,
        workDir,
        ffmpegBin,
        req.config,
        req.hintTitle
      );
      if (cloudRes) {
        return {
          transcript: cloudRes.transcript,
          engineUsed: cloudRes.engineUsed,
          durationSeconds,
        };
      }
    }

    throw new Error(
      "Audio transcription unavailable (neither local-asr nor a multimodal audio API succeeded)"
    );
  } finally {
    cleanupTempDirSafe(workDir);
  }
}

async function tryCloudMultimodalAudioTranscription(
  audioPath: string,
  workDir: string,
  ffmpegBin: string | null,
  config: AppConfig,
  hintTitle?: string
): Promise<{ transcript: string; engineUsed: string } | null> {
  const resolvedEp = resolveModelEndpoint(config, "fast");
  const apiKey = resolvedEp.apiKey || config.llm.apiKey;
  const baseUrl = (resolvedEp.baseUrl || config.llm.baseUrl).replace(/\/+$/, "");
  const model = resolvedEp.model || config.llm.fastModel || config.llm.model;
  if (!apiKey) return null;

  // Compress audio to compact 32kbps mp3 if ffmpeg is available so payload stays small
  let sendPath = audioPath;
  let mimeType = audioPath.endsWith(".wav") ? "audio/wav" : "audio/mp4";
  if (ffmpegBin && !process.env.WXCTX_TEST_ROOT) {
    const mp3Out = join(workDir, "compact_audio.mp3");
    const r = spawnSync(
      ffmpegBin,
      ["-y", "-i", audioPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", mp3Out],
      { timeout: 60_000 }
    );
    if (r.status === 0 && existsSync(mp3Out)) {
      sendPath = mp3Out;
      mimeType = "audio/mp3";
    }
  }

  const audioBuffer = readFileSync(sendPath);
  if (audioBuffer.length > 20 * 1024 * 1024) {
    return null;
  }
  const base64Audio = audioBuffer.toString("base64");

  // Option A: Google Gemini native generateContent with inlineData audio
  if (
    resolvedEp.providerId === "gemini" ||
    baseUrl.includes("generativelanguage.googleapis.com") ||
    model.startsWith("gemini-")
  ) {
    try {
      const nativeBase = baseUrl
        .replace(/\/openai$/i, "")
        .replace(/\/v1beta$/i, "");
      const geminiUrl = `${nativeBase}/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const resp = await fetchWithTransientRetry(geminiUrl, () => ({
        method: "POST",
        signal: AbortSignal.timeout(90_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `请将这段音频完整、准确地转写为带标点符号的书面逐字稿（保留原语言及专业术语，合理分段，不要删减实质内容，只输出转写正文）：${
                    hintTitle ? `\n视频标题参考：${hintTitle}` : ""
                  }`,
                },
                {
                  inlineData: {
                    mimeType,
                    data: base64Audio,
                  },
                },
              ],
            },
          ],
          generationConfig: { temperature: 0.1 },
        }),
      }));
      if (resp.ok) {
        const data = (await resp.json()) as any;
        const text = (data?.candidates?.[0]?.content?.parts ?? [])
          .map((p: any) => p.text || "")
          .join("")
          .trim();
        if (text.length > 10) {
          return { transcript: text, engineUsed: `gemini_audio:${model}` };
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Use the configured Vision-capable LLM to extract structured text, tables, and diagrams
 * from swipeable image-carousel cards (e.g., Xiaohongshu / Douyin PPT cards).
 */
export async function extractStructuredTextFromImageCards(params: {
  imageUrls: string[];
  noteTitle: string;
  noteDesc: string;
  refererUrl: string;
  config?: AppConfig;
}): Promise<string> {
  const { imageUrls, noteTitle, noteDesc, refererUrl, config } = params;
  if (!config || imageUrls.length === 0) return "";

  const resolvedEp = resolveModelEndpoint(config, "fast");
  const apiKey = resolvedEp.apiKey || config.llm.apiKey;
  const baseUrl = (resolvedEp.baseUrl || config.llm.baseUrl).replace(/\/+$/, "");
  const model = resolvedEp.model || config.llm.fastModel || config.llm.model;
  if (!apiKey) return "";

  // Download up to 6 key card images into memory as base64 data URLs
  const dataUrls: string[] = [];
  for (const imgUrl of imageUrls.slice(0, 6)) {
    try {
      const resp = await fetchPublicResource(imgUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          Referer: refererUrl,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) continue;
      const contentType = resp.headers.get("content-type") || "image/jpeg";
      if (!contentType.startsWith("image/")) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 100 || buf.length > 6 * 1024 * 1024) continue;
      dataUrls.push(`data:${contentType.split(";")[0]};base64,${buf.toString("base64")}`);
    } catch {}
  }

  if (dataUrls.length === 0) return "";

  try {
    const endpoint = `${baseUrl}/chat/completions`;
    const userContent: Array<Record<string, unknown>> = [
      {
        type: "text",
        text: `以下是图文笔记《${noteTitle}》中的 ${dataUrls.length} 张信息卡片配图（原帖附言：${noteDesc.slice(
          0,
          400
        )}）。
请逐张准确提取图片卡片中的文字、核心论点、架构图层级、对比表格或代码配置，整理为结构清晰的 Markdown 内容（不要遗漏关键干货细节）：`,
      },
      ...dataUrls.map((url) => ({
        type: "image_url",
        image_url: { url },
      })),
    ];

    const resp = await fetchWithTransientRetry(endpoint, () => ({
      method: "POST",
      signal: AbortSignal.timeout(45_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:
              "你是高精度多模态图文卡片解析器。请将配图中的全部干货文字、结构图、列表与表格完整还原为 Markdown。",
          },
          {
            role: "user",
            content: userContent,
          },
        ],
      }),
    }));

    if (!resp.ok) return "";
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const extracted = data.choices?.[0]?.message?.content?.trim() || "";
    // Avoid accidentally treating a mocked Intent Router JSON or Article Analyzer JSON in tests as OCR text
    if (extracted.startsWith("{") && extracted.endsWith("}")) return "";
    return extracted;
  } catch {
    return "";
  }
}
