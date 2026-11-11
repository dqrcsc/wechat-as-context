import { execFile } from "node:child_process";
import { BlockList, isIP } from "node:net";

export interface MacSystemProxyConfig {
  httpEnabled: boolean;
  httpHost: string;
  httpPort: number;
  httpsEnabled: boolean;
  httpsHost: string;
  httpsPort: number;
  excludeSimpleHostnames: boolean;
  exceptionsList: string[];
}

type SystemProxyDetector = () =>
  | Promise<MacSystemProxyConfig | null>
  | MacSystemProxyConfig
  | null;

const SCUTIL_CACHE_TTL_MS = 15_000;
const SCUTIL_ERROR_CACHE_TTL_MS = 5_000;
const STICKY_PROXY_TTL_MS = 5 * 60_000;

const LOCAL_OR_SPECIAL_IPS = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  LOCAL_OR_SPECIAL_IPS.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  LOCAL_OR_SPECIAL_IPS.addSubnet(address, prefix, "ipv6");
}

const TLS_CERT_ERROR_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
]);

const TLS_CERT_ERROR_PATTERN =
  /(?:unable to get local issuer certificate|unable to verify the first certificate|certificate verification error|Hostname\/IP does not match certificate|altnames|self[- ]signed certificate|certificate has expired|certificate is not yet valid|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|ERR_TLS_CERT_ALTNAME_INVALID|UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)/i;

let testDetector: SystemProxyDetector | undefined;
let cachedProxyState: {
  config: MacSystemProxyConfig | null;
  expiresAt: number;
} | null = null;
let preferSystemProxyUntil = 0;

export function setSystemProxyTestDetector(
  detector?: SystemProxyDetector | null
): void {
  if (!process.env.WXCTX_TEST_ROOT) {
    throw new Error("Test isolation required");
  }
  testDetector = detector ?? undefined;
  cachedProxyState = null;
  preferSystemProxyUntil = 0;
}

export function resetSystemProxyStateForTests(): void {
  if (!process.env.WXCTX_TEST_ROOT) {
    throw new Error("Test isolation required");
  }
  testDetector = undefined;
  cachedProxyState = null;
  preferSystemProxyUntil = 0;
}

export function parseScutilProxyOutput(raw: string): MacSystemProxyConfig {
  const result: MacSystemProxyConfig = {
    httpEnabled: false,
    httpHost: "",
    httpPort: 0,
    httpsEnabled: false,
    httpsHost: "",
    httpsPort: 0,
    excludeSimpleHostnames: false,
    exceptionsList: [],
  };

  let inExceptionsList = false;
  let nestedDepth = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (inExceptionsList) {
      if (/^\s*\}\s*$/.test(line)) {
        inExceptionsList = false;
        continue;
      }
      const itemMatch = /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line);
      if (itemMatch && itemMatch[1]) {
        result.exceptionsList.push(itemMatch[1].trim());
      }
      continue;
    }

    if (/^\s*ExceptionsList\s*:\s*<array>\s*\{\s*$/.test(line)) {
      inExceptionsList = true;
      continue;
    }

    if (/:\s*<(?:array|dictionary)>\s*\{\s*$/.test(line)) {
      nestedDepth++;
      continue;
    }
    if (nestedDepth > 0) {
      if (/^\s*\}\s*$/.test(line)) {
        nestedDepth--;
      }
      continue;
    }

    const kvMatch = /^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const val = kvMatch[2].trim();

    switch (key) {
      case "HTTPEnable":
        result.httpEnabled = val === "1";
        break;
      case "HTTPProxy":
        result.httpHost = val;
        break;
      case "HTTPPort": {
        const port = Number.parseInt(val, 10);
        result.httpPort = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0;
        break;
      }
      case "HTTPSEnable":
        result.httpsEnabled = val === "1";
        break;
      case "HTTPSProxy":
        result.httpsHost = val;
        break;
      case "HTTPSPort": {
        const port = Number.parseInt(val, 10);
        result.httpsPort = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0;
        break;
      }
      case "ExcludeSimpleHostnames":
        result.excludeSimpleHostnames = val === "1";
        break;
    }
  }

  return result;
}

