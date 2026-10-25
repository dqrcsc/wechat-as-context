/** One source of metric units and acceptance gates for both initial-reading outputs. */
export const VALIDATION_SLOT = "{{VALIDATION_CONTRACT}}";

export function applyValidationContract(input: {
  validation_contract?: unknown;
  wechat_reply: string;
  companion_note_markdown: string;
}): { wechat_reply: string; companion_note_markdown: string } {
  const bodies = [input.wechat_reply, input.companion_note_markdown];
  if (input.validation_contract === null) {
    if (bodies.some(body => body.includes(VALIDATION_SLOT))) throw new Error("Unexpected validation slot");
    return { wechat_reply: bodies[0], companion_note_markdown: bodies[1] };
  }
  const contract = input.validation_contract as { metrics?: unknown } | undefined;
  if (!contract || !Array.isArray(contract.metrics) || contract.metrics.length < 1 || contract.metrics.length > 3) {
    throw new Error("Missing or invalid validation contract");
  }
  if (bodies.some(body => body.split(VALIDATION_SLOT).length !== 2)) {
    throw new Error("Each output requires exactly one validation slot");
  }
  for (const body of bodies) {
    const section = /(?:^|\n)(?:#{1,2}\s*)?(?:🏢\s*)?业务(?:与规划启发|验证|启发)[^\n]*\n/u.exec(body);
    if (!section) throw new Error("Missing business validation section");
    const rest = body.slice(section.index + section[0].length);
    const end = rest.search(/\n(?:##\s|(?:#{1,2}\s*)?(?:🔍|🚦))/u);
    const business = end < 0 ? rest : rest.slice(0, end);
    if (!business.includes(VALIDATION_SLOT)) throw new Error("Validation slot must be in business section");
    // This section describes a proposed experiment. Its statistics belong only to the contract.
    if (/显著|波动范围|置信区间|百分点|相对提升|相对下降/u.test(business.replace(VALIDATION_SLOT, ""))) {
      throw new Error("Statistics repeated outside validation contract");
    }
  }
  const names = new Set<string>();
  const metrics = contract.metrics.map((metric: unknown) => {
    if (!metric || typeof metric !== "object") throw new Error("Invalid metric");
    const m = metric as Record<string, any>;
    for (const key of ["name", "numerator", "denominator"]) {
      if (typeof m[key] !== "string" || !m[key].trim() || m[key].length > 100 || /[\r\n]/.test(m[key])) {
        throw new Error(`Invalid metric ${key}`);
      }
    }
    if (names.has(m.name.trim())) throw new Error("Duplicate metric name");
    names.add(m.name.trim());
    if (!["increase", "decrease"].includes(m.direction)) throw new Error("Invalid metric direction");
    const gain = m.minimum_gain;
    if (!gain || !["percentage_points", "relative_percent"].includes(gain.unit)) throw new Error("Invalid gain unit");
    if (gain.value !== null && (typeof gain.value !== "number" || !Number.isFinite(gain.value) || gain.value < 0 ||
      (gain.unit === "percentage_points" && gain.value > 100))) throw new Error("Invalid gain threshold");
    const difference = m.direction === "increase" ? "B - A" : "A - B";
    const relative = gain.unit === "relative_percent";
    const label = relative ? (m.direction === "increase" ? "相对提升" : "相对下降") : (m.direction === "increase" ? "提升" : "下降");
    const formula = relative ? `(${difference}) / A × 100%` : `(${difference}) × 100（百分点）`;
    const threshold = gain.value === null ? "门槛待定" : `${label} ≥ ${gain.value}${relative ? "%" : " 个百分点"}`;
    return `${m.name.trim()} = ${m.numerator.trim()} / ${m.denominator.trim()}；${formula}；${threshold}。`;
  });
  // These are proposed business gates, never estimated sampling noise or a significance test.
  const block = [
    "指标与验收（建议阈值、待确认）：A为基线、B为试验，比率取0–1。",
    ...metrics,
    "分母为 0 不判定；A = 0 时相对变化不可计算。门槛待定或未确认，不能判定通过。",
    "有效试验须全部达到已确认门槛才通过；未达仅指本次样本、模型、规则与配置下未达业务目标。",
    "固定门槛不是波动范围；波动尚未估计，不作统计显著性判断，证据不足时继续取样复核。",
  ].join("\n");
  return {
    wechat_reply: bodies[0].replace(VALIDATION_SLOT, () => block),
    companion_note_markdown: bodies[1].replace(VALIDATION_SLOT, () => block),
  };
}
