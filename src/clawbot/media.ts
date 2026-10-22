import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { writeNewFile } from "../storage.ts";
import { fetchPublicResource } from "../public_url.ts";

export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export interface CdnMediaRef {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

/**
 * Parse WeChat iLink AES-128-ECB key into a 16-byte Buffer.
 * Supports:
 * 1) 32-char hex string (e.g. image_item.aeskey or outbound aeskey)
 * 2) base64(16 raw bytes) (inbound images)
 * 3) base64(32-char ASCII hex string) (inbound files/voice/video & outbound media.aes_key)
 */
export function parseWeChatAesKey(
  aesKeyBase64OrHex?: string,
  rawHexFallback?: string
): Buffer {
  if (rawHexFallback && /^[0-9a-fA-F]{32}$/.test(rawHexFallback.trim())) {
    return Buffer.from(rawHexFallback.trim(), "hex");
  }
  const input = (aesKeyBase64OrHex || "").trim();
  if (!input) {
    throw new Error("Missing AES key for C2C media");
  }
  if (/^[0-9a-fA-F]{32}$/.test(input)) {
    return Buffer.from(input, "hex");
  }
  const decoded = Buffer.from(input, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32) {
    const ascii = decoded.toString("ascii");
    if (/^[0-9a-fA-F]{32}$/.test(ascii)) {
      return Buffer.from(ascii, "hex");
    }
  }
  throw new Error(`Invalid WeChat AES key length after decode: ${decoded.length}`);
}

export function encryptAes128Ecb(plain: Buffer, key16: Buffer): Buffer {
  if (key16.length !== 16) {
    throw new Error(`AES-128-ECB requires 16-byte key, got ${key16.length}`);
  }
  const cipher = createCipheriv("aes-128-ecb", key16, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

export function decryptAes128Ecb(cipher: Buffer, key16: Buffer): Buffer {
  if (key16.length !== 16) {
    throw new Error(`AES-128-ECB requires 16-byte key, got ${key16.length}`);
  }
  const decipher = createDecipheriv("aes-128-ecb", key16, null);
  return Buffer.concat([decipher.update(cipher), decipher.final()]);
}

export function buildCdnDownloadUrl(
  media: CdnMediaRef,
  cdnBaseUrl = CDN_BASE_URL
): string {
  if (media.full_url && /^https?:\/\//i.test(media.full_url)) {
    return media.full_url;
  }
  if (!media.encrypt_query_param) {
    throw new Error("Missing media.full_url and media.encrypt_query_param");
  }
  const base = cdnBaseUrl.replace(/\/+$/, "");
  return `${base}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
}

/**
 * Download and decrypt an inbound C2C media item (image, file, voice, video).
 */
export async function downloadAndDecryptCdnMedia(params: {
  media: CdnMediaRef;
  hexAesKeyFallback?: string;
  saveDir: string;
  suggestedFileName?: string;
  cdnBaseUrl?: string;
}): Promise<{
  filePath: string;
  buffer: Buffer;
  mimeType: string;
  ext: string;
}> {
  const url = buildCdnDownloadUrl(params.media, params.cdnBaseUrl);
  const resp = await fetchPublicResource(url, {
    method: "GET",
    signal: AbortSignal.timeout(45_000),
  });
  if (!resp.ok) {
    throw new Error(`CDN download HTTP ${resp.status}`);
  }
  const encryptedBuf = Buffer.from(await resp.arrayBuffer());
  const hasKey = Boolean(params.media.aes_key || params.hexAesKeyFallback);
  const plainBuf = hasKey
    ? decryptAes128Ecb(
        encryptedBuf,
        parseWeChatAesKey(params.media.aes_key, params.hexAesKeyFallback)
      )
    : encryptedBuf;

  const { ext, mimeType } = detectBufferFormat(
    plainBuf,
    params.suggestedFileName
  );
  mkdirSync(params.saveDir, { recursive: true });
  const hash = createHash("sha256").update(plainBuf).digest("hex");
  const cleanName = params.suggestedFileName
    ? sanitizeFileName(params.suggestedFileName, ext)
    : "wx_media";
  const stem = basename(cleanName, extname(cleanName)).slice(0, 80) || "wx_media";
  const filePath = join(params.saveDir, `${stem}_${hash}.${ext}`);
  if (!writeNewFile(filePath, plainBuf) && !readFileSync(filePath).equals(plainBuf)) {
    throw new Error(`Archived media content mismatch: ${filePath}`);
  }
  return { filePath, buffer: plainBuf, mimeType, ext };
}

/**
 * Prepare metadata and encrypted buffer for outbound C2C CDN upload.
 */
export function prepareMediaForUpload(filePath: string): {
  fileName: string;
  plainBuf: Buffer;
  cipherBuf: Buffer;
  rawsize: number;
  filesize: number;
  rawfilemd5: string;
  filekey: string;
  aeskeyHex: string;
  outboundAesKeyBase64: string;
  mediaType: 1 | 2 | 3; // 1=IMAGE, 2=VIDEO, 3=FILE
} {
  const plainBuf = readFileSync(filePath);
  const aesKeyBuf = randomBytes(16);
  const aeskeyHex = aesKeyBuf.toString("hex");
  const filekey = randomBytes(16).toString("hex");
  const cipherBuf = encryptAes128Ecb(plainBuf, aesKeyBuf);
  const rawsize = plainBuf.length;
  const filesize = cipherBuf.length;
  const rawfilemd5 = createHash("md5").update(plainBuf).digest("hex");
  // Official @tencent-weixin/openclaw-weixin outbound convention: base64(ascii hex string)
  const outboundAesKeyBase64 = Buffer.from(aeskeyHex, "utf-8").toString("base64");

  const ext = extname(filePath).toLowerCase();
  const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext);
  const isVideo = [".mp4", ".mov"].includes(ext);
  const mediaType: 1 | 2 | 3 = isImage ? 1 : isVideo ? 2 : 3;

  return {
    fileName: basename(filePath),
    plainBuf,
    cipherBuf,
    rawsize,
    filesize,
    rawfilemd5,
    filekey,
    aeskeyHex,
    outboundAesKeyBase64,
    mediaType,
  };
}

export function detectBufferFormat(
  buf: Buffer,
  suggestedName?: string
): { ext: string; mimeType: string } {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: "png", mimeType: "image/png" };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return { ext: "jpg", mimeType: "image/jpeg" };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { ext: "gif", mimeType: "image/gif" };
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { ext: "webp", mimeType: "image/webp" };
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46
  ) {
    return { ext: "pdf", mimeType: "application/pdf" };
  }
  if (suggestedName) {
    const ext = extname(suggestedName).replace(/^\./, "").toLowerCase();
    if (ext === "md" || ext === "markdown") return { ext: "md", mimeType: "text/markdown" };
    if (ext === "txt") return { ext: "txt", mimeType: "text/plain" };
    if (ext === "json") return { ext: "json", mimeType: "application/json" };
    if (ext === "pdf") return { ext: "pdf", mimeType: "application/pdf" };
    if (ext) return { ext, mimeType: "application/octet-stream" };
  }
  return { ext: "bin", mimeType: "application/octet-stream" };
}

function sanitizeFileName(name: string, fallbackExt: string): string {
  const base = name.replace(/[/\\?%*:|"<>]/g, "_").trim();
  if (!base) return `file_${Date.now()}.${fallbackExt}`;
  return base;
}
