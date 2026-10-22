import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// Publish a complete file atomically, without replacing even a concurrent writer's document.
export function writeNewFile(path: string, content: string | Uint8Array): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, path); return true; }
    catch (error: any) { if (error.code === "EEXIST") return false; throw error; }
  } finally { unlinkSync(temporary); }
}

export function documentLevel(path: string): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  const header = readFileSync(path, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return header?.match(/^process_level:\s*["']?(raw|light|deep|synthesis)["']?\s*$/m)?.[1];
}
