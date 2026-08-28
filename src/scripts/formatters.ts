/**
 * Centralized formatting helpers for PinOrbit Analytics (V36)
 * Rates are fractions (e.g. 0.0564 -> "5.64%") via Intl percent.
 * Division is guarded against zero impressions.
 */

export function formatNum(n: number | null | undefined): string {
  const num = Number(n);
  return new Intl.NumberFormat('en-US').format(Number.isFinite(num) ? num : 0);
}

export function formatPct(n: number | null | undefined): string {
  const num = Number(n);
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(num) ? num : 0);
}

export function fmtMetric(count: number | null | undefined, rate?: number | null): string {
  const c = Number(count);
  if (rate === null || rate === undefined) {
    return formatNum(Number.isFinite(c) ? c : 0);
  }
  const r = Number(rate);
  return `${formatNum(Number.isFinite(c) ? c : 0)} (${formatPct(Number.isFinite(r) ? r : 0)})`;
}

export function escapeHtml(str: string | null | undefined): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export { fmtAuditTimestamp, fmtDuration } from '../lib/format-audit';
export type { AuditTimestampResult, AuditTimestampOptions } from '../lib/format-audit';

