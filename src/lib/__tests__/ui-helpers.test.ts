import { describe, it, expect } from 'vitest';
import { escapeHtml, formatDate, formatNumber, formatTime, maskWebhookUrl, renderStatusBadge } from '../ui-helpers';

describe('ui-helpers test suite', () => {
  describe('escapeHtml', () => {
    it('escapes HTML special characters and script tags', () => {
      const input = '<script>alert("XSS & attack");</script>';
      const expected = '&lt;script&gt;alert(&quot;XSS &amp; attack&quot;);&lt;/script&gt;';
      expect(escapeHtml(input)).toBe(expected);
    });

    it('escapes single quotes', () => {
      expect(escapeHtml("'hello'")).toBe('&#039;hello&#039;');
    });

    it('handles empty strings and nullish inputs', () => {
      expect(escapeHtml('')).toBe('');
      expect(escapeHtml(null as any)).toBe('');
      expect(escapeHtml(undefined as any)).toBe('');
    });
  });

  describe('formatDate & formatTime', () => {
    it('formats valid ISO date strings', () => {
      const iso = '2026-08-05T12:00:00Z';
      expect(formatDate(iso)).not.toBe('-');
      expect(formatTime(iso)).not.toBe('-');
    });

    it('handles null, undefined, and empty string gracefully', () => {
      expect(formatDate(null)).toBe('-');
      expect(formatDate(undefined)).toBe('-');
      expect(formatDate('')).toBe('-');

      expect(formatTime(null)).toBe('-');
      expect(formatTime(undefined)).toBe('-');
      expect(formatTime('')).toBe('-');
    });

    it('handles invalid date strings gracefully', () => {
      expect(formatDate('invalid-date-string')).toBe('-');
      expect(formatTime('invalid-date-string')).toBe('-');
    });
  });

  describe('maskWebhookUrl', () => {
    it('masks full webhook URL secrets while retaining origin', () => {
      const input = 'https://hook.make.com/abc123healthy1';
      const masked = maskWebhookUrl(input);
      expect(masked).toContain('https://hook.make.com');
      expect(masked).toContain('••••');
      expect(masked).not.toBe(input);
    });

    it('handles short URL paths safely', () => {
      const input = 'https://example.com/a';
      const masked = maskWebhookUrl(input);
      expect(masked).toBe('https://example.com/••••••••');
    });

    it('handles non-URL invalid strings', () => {
      expect(maskWebhookUrl('shortsecret')).toBe('••••••••');
      expect(maskWebhookUrl('longsecretkeywithcharacters')).toContain('••••');
    });

    it('handles null and undefined', () => {
      expect(maskWebhookUrl(null)).toBe('-');
      expect(maskWebhookUrl(undefined)).toBe('-');
    });
  });

  describe('renderStatusBadge', () => {
    it('renders badge for pending, posted, failed, and processing statuses', () => {
      const pending = renderStatusBadge('pending');
      expect(pending).toContain('bg-amber-500');
      expect(pending).toContain('Pending');

      const posted = renderStatusBadge('posted');
      expect(posted).toContain('bg-emerald-500');
      expect(posted).toContain('Posted');

      const failed = renderStatusBadge('failed');
      expect(failed).toContain('bg-rose-500');
      expect(failed).toContain('Failed');

      const processing = renderStatusBadge('processing');
      expect(processing).toContain('bg-sky-500');
      expect(processing).toContain('Processing');
    });

    it('sanitizes custom labels in badges against XSS', () => {
      const customLabel = '<img src=x onerror=alert(1)>';
      const rendered = renderStatusBadge('pending', customLabel);
      expect(rendered).not.toContain('<img');
      expect(rendered).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });
  });

  describe('formatNumber', () => {
    it('formats numbers with commas and avoids compact M/k notation', () => {
      expect(formatNumber(4256456)).toBe('4,256,456');
      expect(formatNumber(1450)).toBe('1,450');
      expect(formatNumber(0)).toBe('0');
    });

    it('formats null, undefined, and NaN as 0', () => {
      expect(formatNumber(null)).toBe('0');
      expect(formatNumber(undefined)).toBe('0');
      expect(formatNumber(NaN)).toBe('0');
    });
  });

  describe('safeFetchJson', () => {
    it('returns parsed JSON when response is ok and application/json', async () => {
      const mockData = { success: true, data: [1, 2, 3] };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(JSON.stringify(mockData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const { safeFetchJson } = await import('../ui-helpers');
      const result = await safeFetchJson('https://api.example.com/test');
      expect(result).toEqual(mockData);
      globalThis.fetch = originalFetch;
    });

    it('throws 404 redeploy required message on 404 response', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response('Not found HTML', {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        });

      const { safeFetchJson } = await import('../ui-helpers');
      await expect(safeFetchJson('https://api.example.com/not-found')).rejects.toThrow(
        'HTTP 404: Endpoint unavailable - redeploy required'
      );
      globalThis.fetch = originalFetch;
    });

    it('throws non-JSON error when response is not application/json', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response('<html>Bad Gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        });

      const { safeFetchJson } = await import('../ui-helpers');
      await expect(safeFetchJson('https://api.example.com/error')).rejects.toThrow(
        'HTTP 502: Server returned non-JSON response'
      );
      globalThis.fetch = originalFetch;
    });
  });

  describe('humanCron & humanCronTitle', () => {
    it('formats 5-part daily cron expressions with minute and hour correctly', async () => {
      const { humanCron, humanCronTitle } = await import('../ui-helpers');
      expect(humanCronTitle('11 15 * * *', 'UTC')).toBe('Daily at 15:11 UTC');
      expect(humanCronTitle('14 15 * * *', 'UTC')).toBe('Daily at 15:14 UTC');
      expect(humanCronTitle('0 2 * * *', 'UTC')).toBe('Daily at 02:00 UTC');
      expect(humanCron('11 15 * * *', 'UTC')).toContain('Daily at 15:11 UTC');
      expect(humanCron('11 15 * * *', 'UTC')).toContain('1/day, 7/week');
    });
  });
});
