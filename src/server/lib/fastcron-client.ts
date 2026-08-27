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

    const data = await res.json().catch(() => ({}));

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