function formatProxyEndpoint(rawHost: string, port: number): string | null {
  const host = rawHost.trim().replace(/^\[|\]$/g, "");
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  if (/[\x00-\x20\x7f/@?#\\]/.test(host)) {
    return null;
  }
  const bracketedHost = host.includes(":") ? `[${host}]` : host;
  const candidate = `http://${bracketedHost}:${port}`;
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "http:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/"
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

function matchesSingleExceptionRule(
  host: string,
  port: number,
  rawRule: string
): boolean {
  let rule = rawRule.trim().toLowerCase();
  if (!rule) return false;
  if (rule === "*") return true;

  // Strip optional port suffix on non-IPv6 rules (e.g. "example.com:8080")
  if (!rule.startsWith("[") && rule.indexOf(":") === rule.lastIndexOf(":") && rule.includes(":")) {
    const colonIdx = rule.lastIndexOf(":");
    const portPart = rule.slice(colonIdx + 1);
    if (/^\d+$/.test(portPart)) {
      if (Number.parseInt(portPart, 10) !== port) return false;
      rule = rule.slice(0, colonIdx);
    }
  } else if (rule.startsWith("[") && rule.includes("]:")) {
    const closeIdx = rule.indexOf("]:");
    const portPart = rule.slice(closeIdx + 2);
    if (/^\d+$/.test(portPart)) {
      if (Number.parseInt(portPart, 10) !== port) return false;
      rule = rule.slice(1, closeIdx);
    }
  }

  rule = rule.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!rule) return false;
  if (rule === "*") return true;

  // CIDR rule matching for IP literal targets (e.g. "192.168.0.0/16")
  if (rule.includes("/")) {
    const hostFamily = isIP(host);
    if (!hostFamily) return false;
    const [netAddrRaw, prefixRaw] = rule.split("/", 2);
    const netAddr = (netAddrRaw || "").trim();
    const netFamily = isIP(netAddr);
    const prefix = Number.parseInt(prefixRaw || "", 10);
    const maxPrefix = netFamily === 4 ? 32 : netFamily === 6 ? 128 : -1;
    if (
      netFamily !== hostFamily ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > maxPrefix
    ) {
      return false;
    }
    try {
      const bl = new BlockList();
      bl.addSubnet(netAddr, prefix, netFamily === 4 ? "ipv4" : "ipv6");
      return bl.check(host, hostFamily === 4 ? "ipv4" : "ipv6");
    } catch {
      return false;
    }
  }

  if (rule.startsWith("*.")) {
    const suffix = rule.slice(2);
    return Boolean(suffix) && (host === suffix || host.endsWith(`.${suffix}`));
  }
  if (rule.startsWith(".")) {
    const suffix = rule.slice(1);
    return Boolean(suffix) && (host === suffix || host.endsWith(`.${suffix}`));
  }

  return host === rule || host.endsWith(`.${rule}`);
}

export function matchesProxyExceptionList(
  host: string,
  port: number,
  rules: readonly string[]
): boolean {
  for (const rule of rules) {
    if (matchesSingleExceptionRule(host, port, rule)) {
      return true;
    }
  }
  return false;
}

async function getMacSystemProxyConfig(
  forceRefresh = false
): Promise<MacSystemProxyConfig | null> {
  const now = Date.now();
  if (!forceRefresh && cachedProxyState && cachedProxyState.expiresAt > now) {
    return cachedProxyState.config;
  }

  if (process.env.WXCTX_TEST_ROOT) {
    if (!testDetector) return null;
    const detected = await testDetector();
    cachedProxyState = {
      config: detected,
      expiresAt: Date.now() + SCUTIL_CACHE_TTL_MS,
    };
    return detected;
  }

  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "/usr/sbin/scutil",
        ["--proxy"],
        {
          encoding: "utf8",
          timeout: 1500,
          maxBuffer: 65536,
          env: { PATH: "/usr/sbin:/usr/bin:/bin" },
        },
        (error, out) => (error ? reject(error) : resolve(out))
      );
    });
    const parsed = parseScutilProxyOutput(stdout);
    cachedProxyState = {
      config: parsed,
      expiresAt: Date.now() + SCUTIL_CACHE_TTL_MS,
    };
    return parsed;
  } catch {
    cachedProxyState = {
      config: null,
      expiresAt: Date.now() + SCUTIL_ERROR_CACHE_TTL_MS,
    };
    return null;
  }
}

export async function resolveSystemProxyForUrl(
  targetUrl: string | URL,
  env: NodeJS.ProcessEnv = process.env,
  forceRefresh = false
): Promise<string | null> {
  let url: URL;
  try {
    url = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl));
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }

  // Respect explicit environment proxy configuration if already provided
  if (url.protocol === "https:") {
    if (
      env.HTTPS_PROXY?.trim() ||
      env.https_proxy?.trim() ||
      env.ALL_PROXY?.trim() ||
      env.all_proxy?.trim()
    ) {
      return null;
    }
  } else if (
    env.HTTP_PROXY?.trim() ||
    env.http_proxy?.trim() ||
    env.ALL_PROXY?.trim() ||
    env.all_proxy?.trim()
  ) {
    return null;
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return null;
  const port = url.port
    ? Number.parseInt(url.port, 10)
    : url.protocol === "https:"
      ? 443
      : 80;

  // Never route loopback, link-local, RFC1918, CGNAT, Fake-IP, or local mDNS names via system proxy
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return null;
  }
  const ipFamily = isIP(host);
  if (
    ipFamily &&
    LOCAL_OR_SPECIAL_IPS.check(host, ipFamily === 4 ? "ipv4" : "ipv6")
  ) {
    return null;
  }

  const rawNoProxy = env.NO_PROXY ?? env.no_proxy ?? "";
  if (rawNoProxy.trim()) {
    const noProxyRules = rawNoProxy.split(",");
    if (matchesProxyExceptionList(host, port, noProxyRules)) {
      return null;
    }
  }

  const sysConfig = await getMacSystemProxyConfig(forceRefresh);
  if (!sysConfig) return null;

  if (sysConfig.excludeSimpleHostnames && !host.includes(".") && !host.includes(":")) {
    return null;
  }
  if (matchesProxyExceptionList(host, port, sysConfig.exceptionsList)) {
    return null;
  }

  if (url.protocol === "https:") {
    return sysConfig.httpsEnabled
      ? formatProxyEndpoint(sysConfig.httpsHost, sysConfig.httpsPort)
      : null;
  }
  return sysConfig.httpEnabled
    ? formatProxyEndpoint(sysConfig.httpHost, sysConfig.httpPort)
    : null;
}

