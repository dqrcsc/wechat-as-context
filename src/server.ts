import { LOCAL_HOST, createHttpHandler } from "./http.ts";
import { loadConfig } from "./config.ts";
import { ContextDatabase } from "./db.ts";
import { WeChatContextPipeline } from "./pipeline.ts";

const config = loadConfig();
const db = new ContextDatabase(config.dbPath);
const pipeline = new WeChatContextPipeline(config, db);

const server = Bun.serve({ hostname: LOCAL_HOST, port: config.port, fetch: createHttpHandler(db, pipeline), maxRequestBodySize: 1024 * 1024 });

console.log(
  `🚀 [wechat-as-context] Server listening on http://127.0.0.1:${server.port}`
);
console.log(
  `   ClawBot Status:   ${
    pipeline.clawbot.isConfigured()
      ? `Credentials configured (${pipeline.clawbot.getCredentials()?.botId} long-polling active)`
      : "⏳ Not bound yet (run `bun run src/cli.ts login` to scan QR)"
  }`
);
console.log(`   Vault Root:       ${config.vaultRoot}`);
console.log(
  `   Agent Models:     Fast=${config.llm.fastModel || config.llm.model} | Pro=${config.llm.proModel || "gemini-2.5-pro"}`
);

// Background queue drainer (checks annotation wait windows, pending agent tasks & outbox retries every 5 seconds)
setInterval(async () => {
  try {
    await pipeline.drainAgentQueue();
    await pipeline.drainReadyQueue();
    if (pipeline.clawbot.isConfigured()) {
      await pipeline.flushReplies({ enforceRetryBackoff: true });
    }
  } catch (err) {
    console.error("[Timer] drainReadyQueue error:", err);
  }
}, 5000);

// Continuous Long-Polling Loop for 微信ClawBot [AI] (Zero Tunnel, Pinnable in WeChat)
(async function startClawBotLongPollLoop() {
  while (true) {
    try {
      if (pipeline.clawbot.isConfigured()) {
        await pipeline.pollClawBotUpdates(30_000, { backgroundDrain: true });
      } else {
        await Bun.sleep(3000);
      }
    } catch (err: any) {
      console.warn("[ClawBot Poll] retrying after error:", err?.message || err);
      await Bun.sleep(3000);
    }
  }
})();
