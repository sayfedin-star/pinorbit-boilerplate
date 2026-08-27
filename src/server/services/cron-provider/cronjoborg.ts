import type {
  CronProvider,
  CreateJobParams,
  UpdateJobParams,
  CronJob,
  CronLog,
  ProviderResult,
} from './provider';

const CRONJOB_API_BASE = 'https://api.cron-job.org';

const METHOD_MAP: Record<string, number> = {
  GET: 0,
  POST: 1,
  HEAD: 2,
  PUT: 3,
  DELETE: 4,
  PATCH: 5,
  OPTIONS: 6,
};

function parseRangeOrList(field: string, min: number, max: number): number[] {
  if (!field || field === '*') return [-1];
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) return [-1];
    const res: number[] = [];
    for (let i = min; i <= max; i += step) res.push(i);
    return res.length > 0 ? res : [-1];
  }
  const parts = field.split(',');
  const numbers = new Set<number>();
  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.max(min, start); i <= Math.min(max, end); i++) numbers.add(i);
      }
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num) && num >= min && num <= max) numbers.add(num);
    }
  }
  return numbers.size > 0 ? Array.from(numbers).sort((a, b) => a - b) : [-1];
}

export function cronExpressionToCronJobOrgSchedule(expr: string, timezone: string = 'UTC') {
  const parts = (expr || '').trim().split(/\s+/);
  const minField = parts[0] || '0';
  const hourField = parts[1] || '0';
  const domField = parts[2] || '*';
  const monField = parts[3] || '*';
  const dowField = parts[4] || '*';

  return {
    timezone: timezone || 'UTC',
    minutes: parseRangeOrList(minField, 0, 59),
    hours: parseRangeOrList(hourField, 0, 23),
    mdays: parseRangeOrList(domField, 1, 31),
    months: parseRangeOrList(monField, 1, 12),
    wdays: parseRangeOrList(dowField, 0, 6),
  };
}

