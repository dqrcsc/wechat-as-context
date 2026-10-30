import { copyFileSync, existsSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";

/** Keep launchd's O_APPEND stdout/stderr descriptors on the active inode.
 * Copy/truncate has a small concurrent-write loss window; this is bounded
 * diagnostic retention, not a lossless audit log.
 */
export function rotateDaemonLogsIfOversized(dataDir: string, maxBytes = 5 * 1024 * 1024): void {
  for (const name of ["daemon.stdout.log", "daemon.stderr.log"]) {
    const path = join(dataDir, name);
    try {
      if (existsSync(path) && statSync(path).size > maxBytes) {
        copyFileSync(path, `${path}.1`);
        truncateSync(path, 0);
      }
    } catch { /* Logging must not stop the queue drainer. */ }
  }
}
