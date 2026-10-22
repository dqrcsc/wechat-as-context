import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0",8], ["10.0.0.0",8], ["100.64.0.0",10], ["127.0.0.0",8],
  ["169.254.0.0",16], ["172.16.0.0",12], ["192.168.0.0",16],
  ["198.18.0.0",15], ["224.0.0.0",4], ["240.0.0.0",4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::",96], ["::ffff:0:0",96], ["fc00::",7], ["fe80::",10], ["ff00::",8],
] as const) blocked.addSubnet(address, prefix, "ipv6");

export class UnsafeUrlError extends Error {}

// Reject literal/private hostnames before requests and on every redirect.
// This does not pin DNS resolutions; deployment must also restrict network egress.
export function assertPublicUrl(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const family = isIP(host);
  if (!["http:","https:"].includes(url.protocol) || url.username || url.password ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || !host.includes(":") && !host.includes(".") ||
      family && blocked.check(host, family === 4 ? "ipv4" : "ipv6")) {
    throw new UnsafeUrlError("Private, loopback or credential-bearing URLs are not allowed");
  }
  return url;
}

export async function fetchPublicResource(raw: string, init: RequestInit = {}): Promise<Response> {
  let url = assertPublicUrl(raw);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url.toString(), { ...init, redirect: "manual" });
    if (![301,302,303,307,308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    await response.body?.cancel();
    url = assertPublicUrl(new URL(location, url).toString());
  }
  throw new UnsafeUrlError("Too many redirects");
}
