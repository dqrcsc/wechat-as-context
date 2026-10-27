export interface ParsedCron {
  raw: string;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domWildcard: boolean;
  dowWildcard: boolean;
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  isDayOfWeek = false
): { values: Set<number>; isWildcard: boolean } {
  const trimmed = field.trim();
  const isWildcard = trimmed === "*";
  const values = new Set<number>();

  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (!token) throw new Error(`Invalid empty cron token in "${field}"`);

    const [rangePart, stepPart] = token.split("/");
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step "${stepPart}" in "${field}"`);
    }

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [sRaw, eRaw] = rangePart.split("-");
        start = Number(sRaw);
        end = Number(eRaw);
      } else {
        start = Number(rangePart);
        end = stepPart !== undefined ? max : start;
      }
    }

    if (isDayOfWeek) {
      if (start === 7 && end === 7) {
        start = 0;
        end = 0;
      }
    }

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > (isDayOfWeek ? 7 : max) ||
      start > end
    ) {
      throw new Error(`Cron value out of range [${min}-${max}]: "${token}"`);
    }

    for (let v = start; v <= end; v += step) {
      values.add(isDayOfWeek && v === 7 ? 0 : v);
    }
  }

  if (values.size === 0) {
    throw new Error(`Cron field produced no valid values: "${field}"`);
  }
  return { values, isWildcard };
}

export function parseCronExpression(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Expected 5-field cron expression (minute hour dom month dow), got: "${expr}"`
    );
  }
  const minField = parseCronField(parts[0], 0, 59);
  const hourField = parseCronField(parts[1], 0, 23);
  const domField = parseCronField(parts[2], 1, 31);
  const monthField = parseCronField(parts[3], 1, 12);
  const dowField = parseCronField(parts[4], 0, 6, true);

  return {
    raw: parts.join(" "),
    minutes: minField.values,
    hours: hourField.values,
    daysOfMonth: domField.values,
    months: monthField.values,
    daysOfWeek: dowField.values,
    domWildcard: domField.isWildcard,
    dowWildcard: dowField.isWildcard,
  };
}

export function isValidCronExpression(expr: string): boolean {
  try {
    parseCronExpression(expr);
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number; // 0 = Sun .. 6 = Sat
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getZonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hour12: false,
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function getZonedDateParts(
  epochMs: number,
  timeZone = "Asia/Shanghai"
): ZonedParts {
  try {
    const fmt = getZonedFormatter(timeZone);
    const parts = fmt.formatToParts(new Date(epochMs));
    let year = 1970;
    let month = 1;
    let day = 1;
    let hour = 0;
    let minute = 0;
    let dayOfWeek = 0;

    for (const p of parts) {
      if (p.type === "year") year = Number(p.value);
      else if (p.type === "month") month = Number(p.value);
      else if (p.type === "day") day = Number(p.value);
      else if (p.type === "hour") {
        const h = Number(p.value);
        hour = h === 24 ? 0 : h;
      } else if (p.type === "minute") minute = Number(p.value);
      else if (p.type === "weekday") dayOfWeek = WEEKDAY_MAP[p.value] ?? 0;
    }
    return { year, month, day, hour, minute, dayOfWeek };
  } catch {
    const d = new Date(epochMs);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      dayOfWeek: d.getDay(),
    };
  }
}

/**
 * Convert a local wall-clock date/time in `timeZone` to exact Unix epoch ms.
 */
export function zonedWallClockToEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone = "Asia/Shanghai"
): number {
  const approxUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const p1 = getZonedDateParts(approxUtc, timeZone);
  const asUtc1 = Date.UTC(p1.year, p1.month - 1, p1.day, p1.hour, p1.minute, 0, 0);
  const diff1 = approxUtc - asUtc1;
  const candidate = approxUtc + diff1;
  const p2 = getZonedDateParts(candidate, timeZone);
  const asUtc2 = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, 0, 0);
  const diff2 = approxUtc - asUtc2;
  return candidate + diff2;
}

/**
 * Compute the next trigger timestamp (in Unix epoch milliseconds) strictly greater than `afterMs`.
 */
export function getNextCronRunMs(
  cronExpr: string,
  afterMs = Date.now(),
  timeZone = "Asia/Shanghai"
): number {
  const parsed = parseCronExpression(cronExpr);
  // Start at the next full minute boundary strictly after `afterMs`
  let cursorMs = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  // Search up to 366 days ahead (527,040 minutes)
  const maxMinutes = 366 * 24 * 60;

  for (let i = 0; i < maxMinutes; i++) {
    const zp = getZonedDateParts(cursorMs, timeZone);

    if (!parsed.months.has(zp.month)) {
      // Advance to the start of the next day
      cursorMs += (24 - zp.hour) * 3_600_000 - zp.minute * 60_000;
      continue;
    }

    const domMatch = parsed.daysOfMonth.has(zp.day);
    const dowMatch = parsed.daysOfWeek.has(zp.dayOfWeek);
    const dayMatches =
      parsed.domWildcard && parsed.dowWildcard
        ? true
        : parsed.domWildcard
          ? dowMatch
          : parsed.dowWildcard
            ? domMatch
            : domMatch || dowMatch;

    if (!dayMatches) {
      cursorMs += (24 - zp.hour) * 3_600_000 - zp.minute * 60_000;
      continue;
    }

    if (!parsed.hours.has(zp.hour)) {
      cursorMs += (60 - zp.minute) * 60_000;
      continue;
    }

    if (!parsed.minutes.has(zp.minute)) {
      cursorMs += 60_000;
      continue;
    }

    return cursorMs;
  }

  throw new Error(`Unable to find next cron execution within 366 days for: "${cronExpr}"`);
}

const ZH_WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function describeCronExpression(cronExpr: string): string {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return cronExpr;
  const [minStr, hourStr, domStr, monthStr, dowStr] = parts;
  const minNum = Number(minStr);
  const hourNum = Number(hourStr);

  if (
    Number.isInteger(minNum) &&
    Number.isInteger(hourNum) &&
    minNum >= 0 &&
    minNum <= 59 &&
    hourNum >= 0 &&
    hourNum <= 23 &&
    monthStr === "*"
  ) {
    const timeLabel = `${String(hourNum).padStart(2, "0")}:${String(minNum).padStart(2, "0")}`;
    if (domStr === "*" && dowStr === "*") {
      return `每天 ${timeLabel}`;
    }
    if (domStr === "*" && dowStr === "1-5") {
      return `每个工作日 ${timeLabel}`;
    }
    if (domStr === "*" && (dowStr === "0,6" || dowStr === "6,0")) {
      return `每个周末 ${timeLabel}`;
    }
    if (domStr === "*" && /^[0-7]$/.test(dowStr)) {
      const idx = Number(dowStr) % 7;
      return `每${ZH_WEEKDAYS[idx]} ${timeLabel}`;
    }
    if (/^\d+$/.test(domStr) && dowStr === "*") {
      return `每月 ${domStr} 日 ${timeLabel}`;
    }
  }
  return `Cron (${cronExpr})`;
}

export function formatZonedDateTime(
  epochMs: number,
  timeZone = "Asia/Shanghai"
): string {
  const zp = getZonedDateParts(epochMs, timeZone);
  const y = zp.year;
  const m = String(zp.month).padStart(2, "0");
  const d = String(zp.day).padStart(2, "0");
  const hh = String(zp.hour).padStart(2, "0");
  const mm = String(zp.minute).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}
