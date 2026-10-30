export type SocialPlatform = "xiaohongshu" | "douyin";

export class SocialIdentityError extends Error {}

export function socialPostId(raw: string, platform: SocialPlatform): string | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const domains = platform === "xiaohongshu" ? ["xiaohongshu.com"] : ["douyin.com", "iesdouyin.com"];
    if (!domains.some(domain => host === domain || host.endsWith(`.${domain}`))) return null;
    if (platform === "xiaohongshu") return url.pathname.match(/^\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)(?:\/|$)/)?.[1] || null;
    return url.pathname.match(/^\/(?:share\/)?(?:video|note)\/(\d{15,22})(?:\/|$)/)?.[1] ||
      (/^\d{15,22}$/.test(url.searchParams.get("modal_id") || "") ? url.searchParams.get("modal_id") : null);
  } catch { return null; }
}

export function requestedSocialPostId(raw: string, resolved: string, platform: SocialPlatform): string {
  const original = socialPostId(raw, platform), final = socialPostId(resolved, platform);
  if (original && final && original !== final) throw new SocialIdentityError(`${platform} identity changed after redirect`);
  const id = original || final;
  if (!id) throw new SocialIdentityError(`${platform} identity could not be verified from URL`);
  return id;
}

function attribute(tag: string, name: string): string {
  const value = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return (value?.[1] ?? value?.[2] ?? value?.[3] ?? "").replace(/&amp;/g, "&");
}

/** Declared references need their own nonempty path, not the request URL inherited
 * from an empty value, fragment or tracking query. Invalid URLs are non-matches. */
export function declaredSocialPostId(raw: string, pageUrl: string, platform: SocialPlatform): string | null {
  const value = raw.trim();
  if (!value || /^[#?]/.test(value)) return null;
  try { return socialPostId(new URL(value, pageUrl).toString(), platform); }
  catch { return null; }
}

/** A matching state object can stand alone. Page-level fallbacks require their
 * own identity, and an explicitly contradictory page identity is never ignored. */
export function pageHasSocialIdentity(html: string, pageUrl: string, id: string, platform: SocialPlatform): boolean {
  const identities: string[] = [];
  for (const [tag] of html.matchAll(/<(?:meta|link)\b[^>]*>/gi)) {
    if (/^<meta\b/i.test(tag) && (attribute(tag, "property") || attribute(tag, "name")).toLowerCase() === "og:url") {
      identities.push(attribute(tag, "content"));
    } else if (/^<link\b/i.test(tag) && attribute(tag, "rel").toLowerCase().split(/\s+/).includes("canonical")) {
      identities.push(attribute(tag, "href"));
    }
  }
  const resolvedIds = identities.map(raw => declaredSocialPostId(raw, pageUrl, platform));
  if (resolvedIds.some(found => found && found !== id)) throw new SocialIdentityError(`${platform} page identity mismatch`);
  return resolvedIds.length > 0 && resolvedIds.every(found => found === id);
}

/** Shared by SSR, RENDER_DATA and CDP response parsing. */
export function matchingDouyinDetail(value: any, awemeId: string): any | null {
  return value && typeof value.aweme_id === "string" && value.aweme_id === awemeId ? value : null;
}
