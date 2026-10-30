import {
  describeCronExpression,
  getNextCronRunMs,
  getZonedDateParts,
  isValidCronExpression,
  zonedWallClockToEpochMs,
} from "./cron.ts";

export interface ParsedScheduleSpec {
  scheduleType: "once" | "cron";
  taskKind: "reminder" | "todo" | "digest";
  cronExpr: string;
  nextRunAt: number;
  isDefaultTime: boolean;
  humanScheduleLabel: string;
  cleanedTaskText: string;
  cleanedTitle: string;
}

const ZH_NUM_MAP: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

export function parseChineseOrArabicInt(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  if (s === "半") return 30;
  if (s === "一刻") return 15;
  if (s === "三刻") return 45;

  if (s.length === 1 && ZH_NUM_MAP[s] !== undefined) {
    return ZH_NUM_MAP[s];
  }
  if (s.startsWith("十") && s.length === 2 && ZH_NUM_MAP[s[1]] !== undefined) {
    return 10 + ZH_NUM_MAP[s[1]];
  }
  if (s.endsWith("十") && s.length === 2 && ZH_NUM_MAP[s[0]] !== undefined) {
    return ZH_NUM_MAP[s[0]] * 10;
  }
  if (
    s.length === 3 &&
    s[1] === "十" &&
    ZH_NUM_MAP[s[0]] !== undefined &&
    ZH_NUM_MAP[s[2]] !== undefined
  ) {
    return ZH_NUM_MAP[s[0]] * 10 + ZH_NUM_MAP[s[2]];
  }
  return null;
}

function normalizeHourWithMeridiem(hour: number, meridiem?: string): number {
  const m = (meridiem || "").trim();
  if (/(?:下午|傍晚|晚上|夜里|今晚|明晚)/.test(m)) {
    if (hour >= 1 && hour <= 11) return hour + 12;
  } else if (/中午/.test(m)) {
    if (hour >= 1 && hour <= 3) return hour + 12;
  } else if (/凌晨/.test(m)) {
    if (hour === 12) return 0;
  }
  return hour;
}

function extractClockHourMinute(
  text: string,
  defaultHour = 8,
  defaultMinute = 30
): {
  matched: boolean;
  hour: number;
  minute: number;
  matchedSubstring: string;
} {
  // Match patterns like: "早上8点半", "下午 4:30", "晚上8点15分", "20点", "9点一刻", "14:05"
  const clockRegex =
    /(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:点|时|:|：)\s*(?:(半|一刻|三刻)|(\d{1,2}|[零一二三四五六七八九十]{1,3})\s*分?)?/i;
  const m = text.match(clockRegex);
  if (m) {
    const meridiem = m[1] || "";
    const rawHour = parseChineseOrArabicInt(m[2]);
    if (rawHour !== null && rawHour >= 0 && rawHour <= 23) {
      let minute = 0;
      if (m[3]) {
        minute = parseChineseOrArabicInt(m[3]) ?? 0;
      } else if (m[4]) {
        minute = parseChineseOrArabicInt(m[4]) ?? 0;
      }
      if (minute >= 0 && minute <= 59) {
        const hour = normalizeHourWithMeridiem(rawHour, meridiem);
        return {
          matched: true,
          hour,
          minute,
          matchedSubstring: m[0],
        };
      }
    }
  }

  // Fallback check for meridiem-only hints like "早上", "中午", "下午", "晚上"
  const meridiemOnly = text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)/);
  if (meridiemOnly) {
    const p = meridiemOnly[1];
    if (p === "早上" || p === "上午") {
      return { matched: false, hour: 8, minute: 30, matchedSubstring: p };
    }
    if (p === "中午") {
      return { matched: false, hour: 12, minute: 30, matchedSubstring: p };
    }
    if (p === "下午" || p === "傍晚") {
      return { matched: false, hour: 17, minute: 0, matchedSubstring: p };
    }
    if (p === "晚上" || p === "夜里") {
      return { matched: false, hour: 20, minute: 0, matchedSubstring: p };
    }
  }

  return {
    matched: false,
    hour: defaultHour,
    minute: defaultMinute,
    matchedSubstring: "",
  };
}

const ZH_DOW_MAP: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

