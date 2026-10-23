import { mock } from "bun:test";
import * as fs from "node:fs";
import * as sqlite from "bun:sqlite";
import * as childProcess from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep, join } from "node:path";

const rootValue = process.env.WXCTX_TEST_ROOT;
if (!rootValue || !process.env.WXCTX_TEST_TOKEN) {
  throw new Error("Test isolation is required. Run: bun run test [repository-relative test path]");
}
const root = fs.realpathSync(rootValue);
const marker = JSON.parse(fs.readFileSync(join(root, ".test-isolation.json"), "utf8"));
if (marker.token !== process.env.WXCTX_TEST_TOKEN || fs.realpathSync(resolve(import.meta.dir, "../..")) !== marker.project) {
  throw new Error("Invalid test isolation workspace");
}
const originalLstat = fs.lstatSync, originalRealpath = fs.realpathSync;
function assertInside(path: string): void {
  const absolute = resolve(path);
  let ancestor = absolute;
  while (true) {
    try { originalLstat(ancestor); break; }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Test isolation: unresolved path");
    ancestor = parent;
  }
  const canonical = resolve(originalRealpath(ancestor), relative(ancestor, absolute));
  const rel = relative(root, canonical);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Test isolation: path outside workspace: ${path}`);
  }
}
assertInside(process.cwd());
assertInside(process.env.HOME || "");
assertInside(process.env.TMPDIR || "");

const RealDatabase = sqlite.Database;
// SQLite can open other files after construction. Tests do not need these SQL operations.
for (const name of ["exec", "run", "query", "prepare"] as const) {
  const original = RealDatabase.prototype[name] as Function;
  (RealDatabase.prototype as any)[name] = function (sql: string, ...args: any[]) {
    if (/\b(?:attach|vacuum|load_extension|temp_store_directory|data_store_directory)\b/i.test(sql)) {
      throw new Error("Test isolation: SQL file access blocked");
    }
    return original.call(this, sql, ...args);
  };
}
RealDatabase.prototype.loadExtension = () => { throw new Error("Test isolation: SQLite extensions blocked"); };
const GuardedDatabase = new Proxy(RealDatabase, {
  construct(target, args) {
    if (args[0] !== undefined && args[0] !== ":memory:") {
      if (typeof args[0] !== "string" || args[0].startsWith("file:")) throw new Error("Test isolation: unsupported database path");
      assertInside(args[0]);
    }
    return Reflect.construct(target, args);
  },
  get(target, key, receiver) {
    if (key === "open") return (...args: any[]) => Reflect.construct(GuardedDatabase, args);
    return Reflect.get(target, key, receiver);
  },
});
mock.module("bun:sqlite", () => ({ ...sqlite, Database: GuardedDatabase }));

// Check before ContextDatabase creates its parent directory, and before app file reads/writes.
const guardedFs: Record<string, any> = { ...fs };
const safeDescriptors = new Set<number>();
const openSync = fs.openSync, closeSync = fs.closeSync;
const symlinkSync = fs.symlinkSync;
guardedFs.symlinkSync = (target: string, path: string, ...args: any[]) => {
  assertInside(path);
  return (symlinkSync as Function)(target, path, ...args);
};
guardedFs.openSync = (path: string, ...args: any[]) => {
  assertInside(path);
  const fd = (openSync as Function)(path, ...args);
  safeDescriptors.add(fd);
  return fd;
};
guardedFs.closeSync = (fd: number) => { safeDescriptors.delete(fd); return closeSync(fd); };
for (const name of ["mkdirSync", "readFileSync", "writeFileSync", "appendFileSync", "unlinkSync", "readdirSync"] as const) {
  const original = fs[name] as Function;
  guardedFs[name] = (path: any, ...args: any[]) => {
    if (typeof path === "number" && safeDescriptors.has(path)) return original(path, ...args);
    if (typeof path !== "string") throw new Error("Test isolation: file path or owned descriptor required");
    assertInside(path);
    return original(path, ...args);
  };
}
for (const name of ["renameSync", "linkSync", "copyFileSync"] as const) {
  const original = fs[name] as Function;
  guardedFs[name] = (from: string, to: string, ...args: any[]) => { assertInside(from); assertInside(to); return original(from, to, ...args); };
}
mock.module("node:fs", () => guardedFs);

// Tests may install fetch mocks. Restoring fetch restores this denial, never live networking.
globalThis.fetch = (async () => { throw new Error("Test isolation: unmocked network request blocked"); }) as unknown as typeof fetch;
const blockedProcess = () => { throw new Error("Test isolation: external process blocked; install a mock"); };
mock.module("node:child_process", () => ({ ...childProcess, spawn: blockedProcess, spawnSync: blockedProcess,
  exec: blockedProcess, execSync: blockedProcess, execFile: blockedProcess, execFileSync: blockedProcess, fork: blockedProcess }));

// All real Bun child probes inherit the boundary, including callers supplying a partial env.
const originalSpawn = Bun.spawn.bind(Bun), originalSpawnSync = Bun.spawnSync.bind(Bun);
function childArgs(command: any, options: any = {}) {
  const cmd = Array.isArray(command) ? command : command.cmd;
  const opts = Array.isArray(command) ? options : command;
  if (cmd[0] !== process.execPath) return blockedProcess();
  const cwd = opts.cwd || process.cwd(); assertInside(cwd);
  return { cmd: [process.execPath, "--no-env-file", "--preload", import.meta.path, ...cmd.slice(1)],
    options: { ...opts, cwd, env: { ...(opts.env || process.env), HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      TMP: process.env.TMPDIR, TEMP: process.env.TMPDIR, WXCTX_TEST_ROOT: root, WXCTX_TEST_TOKEN: marker.token } } };
}
Bun.spawn = ((cmd: any, options: any) => { const child = childArgs(cmd, options); return originalSpawn(child.cmd, child.options); }) as typeof Bun.spawn;
Bun.spawnSync = ((cmd: any, options: any) => { const child = childArgs(cmd, options); return originalSpawnSync(child.cmd, child.options); }) as typeof Bun.spawnSync;
