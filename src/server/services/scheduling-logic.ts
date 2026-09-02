/**
 * Pure Scheduling Logic & Calculations.
 *
 * Zero external side-effects; 100% deterministic and unit-testable.
 */

export const DEFAULT_RETENTION_POSTED_DAYS = 30;
export const MIN_RETENTION_POSTED_DAYS = 1;
export const MAX_RETENTION_POSTED_DAYS = 365;

export const DEFAULT_PROCESSING_TIMEOUT_MINUTES = 45;
export const MIN_PROCESSING_TIMEOUT_MINUTES = 5;
export const MAX_PROCESSING_TIMEOUT_MINUTES = 240;

export interface ScheduleConfig {
  interval_minutes?: number | null;
  window_start?: string | null;
  window_end?: string | null;
  active_days?: string[] | number[] | string | null;
  timezone?: string | null;
  cron_expression?: string | null;
}

export interface WindowCheckResult {
  allowed: boolean;
  reason?: 'day_off' | 'window_closed';
}

export const DAY_NAME_TO_NUM: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

export const NUM_TO_DAY_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Normalizes active days from arrays, strings, or Postgres array representations
 * into a sorted unique list of integers (0=Sun .. 6=Sat).
 */
export function parseActiveDayNumbers(activeDays?: any): number[] {
  if (!activeDays) return [];

  let rawList: any[] = [];
  if (Array.isArray(activeDays)) {
    rawList = activeDays;
  } else if (typeof activeDays === 'string') {
    rawList = activeDays.replace(/[{}"']/g, '').split(',').map((x) => x.trim()).filter(Boolean);
  }

  const dayNums = new Set<number>();
  for (const item of rawList) {
    if (typeof item === 'number' && Number.isInteger(item)) {
      if (item >= 0 && item <= 6) dayNums.add(item);
      else if (item === 7) dayNums.add(0); // 7 is Sunday in standard cron notation
    } else if (typeof item === 'string') {
      const clean = item.trim().toLowerCase();
      if (/^[0-7]$/.test(clean)) {
        const n = parseInt(clean, 10);
        dayNums.add(n === 7 ? 0 : n);
      } else {
        const num = DAY_NAME_TO_NUM[clean] ?? DAY_NAME_TO_NUM[clean.slice(0, 3)];
        if (num !== undefined) dayNums.add(num);
      }
    }
  }

  return Array.from(dayNums).sort((a, b) => a - b);
}

/**
 * Extracts and clamps an hour value [0, 23] from HH:MM string representations.
 */
export function parseHour(val?: string | null, defaultHour: number = 0): number {
  if (!val || typeof val !== 'string') return defaultHour;
  const match = val.trim().match(/^(\d{1,2})/);
  if (!match) return defaultHour;
  const h = parseInt(match[1], 10);
  return isNaN(h) ? defaultHour : Math.max(0, Math.min(23, h));
}

/**
 * 1. Portable Cron Expression Builder
 * Generates deterministic crontab format: minute hour day-of-month month day-of-week
 * - Minutes: divisor intervals use `* / N` (e.g. `* / 20`), non-divisors use explicit comma lists (e.g. `0,25,50`)
 * - Hours: explicit comma-separated list of window hours (handles overnight windows e.g. 22 to 06)
 * - Days: explicit 0-6 comma list based on active_days (0=Sun .. 6=Sat) or * if all 7 days
 */
export function buildPortableCron(s?: ScheduleConfig | null): string {
  const rawInterval = Number(s?.interval_minutes);
  const interval = (!rawInterval || isNaN(rawInterval) || rawInterval <= 0) ? 36 : Math.round(rawInterval);
  const startH = parseHour(s?.window_start, 9);
  const endH = parseHour(s?.window_end, 21);

  // 1. Build window hours list (explicit comma list, NO / in hours)
  const windowHours: number[] = [];
  if (startH <= endH) {
    for (let h = startH; h <= endH; h++) windowHours.push(h);
  } else {
    for (let h = startH; h <= 23; h++) windowHours.push(h);
    for (let h = 0; h <= endH; h++) windowHours.push(h);
  }
  if (windowHours.length === 0) windowHours.push(startH);

  let minuteField = '0';
  let hourField = '';

  if (interval < 60) {
    if (60 % interval === 0) {
      minuteField = `*/${interval}`;
    } else {
      const mins: number[] = [];
      for (let m = 0; m < 60; m += interval) mins.push(m);
      minuteField = mins.join(',');
    }
    hourField = windowHours.join(',');
  } else {
    minuteField = '0';
    const stepHours = Math.max(1, Math.round(interval / 60));
    const selectedHours: number[] = [];
    for (let i = 0; i < windowHours.length; i += stepHours) {
      selectedHours.push(windowHours[i]);
    }
    hourField = selectedHours.join(',');
  }

  // 2. Active days (0=Sun .. 6=Sat)
  const activeDayNums = parseActiveDayNumbers(s?.active_days);
  let dayField = '*';
  if (activeDayNums.length > 0 && activeDayNums.length < 7) {
    dayField = activeDayNums.join(',');
  }

  return `${minuteField} ${hourField} * * ${dayField}`;
}

/**
 * Companion parser for buildPortableCron output.
 * Ensures the generated cron expression is reversible and reconstructs configuration.
 */
export function parsePortableCron(cron: string): Partial<ScheduleConfig> | null {
  if (!cron || typeof cron !== 'string') return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minuteField, hourField, , , dayField] = parts;

  // Reconstruct interval_minutes
  let interval_minutes = 36;
  if (minuteField.startsWith('*/')) {
    interval_minutes = parseInt(minuteField.slice(2), 10) || 36;
  } else if (minuteField.includes(',')) {
    const mins = minuteField.split(',').map((m) => parseInt(m, 10)).filter((n) => !isNaN(n));
    if (mins.length >= 2) {
      interval_minutes = mins[1] - mins[0];
    }
  } else if (minuteField === '0') {
    const hours = hourField.split(',').map((h) => parseInt(h, 10)).filter((n) => !isNaN(n));
    if (hours.length >= 2) {
      interval_minutes = (hours[1] - hours[0]) * 60;
    } else {
      interval_minutes = 60;
    }
  }

  // Reconstruct window_start & window_end
  const hours = hourField === '*'
    ? [0, 23]
    : hourField.split(',').map((h) => parseInt(h, 10)).filter((n) => !isNaN(n));

  let window_start = '09:00';
  let window_end = '21:00';
  if (hours.length > 0) {
    const firstH = hours[0];
    const lastH = hours[hours.length - 1];
    window_start = `${String(firstH).padStart(2, '0')}:00`;
    window_end = `${String(lastH).padStart(2, '0')}:00`;
  }

  // Reconstruct active_days
  let active_days: string[] | null = null;
  if (dayField !== '*') {
    const dNums = dayField.split(',').map((d) => parseInt(d, 10)).filter((n) => !isNaN(n));
    active_days = dNums.map((n) => NUM_TO_DAY_NAME[n] || String(n));
  }

  return {
    interval_minutes,
    window_start,
    window_end,
    active_days,
  };
}

/**
 * 2. Timezone-Aware Schedule Window and Active-Day Check
 * Validates whether dispatch is permitted at the specified point in time (`now`).
 * - Skips check if schedule has an explicit custom `cron_expression`.
 * - Validates weekday in schedule's timezone against `active_days`.
 * - Validates local HH:MM against `[window_start, window_end]`, including overnight windows (e.g. 22:00 -> 06:00).
 */
export function checkScheduleWindow(
  schedule: ScheduleConfig,
  now: Date = new Date()
): WindowCheckResult {
  // Explicit cron expression skips window and active day server-side checks
  if (schedule.cron_expression && String(schedule.cron_expression).trim().length > 0) {
    return { allowed: true };
  }

  const tz = schedule.timezone || 'UTC';
  let dayName = '';
  let hm = '';

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);

    dayName = parts.find((p) => p.type === 'weekday')?.value || '';
    let hour = parts.find((p) => p.type === 'hour')?.value || '00';
    if (hour === '24') hour = '00';
    const minute = parts.find((p) => p.type === 'minute')?.value || '00';
    hm = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  } catch (tzError) {
    console.warn('[SchedulingLogic] Invalid timezone, falling back to UTC:', tzError);
    const utcParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);

    dayName = utcParts.find((p) => p.type === 'weekday')?.value || '';
    let utcHour = utcParts.find((p) => p.type === 'hour')?.value || '00';
    if (utcHour === '24') utcHour = '00';
    const minute = utcParts.find((p) => p.type === 'minute')?.value || '00';
    hm = `${utcHour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  // Active days check using unified parseActiveDayNumbers
  const activeDayNums = parseActiveDayNumbers(schedule.active_days);
  if (activeDayNums.length > 0 && activeDayNums.length < 7) {
    const currentDayNum = DAY_NAME_TO_NUM[dayName.toLowerCase()] ?? DAY_NAME_TO_NUM[dayName.toLowerCase().slice(0, 3)];
    if (currentDayNum !== undefined && !activeDayNums.includes(currentDayNum)) {
      return { allowed: false, reason: 'day_off' };
    }
  }

  const w0 = String(schedule.window_start || '09:00').trim().slice(0, 5);
  const w1 = String(schedule.window_end || '21:00').trim().slice(0, 5);

  if (hm && w0 && w1) {
    const isClosed = w0 <= w1 ? (hm < w0 || hm > w1) : (hm < w0 && hm > w1);
    if (isClosed) {
      return { allowed: false, reason: 'window_closed' };
    }
  }

  return { allowed: true };
}

import { evaluateTokenCandidates, maskToken } from '../lib/token-resolver';
export { evaluateTokenCandidates, maskToken };

/**
 * 4. Deterministic Idempotency Key Builders
 */
export function buildPinPostIdempotencyKey(pinId: string, attempts: number | string = 0): string {
  return `pin.post:${pinId}:${attempts}`;
}

export function buildDeterministicPinPostKey(pinId: string): string {
  return `pin.post:${pinId}`;
}

export function isLeaseActive(lockedUntil: string | null | undefined, now: Date = new Date()): boolean {
  if (!lockedUntil) return false;
  const lockTime = new Date(lockedUntil).getTime();
  return !isNaN(lockTime) && lockTime > now.getTime();
}

export function buildBoardCreateIdempotencyKey(accountId: string, boardName: string): string {
  return `create:${String(accountId || '').trim()}:${String(boardName || '').trim().toLowerCase()}`;
}

export function buildBoardListIdempotencyKey(accountId: string, boardId: string): string {
  return `list:${accountId}:${boardId}`;
}

/**
 * 5. Retention & Timeout Clamps
 */
export function clampRetentionPostedDays(rawDays?: any): number {
  if (rawDays === undefined || rawDays === null || rawDays === '') {
    return DEFAULT_RETENTION_POSTED_DAYS;
  }
  const num = Number(rawDays);
  if (isNaN(num)) {
    return DEFAULT_RETENTION_POSTED_DAYS;
  }
  return Math.max(MIN_RETENTION_POSTED_DAYS, Math.min(MAX_RETENTION_POSTED_DAYS, Math.round(num)));
}

export function clampProcessingTimeoutMinutes(rawMinutes?: any): number {
  if (rawMinutes === undefined || rawMinutes === null || rawMinutes === '') {
    return DEFAULT_PROCESSING_TIMEOUT_MINUTES;
  }
  const num = Number(rawMinutes);
  if (isNaN(num)) {
    return DEFAULT_PROCESSING_TIMEOUT_MINUTES;
  }
  return Math.max(MIN_PROCESSING_TIMEOUT_MINUTES, Math.min(MAX_PROCESSING_TIMEOUT_MINUTES, Math.round(num)));
}