/**
 * Compute the default 20:00 fallback timestamp for untimed todos/reminders:
 * - If current local time is strictly before 19:30, schedule for today at 20:00.
 * - If current local time is 19:30 or later, schedule for tomorrow at 20:00.
 */
export function computeDefault20pmFallbackMs(
  nowMs = Date.now(),
  timeZone = "Asia/Shanghai"
): { nextRunAt: number; label: string } {
  const zp = getZonedDateParts(nowMs, timeZone);
  const beforeCutoff = zp.hour < 19 || (zp.hour === 19 && zp.minute < 30);

  if (beforeCutoff) {
    const nextRunAt = zonedWallClockToEpochMs(
      zp.year,
      zp.month,
      zp.day,
      20,
      0,
      timeZone
    );
    return {
      nextRunAt,
      label: "今天 20:00（默认兜底提醒）",
    };
  }

  const tomorrowProbe = zonedWallClockToEpochMs(
    zp.year,
    zp.month,
    zp.day,
    12,
    0,
    timeZone
  ) + 24 * 3_600_000;
  const tp = getZonedDateParts(tomorrowProbe, timeZone);
  const nextRunAt = zonedWallClockToEpochMs(
    tp.year,
    tp.month,
    tp.day,
    20,
    0,
    timeZone
  );
  return {
    nextRunAt,
    label: "明天 20:00（默认兜底提醒）",
  };
}

/**
 * Clean scheduling boilerplate prefixes/phrases from user text to get a crisp task title/subject.
 */
export function cleanScheduleTaskTitle(rawText: string): string {
  let s = rawText.trim();
  s = s.replace(/^(?:待办|备忘|速记|提醒我|提醒|定时任务|定时|闹钟|todo)\s*[:：，,]?\s*/i, "");
  s = s.replace(
    /^(?:请|麻烦|帮我|记得)?\s*(?:在|于|到)?\s*(?:每天|每日|每个?工作日|每周[一二三四五六日天]|每个?周末|每月\d{1,2}[日号])\s*(?:的)?\s*(?:(?:凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\s*(?:\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:点|时|:|：)\s*(?:半|一刻|三刻|\d{1,2}\s*分?|[一二三四五六七八九十]{1,3}\s*分?)?)?\s*(?:定时|准时|自动)?\s*(?:提醒我|帮我|给我)?\s*/i,
    ""
  );
  s = s.replace(
    /^(?:请|麻烦|帮我|记得)?\s*(?:在|于|过)?\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:个)?(?:半)?\s*(?:秒|分钟|分|小时|钟头|天|周)(?:半)?(?:后|之后|以后)\s*(?:提醒我|记得|通知我)?\s*/i,
    ""
  );
  s = s.replace(
    /^(?:请|麻烦|帮我|记得)?\s*(?:在|于)?\s*(?:今天|今晚|今早|明天|明早|明晚|后天|大后天|(?:本|这|下)周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号])?\s*(?:凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\s*(?:\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:点|时|:|：)\s*(?:半|一刻|三刻|\d{1,2}\s*分?|[一二三四五六七八九十]{1,3}\s*分?)?\s*(?:提醒我|记得|通知我|帮我)?\s*/i,
    ""
  );
  s = s.replace(/^(?:提醒我|通知我|叫我|记得)\s*[:：，,]?\s*/i, "");
  return s.trim() || rawText.trim();
}

export interface ParseNaturalScheduleOptions {
  nowMs?: number;
  timeZone?: string;
  timezone?: string;
  llmCronHint?: string;
  llmRunAtIsoHint?: string;
  llmScheduleTypeHint?: "once" | "cron";
}

function inferScheduleTaskKind(
  rawText: string,
  scheduleType: "once" | "cron",
  isDefaultTime: boolean
): "reminder" | "todo" | "digest" {
  if (
    scheduleType === "cron" &&
    /(?:搜一下|搜索|收集|整理|汇总|早报|日报|晚报|简报|周报|动态|资讯)/i.test(
      rawText
    )
  ) {
    return "digest";
  }
  if (
    /^(?:待办|todo|(?:加个?|添加|创建|新建)待办)/i.test(rawText.trim()) ||
    isDefaultTime
  ) {
    return "todo";
  }
  return "reminder";
}

