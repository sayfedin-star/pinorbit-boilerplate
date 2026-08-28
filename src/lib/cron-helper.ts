/**
 * Human-Readable Cron Formatter and Frequency Breakdown Helper
 */

export interface HumanCronOptions {
  breakdown?: boolean;
}

/**
 * Translates cron expressions into human-readable descriptions with cadence and frequency breakdown.
 * Example: '0 2 * * *' -> 'Daily at 02:00 UTC — 1/day, 7/week, ~30/month'
 */
export function humanCron(
  expression: string,
  timezone: string = 'UTC',
  options?: HumanCronOptions
): string {
  const expr = (expression || '').trim();
  if (!expr) return 'No schedule';

  // Standard specific formats
  if (expr === '0 2 * * *') {
    return options?.breakdown === false
      ? `Daily at 02:00 ${timezone}`
      : `Daily at 02:00 ${timezone} — 1/day, 7/week, ~30/month`;
  }
  if (expr === '0 4 * * *') {
    return options?.breakdown === false
      ? `Daily at 04:00 ${timezone}`
      : `Daily at 04:00 ${timezone} — 1/day, 7/week, ~30/month`;
  }
  if (expr === '0 0 * * *') {
    return options?.breakdown === false
      ? `Daily at 00:00 ${timezone}`
      : `Daily at 00:00 ${timezone} — 1/day, 7/week, ~30/month`;
  }

  // General 5-part cron parser: minute hour dom month dow
  const parts = expr.split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts;

    // Every X minutes: */15 * * * *
    if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
      const step = parseInt(min.slice(2), 10) || 15;
      const perDay = Math.round(1440 / step);
      return options?.breakdown === false
        ? `Every ${step} minutes`
        : `Every ${step} minutes — ${perDay}/day, ${perDay * 7}/week, ~${perDay * 30}/month`;
    }

    // Every hour at :MM: 0 * * * *
    if (min !== '*' && !min.includes('/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
      const mm = min.padStart(2, '0');
      return options?.breakdown === false
        ? `Hourly at :${mm} ${timezone}`
        : `Hourly at :${mm} — 24/day, 168/week, ~720/month`;
    }

    // Daily at HH:MM: 0 2 * * *
    if (min !== '*' && hour !== '*' && !min.includes('/') && !hour.includes('/') && dom === '*' && mon === '*' && dow === '*') {
      const hh = hour.padStart(2, '0');
      const mm = min.padStart(2, '0');
      return options?.breakdown === false
        ? `Daily at ${hh}:${mm} ${timezone}`
        : `Daily at ${hh}:${mm} ${timezone} — 1/day, 7/week, ~30/month`;
    }

    // Specific days of week at HH:MM: 0 4 * * 1,3,5
    if (min !== '*' && hour !== '*' && dom === '*' && mon === '*' && dow !== '*') {
      const hh = hour.padStart(2, '0');
      const mm = min.padStart(2, '0');
      const countDays = dow.split(',').length;
      return options?.breakdown === false
        ? `At ${hh}:${mm} ${timezone} on [${dow}]`
        : `At ${hh}:${mm} ${timezone} on [${dow}] — ${countDays}/week, ~${countDays * 4}/month`;
    }
  }

  return `${expr} (${timezone})`;
}

/**
 * Short human-readable title for tooltips and badges
 * Example: '0 2 * * *' -> 'Daily at 02:00 UTC'
 */
export function humanCronTitle(expression: string, timezone: string = 'UTC'): string {
  const expr = (expression || '').trim();
  if (expr === '0 2 * * *') return `Daily at 02:00 ${timezone}`;
  if (expr === '0 4 * * *') return `Daily at 04:00 ${timezone}`;
  if (expr === '0 0 * * *') return `Daily at 00:00 ${timezone}`;
  return humanCron(expression, timezone, { breakdown: false });
}

function matchesCronField(val: number, rule: string, minLimit: number, maxLimit: number): boolean {
  if (!rule || rule === '*') return true;
  const segments = rule.split(',');
  for (const seg of segments) {
    const s = seg.trim();
    if (!s || s === '*') return true;
    if (s.startsWith('*/')) {
      const step = Number(s.slice(2));
      if (step > 0 && (val - minLimit) % step === 0) return true;
      continue;
    }
    if (s.includes('/')) {
      const [rangeStr, stepStr] = s.split('/');
      const step = Number(stepStr);
      if (step > 0) {
        let start = minLimit, end = maxLimit;
        if (rangeStr && rangeStr !== '*') {
          const [r1, r2] = rangeStr.split('-').map(Number);
          start = !isNaN(r1) ? r1 : minLimit;
          end = !isNaN(r2) ? r2 : maxLimit;
        }
        if (val >= start && val <= end && (val - start) % step === 0) return true;
      }
      continue;
    }
    if (s.includes('-')) {
      const [r1, r2] = s.split('-').map(Number);
      if (!isNaN(r1) && !isNaN(r2) && val >= r1 && val <= r2) return true;
      continue;
    }
    const num = Number(s);
    if (!isNaN(num) && num === val) return true;
  }
  return false;
}

/**
 * Calculates the next Date when a 5-part cron expression will trigger after `fromDate`.
 * Full support for 5-part cron: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-7).
 * Supports ranges (a-b), steps (a-b/n, * /n), and lists (a,b,c). Fail-lazy.
 */
export function getNextCronDate(
  cronExpr: string,
  tzStr: string = 'UTC',
  fromDate: Date = new Date()
): Date | null {
  try {
    const parts = (cronExpr || '').trim().split(/\s+/);
    if (parts.length < 5) return null;
    const [mPart, hPart, domPart, monPart, dowPart] = parts;

    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tzStr || 'UTC',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
        hour12: false,
      });
    } catch {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
        hour12: false,
      });
    }

    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    // Start scan 1 minute after fromDate, aligned to the next whole minute
    const startMs = fromDate.getTime() + 60000;
    const alignedStart = new Date(startMs - (startMs % 60000));

    // Scan up to 366 days (527040 minutes)
    for (let offset = 0; offset < 366 * 24 * 60; offset++) {
      const testDate = new Date(alignedStart.getTime() + offset * 60000);
      let m = testDate.getUTCMinutes();
      let h = testDate.getUTCHours();
      let dom = testDate.getUTCDate();
      let mon = testDate.getUTCMonth() + 1;
      let dow = testDate.getUTCDay();

      try {
        const partsTz = formatter.formatToParts(testDate);
        m = Number(partsTz.find(p => p.type === 'minute')?.value ?? m);
        h = Number(partsTz.find(p => p.type === 'hour')?.value ?? h);
        dom = Number(partsTz.find(p => p.type === 'day')?.value ?? dom);
        mon = Number(partsTz.find(p => p.type === 'month')?.value ?? mon);
        const dayStr = partsTz.find(p => p.type === 'weekday')?.value ?? '';
        if (dayStr in dowMap) dow = dowMap[dayStr];
      } catch {}

      const mMatch = matchesCronField(m, mPart, 0, 59);
      if (!mMatch) continue;

      const hMatch = matchesCronField(h, hPart, 0, 23);
      if (!hMatch) continue;

      const domMatch = matchesCronField(dom, domPart, 1, 31);
      if (!domMatch) continue;

      const monMatch = matchesCronField(mon, monPart, 1, 12);
      if (!monMatch) continue;

      // Handle Sunday as 0 or 7
      const dowMatch = matchesCronField(dow, dowPart, 0, 6) || (dow === 0 && matchesCronField(7, dowPart, 0, 7));
      if (!dowMatch) continue;

      return testDate;
    }
    return null;
  } catch {
    return null;
  }
}