function normalizeHeaders(headers?: Record<string, string> | string): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (typeof headers === 'object') return headers;
  const result: Record<string, string> = {};
  const lines = headers.split(/\r?\n/);
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const k = line.slice(0, colonIdx).trim();
      const v = line.slice(colonIdx + 1).trim();
      if (k) result[k] = v;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export class CronJobOrgProvider implements CronProvider {
  readonly providerName = 'cronjoborg' as const;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey.trim();
  }

  private async request(path: string, options: RequestInit = {}): Promise<{ status: number; ok: boolean; data: any; error?: string }> {
    const url = `${CRONJOB_API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    try {
      const res = await fetch(url, {
        ...options,
        headers,
        signal: AbortSignal.timeout(8000),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errorMsg = data?.error?.message || data?.message || data?.error || `cron-job.org HTTP ${res.status}`;
        return { status: res.status, ok: false, data, error: errorMsg };
      }
      return { status: res.status, ok: true, data };
    } catch (err: any) {
      return {
        status: 0,
        ok: false,
        data: {},
        error: err.message || 'cron-job.org network request failed',
      };
    }
  }

  async create(params: CreateJobParams): Promise<ProviderResult<{ id: string }>> {
    const schedule = cronExpressionToCronJobOrgSchedule(params.expression, params.timezone);
    const methodNum = METHOD_MAP[params.httpMethod || 'POST'] ?? 1;
    const headersObj = normalizeHeaders(params.headers);
    const bodyStr = typeof params.payload === 'object' ? JSON.stringify(params.payload) : params.payload;

    const jobPayload: Record<string, any> = {
      title: params.name,
      url: params.url,
      enabled: params.status !== 'disabled',
      saveResponses: true,
      schedule,
      requestMethod: methodNum,
    };

    if (headersObj || bodyStr) {
      jobPayload.extendedData = {};
      if (headersObj) jobPayload.extendedData.headers = headersObj;
      if (bodyStr) jobPayload.extendedData.body = bodyStr;
    }

    const res = await this.request('/jobs', {
      method: 'PUT',
      body: JSON.stringify({ job: jobPayload }),
    });

    if (!res.ok) {
      return { success: false, error: res.error, raw: res.data };
    }

    const jobId = String(res.data?.jobId || res.data?.job?.jobId || res.data?.id || '');
    return {
      success: true,
      id: jobId,
      data: { id: jobId },
      raw: res.data,
    };
  }

  async update(id: string | number, patch: UpdateJobParams): Promise<ProviderResult<{ id: string }>> {
    const jobPayload: Record<string, any> = {};

    if (patch.name !== undefined) jobPayload.title = patch.name;
    if (patch.url !== undefined) jobPayload.url = patch.url;
    if (patch.enabled !== undefined) jobPayload.enabled = patch.enabled;
    if (patch.status !== undefined) jobPayload.enabled = patch.status === 'enabled';

    if (patch.expression !== undefined || patch.timezone !== undefined) {
      const expr = patch.expression || '0 0 * * *';
      jobPayload.schedule = cronExpressionToCronJobOrgSchedule(expr, patch.timezone);
    }

    if (patch.httpMethod !== undefined) {
      jobPayload.requestMethod = METHOD_MAP[patch.httpMethod] ?? 1;
    }

    if (patch.headers !== undefined || patch.payload !== undefined) {
      jobPayload.extendedData = {};
      if (patch.headers !== undefined) {
        jobPayload.extendedData.headers = normalizeHeaders(patch.headers);
      }
      if (patch.payload !== undefined) {
        jobPayload.extendedData.body = typeof patch.payload === 'object' ? JSON.stringify(patch.payload) : patch.payload;
      }
    }

    const res = await this.request(`/jobs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ job: jobPayload }),
    });

    if (!res.ok) {
      return { success: false, error: res.error, raw: res.data };
    }

    return {
      success: true,
      id: String(id),
      data: { id: String(id) },
      raw: res.data,
    };
  }

  async remove(id: string | number): Promise<ProviderResult> {
    const res = await this.request(`/jobs/${id}`, {
      method: 'DELETE',
    });

    return {
      success: res.ok,
      error: res.error,
      raw: res.data,
    };
  }

  async triggerNow(id: string | number): Promise<ProviderResult> {
    const res = await this.request(`/jobs/${id}/run`, {
      method: 'POST',
    });

    return {
      success: res.ok,
      error: res.error,
      raw: res.data,
    };
  }

  async list(keyword?: string): Promise<ProviderResult<{ jobs: CronJob[] }>> {
    const res = await this.request('/jobs', { method: 'GET' });
    if (!res.ok) {
      return { success: false, error: res.error, raw: res.data };
    }

    const rawJobs: any[] = Array.isArray(res.data?.jobs) ? res.data.jobs : [];
    let filtered = rawJobs;
    if (keyword) {
      const q = keyword.toLowerCase();
      filtered = rawJobs.filter((j) => (j.title || '').toLowerCase().includes(q) || (j.url || '').toLowerCase().includes(q));
    }

    const jobs: CronJob[] = filtered.map((j) => {
      const isEnabled = Boolean(j.enabled);
      return {
        id: String(j.jobId || j.id),
        name: j.title || '',
        expression: j.schedule ? `${j.schedule.minutes?.[0] ?? '*'} ${j.schedule.hours?.[0] ?? '*'} * * *` : '',
        timezone: j.schedule?.timezone || 'UTC',
        url: j.url || '',
        status: isEnabled ? 'enabled' : 'disabled',
        enabled: isEnabled,
        nextRun: j.nextExecution ? j.nextExecution * 1000 : null,
        lastRun: j.lastExecution ? j.lastExecution * 1000 : null,
        lastStatus: j.lastStatus === 1 ? 'OK' : (j.lastStatus === 2 ? 'ERROR' : null),
        lastHttpCode: j.lastDuration || null,
        raw: j,
      };
    });

    return {
      success: true,
      data: { jobs },
      raw: res.data,
    };
  }

  async get(id: string | number): Promise<ProviderResult<{ job: CronJob }>> {
    const res = await this.request(`/jobs/${id}`, { method: 'GET' });
    if (!res.ok) {
      return { success: false, error: res.error, raw: res.data };
    }

    const j = res.data?.jobDetails || res.data?.job || res.data;
    if (!j) {
      return { success: false, error: 'Job not found', raw: res.data };
    }

    const isEnabled = Boolean(j.enabled);
    const job: CronJob = {
      id: String(j.jobId || j.id || id),
      name: j.title || '',
      expression: j.schedule ? `${j.schedule.minutes?.[0] ?? '*'} ${j.schedule.hours?.[0] ?? '*'} * * *` : '',
      timezone: j.schedule?.timezone || 'UTC',
      url: j.url || '',
      status: isEnabled ? 'enabled' : 'disabled',
      enabled: isEnabled,
      nextRun: j.nextExecution ? j.nextExecution * 1000 : null,
      lastRun: j.lastExecution ? j.lastExecution * 1000 : null,
      lastStatus: j.lastStatus === 1 ? 'OK' : (j.lastStatus === 2 ? 'ERROR' : null),
      postData: j.extendedData?.body ? JSON.parse(j.extendedData.body).catch?.(() => j.extendedData.body) : null,
      raw: j,
    };

    return {
      success: true,
      data: { job },
      raw: res.data,
    };
  }

  async logs(id: string | number): Promise<ProviderResult<{ logs: CronLog[] }>> {
    const res = await this.request(`/jobs/${id}/history`, { method: 'GET' });
    if (!res.ok) {
      return { success: false, error: res.error, raw: res.data };
    }

    const rawHistory: any[] = Array.isArray(res.data?.history) ? res.data.history : [];
    const logs: CronLog[] = rawHistory.map((h) => ({
      date: h.executedAt ? new Date(h.executedAt * 1000).toISOString() : new Date().toISOString(),
      http_status: h.httpStatus || null,
      status: h.status === 1 ? 'OK' : 'ERROR',
      output: h.body || '',
      response_time: h.duration || null,
      raw: h,
    }));

    return {
      success: true,
      data: { logs },
      raw: res.data,
    };
  }

  async next(id: string | number): Promise<ProviderResult<{ next: Array<string | number> }>> {
    const getRes = await this.get(id);
    if (!getRes.success || !getRes.data?.job?.nextRun) {
      return { success: true, data: { next: [] } };
    }
    return {
      success: true,
      data: { next: [getRes.data.job.nextRun] },
    };
  }

  async enable(id: string | number): Promise<ProviderResult> {
    return this.update(id, { enabled: true });
  }

  async disable(id: string | number): Promise<ProviderResult> {
    return this.update(id, { enabled: false });
  }
}
