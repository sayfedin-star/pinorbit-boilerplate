/**
 * Shared audit timestamp and duration formatters for PinOrbit (P1-P4).
 * Pure, client-safe, fail-lazy (never throws, returns fallback strings on bad inputs).
 */

export interface AuditTimestampResult {
  line1: string;      // Local date+time (or workspace timezone if provided)
  line2utc: string;   // UTC date+time with "UTC" suffix
  relative: string;   // Relative time e.g. "12m ago", "just now"
  full: string;       // Formatted combined string
  html: string;       // Standard two-line HTML component
  isValid: boolean;
}

export interface AuditTimestampOptions {
  timezone?: string | null;
  locale?: string;
}

/**
 * Escapes HTML entities for client-safe rendering.
 */
function esc(str: string | null | undefined): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format audit timestamp into two lines:
 * Line 1: Local / Workspace timezone date + time (e.g. "Aug 28, 4:54:40 AM")
 * Line 2: UTC date + time (e.g. "Aug 28, 03:54:40 UTC" or "03:54:40 UTC") + relative (e.g. "12m ago")
 */
export function fmtAuditTimestamp(
  iso: string | number | Date | null | undefined,
  opts?: AuditTimestampOptions
): AuditTimestampResult {
  if (!iso) {
    return {
      line1: '—',
      line2utc: '',
      relative: '',
      full: '—',
      html: '<span class="text-muted-foreground/60">—</span>',
      isValid: false,
    };
  }

  try {
    let d: Date;
    if (iso instanceof Date) {
      d = iso;
    } else if (typeof iso === 'number') {
      d = new Date(iso > 1e11 ? iso : iso * 1000);
    } else {
      const trimmed = String(iso).trim();
      if (!trimmed) {
        return {
          line1: '—',
          line2utc: '',
          relative: '',
          full: '—',
          html: '<span class="text-muted-foreground/60">—</span>',
          isValid: false,
        };
      }
      d = new Date(trimmed);
    }

    if (isNaN(d.getTime())) {
      return {
        line1: '—',
        line2utc: '',
        relative: '',
        full: '—',
        html: '<span class="text-muted-foreground/60">—</span>',
        isValid: false,
      };
    }

    const locale = opts?.locale || 'en-US';
    const tz = opts?.timezone && opts.timezone.trim() ? opts.timezone.trim() : undefined;

    // Line 1: Local or Workspace timezone
    let line1 = '';
    try {
      line1 = new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: tz,
      }).format(d);
    } catch {
      // Fallback if invalid timezone string passed
      line1 = new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      }).format(d);
    }

    // Line 2: UTC date + time
    const utcFormatted = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    }).format(d);
    const line2utc = `${utcFormatted} UTC`;

    // Relative calculation
    const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
    let relative = '';
    if (diffSec >= 0) {
      if (diffSec < 45) relative = 'just now';
      else if (diffSec < 3600) relative = `${Math.floor(diffSec / 60)}m ago`;
      else if (diffSec < 86400) relative = `${Math.floor(diffSec / 3600)}h ago`;
      else if (diffSec < 604800) relative = `${Math.floor(diffSec / 86400)}d ago`;
      else relative = `${Math.floor(diffSec / 604800)}w ago`;
    } else {
      const absSec = Math.abs(diffSec);
      if (absSec < 60) relative = 'in <1m';
      else if (absSec < 3600) relative = `in ${Math.floor(absSec / 60)}m`;
      else if (absSec < 86400) relative = `in ${Math.floor(absSec / 3600)}h`;
      else relative = `in ${Math.floor(absSec / 86400)}d`;
    }

    const full = `${line1} (${line2utc}${relative ? ` • ${relative}` : ''})`;

    const safeLine1 = esc(line1);
    const safeLine2Utc = esc(line2utc);
    const safeRelative = esc(relative);

    const html = `<div class="flex flex-col text-left">
  <span class="font-medium text-foreground text-xs leading-tight">${safeLine1}</span>
  <span class="text-[10px] text-muted-foreground font-mono leading-tight flex items-center gap-1 mt-0.5 whitespace-nowrap">
    <span>${safeLine2Utc}</span>
    ${safeRelative ? `<span class="opacity-40">•</span><span class="opacity-80 font-sans">${safeRelative}</span>` : ''}
  </span>
</div>`;

    return {
      line1,
      line2utc,
      relative,
      full,
      html,
      isValid: true,
    };
  } catch {
    return {
      line1: '—',
      line2utc: '',
      relative: '',
      full: '—',
      html: '<span class="text-muted-foreground/60">—</span>',
      isValid: false,
    };
  }
}

/**
 * Format duration between two timestamps.
 * Returns e.g. "12s", "1m 05s", "2h 15m", or "—".
 */
export function fmtDuration(
  startIso: string | number | Date | null | undefined,
  endIso: string | number | Date | null | undefined
): string {
  if (!startIso || !endIso) return '—';

  try {
    let start: number;
    let end: number;

    if (startIso instanceof Date) start = startIso.getTime();
    else if (typeof startIso === 'number') start = startIso > 1e11 ? startIso : startIso * 1000;
    else start = new Date(String(startIso).trim()).getTime();

    if (endIso instanceof Date) end = endIso.getTime();
    else if (typeof endIso === 'number') end = endIso > 1e11 ? endIso : endIso * 1000;
    else end = new Date(String(endIso).trim()).getTime();

    if (isNaN(start) || isNaN(end) || end < start) return '—';

    const diffMs = end - start;
    const totalSec = Math.floor(diffMs / 1000);

    if (totalSec < 60) {
      return `${totalSec}s`;
    }

    if (totalSec < 3600) {
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return `${m}m ${String(s).padStart(2, '0')}s`;
    }

    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}h ${m}m`;
  } catch {
    return '—';
  }
}
