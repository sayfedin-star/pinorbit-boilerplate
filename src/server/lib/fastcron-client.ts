export const FASTCRON_BASE = 'https://www.fastcron.com/api/v1';

export interface FastCronCallResponse {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Robust FastCron API Client.
 * Strategy:
 * 1. Primary: POST JSON body with 8s timeout.
 * 2. Fallback: On 404/405, fallback to GET query-string.
 * 3. Surface status codes and error messages verbatim.
 */
export async function fastcronCall(
  action: string,
  params: Record<string, any>,
  token: string
): Promise<FastCronCallResponse> {
  const url = `${FASTCRON_BASE}/${action}`;
  const payload = { token, ...params };

  try {
    let res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });

    if (res.status === 404 || res.status === 405) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined && value !== null) {
          searchParams.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
      }
      res = await fetch(`${url}?${searchParams.toString()}`, {
        method: 'GET',
        signal: AbortSignal.timeout(8000),
      });
    }

    let data: any = {};
    const contentType = res.headers?.get ? (res.headers.get('content-type') || '') : '';
    if (contentType.includes('text/html')) {
      const rawText = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
      console.error(`[FastCron Client] Non-JSON HTML response (HTTP ${res.status}):`, rawText.slice(0, 400));
      data = { message: `FastCron HTTP ${res.status}: ${rawText.slice(0, 200).replace(/\s+/g, ' ').trim()}` };
    } else {
      try {
        data = await res.json();
      } catch {
        const rawText = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
        data = rawText ? { message: `FastCron HTTP ${res.status}: ${rawText.slice(0, 200).replace(/\s+/g, ' ').trim()}` } : {};
      }
    }

    if (
      data.status === 'OK' ||
      data.status === 'success' ||
      data.id ||
      data?.data?.id ||
      Array.isArray(data) ||
      Array.isArray(data?.data)
    ) {
      return { success: true, data };
    }

    const errorMsg =
      data.message ||
      data.error ||
      data.err_message ||
      (typeof data === 'string' && data.length > 0 ? data : `FastCron returned HTTP ${res.status}`);

    return { success: false, data, error: errorMsg };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'FastCron network request failed',
    };
  }
}

/**
 * Accurately determines if a FastCron job is paused/disabled.
 * FastCron API semantics:
 * - status: 0 or "0" or "enabled" or "active" or "UP" or "OK" -> Active / Running (paused: false)
 * - status: 1 or "1" or "disabled" or "paused" -> Disabled / Paused (paused: true)
 * - paused: true or 1 or "1" -> Paused (paused: true)
 * - paused: false or 0 or "0" -> Active (paused: false)
 */
export function isFastCronJobPaused(job: any): boolean {
  if (!job) return false;

  // 1. Explicit paused property
  if (job.paused === true || job.paused === 1 || job.paused === '1') return true;
  if (job.paused === false || job.paused === 0 || job.paused === '0') return false;

  // 2. String status property
  if (typeof job.status === 'string') {
    const s = job.status.toLowerCase().trim();
    if (s === 'disabled' || s === 'paused' || s === '1') return true;
    if (s === 'enabled' || s === 'active' || s === '0' || s === 'up' || s === 'ok') return false;
  }

  // 3. Numeric status property
  if (typeof job.status === 'number') {
    if (job.status === 1) return true;
    if (job.status === 0) return false;
  }

  // 4. Enabled boolean property
  if (typeof job.enabled === 'boolean') {
    return !job.enabled;
  }

  return false;
}