/**
 * Parse natural language schedule / reminder / recurring expression into a concrete `ParsedScheduleSpec`.
 * Combines optional LLM router slot hints with deterministic local parsing and the 20:00 default fallback.
 */
export function parseNaturalScheduleSpec(
  input:
    | string
    | ({
        text: string;
      } & ParseNaturalScheduleOptions),
  options?: ParseNaturalScheduleOptions
): ParsedScheduleSpec {
  const params =
    typeof input === "string" ? { text: input, ...options } : input;
  const nowMs = params.nowMs ?? Date.now();
  const timeZone = params.timeZone || params.timezone || "Asia/Shanghai";
  const text = params.text.trim();
  const cleanedTaskText = cleanScheduleTaskTitle(text);
  const withMeta = (
    base: Omit<ParsedScheduleSpec, "taskKind" | "cleanedTitle">
  ): ParsedScheduleSpec => ({
    ...base,
    taskKind: inferScheduleTaskKind(text, base.scheduleType, base.isDefaultTime),
    cleanedTitle: base.cleanedTaskText,
  });

  // 1. Check deterministic relative time FIRST (e.g. "20分钟后", "半小时后", "2小时后", "1个半小时后", "3天后")
  const oneAndHalfHour = text.match(
    /(\d+|[一二两三四五六七八九十]+)\s*个\s*半\s*小时\s*(?:后|之后|以后)/
  );
  if (oneAndHalfHour) {
    const n = parseChineseOrArabicInt(oneAndHalfHour[1]) ?? 1;
    const mins = n * 60 + 30;
    return withMeta({
      scheduleType: "once",
      cronExpr: "",
      nextRunAt: nowMs + mins * 60_000,
      isDefaultTime: false,
      humanScheduleLabel: `${n} 个半小时后`,
      cleanedTaskText,
    });
  }

  if (/半\s*(?:个)?\s*小时(?:后|之后|以后)/.test(text)) {
    const nextRunAt = nowMs + 30 * 60_000;
    return withMeta({
      scheduleType: "once",
      cronExpr: "",
      nextRunAt,
      isDefaultTime: false,
      humanScheduleLabel: "30 分钟后",
      cleanedTaskText,
    });
  }

  const relMatch = text.match(
    /(\d+|[一二两三四五六七八九十]{1,3})\s*(?:个)?\s*(秒|分钟|分|小时|钟头|天|周)(?:后|之后|以后)/
  );
  if (relMatch) {
    const amount = parseChineseOrArabicInt(relMatch[1]);
    const unit = relMatch[2];
    if (amount !== null && amount > 0) {
      let deltaMs = 0;
      let unitLabel = unit;
      if (unit === "秒") {
        deltaMs = amount * 1000;
        unitLabel = "秒";
      } else if (unit === "分钟" || unit === "分") {
        deltaMs = amount * 60_000;
        unitLabel = "分钟";
      } else if (unit === "小时" || unit === "钟头") {
        deltaMs = amount * 3_600_000;
        unitLabel = "小时";
      } else if (unit === "天") {
        deltaMs = amount * 24 * 3_600_000;
        unitLabel = "天";
      } else if (unit === "周") {
        deltaMs = amount * 7 * 24 * 3_600_000;
        unitLabel = "周";
      }
      if (deltaMs > 0) {
        return withMeta({
          scheduleType: "once",
          cronExpr: "",
          nextRunAt: nowMs + deltaMs,
          isDefaultTime: false,
          humanScheduleLabel: `${amount} ${unitLabel}后`,
          cleanedTaskText,
        });
      }
    }
  }

  // 2. Check recurring natural language expressions ("每天...", "每日...", "每个工作日...", "每周X...", "每月X号...")
  const isRecurringText =
    /(?:每天|每日|每个?工作日|每(?:周|礼拜|星期)\s*[一二三四五六日天]|每个?周末|每月\s*\d{1,2}\s*[日号]|每隔?\s*\d+\s*小时)/.test(
      text
    ) && !/(?:这周|本周|下周)/.test(text);

  if (isRecurringText) {
    const clock = extractClockHourMinute(text, 8, 30);
    const h = clock.hour;
    const m = clock.minute;

    let cronExpr = `${m} ${h} * * *`;
    if (/每个?工作日|周一(?:到|至)周五/.test(text)) {
      cronExpr = `${m} ${h} * * 1-5`;
    } else if (/每个?周末/.test(text)) {
      cronExpr = `${m} ${h} * * 0,6`;
    } else {
      const weeklyMatch = text.match(/每(?:周|星期|礼拜)\s*([一二三四五六日天])/);
      const monthlyMatch = text.match(/每月\s*(\d{1,2})\s*[日号]/);
      const hourlyMatch = text.match(/每隔?\s*(\d{1,2})\s*(?:个)?小时/);
      if (weeklyMatch && ZH_DOW_MAP[weeklyMatch[1]] !== undefined) {
        cronExpr = `${m} ${h} * * ${ZH_DOW_MAP[weeklyMatch[1]]}`;
      } else if (monthlyMatch) {
        const dom = Math.min(31, Math.max(1, Number(monthlyMatch[1])));
        cronExpr = `${m} ${h} ${dom} * *`;
      } else if (hourlyMatch) {
        const stepH = Math.min(12, Math.max(1, Number(hourlyMatch[1])));
        cronExpr = `0 */${stepH} * * *`;
      }
    }

    const nextRunAt = getNextCronRunMs(cronExpr, nowMs, timeZone);
    return withMeta({
      scheduleType: "cron",
      cronExpr,
      nextRunAt,
      isDefaultTime: false,
      humanScheduleLabel: describeCronExpression(cronExpr),
      cleanedTaskText,
    });
  }

  // 3. If LLM router provided a valid cron hint when user asked for recurring schedule
  if (
    params.llmScheduleTypeHint === "cron" &&
    !/(?<!每)(?:本|这|下)?(?:周|星期|礼拜)\s*[一二三四五六日天]/.test(text) &&
    params.llmCronHint &&
    isValidCronExpression(params.llmCronHint)
  ) {
    const nextRunAt = getNextCronRunMs(params.llmCronHint, nowMs, timeZone);
    return withMeta({
      scheduleType: "cron",
      cronExpr: params.llmCronHint.trim(),
      nextRunAt,
      isDefaultTime: false,
      humanScheduleLabel: describeCronExpression(params.llmCronHint.trim()),
      cleanedTaskText,
    });
  }

  // 4. Check explicit calendar day + clock time (e.g. "今天下午4点半", "明早9点", "后天晚上8点", "下周三上午10点", "10月29日 15:00")
  const zpNow = getZonedDateParts(nowMs, timeZone);
  let dayOffset: number | null = null;
  let dayLabel = "";
  let defaultMeridiemFromDay = "";

  if (/今早|今晨/.test(text)) {
    dayOffset = 0;
    dayLabel = "今天";
    defaultMeridiemFromDay = "早上";
  } else if (/今晚|今夜/.test(text)) {
    dayOffset = 0;
    dayLabel = "今天";
    defaultMeridiemFromDay = "晚上";
  } else if (/今天|今日/.test(text)) {
    dayOffset = 0;
    dayLabel = "今天";
  } else if (/明早|明晨/.test(text)) {
    dayOffset = 1;
    dayLabel = "明天";
    defaultMeridiemFromDay = "早上";
  } else if (/明晚|明夜/.test(text)) {
    dayOffset = 1;
    dayLabel = "明天";
    defaultMeridiemFromDay = "晚上";
  } else if (/明天|明日/.test(text)) {
    dayOffset = 1;
    dayLabel = "明天";
  } else if (/大后天/.test(text)) {
    dayOffset = 3;
    dayLabel = "大后天";
  } else if (/后天/.test(text)) {
    dayOffset = 2;
    dayLabel = "后天";
  } else {
    const weekdayMatch = text.match(/(本|这|下)?(?:周|星期|礼拜)([一二三四五六日天])/);
    if (weekdayMatch) {
      const prefix = weekdayMatch[1] || "";
      const targetDow = ZH_DOW_MAP[weekdayMatch[2]];
      if (targetDow !== undefined) {
        let diff = targetDow - zpNow.dayOfWeek;
        if (prefix === "下") {
          // Next week's weekday
          const daysToNextMonday =
            zpNow.dayOfWeek === 0 ? 1 : 8 - zpNow.dayOfWeek;
          const offsetFromMonday = targetDow === 0 ? 6 : targetDow - 1;
          diff = daysToNextMonday + offsetFromMonday;
        } else if (diff < 0 || (diff === 0 && !prefix)) {
          diff += 7;
        }
        dayOffset = diff;
        dayLabel = `${prefix || "本"}周${weekdayMatch[2]}`;
      }
    }
  }

  // Check explicit M月D日
  const mdMatch = text.match(/(?:(\d{4})年)?\s*(\d{1,2})月(\d{1,2})[日号]/);
  const clockInfo = extractClockHourMinute(
    defaultMeridiemFromDay && !/(?:凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)/.test(text)
      ? `${defaultMeridiemFromDay} ${text}`
      : text,
    defaultMeridiemFromDay === "晚上" ? 20 : 9,
    0
  );

  if (mdMatch) {
    const targetYear = mdMatch[1] ? Number(mdMatch[1]) : zpNow.year;
    const targetMonth = Number(mdMatch[2]);
    const targetDay = Number(mdMatch[3]);
    const hour = clockInfo.matched ? clockInfo.hour : 9;
    const minute = clockInfo.matched ? clockInfo.minute : 0;
    const nextRunAt = zonedWallClockToEpochMs(
      targetYear,
      targetMonth,
      targetDay,
      hour,
      minute,
      timeZone
    );
    return withMeta({
      scheduleType: "once",
      cronExpr: "",
      nextRunAt,
      isDefaultTime: false,
      humanScheduleLabel: `${targetMonth}月${targetDay}日 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      cleanedTaskText,
    });
  }

  if (dayOffset !== null || clockInfo.matched) {
    const effectiveDayOffset = dayOffset ?? 0;
    const baseMiddayMs =
      zonedWallClockToEpochMs(
        zpNow.year,
        zpNow.month,
        zpNow.day,
        12,
        0,
        timeZone
      ) +
      effectiveDayOffset * 24 * 3_600_000;
    const targetDayParts = getZonedDateParts(baseMiddayMs, timeZone);
    const hour = clockInfo.hour;
    const minute = clockInfo.minute;

    let candidateMs = zonedWallClockToEpochMs(
      targetDayParts.year,
      targetDayParts.month,
      targetDayParts.day,
      hour,
      minute,
      timeZone
    );
    let finalDayLabel = dayLabel || "今天";

    // If user didn't specify a day ("下午4点半提醒我") and that time today has already passed, roll to tomorrow
    if (dayOffset === null && candidateMs <= nowMs) {
      const nextDayParts = getZonedDateParts(
        baseMiddayMs + 24 * 3_600_000,
        timeZone
      );
      candidateMs = zonedWallClockToEpochMs(
        nextDayParts.year,
        nextDayParts.month,
        nextDayParts.day,
        hour,
        minute,
        timeZone
      );
      finalDayLabel = "明天";
    }

    const hhmm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    return withMeta({
      scheduleType: "once",
      cronExpr: "",
      nextRunAt: candidateMs,
      isDefaultTime: false,
      humanScheduleLabel: `${finalDayLabel} ${hhmm}`,
      cleanedTaskText,
    });
  }

  // 5. Check LLM ISO timestamp hint if provided and valid in the future
  if (params.llmRunAtIsoHint) {
    const parsedMs = Date.parse(params.llmRunAtIsoHint);
    if (Number.isFinite(parsedMs) && parsedMs > nowMs) {
      const zp = getZonedDateParts(parsedMs, timeZone);
      const hhmm = `${String(zp.hour).padStart(2, "0")}:${String(zp.minute).padStart(2, "0")}`;
      return withMeta({
        scheduleType: "once",
        cronExpr: "",
        nextRunAt: parsedMs,
        isDefaultTime: false,
        humanScheduleLabel: `${zp.month}月${zp.day}日 ${hhmm}`,
        cleanedTaskText,
      });
    }
  }

  // 6. Default 20:00 Fallback Rule for untimed Todos / Reminders!
  const fallback = computeDefault20pmFallbackMs(nowMs, timeZone);
  return withMeta({
    scheduleType: "once",
    cronExpr: "",
    nextRunAt: fallback.nextRunAt,
    isDefaultTime: true,
    humanScheduleLabel: fallback.label,
    cleanedTaskText,
  });
}
