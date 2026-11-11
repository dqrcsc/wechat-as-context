import "./support/isolation.ts";
import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchWithSystemProxyFallback,
  isLocalProxyRefusedError,
  isTlsCertificateVerificationError,
  matchesProxyExceptionList,
  parseScutilProxyOutput,
  resetSystemProxyStateForTests,
  resolveSystemProxyForUrl,
  setSystemProxyTestDetector,
  type MacSystemProxyConfig,
} from "../src/system_proxy.ts";
import { fetchWithTransientRetry } from "../src/agent/llm.ts";
import { fetchPublicResource } from "../src/public_url.ts";
import { setSystemTlsTestRunner } from "../src/extractor/system_tls.ts";
import { ContextDatabase } from "../src/db.ts";
import { WeChatClawBotClient } from "../src/clawbot/client.ts";

const originalFetch = globalThis.fetch;

const SAMPLE_CLASH_SCUTIL_OUTPUT = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : 10.0.0.0/8
    3 : 172.16.0.0/12
    4 : 100.64.0.0/10
    5 : localhost
    6 : *.local
    7 : timestamp.apple.com
  }
  ExcludeSimpleHostnames : 1
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  Scoped : <dictionary> {
    en0 : <dictionary> {
      HTTPEnable : 0
      HTTPSEnable : 0
    }
  }
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}`;

function activeClashConfig(
  overrides?: Partial<MacSystemProxyConfig>
): MacSystemProxyConfig {
  return {
    ...parseScutilProxyOutput(SAMPLE_CLASH_SCUTIL_OUTPUT),
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetSystemProxyStateForTests();
  setSystemTlsTestRunner();
});

describe("system_proxy scutil parsing & URL resolution", () => {
  test("parses macOS scutil --proxy output including ExceptionsList while ignoring Scoped sub-dicts", () => {
    const parsed = parseScutilProxyOutput(SAMPLE_CLASH_SCUTIL_OUTPUT);
    expect(parsed).toEqual({
      httpEnabled: true,
      httpHost: "127.0.0.1",
      httpPort: 7890,
      httpsEnabled: true,
      httpsHost: "127.0.0.1",
      httpsPort: 7890,
      excludeSimpleHostnames: true,
      exceptionsList: [
        "127.0.0.1",
        "192.168.0.0/16",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "100.64.0.0/10",
        "localhost",
        "*.local",
        "timestamp.apple.com",
      ],
    });
  });

  test("rejects malformed or credential-bearing proxy host/port values", async () => {
    setSystemProxyTestDetector(() =>
      activeClashConfig({ httpsHost: "user:secret@127.0.0.1", httpsPort: 7890 })
    );
    expect(
      await resolveSystemProxyForUrl("https://generativelanguage.googleapis.com/v1beta/models", {})
    ).toBeNull();

    setSystemProxyTestDetector(() =>
      activeClashConfig({ httpsHost: "127.0.0.1", httpsPort: 70000 })
    );
    expect(
      await resolveSystemProxyForUrl("https://generativelanguage.googleapis.com/v1beta/models", {})
    ).toBeNull();
  });

  test("resolves proxy URL for public HTTPS targets and skips exceptions, private IPs, and explicit env proxies", async () => {
    setSystemProxyTestDetector(() => activeClashConfig());

    expect(
      await resolveSystemProxyForUrl(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        {}
      )
    ).toBe("http://127.0.0.1:7890");
    expect(
      await resolveSystemProxyForUrl("https://mp.weixin.qq.com/s/abc123", {})
    ).toBe("http://127.0.0.1:7890");
    expect(
      await resolveSystemProxyForUrl("https://mmbiz.qpic.cn/mmbiz_png/xyz/0", {})
    ).toBe("http://127.0.0.1:7890");

    // ExceptionsList & simple hostnames & local/Fake-IP addresses
    expect(await resolveSystemProxyForUrl("https://timestamp.apple.com/ts", {})).toBeNull();
    expect(await resolveSystemProxyForUrl("https://sub.timestamp.apple.com/ts", {})).toBeNull();
    expect(await resolveSystemProxyForUrl("https://myprinter.local/status", {})).toBeNull();
    expect(await resolveSystemProxyForUrl("https://intranet/api", {})).toBeNull();
    expect(await resolveSystemProxyForUrl("https://localhost:8787/health", {})).toBeNull();
    expect(await resolveSystemProxyForUrl("https://127.0.0.1:8787/health", {})).toBeNull();
    expect(await resolveSystemProxyForUrl("https://198.18.0.55/v1", {})).toBeNull();
    expect(await resolveSystemProxyForUrl("https://192.168.1.20/api", {})).toBeNull();

    // Respect explicit environment variables
    expect(
      await resolveSystemProxyForUrl(
        "https://generativelanguage.googleapis.com/v1beta/models",
        { HTTPS_PROXY: "http://127.0.0.1:9090" }
      )
    ).toBeNull();
    expect(
      await resolveSystemProxyForUrl(
        "https://generativelanguage.googleapis.com/v1beta/models",
        { NO_PROXY: "localhost,googleapis.com" }
      )
    ).toBeNull();
    expect(
      await resolveSystemProxyForUrl(
        "https://generativelanguage.googleapis.com/v1beta/models",
        { no_proxy: "*" }
      )
    ).toBeNull();
  });

  test("matchesProxyExceptionList handles ports, wildcards, leading dots, and CIDRs", () => {
    expect(matchesProxyExceptionList("api.example.com", 8443, ["example.com:8443"])).toBe(true);
    expect(matchesProxyExceptionList("api.example.com", 443, ["example.com:8443"])).toBe(false);
    expect(matchesProxyExceptionList("a.b.corp.test", 443, ["*.corp.test"])).toBe(true);
    expect(matchesProxyExceptionList("corp.test", 443, [".corp.test"])).toBe(true);
    expect(matchesProxyExceptionList("172.20.5.9", 443, ["172.16.0.0/12"])).toBe(true);
    expect(matchesProxyExceptionList("8.8.8.8", 443, ["172.16.0.0/12"])).toBe(false);
  });
});

describe("fetchWithSystemProxyFallback state machine & safety invariants", () => {
  test("recognizes BoringSSL/Bun TLS certificate verification errors and local proxy ConnectionRefused", () => {
    expect(
      isTlsCertificateVerificationError(
        Object.assign(new Error("unable to get local issuer certificate"), {
          code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        })
      )
    ).toBe(true);
    expect(
      isTlsCertificateVerificationError(
        Object.assign(new Error("Hostname/IP does not match certificate's altnames"), {
          code: "ERR_TLS_CERT_ALTNAME_INVALID",
        })
      )
    ).toBe(true);
    expect(
      isTlsCertificateVerificationError(
        Object.assign(new Error("certificate verification error"), {
          code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
        })
      )
    ).toBe(true);
    expect(
      isTlsCertificateVerificationError(
        Object.assign(new Error("socket connection was closed unexpectedly"), {
          code: "ECONNRESET",
        })
      )
    ).toBe(false);

    expect(
      isLocalProxyRefusedError(
        Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
          code: "ConnectionRefused",
        })
      )
    ).toBe(true);
    expect(
      isLocalProxyRefusedError(
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7890"), {
          code: "ECONNREFUSED",
        })
      )
    ).toBe(true);
    expect(
      isLocalProxyRefusedError(
        Object.assign(new Error("Unable to connect"), { code: "ETIMEDOUT" })
      )
    ).toBe(false);
  });

  test("heals Fake-IP TLS certificate mismatch via system proxy, enables sticky proxy, and recovers if proxy later closes", async () => {
    setSystemProxyTestDetector(() => activeClashConfig());

    const calls: Array<{ url: string; proxy?: string; tls?: unknown }> = [];
    let mode: "fake_ip_broken" | "proxy_closed" = "fake_ip_broken";

    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      const proxy = init?.proxy;
      calls.push({ url, proxy, tls: init?.tls });

      if (proxy) {
        if (mode === "proxy_closed") {
          throw Object.assign(
            new Error("Unable to connect. Is the computer able to access the url?"),
            { code: "ConnectionRefused" }
          );
        }
        return new Response("ok-via-proxy", { status: 200 });
      }

      if (mode === "fake_ip_broken") {
        throw Object.assign(new Error("unable to get local issuer certificate"), {
          code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        });
      }
      return new Response("ok-direct", { status: 200 });
    }) as unknown as typeof fetch;

    // 1st call: direct fails TLS -> retries with proxy -> succeeds & activates sticky proxy
    const res1 = await fetchWithSystemProxyFallback(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      { method: "POST", body: JSON.stringify({ ping: 1 }) }
    );
    expect(await res1.text()).toBe("ok-via-proxy");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.proxy).toBeUndefined();
    expect(calls[1]?.proxy).toBe("http://127.0.0.1:7890");
    expect(calls[1]?.tls).toBeUndefined(); // Never weakens TLS verification

    // 2nd call while sticky: goes straight through proxy (0 wasted direct TLS handshakes)
    const res2 = await fetchWithSystemProxyFallback("https://mmbiz.qpic.cn/mmbiz_png/1/0", {
      method: "GET",
    });
    expect(await res2.text()).toBe("ok-via-proxy");
    expect(calls).toHaveLength(3);
    expect(calls[2]?.proxy).toBe("http://127.0.0.1:7890");

    // User quits ClashX Pro: sticky proxy refuses local TCP -> clears sticky & succeeds direct
    mode = "proxy_closed";
    const res3 = await fetchWithSystemProxyFallback(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      { method: "POST", body: JSON.stringify({ ping: 2 }) }
    );
    expect(await res3.text()).toBe("ok-direct");
    expect(calls).toHaveLength(5);
    expect(calls[3]?.proxy).toBe("http://127.0.0.1:7890");
    expect(calls[4]?.proxy).toBeUndefined();

    // 4th call after sticky cleared: goes direct immediately
    const res4 = await fetchWithSystemProxyFallback("https://mp.weixin.qq.com/s/test");
    expect(await res4.text()).toBe("ok-direct");
    expect(calls).toHaveLength(6);
    expect(calls[5]?.proxy).toBeUndefined();
  });

  test("never replays non-ConnectionRefused errors during sticky proxy mode (preserving POST idempotency)", async () => {
    setSystemProxyTestDetector(() => activeClashConfig());

    let attempt = 0;
    globalThis.fetch = (async (_input: any, init?: any) => {
      attempt++;
      if (attempt === 1) {
        // Trigger sticky activation
        throw Object.assign(new Error("certificate verification error"), {
          code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
        });
      }
      if (attempt === 2) {
        expect(init?.proxy).toBe("http://127.0.0.1:7890");
        return new Response("primed", { status: 200 });
      }
      if (attempt === 3) {
        // Mid-flight socket reset on sticky proxy: could have transmitted bytes, MUST NOT auto-replay here
        expect(init?.proxy).toBe("http://127.0.0.1:7890");
        throw Object.assign(new Error("socket connection was closed unexpectedly"), {
          code: "ECONNRESET",
        });
      }
      return new Response("unexpected-replay", { status: 200 });
    }) as unknown as typeof fetch;

    await fetchWithSystemProxyFallback("https://ilinkai.weixin.qq.com/ilink/bot/getconfig");
    await expect(
      fetchWithSystemProxyFallback("https://ilinkai.weixin.qq.com/ilink/bot/sendmessage", {
        method: "POST",
        body: '{"msg":"once"}',
      })
    ).rejects.toThrow("socket connection was closed unexpectedly");
    expect(attempt).toBe(3);
  });

  test("does not proxy plain http:// URLs, non-TLS errors, aborted signals, or ReadableStream bodies", async () => {
    setSystemProxyTestDetector(() => activeClashConfig());
    const seenProxies: Array<string | undefined> = [];

    globalThis.fetch = (async (_input: any, init?: any) => {
      seenProxies.push(init?.proxy);
      throw Object.assign(new Error("unable to get local issuer certificate"), {
        code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      });
    }) as unknown as typeof fetch;

    // Plain HTTP is never routed through proxy fallback
    await expect(fetchWithSystemProxyFallback("http://example.com/plain")).rejects.toThrow();
    expect(seenProxies).toEqual([undefined]);

    // Aborted signal is never retried
    seenProxies.length = 0;
    const ac = new AbortController();
    ac.abort();
    await expect(
      fetchWithSystemProxyFallback("https://example.com/aborted", { signal: ac.signal })
    ).rejects.toThrow();
    expect(seenProxies).toEqual([undefined]);

    // ReadableStream body is never replayed
    seenProxies.length = 0;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("chunk"));
        c.close();
      },
    });
    await expect(
      fetchWithSystemProxyFallback("https://example.com/stream", {
        method: "POST",
        body: stream,
      })
    ).rejects.toThrow();
    expect(seenProxies).toEqual([undefined]);
  });
});

describe("caller integration (LLM, fetchPublicResource, ClawBot client)", () => {
  test("fetchWithTransientRetry heals TLS mismatch via system proxy in 1 logical attempt", async () => {
    setSystemProxyTestDetector(() => activeClashConfig());
    const proxies: Array<string | undefined> = [];

    globalThis.fetch = (async (_url: any, init?: any) => {
      proxies.push(init?.proxy);
      if (!init?.proxy) {
        throw Object.assign(new Error("unable to get local issuer certificate"), {
          code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        });
      }
      return Response.json({ choices: [{ message: { content: "healed" } }] });
    }) as unknown as typeof fetch;

    const resp = await fetchWithTransientRetry(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      () => ({
        method: "POST",
        headers: { Authorization: "Bearer test-key" },
        body: JSON.stringify({ model: "gemini-2.5-flash" }),
      })
    );
    expect(resp.status).toBe(200);
    expect(proxies).toEqual([undefined, "http://127.0.0.1:7890"]);
  });

  test("fetchPublicResource heals mmbiz image TLS mismatch via proxy while preserving redirect SSRF protection and Douyin system_tls fallback", async () => {
    setSystemProxyTestDetector(() => activeClashConfig());

    globalThis.fetch = (async (url: any, init?: any) => {
      if (!init?.proxy) {
        throw Object.assign(new Error("Hostname/IP does not match certificate's altnames"), {
          code: "ERR_TLS_CERT_ALTNAME_INVALID",
        });
      }
      if (String(url).includes("evil-redirect")) {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1:8787/api/config" },
        });
      }
      return new Response("png-bytes", { status: 200 });
    }) as unknown as typeof fetch;

    const okRes = await fetchPublicResource("https://mmbiz.qpic.cn/mmbiz_png/abc/640");
    expect(await okRes.text()).toBe("png-bytes");

    await expect(
      fetchPublicResource("https://mmbiz.qpic.cn/evil-redirect")
    ).rejects.toThrow("Private");

    // When system proxy is disabled, Douyin still falls back to system_tls (curl)
    resetSystemProxyStateForTests();
    setSystemProxyTestDetector(() => null);
    let curlCalls = 0;
    globalThis.fetch = (async () => {
      throw new Error("unable to get local issuer certificate");
    }) as unknown as typeof fetch;
    setSystemTlsTestRunner(async () => {
      curlCalls++;
      return Buffer.from("HTTP/2 200 OK\r\ncontent-type: text/html\r\n\r\ndouyin-ok");
    });
    const douyinRes = await fetchPublicResource("https://v.douyin.com/iJxyz/");
    expect(curlCalls).toBe(1);
    expect(await douyinRes.text()).toBe("douyin-ok");
  });

  test("WeChatClawBotClient.sendTextMessage heals TLS mismatch via system proxy without duplicate sends", async () => {
    setSystemProxyTestDetector(() => activeClashConfig());
    const db = new ContextDatabase(":memory:");
    const client = new WeChatClawBotClient(db);
    client.saveCredentials({
      botToken: "synthetic-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      botId: "bot-1",
      userId: "user-1@im.wechat",
      savedAt: new Date().toISOString(),
    });

    const deliveredClientIds: string[] = [];
    globalThis.fetch = (async (_url: any, init?: any) => {
      if (!init?.proxy) {
        throw Object.assign(new Error("unable to get local issuer certificate"), {
          code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        });
      }
      const parsed = JSON.parse(String(init?.body || "{}"));
      deliveredClientIds.push(parsed?.msg?.client_id);
      return Response.json({ ret: 0, errcode: 0 });
    }) as unknown as typeof fetch;

    await client.sendTextMessage("user-1@im.wechat", "hello world", "cid-unique-1");
    expect(deliveredClientIds).toEqual(["cid-unique-1"]);
    db.db.close();
  });
});
