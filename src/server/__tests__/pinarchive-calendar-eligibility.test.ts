import { describe, it, expect } from 'vitest';
import { checkCalendarEligibility, computeNextRunDate } from '../../../scripts/pinarchive-discovery.mjs';

describe('PinArchive Calendar-Aligned Eligibility (Tier 1)', () => {
  it('is eligible for any run on the next day when interval=1d (even if arriving early)', () => {
    // Processed on 2026-09-02 at 12:26:51 UTC
    const acc = {
      username: 'charandcoall',
      last_run_at: '2026-09-02T12:26:51.797Z',
      interval_days: 1,
    };

    // Runner arrives on 2026-09-03 (regardless of time, e.g. 07:00 UTC or 12:20 UTC)
    const result = checkCalendarEligibility(acc, '2026-09-03');
    expect(result.isEligible).toBe(true);
    expect(result.dayDiff).toBe(1);
    expect(result.intervalDays).toBe(1);
    expect(result.isSelfHeal).toBe(false);
  });

  it('skips when a second run arrives on the same UTC day (prevents double processing)', () => {
    // Processed on 2026-09-02 at 07:00:00 UTC
    const acc = {
      username: 'everydayeatskitchen',
      last_run_at: '2026-09-02T07:00:00.000Z',
      interval_days: 1,
    };

    // Second run arrives on the same UTC day 2026-09-02 at 12:20 UTC
    const result = checkCalendarEligibility(acc, '2026-09-02');
    expect(result.isEligible).toBe(false);
    expect(result.dayDiff).toBe(0);
    expect(result.intervalDays).toBe(1);
  });

  it('self-heals and marks eligible when last_run_at is stale (e.g. 3 days ago with interval=1d)', () => {
    // Processed 3 days ago on 2026-08-30
    const acc = {
      username: 'stelbftwinn',
      last_run_at: '2026-08-30T10:00:00.000Z',
      interval_days: 1,
    };

    const result = checkCalendarEligibility(acc, '2026-09-02');
    expect(result.isEligible).toBe(true);
    expect(result.dayDiff).toBe(3);
    expect(result.isSelfHeal).toBe(true);
  });

  it('honors 3-day interval correctly across intermediate days', () => {
    // Processed on 2026-09-01
    const acc = {
      username: 'cicisentiafarida',
      last_run_at: '2026-09-01T12:30:25.000Z',
      interval_days: 3,
    };

    // Day 1 (2026-09-02) -> diff=1 < 3 -> skip
    const day1 = checkCalendarEligibility(acc, '2026-09-02');
    expect(day1.isEligible).toBe(false);
    expect(day1.dayDiff).toBe(1);

    // Day 2 (2026-09-03) -> diff=2 < 3 -> skip
    const day2 = checkCalendarEligibility(acc, '2026-09-03');
    expect(day2.isEligible).toBe(false);
    expect(day2.dayDiff).toBe(2);

    // Day 3 (2026-09-04) -> diff=3 >= 3 -> eligible
    const day3 = checkCalendarEligibility(acc, '2026-09-04');
    expect(day3.isEligible).toBe(true);
    expect(day3.dayDiff).toBe(3);
  });

  it('treats accounts with null last_run_at as immediately eligible', () => {
    const acc = {
      username: 'newaccount',
      last_run_at: null,
      interval_days: 1,
    };

    const result = checkCalendarEligibility(acc, '2026-09-03');
    expect(result.isEligible).toBe(true);
    expect(result.dayDiff).toBe(Infinity);
  });

  it('computes calendar-aligned next_run_at anchored at UTC midnight without 0-index month bug', () => {
    // September date: 2026-09-02 + 1d = 2026-09-03T00:00:00.000Z
    const next1d = computeNextRunDate('2026-09-02', 1);
    expect(next1d).toBe('2026-09-03T00:00:00.000Z');

    // Multi-day interval: 2026-09-02 + 3d = 2026-09-05T00:00:00.000Z
    const next3d = computeNextRunDate('2026-09-02', 3);
    expect(next3d).toBe('2026-09-05T00:00:00.000Z');

    // Month rollover: 2026-09-30 + 1d = 2026-10-01T00:00:00.000Z
    const rollover = computeNextRunDate('2026-09-30', 1);
    expect(rollover).toBe('2026-10-01T00:00:00.000Z');
  });
});
