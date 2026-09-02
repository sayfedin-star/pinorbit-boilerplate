import { describe, it, expect } from 'vitest';
import {
  buildPortableCron,
  parsePortableCron,
  checkScheduleWindow,
  parseActiveDayNumbers,
  parseHour,
  evaluateTokenCandidates,
  buildPinPostIdempotencyKey,
  buildBoardCreateIdempotencyKey,
  buildBoardListIdempotencyKey,
  clampRetentionPostedDays,
  clampProcessingTimeoutMinutes,
  DEFAULT_RETENTION_POSTED_DAYS,
  DEFAULT_PROCESSING_TIMEOUT_MINUTES,
} from '../services/scheduling-logic';

describe('Pure Scheduling Logic Suite (scheduling-logic.ts)', () => {
  describe('1. buildPortableCron', () => {
    it('generates divisor minute intervals using */N syntax (interval = 20)', () => {
      const cron = buildPortableCron({
        interval_minutes: 20,
        window_start: '09:00',
        window_end: '17:00',
        active_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      });
      expect(cron).toBe('*/20 9,10,11,12,13,14,15,16,17 * * 1,2,3,4,5');
    });

    it('generates non-divisor minute intervals using explicit comma list (interval = 25)', () => {
      const cron = buildPortableCron({
        interval_minutes: 25,
        window_start: '09:00',
        window_end: '12:00',
        active_days: ['Mon', 'Wed', 'Fri'],
      });
      // 0, 25, 50
      expect(cron).toBe('0,25,50 9,10,11,12 * * 1,3,5');
    });

    it('handles overnight window (22:00 -> 06:00) with explicit comma-separated hours', () => {
      const cron = buildPortableCron({
        interval_minutes: 30,
        window_start: '22:00',
        window_end: '06:00',
        active_days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      });
      // All 7 days -> *
      // Hours from 22..23, 0..6: 22,23,0,1,2,3,4,5,6
      expect(cron).toBe('*/30 22,23,0,1,2,3,4,5,6 * * *');
    });

    it('handles hourly and multi-hour intervals (interval >= 60)', () => {
      const cron = buildPortableCron({
        interval_minutes: 120, // stepHours = 2
        window_start: '08:00',
        window_end: '16:00',
        active_days: ['Mon', 'Tue'],
      });
      // window: 8,9,10,11,12,13,14,15,16. Step 2: 8, 10, 12, 14, 16
      expect(cron).toBe('0 8,10,12,14,16 * * 1,2');
    });

    it('handles string active_days and single-day schedules', () => {
      const cron = buildPortableCron({
        interval_minutes: 15,
        window_start: '10:00',
        window_end: '11:00',
        active_days: 'Saturday, Sunday',
      });
      // 0=Sun, 6=Sat -> 0,6
      expect(cron).toBe('*/15 10,11 * * 0,6');
    });

    it('falls back to defaults when input is empty or partial', () => {
      const cron = buildPortableCron({});
      expect(cron).toBe('0,36 9,10,11,12,13,14,15,16,17,18,19,20,21 * * *');
    });
  });

  describe('2. checkScheduleWindow', () => {
    it('bypasses checks entirely when explicit cron_expression is configured', () => {
      const schedule = {
        timezone: 'America/New_York',
        active_days: ['Mon'],
        window_start: '09:00',
        window_end: '10:00',
        cron_expression: '0 12 * * *',
      };
      // Test at a time outside window on a non-active day (e.g. Sunday midnight)
      const sundayNight = new Date('2026-08-16T04:00:00Z');
      const res = checkScheduleWindow(schedule, sundayNight);
      expect(res).toEqual({ allowed: true });
    });

    it('blocks dispatch with reason "day_off" on inactive days', () => {
      const schedule = {
        timezone: 'UTC',
        active_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        window_start: '09:00',
        window_end: '21:00',
      };
      // 2026-08-16 is Sunday
      const sundayNoon = new Date('2026-08-16T12:00:00Z');
      const res = checkScheduleWindow(schedule, sundayNoon);
      expect(res).toEqual({ allowed: false, reason: 'day_off' });
    });

    it('blocks dispatch with reason "window_closed" outside standard window hours', () => {
      const schedule = {
        timezone: 'UTC',
        active_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        window_start: '09:00',
        window_end: '17:00',
      };
      // 2026-08-17 is Monday
      const mondayEarly = new Date('2026-08-17T08:30:00Z');
      const resEarly = checkScheduleWindow(schedule, mondayEarly);
      expect(resEarly).toEqual({ allowed: false, reason: 'window_closed' });

      const mondayLate = new Date('2026-08-17T17:30:00Z');
      const resLate = checkScheduleWindow(schedule, mondayLate);
      expect(resLate).toEqual({ allowed: false, reason: 'window_closed' });
    });

    it('allows dispatch inside standard window hours on active days', () => {
      const schedule = {
        timezone: 'UTC',
        active_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        window_start: '09:00',
        window_end: '17:00',
      };
      // 2026-08-17 is Monday at 14:30
      const mondayActive = new Date('2026-08-17T14:30:00Z');
      const res = checkScheduleWindow(schedule, mondayActive);
      expect(res).toEqual({ allowed: true });
    });

    it('correctly validates overnight windows (22:00 -> 06:00)', () => {
      const schedule = {
        timezone: 'UTC',
        active_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        window_start: '22:00',
        window_end: '06:00',
      };

      // Allowed inside evening part (23:15)
      const lateEvening = new Date('2026-08-17T23:15:00Z');
      expect(checkScheduleWindow(schedule, lateEvening)).toEqual({ allowed: true });

      // Allowed inside early morning part (04:30)
      const earlyMorning = new Date('2026-08-18T04:30:00Z');
      expect(checkScheduleWindow(schedule, earlyMorning)).toEqual({ allowed: true });

      // Blocked in daytime (12:00)
      const noon = new Date('2026-08-17T12:00:00Z');
      expect(checkScheduleWindow(schedule, noon)).toEqual({ allowed: false, reason: 'window_closed' });
    });
  });

  describe('3. evaluateTokenCandidates', () => {
    const validEmbedded = 'embedded_token_12345678';
    const validTokenId = 'token_id_val_123456789';
    const validWorkspaceDefault = 'workspace_default_token_123';
    const validEnvToken = 'env_fastcron_token_123456';

    it('resolves in priority: Embedded -> Token ID -> Workspace Default -> Env', () => {
      // 1. Embedded wins if present
      expect(
        evaluateTokenCandidates([validEmbedded, validTokenId, validWorkspaceDefault, validEnvToken])
      ).toBe(validEmbedded);

      // 2. Token ID wins if embedded is null/short
      expect(
        evaluateTokenCandidates([null, validTokenId, validWorkspaceDefault, validEnvToken])
      ).toBe(validTokenId);

      expect(
        evaluateTokenCandidates(['too_short', validTokenId, validWorkspaceDefault, validEnvToken])
      ).toBe(validTokenId);

      // 3. Workspace Default wins if previous are absent
      expect(
        evaluateTokenCandidates([undefined, null, validWorkspaceDefault, validEnvToken])
      ).toBe(validWorkspaceDefault);

      // 4. Env wins if only it is available
      expect(
        evaluateTokenCandidates(['', null, undefined, validEnvToken])
      ).toBe(validEnvToken);

      // 5. Returns null if all candidates missing or invalid (< 16 chars)
      expect(
        evaluateTokenCandidates([null, 'short', undefined, ''])
      ).toBeNull();
    });
  });

  describe('4. Deterministic Idempotency Key Builders', () => {
    it('builds pin post idempotency key with attempt count', () => {
      expect(buildPinPostIdempotencyKey('pin-1234', 0)).toBe('pin.post:pin-1234:0');
      expect(buildPinPostIdempotencyKey('pin-5678', 2)).toBe('pin.post:pin-5678:2');
    });

    it('builds board create idempotency key with lowercased board name', () => {
      expect(buildBoardCreateIdempotencyKey('acc-1', 'Summer Recipes')).toBe('create:acc-1:summer recipes');
      expect(buildBoardCreateIdempotencyKey('acc-2', 'DIy CRAFTS')).toBe('create:acc-2:diy crafts');
    });

    it('builds board list idempotency key', () => {
      expect(buildBoardListIdempotencyKey('acc-1', 'board-99')).toBe('list:acc-1:board-99');
    });
  });

  describe('5. Retention and Timeout Clamps', () => {
    it('clamps retention_posted_days to [1, 365] with default 30', () => {
      // Edge below min
      expect(clampRetentionPostedDays(0)).toBe(1);
      expect(clampRetentionPostedDays(-10)).toBe(1);

      // Exact boundaries
      expect(clampRetentionPostedDays(1)).toBe(1);
      expect(clampRetentionPostedDays(30)).toBe(30);
      expect(clampRetentionPostedDays(365)).toBe(365);

      // Edge above max
      expect(clampRetentionPostedDays(366)).toBe(365);
      expect(clampRetentionPostedDays(1000)).toBe(365);

      // Non-numeric / missing fallbacks
      expect(clampRetentionPostedDays(null)).toBe(DEFAULT_RETENTION_POSTED_DAYS);
      expect(clampRetentionPostedDays(undefined)).toBe(DEFAULT_RETENTION_POSTED_DAYS);
      expect(clampRetentionPostedDays('')).toBe(DEFAULT_RETENTION_POSTED_DAYS);
      expect(clampRetentionPostedDays('invalid')).toBe(DEFAULT_RETENTION_POSTED_DAYS);

      // Rounding
      expect(clampRetentionPostedDays(14.6)).toBe(15);
    });

    it('clamps processing_timeout_minutes to [5, 240] with default 45', () => {
      // Edge below min
      expect(clampProcessingTimeoutMinutes(0)).toBe(5);
      expect(clampProcessingTimeoutMinutes(4)).toBe(5);

      // Exact boundaries
      expect(clampProcessingTimeoutMinutes(5)).toBe(5);
      expect(clampProcessingTimeoutMinutes(45)).toBe(45);
      expect(clampProcessingTimeoutMinutes(240)).toBe(240);

      // Edge above max
      expect(clampProcessingTimeoutMinutes(241)).toBe(240);
      expect(clampProcessingTimeoutMinutes(500)).toBe(240);

      // Non-numeric / missing fallbacks
      expect(clampProcessingTimeoutMinutes(null)).toBe(DEFAULT_PROCESSING_TIMEOUT_MINUTES);
      expect(clampProcessingTimeoutMinutes(undefined)).toBe(DEFAULT_PROCESSING_TIMEOUT_MINUTES);
      expect(clampProcessingTimeoutMinutes('')).toBe(DEFAULT_PROCESSING_TIMEOUT_MINUTES);
      expect(clampProcessingTimeoutMinutes('invalid')).toBe(DEFAULT_PROCESSING_TIMEOUT_MINUTES);

    });
  });

  describe('6. Exhaustive Interval Calculations (25, 36, 120 min & Edges)', () => {
    it('handles 25-minute non-divisor interval correctly (0,25,50)', () => {
      const cron = buildPortableCron({
        interval_minutes: 25,
        window_start: '10:00',
        window_end: '14:00',
      });
      expect(cron).toBe('0,25,50 10,11,12,13,14 * * *');
    });

    it('handles 36-minute default / non-divisor interval correctly (0,36)', () => {
      const cron = buildPortableCron({
        interval_minutes: 36,
        window_start: '09:00',
        window_end: '12:00',
      });
      expect(cron).toBe('0,36 9,10,11,12 * * *');
    });

    it('handles 120-minute multi-hour interval correctly (step 2 hours)', () => {
      const cron = buildPortableCron({
        interval_minutes: 120,
        window_start: '08:00',
        window_end: '16:00',
      });
      expect(cron).toBe('0 8,10,12,14,16 * * *');
    });

    it('handles 1-minute interval (every minute)', () => {
      const cron = buildPortableCron({
        interval_minutes: 1,
        window_start: '09:00',
        window_end: '10:00',
      });
      expect(cron).toBe('*/1 9,10 * * *');
    });

    it('handles 5, 10, 15, 30 minute divisor intervals', () => {
      expect(buildPortableCron({ interval_minutes: 5, window_start: '09:00', window_end: '09:00' }))
        .toBe('*/5 9 * * *');
      expect(buildPortableCron({ interval_minutes: 10, window_start: '09:00', window_end: '09:00' }))
        .toBe('*/10 9 * * *');
      expect(buildPortableCron({ interval_minutes: 15, window_start: '09:00', window_end: '09:00' }))
        .toBe('*/15 9 * * *');
      expect(buildPortableCron({ interval_minutes: 30, window_start: '09:00', window_end: '09:00' }))
        .toBe('*/30 9 * * *');
    });

    it('handles 45-minute non-divisor interval (0,45)', () => {
      const cron = buildPortableCron({
        interval_minutes: 45,
        window_start: '13:00',
        window_end: '15:00',
      });
      expect(cron).toBe('0,45 13,14,15 * * *');
    });

    it('handles 180-minute (3-hour) interval (step 3 hours)', () => {
      const cron = buildPortableCron({
        interval_minutes: 180,
        window_start: '06:00',
        window_end: '18:00',
      });
      expect(cron).toBe('0 6,9,12,15,18 * * *');
    });

    it('clamps 0, negative, float, or invalid intervals to default 36 minutes', () => {
      expect(buildPortableCron({ interval_minutes: 0, window_start: '10:00', window_end: '11:00' }))
        .toBe('0,36 10,11 * * *');
      expect(buildPortableCron({ interval_minutes: -15, window_start: '10:00', window_end: '11:00' }))
        .toBe('0,36 10,11 * * *');
      expect(buildPortableCron({ interval_minutes: NaN as any, window_start: '10:00', window_end: '11:00' }))
        .toBe('0,36 10,11 * * *');
      // Float 20.4 rounds to 20
      expect(buildPortableCron({ interval_minutes: 20.4, window_start: '10:00', window_end: '11:00' }))
        .toBe('*/20 10,11 * * *');
    });
  });

  describe('7. Active Days Parsing & All 7 Days Edge Cases', () => {
    it('normalizes full day names and short day names', () => {
      expect(parseActiveDayNumbers(['Sunday', 'Wednesday', 'Friday'])).toEqual([0, 3, 5]);
      expect(parseActiveDayNumbers(['mon', 'tue', 'thu'])).toEqual([1, 2, 4]);
    });

    it('normalizes numeric days (0..6 and cron 7=Sun)', () => {
      expect(parseActiveDayNumbers([1, 2, 3])).toEqual([1, 2, 3]);
      expect(parseActiveDayNumbers(['0', '2', '4'])).toEqual([0, 2, 4]);
      expect(parseActiveDayNumbers(['7'])).toEqual([0]); // 7 -> Sunday
    });

    it('parses Postgres array format string "{Mon,Wed,Fri}" and "{1,3,5}"', () => {
      expect(parseActiveDayNumbers('{Mon,Wed,Fri}')).toEqual([1, 3, 5]);
      expect(parseActiveDayNumbers('{1,3,5}')).toEqual([1, 3, 5]);
    });

    it('handles all 7 days with various representations and emits "*"', () => {
      // Full names
      expect(buildPortableCron({ active_days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] }))
        .toContain('* * *');
      // Numeric
      expect(buildPortableCron({ active_days: [0, 1, 2, 3, 4, 5, 6] }))
        .toContain('* * *');
      // String numbers
      expect(buildPortableCron({ active_days: '0,1,2,3,4,5,6' }))
        .toContain('* * *');
    });

    it('correctly deduplicates days and does NOT emit "*" when 7 duplicates of the same day are passed', () => {
      // 7 duplicates of 'Mon' should yield only Monday (1), NOT all 7 days (*)
      const cron = buildPortableCron({
        active_days: ['Mon', 'Mon', 'Mon', 'Mon', 'Mon', 'Mon', 'Mon'],
        window_start: '09:00',
        window_end: '10:00',
      });
      expect(cron).toBe('0,36 9,10 * * 1');
    });

    it('allows checkScheduleWindow to support numeric active_days seamlessly', () => {
      const schedule = {
        timezone: 'UTC',
        active_days: [1, 3, 5], // Mon, Wed, Fri
        window_start: '09:00',
        window_end: '17:00',
      };

      // 2026-08-17 is Monday -> Allowed
      expect(checkScheduleWindow(schedule, new Date('2026-08-17T12:00:00Z'))).toEqual({ allowed: true });
      // 2026-08-18 is Tuesday -> Day off
      expect(checkScheduleWindow(schedule, new Date('2026-08-18T12:00:00Z'))).toEqual({ allowed: false, reason: 'day_off' });
    });
  });

  describe('8. Overnight Window Auditing (22:00 -> 06:00, 23:30 -> 01:30)', () => {
    const overnightSchedule = {
      timezone: 'UTC',
      active_days: [0, 1, 2, 3, 4, 5, 6],
      window_start: '22:00',
      window_end: '06:00',
    };

    it('validates every boundary minute for 22:00 -> 06:00', () => {
      // 21:59 -> closed
      expect(checkScheduleWindow(overnightSchedule, new Date('2026-08-17T21:59:00Z')))
        .toEqual({ allowed: false, reason: 'window_closed' });

      // 22:00 -> open
      expect(checkScheduleWindow(overnightSchedule, new Date('2026-08-17T22:00:00Z')))
        .toEqual({ allowed: true });

      // 23:59 -> open
      expect(checkScheduleWindow(overnightSchedule, new Date('2026-08-17T23:59:00Z')))
        .toEqual({ allowed: true });

      // 00:00 -> open
      expect(checkScheduleWindow(overnightSchedule, new Date('2026-08-18T00:00:00Z')))
        .toEqual({ allowed: true });

      // 05:59 -> open
      expect(checkScheduleWindow(overnightSchedule, new Date('2026-08-18T05:59:00Z')))
        .toEqual({ allowed: true });

      // 06:00 -> open
      expect(checkScheduleWindow(overnightSchedule, new Date('2026-08-18T06:00:00Z')))
        .toEqual({ allowed: true });

      // 06:01 -> closed
      expect(checkScheduleWindow(overnightSchedule, new Date('2026-08-18T06:01:00Z')))
        .toEqual({ allowed: false, reason: 'window_closed' });
    });

    it('validates sub-hour overnight window (23:30 -> 01:30)', () => {
      const tightSchedule = {
        timezone: 'UTC',
        active_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        window_start: '23:30',
        window_end: '01:30',
      };

      expect(checkScheduleWindow(tightSchedule, new Date('2026-08-17T23:29:00Z')))
        .toEqual({ allowed: false, reason: 'window_closed' });
      expect(checkScheduleWindow(tightSchedule, new Date('2026-08-17T23:30:00Z')))
        .toEqual({ allowed: true });
      expect(checkScheduleWindow(tightSchedule, new Date('2026-08-18T01:30:00Z')))
        .toEqual({ allowed: true });
      expect(checkScheduleWindow(tightSchedule, new Date('2026-08-18T01:31:00Z')))
        .toEqual({ allowed: false, reason: 'window_closed' });
    });

    it('handles all-day window (00:00 -> 23:59)', () => {
      const allDay = {
        timezone: 'UTC',
        active_days: ['Mon'],
        window_start: '00:00',
        window_end: '23:59',
      };

      // Monday at 00:00
      expect(checkScheduleWindow(allDay, new Date('2026-08-17T00:00:00Z'))).toEqual({ allowed: true });
      // Monday at 23:59
      expect(checkScheduleWindow(allDay, new Date('2026-08-17T23:59:00Z'))).toEqual({ allowed: true });
    });
  });

  describe('9. Daylight Saving Time (DST) Transitions & Timezone Robustness', () => {
    it('handles US Eastern DST Spring Forward transition (America/New_York on 2026-03-08)', () => {
      const schedule = {
        timezone: 'America/New_York',
        active_days: ['Sun'],
        window_start: '01:00',
        window_end: '05:00',
      };

      // At 06:30 UTC -> 01:30 EST (before spring forward jump at 02:00) -> Allowed
      const beforeJump = new Date('2026-03-08T06:30:00Z');
      expect(checkScheduleWindow(schedule, beforeJump)).toEqual({ allowed: true });

      // At 07:30 UTC -> 03:30 EDT (after clock jumps forward to 03:00) -> Allowed
      const afterJump = new Date('2026-03-08T07:30:00Z');
      expect(checkScheduleWindow(schedule, afterJump)).toEqual({ allowed: true });

      // At 09:30 UTC -> 05:30 EDT (outside window) -> Closed
      const outsideAfterJump = new Date('2026-03-08T09:30:00Z');
      expect(checkScheduleWindow(schedule, outsideAfterJump)).toEqual({ allowed: false, reason: 'window_closed' });
    });

    it('handles US Eastern DST Fall Back transition (America/New_York on 2026-11-01)', () => {
      const schedule = {
        timezone: 'America/New_York',
        active_days: ['Sun'],
        window_start: '00:00',
        window_end: '03:00',
      };

      // At 05:30 UTC -> 01:30 EDT (first pass of 01:30) -> Allowed
      const firstPass = new Date('2026-11-01T05:30:00Z');
      expect(checkScheduleWindow(schedule, firstPass)).toEqual({ allowed: true });

      // At 06:30 UTC -> 01:30 EST (second pass of 01:30 after 2am roll back) -> Allowed
      const secondPass = new Date('2026-11-01T06:30:00Z');
      expect(checkScheduleWindow(schedule, secondPass)).toEqual({ allowed: true });

      // At 08:30 UTC -> 03:30 EST (outside window) -> Closed
      const outside = new Date('2026-11-01T08:30:00Z');
      expect(checkScheduleWindow(schedule, outside)).toEqual({ allowed: false, reason: 'window_closed' });
    });

    it('handles Europe/London Summer (BST) vs Winter (GMT) shifts', () => {
      const schedule = {
        timezone: 'Europe/London',
        active_days: ['Wed'],
        window_start: '10:00',
        window_end: '12:00',
      };

      // Winter (GMT = UTC+0): 2026-01-14 at 10:30 UTC is 10:30 GMT -> Allowed
      const winterTime = new Date('2026-01-14T10:30:00Z');
      expect(checkScheduleWindow(schedule, winterTime)).toEqual({ allowed: true });

      // Summer (BST = UTC+1): 2026-07-15 at 09:30 UTC is 10:30 BST -> Allowed
      const summerTime = new Date('2026-07-15T09:30:00Z');
      expect(checkScheduleWindow(schedule, summerTime)).toEqual({ allowed: true });

      // Summer at 11:30 UTC is 12:30 BST -> Outside window (closed)
      const summerClosed = new Date('2026-07-15T11:30:00Z');
      expect(checkScheduleWindow(schedule, summerClosed)).toEqual({ allowed: false, reason: 'window_closed' });
    });

    it('falls back gracefully to UTC on invalid or unrecognizable timezone without throwing', () => {
      const schedule = {
        timezone: 'SolarSystem/Mars_Crater',
        active_days: ['Mon'],
        window_start: '10:00',
        window_end: '12:00',
      };

      // UTC Monday 11:00 -> Allowed
      const nowUtc = new Date('2026-08-17T11:00:00Z');
      expect(checkScheduleWindow(schedule, nowUtc)).toEqual({ allowed: true });

      // UTC Monday 13:00 -> Closed
      const nowUtcClosed = new Date('2026-08-17T13:00:00Z');
      expect(checkScheduleWindow(schedule, nowUtcClosed)).toEqual({ allowed: false, reason: 'window_closed' });
    });
  });

  describe('10. Stability, Determinism, & Reversibility (parsePortableCron)', () => {
    it('guarantees deterministic output across 100 consecutive invocations', () => {
      const config = {
        interval_minutes: 25,
        window_start: '09:00',
        window_end: '18:00',
        active_days: ['Mon', 'Wed', 'Fri'],
      };

      const expected = buildPortableCron(config);
      for (let i = 0; i < 100; i++) {
        expect(buildPortableCron(config)).toBe(expected);
      }
    });

    it('roundtrip: parses and reverses buildPortableCron output for standard intervals', () => {
      const testCases = [
        { interval_minutes: 20, window_start: '09:00', window_end: '17:00', active_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
        { interval_minutes: 25, window_start: '10:00', window_end: '14:00', active_days: ['Mon', 'Wed', 'Fri'] },
        { interval_minutes: 30, window_start: '08:00', window_end: '20:00', active_days: ['Sun', 'Sat'] },
        { interval_minutes: 36, window_start: '09:00', window_end: '21:00', active_days: null },
        { interval_minutes: 120, window_start: '08:00', window_end: '16:00', active_days: ['Mon', 'Tue'] },
      ];

      for (const tc of testCases) {
        const cron = buildPortableCron(tc);
        const parsed = parsePortableCron(cron);

        expect(parsed).toBeDefined();
        expect(parsed?.interval_minutes).toBe(tc.interval_minutes);
        expect(parsed?.window_start).toBe(tc.window_start);
        expect(parsed?.window_end).toBe(tc.window_end);

        if (tc.active_days) {
          const expectedDays = parseActiveDayNumbers(tc.active_days).map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]);
          expect(parsed?.active_days).toEqual(expectedDays);
        } else {
          expect(parsed?.active_days).toBeNull();
        }
      }
    });

    it('roundtrip: parses and reverses overnight windows (22:00 -> 06:00)', () => {
      const config = {
        interval_minutes: 30,
        window_start: '22:00',
        window_end: '06:00',
        active_days: ['Mon', 'Wed'],
      };

      const cron = buildPortableCron(config);
      const parsed = parsePortableCron(cron);

      expect(parsed?.interval_minutes).toBe(30);
      expect(parsed?.window_start).toBe('22:00');
      expect(parsed?.window_end).toBe('06:00');
      expect(parsed?.active_days).toEqual(['Mon', 'Wed']);
    });
  });
});
