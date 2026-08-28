import { describe, it, expect } from 'vitest';
import { fmtAuditTimestamp, fmtDuration } from '../format-audit';

describe('fmtAuditTimestamp & fmtDuration Suite', () => {
  describe('fmtAuditTimestamp', () => {
    it('handles ISO UTC timestamps correctly with two-line output', () => {
      const iso = '2026-08-28T04:54:40.000Z';
      const res = fmtAuditTimestamp(iso, { timezone: 'UTC' });

      expect(res.isValid).toBe(true);
      expect(res.line1).toContain('Aug 28');
      expect(res.line1).toContain('4:54:40 AM');
      expect(res.line2utc).toBe('Aug 28, 04:54:40 UTC');
      expect(res.html).toContain('Aug 28, 4:54:40 AM');
      expect(res.html).toContain('Aug 28, 04:54:40 UTC');
    });

    it('supports custom workspace timezone (e.g. America/New_York) with correct overnight shift', () => {
      // 04:54:40 UTC is 00:54:40 EDT (same date) or in Tokyo 13:54:40 JST
      const iso = '2026-08-28T04:54:40.000Z';
      const res = fmtAuditTimestamp(iso, { timezone: 'Asia/Tokyo' });

      expect(res.isValid).toBe(true);
      expect(res.line1).toContain('Aug 28');
      expect(res.line1).toContain('1:54:40 PM');
      expect(res.line2utc).toBe('Aug 28, 04:54:40 UTC');
    });

    it('supports numeric epoch timestamp input (ms and seconds)', () => {
      const ms = 1787929977000;
      const resMs = fmtAuditTimestamp(ms, { timezone: 'UTC' });
      expect(resMs.isValid).toBe(true);
      expect(resMs.line2utc).toContain('UTC');

      const sec = 1787929977;
      const resSec = fmtAuditTimestamp(sec, { timezone: 'UTC' });
      expect(resSec.isValid).toBe(true);
      expect(resSec.line2utc).toContain('UTC');
    });

    it('returns fail-lazy fallback on null, undefined, or invalid date string', () => {
      const nullRes = fmtAuditTimestamp(null);
      expect(nullRes.isValid).toBe(false);
      expect(nullRes.line1).toBe('—');
      expect(nullRes.line2utc).toBe('');
      expect(nullRes.html).toContain('—');

      const undefRes = fmtAuditTimestamp(undefined);
      expect(undefRes.isValid).toBe(false);
      expect(undefRes.line1).toBe('—');

      const badRes = fmtAuditTimestamp('invalid-date-string');
      expect(badRes.isValid).toBe(false);
      expect(badRes.line1).toBe('—');
    });

    it('renders one_line_tz mode with explicit timezone badge', () => {
      const iso = '2026-08-28T04:54:40.000Z';
      const res = fmtAuditTimestamp(iso, { timezone: 'UTC', mode: 'one_line_tz' });
      expect(res.isValid).toBe(true);
      expect(res.full).toContain('UTC');
      expect(res.html).toContain('(UTC)');
      expect(res.html).not.toContain('<div class="flex flex-col');
    });
  });

  describe('fmtDuration', () => {
    it('formats sub-minute durations in seconds', () => {
      const start = '2026-08-28T04:00:00.000Z';
      const end = '2026-08-28T04:00:12.000Z';
      expect(fmtDuration(start, end)).toBe('12s');
    });

    it('formats multi-minute durations in minutes and padded seconds', () => {
      const start = '2026-08-28T04:00:00.000Z';
      const end = '2026-08-28T04:01:05.000Z';
      expect(fmtDuration(start, end)).toBe('1m 05s');

      const end2 = '2026-08-28T04:15:30.000Z';
      expect(fmtDuration(start, end2)).toBe('15m 30s');
    });

    it('formats multi-hour durations in hours and minutes', () => {
      const start = '2026-08-28T02:00:00.000Z';
      const end = '2026-08-28T04:15:00.000Z';
      expect(fmtDuration(start, end)).toBe('2h 15m');
    });

    it('returns "—" for missing, invalid, or reversed timestamps', () => {
      expect(fmtDuration(null, '2026-08-28T04:00:00.000Z')).toBe('—');
      expect(fmtDuration('2026-08-28T04:00:00.000Z', null)).toBe('—');
      expect(fmtDuration('bad-start', '2026-08-28T04:00:00.000Z')).toBe('—');
      expect(fmtDuration('2026-08-28T04:00:00.000Z', '2026-08-28T03:00:00.000Z')).toBe('—');
    });
  });
});
