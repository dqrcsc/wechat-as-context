/** Preserve the publisher's calendar date; never substitute collection time. */
export function validPublicationDate(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const match = raw.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|T\d{2}:\d{2})/);
  if (!match) return '';
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1] ? match[1] : '';
}
function attrs(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(m=>[m[1].toLowerCase(),m[3]]));
}
export function extractPublicationDate(html: string, pageUrl: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const a=attrs(tag);
    if (['article:published_time','datepublished','pubdate','publishdate'].includes((a.property||a.name||a.itemprop||'').toLowerCase())) {
      const d=validPublicationDate(a.content); if(d) return d;
    }
  }
  const dates: string[]=[];
  const samePage=(raw: string)=>{try {const a=new URL(raw,pageUrl),b=new URL(pageUrl);return a.hostname===b.hostname&&a.pathname.replace(/\/$/,'')===b.pathname.replace(/\/$/,'');}catch{return false;}};
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (attrs(match[1]).type?.toLowerCase()!=='application/ld+json') continue;
    try {
      const parsed=JSON.parse(match[2]);
      const nodes=Array.isArray(parsed)?parsed:parsed?.['@graph']||[parsed];
      if(!Array.isArray(nodes))continue;
      for(const n of nodes){
        const types=Array.isArray(n?.['@type'])?n['@type']:[n?.['@type']];
        if(!types.some((t:unknown)=>typeof t==='string'&&/^(?:NewsArticle|Article|BlogPosting|TechArticle)$/.test(t)))continue;
        const identity=n.url|| (typeof n.mainEntityOfPage==='string'?n.mainEntityOfPage:n.mainEntityOfPage?.['@id']);
        if(identity&&!samePage(String(identity)))continue;
        const d=validPublicationDate(n.datePublished);if(d)dates.push(d);
      }
    } catch { /* Invalid structured metadata is not a date. */ }
  }
  if(new Set(dates).size===1)return dates[0];
  if(dates.length)return '';
  const article=html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]||html;
  const times=(article.match(/<time\b[^>]*>/gi) || []).map(tag=>validPublicationDate(attrs(tag).datetime)).filter(Boolean);
  if(new Set(times).size===1)return times[0];
  if(new URL(pageUrl).hostname==='medium.com'||new URL(pageUrl).hostname.endsWith('.medium.com')){
    const plain=article.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    const m=plain.match(/\b\d+\s*min read\s*[·•|]?\s*([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})\b/);
    if(m){const month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].slice(0,3).toLowerCase())+1;
      return validPublicationDate(`${m[3]}-${String(month).padStart(2,'0')}-${m[2].padStart(2,'0')}`);}
  }
  return '';
}

export function savedPublicationDate(source: string): string {
  const front=source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  return validPublicationDate(front.match(/^published_date:\s*([^\n]*)$/m)?.[1]?.trim().replace(/^["']|["']$/g,''));
}
