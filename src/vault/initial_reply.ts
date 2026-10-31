export const INITIAL_REPLY_LIMIT = 650;
export const LONG_REPLY_NOTICE = '⚠️ 本次初筛未压缩到手机短版，保留完整内容以免丢失证据或验收条件。';
export const replyLength = (text: string) => Array.from(text).length;
export function hasSubstantiveAnnotation(notes: string, title: string): boolean {
  const clean = (value: string) => value.replace(/^\s*\[链接\]\s*/, '').replace(/[\s“”"'「」『』，。！？：、]/g, '');
  const value=clean(notes); const heading=clean(title);
  return Boolean(value && value!=='（无额外批注）' && !(value===heading || (/^\s*\[链接\]/.test(notes) && value.length>=4 && heading.startsWith(value))));
}
export function omitEmptyAnnotation(text: string, keep: boolean): string {
  if(keep)return text;
  const lines=text.split('\n'); const result:string[]=[]; let skipping=false;
  for(const line of lines){
    if(/^\s*(?:#{1,6}\s*)?(?:🎯\s*)?(?:\*\*)?批注回应(?:\*\*)?\s*[:：]?/.test(line)){skipping=true;continue;}
    if(skipping && /^\s*(?:#{1,6}\s+|[💧💡🏢🔍🚦]|(?:脱水干货|观点碰撞|业务与规划启发|边界与待验证|分诊与下一步))/u.test(line))skipping=false;
    if(!skipping)result.push(line);
  }
  return result.join('\n').trim();
}

/** Only redundant explanation may shrink; business conditions and decisions stay verbatim. */
export function preservesReplyConditions(original: string, candidate: string): boolean {
  const heading = /^\s*(?:#{1,6}\s*)?(?:\d+[.、]\s*)?(?:[🎯💧💡🏢🔍🚦]\s*)?(?:\*\*)?(批注回应|脱水干货|观点碰撞|业务(?:与规划启发|验证|启发)?|边界(?:与待验证)?|分诊(?:与下一步)?)(?:\*\*)?(?=[:：\s]|$)/u;
  const sections = (text: string) => {
    const result = new Map<string, string>();
    let current = '';
    for (const line of text.split('\n')) {
      const match = line.match(heading);
      if (match) {
        current = match[1];
        if (result.has(current)) return null;
        result.set(current, line);
      } else if (current) result.set(current, result.get(current) + '\n' + line);
      else if (line.trim()) return null;
    }
    return result;
  };
  const before = sections(original), after = sections(candidate);
  if (!before || !after || JSON.stringify([...before.keys()]) !== JSON.stringify([...after.keys()])) return false;
  // An unrecognized structure cannot safely prove preservation.
  if (!['业务', '边界', '分诊'].every(prefix => [...before.keys()].some(k => k.startsWith(prefix)))) return false;
  for (const [name, text] of before) {
    if (!after.has(name)) return false;
    if (/^(?:批注|业务|边界|分诊)/.test(name) && text.trim() !== after.get(name)!.trim()) return false;
  }
  return true;
}
