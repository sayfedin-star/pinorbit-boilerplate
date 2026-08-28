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

/**
 * Calculates the next Date when a 5-part cron expression will trigger after `fromDate`.
 * Scans up to 14 days ahead minute-by-minute with timezone support. Fail-lazy.
 */
export function getNextCronDate(
  cronExpr: string,
  tzStr: string = 'UTC',
  fromDate: Date = new Date()
): Date | null {
  try {
    const parts = (cronExpr || '').trim().split(/\s+/);
    if (parts.length < 5) return null;
    const [mPart, hPart, , , dowPart] = parts;
    const scanTime = new Date(fromDate.getTime() + 60000);

    const matchNum = (val: number, rule: string): boolean => {
      if (rule === '*') return true;
      if (rule.startsWith('*/')) {
        const step = Number(rule.slice(2));
        return step > 0 && val % step === 0;
      }
      return rule.split(',').some(p => Number(p) === val);
    };

    // Scan up to 14 days (20160 minutes)
    for (let offset = 0; offset < 14 * 24 * 60; offset++) {
      const testDate = new Date(scanTime.getTime() + offset * 60000);
      let m = testDate.getUTCMinutes();
      let h = testDate.getUTCHours();
      let dow = testDate.getUTCDay();

      try {
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: tzStr,
          minute: 'numeric',
          hour: 'numeric',
          weekday: 'short',
          hour12: false,
        });
        const partsTz = formatter.formatToParts(testDate);
        m = Number(partsTz.find(p => p.type === 'minute')?.value ?? m);
        h = Number(partsTz.find(p => p.type === 'hour')?.value ?? h);
        const dayStr = partsTz.find(p => p.type === 'weekday')?.value ?? '';
        const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        if (dayStr in dowMap) dow = dowMap[dayStr];
      } catch {}

      if (matchNum(m, mPart) && matchNum(h, hPart) && matchNum(dow, dowPart)) {
        return new Date(testDate.getTime() - (testDate.getTime() % 60000));
      }
    }
    return null;
  } catch {
    return null;
  }
}

