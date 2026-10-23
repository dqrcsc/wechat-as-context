import { resolve, isAbsolute } from "node:path";
import { createTestWorkspace } from "./support/workspace.ts";

const args = process.argv.slice(2);
// Paths are interpreted in the isolated project, never in the original checkout.
if (args.some(arg => isAbsolute(arg) || arg.split(/[\\/]/).includes("..") || /^(?:--(?:cwd|preload|require|import|config|env-file)|-r)(?:=|$)/.test(arg))) {
  throw new Error("Use repository-relative test paths; runtime/config overrides are not allowed");
}
const workspace = createTestWorkspace(resolve(import.meta.dir, ".."));
console.error(`[Test isolation] ${workspace.root}`);
const child = Bun.spawn([process.execPath, "--no-env-file", "test", ...args], {
  cwd: workspace.project, env: workspace.env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