export function isTlsCertificateVerificationError(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 4 && cursor; depth++) {
    const anyErr = cursor as Record<string, unknown>;
    const code = typeof anyErr.code === "string" ? anyErr.code : "";
    if (code && TLS_CERT_ERROR_CODES.has(code)) {
      return true;
    }
    const msg =
      typeof anyErr.message === "string" ? anyErr.message : String(cursor);
    if (TLS_CERT_ERROR_PATTERN.test(msg)) {
      return true;
    }
    cursor = anyErr.cause;
  }
  return false;
}

export function isLocalProxyRefusedError(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 4 && cursor; depth++) {
    const anyErr = cursor as Record<string, unknown>;
    const code = typeof anyErr.code === "string" ? anyErr.code : "";
    if (code === "ECONNREFUSED" || code === "ConnectionRefused") {
      return true;
    }
    const msg =
      typeof anyErr.message === "string" ? anyErr.message : String(cursor);
    if (/\b(?:ECONNREFUSED|ConnectionRefused)\b/i.test(msg)) {
      return true;
    }
    cursor = anyErr.cause;
  }
  return false;
}

function canReplayRequestBody(init?: RequestInit): boolean {
  if (!init?.body) return true;
  if (
    typeof ReadableStream !== "undefined" &&
    init.body instanceof ReadableStream
  ) {
    return false;
  }
  return true;
}

function callDirectFetch(
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  return init !== undefined ? fetch(input, init) : fetch(input);
}

/**
 * Execute an outbound fetch with safe macOS System Proxy (`scutil --proxy`) fallback
 * when Fake-IP / TUN table desynchronization causes a pre-HTTP TLS handshake certificate
 * mismatch on an `https:` target.
 *
 * Security & idempotency invariants:
 * - Full X.509 certificate chain and hostname verification remain strictly enforced.
 * - Only `https:` requests are proxied (`CONNECT host:port` end-to-end TLS).
 * - Direct -> Proxy fallback triggers strictly on pre-HTTP TLS certificate verification errors
 *   (0 HTTP bytes transmitted).
 * - Sticky Proxy -> Direct fallback triggers strictly on local proxy TCP `ECONNREFUSED` /
 *   `ConnectionRefused` (0 bytes transmitted). Any other error clears sticky state and rethrows
 *   without replaying non-idempotent requests.
 */
export async function fetchWithSystemProxyFallback(
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  if (init && typeof init === "object" && "proxy" in init && (init as Record<string, unknown>).proxy) {
    return callDirectFetch(input, init);
  }

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = input instanceof URL ? input : new URL(String(input));
  } catch {
    parsedUrl = null;
  }

  if (!parsedUrl || parsedUrl.protocol !== "https:") {
    return callDirectFetch(input, init);
  }

  // Sticky mode: a recent TLS handshake mismatch was healed via macOS system proxy
  if (Date.now() < preferSystemProxyUntil) {
    const stickyProxyUrl = await resolveSystemProxyForUrl(parsedUrl, process.env, false);
    if (stickyProxyUrl) {
      try {
        return await fetch(input, { ...init, proxy: stickyProxyUrl } as RequestInit);
      } catch (proxyError) {
        preferSystemProxyUntil = 0;
        cachedProxyState = null;
        if (
          !init?.signal?.aborted &&
          canReplayRequestBody(init) &&
          isLocalProxyRefusedError(proxyError)
        ) {
          return callDirectFetch(input, init);
        }
        throw proxyError;
      }
    } else {
      preferSystemProxyUntil = 0;
    }
  }

  try {
    return await callDirectFetch(input, init);
  } catch (directError) {
    if (
      init?.signal?.aborted ||
      !canReplayRequestBody(init) ||
      !isTlsCertificateVerificationError(directError)
    ) {
      throw directError;
    }

    const proxyUrl = await resolveSystemProxyForUrl(parsedUrl, process.env, true);
    if (!proxyUrl) {
      throw directError;
    }

    const response = await fetch(input, { ...init, proxy: proxyUrl } as RequestInit);
    preferSystemProxyUntil = Date.now() + STICKY_PROXY_TTL_MS;
    return response;
  }
}
