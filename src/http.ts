import { ContextDatabase, ScheduledTaskKind, ScheduledTaskStatus } from "./db.ts";
import { WeChatContextPipeline, normalizeWeChatUrl } from "./pipeline.ts";
import { scanLocalAgentClis } from "./agent/subagent_cli.ts";
import { detectRequestedFormats } from "./agent/doc_exporter.ts";
import { parseNaturalScheduleSpec } from "./scheduler/time_parser.ts";
import { getNextCronRunMs, isValidCronExpression } from "./scheduler/cron.ts";
import { syncScheduledTasksToVaultQueue } from "./scheduler/vault_sync.ts";
import {
  buildConfigApiPayload,
  handleFetchProviderModels,
  handleInitVaultRequest,
  handlePickDirectoryRequest,
  handleSaveConfigRequest,
  handleTestLlmConnection,
  renderConfigPageHtml,
} from "./web_config.ts";

export const LOCAL_HOST = "127.0.0.1";

export function createHttpHandler(db: ContextDatabase, pipeline: WeChatContextPipeline) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    // Loopback only, plus Host/Origin checks against browser-origin requests and DNS rebinding.
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return new Response("Forbidden host", { status: 403 });
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) return new Response("Forbidden origin", { status: 403 });
    if (url.pathname === "/health" && req.method === "GET") {
      const activeAgentTasks = db.getActiveAgentTasks().map((t) => ({
        id: t.id,
        status: t.status,
        stage: t.stage,
        startedAt: t.started_at,
        heartbeatAt: t.heartbeat_at,
      }));
      return Response.json({
        ok: true,
        service: "wechat-as-context",
        credentialsConfigured: pipeline.clawbot.isConfigured(),
        connectionVerified: false,
        lastPoll: db.getState("clawbot_last_poll"),
        delivery: db.deliveryStatus(),
        pendingMessages: db.pendingMessages().length,
        activeAgentTasks,
      });
    }
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(null, {
        status: 302,
        headers: { Location: "/config" },
      });
    }
    if (url.pathname === "/config" && req.method === "GET") {
      return new Response(renderConfigPageHtml(), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/api/config" && req.method === "GET") {
      return Response.json(buildConfigApiPayload(db, pipeline));
    }
    if (url.pathname === "/api/config" && req.method === "POST") {
      return handleSaveConfigRequest(req, db, pipeline);
    }
    if (url.pathname === "/api/config/scan-cli" && req.method === "GET") {
      return Response.json({
        ok: true,
        discoveredClis: scanLocalAgentClis(pipeline.config),
        cliRoutingChain: pipeline.config.llm.cliRoutingChain,
      });
    }
    if (url.pathname === "/api/config/test-llm" && req.method === "POST") {
      return handleTestLlmConnection(req, pipeline);
    }
    if (url.pathname === "/api/config/fetch-models" && req.method === "POST") {
      return handleFetchProviderModels(req, pipeline);
    }
    if (url.pathname === "/api/config/pick-directory" && req.method === "POST") {
      return handlePickDirectoryRequest(req, pipeline);
    }
    if (url.pathname === "/api/config/init-vault" && req.method === "POST") {
      return handleInitVaultRequest(req, pipeline);
    }
    if (url.pathname === "/api/ingest" && req.method === "POST") {
      let body: { url: string; note?: string; title?: string };
      try {
        if (!req.headers.get("content-type")?.startsWith("application/json")) return new Response("Expected application/json", { status: 415 });
        body = await req.json() as typeof body;
        if (body && "annotation" in body) throw new Error("Use note instead of annotation");
        if (!body || typeof body.url !== "string" || (body.note !== undefined && typeof body.note !== "string") || (body.title !== undefined && typeof body.title !== "string")) throw new Error("Invalid article payload");
        body.url = normalizeWeChatUrl(body.url);
      } catch (error: any) { return Response.json({ ok: false, error: error.message }, { status: 400 }); }
      try {
        const { record } = db.enqueueArticle({ msgid: `api_${crypto.randomUUID()}`, url: body.url, title: body.title, user_notes: body.note, channel: "cli", waitSeconds: 0 });
        const article = await pipeline.processArticleById(record.id, { sendWeChatReply: false });
        return Response.json({ ok: true, article });
      } catch (error: any) { return Response.json({ ok: false, error: error.message }, { status: 500 }); }
    }
    if (url.pathname === "/api/push" && req.method === "POST") {
      try {
        if (!req.headers.get("content-type")?.startsWith("application/json")) {
          return new Response("Expected application/json", { status: 415 });
        }
        const body = (await req.json()) as {
          text?: string;
          title?: string;
          files?: string[];
          formats?: string[];
          articleId?: number;
          includeArticleFile?: boolean;
          useSourceFile?: boolean;
          recipient?: string;
          queueOnly?: boolean;
        };
        if (body && ("docPath" in body || "exportFormats" in body)) {
          throw new Error("Use files and formats instead of docPath and exportFormats");
        }
        const formats = Array.isArray(body?.formats)
          ? detectRequestedFormats("", body.formats)
          : [];
        const result = await pipeline.pushToWeChat({
          text: typeof body?.text === "string" ? body.text : undefined,
          title: typeof body?.title === "string" ? body.title : undefined,
          files: Array.isArray(body?.files) ? body.files.map(String) : undefined,
          formats,
          articleId: typeof body?.articleId === "number" ? body.articleId : undefined,
          includeArticleFile: Boolean(body?.includeArticleFile),
          useSourceFile: Boolean(body?.useSourceFile),
          recipient: typeof body?.recipient === "string" ? body.recipient : undefined,
          queueOnly: Boolean(body?.queueOnly),
        });
        return Response.json(result, { status: result.ok ? 200 : 502 });
      } catch (error: any) {
        return Response.json(
          { ok: false, error: error?.message || String(error) },
          { status: 400 }
        );
      }
    }
    if (url.pathname === "/api/schedules" && req.method === "GET") {
      const statusParam = url.searchParams.get("status") || undefined;
      const tasks = db.listScheduledTasks({
        status: statusParam as ScheduledTaskStatus | undefined,
        limit: 100,
      });
      return Response.json({ ok: true, tasks });
    }
    if (url.pathname === "/api/schedules" && req.method === "POST") {
      try {
        if (!req.headers.get("content-type")?.startsWith("application/json")) {
          return new Response("Expected application/json", { status: 415 });
        }
        const body = (await req.json()) as {
          action?: "create" | "complete" | "cancel" | "run";
          id?: number;
          text?: string;
          title?: string;
          taskKind?: ScheduledTaskKind;
          cronExpr?: string;
          nextRunAt?: number;
        };
        const action = body?.action || "create";

        if (action === "complete" || action === "cancel") {
          const id = Number(body?.id);
          if (!Number.isFinite(id) || id <= 0) {
            throw new Error("Valid task id is required");
          }
          const existing = db.getScheduledTaskById(id);
          if (!existing) {
            return Response.json(
              { ok: false, error: `Scheduled task #${id} not found` },
              { status: 404 }
            );
          }
          const updated = db.updateScheduledTask(id, {
            status: action === "complete" ? "completed" : "cancelled",
            next_run_at: null,
            ...(action === "complete"
              ? { last_run_at: new Date().toISOString() }
              : {}),
          });
          syncScheduledTasksToVaultQueue(pipeline.config, db);
          return Response.json({ ok: true, task: updated });
        }

        if (action === "run") {
          const id = Number(body?.id);
          if (!Number.isFinite(id) || id <= 0) {
            throw new Error("Valid task id is required");
          }
          const outcomes = await pipeline.drainScheduledTasks({
            forceTaskId: id,
          });
          if (pipeline.clawbot.isConfigured()) {
            await pipeline.flushReplies({ ignoreBusy: true });
          }
          return Response.json({ ok: true, outcomes });
        }

        const rawText = String(body?.text || body?.title || "").trim();
        if (!rawText) {
          throw new Error("Schedule text or title is required");
        }
        const spec = parseNaturalScheduleSpec(rawText);
        let scheduleType = spec.scheduleType;
        let cronExpr = spec.cronExpr;
        let nextRunAt = spec.nextRunAt;
        let isDefaultTime = spec.isDefaultTime;

        if (body?.cronExpr && isValidCronExpression(body.cronExpr)) {
          scheduleType = "cron";
          cronExpr = body.cronExpr.trim();
          nextRunAt = getNextCronRunMs(cronExpr, Date.now(), "Asia/Shanghai");
          isDefaultTime = false;
        } else if (typeof body?.nextRunAt === "number" && body.nextRunAt > 0) {
          scheduleType = "once";
          nextRunAt = body.nextRunAt;
          isDefaultTime = false;
        }

        const taskKind = body?.taskKind || spec.taskKind;
        const created = db.createScheduledTask({
          senderId: pipeline.clawbot.resolveDefaultRecipient() || "",
          title: (body?.title || spec.cleanedTitle || rawText).slice(0, 80),
          taskKind,
          scheduleType,
          cronExpr,
          timezone: "Asia/Shanghai",
          nextRunAt,
          isDefaultTime,
          actionPayload: {
            executor:
              taskKind === "digest" ? "web_search_digest" : "reminder_push",
            prompt: rawText,
            includeVaultNow: true,
            includeRecentArticlesHours: 24,
            archiveToVault: true,
          },
        });
        syncScheduledTasksToVaultQueue(pipeline.config, db);
        return Response.json({ ok: true, task: created });
      } catch (error: any) {
        return Response.json(
          { ok: false, error: error?.message || String(error) },
          { status: 400 }
        );
      }
    }
    return new Response("Not found", { status: 404 });
  };
}
