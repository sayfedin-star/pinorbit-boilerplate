import { fastcronCall, isFastCronJobPaused } from '../../lib/fastcron-client';
import type {
  CronProvider,
  CreateJobParams,
  UpdateJobParams,
  CronJob,
  CronLog,
  ProviderResult,
} from './provider';

function formatHeaders(headers?: Record<string, string> | string): string | undefined {
  if (!headers) return undefined;
  if (typeof headers === 'string') return headers;
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
}

function formatPayload(payload?: Record<string, any> | string): string | undefined {
  if (!payload) return undefined;
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload);
}

function parsePostData(raw: any): any {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class FastCronProvider implements CronProvider {
  readonly providerName = 'fastcron' as const;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey.trim();
  }

  async create(params: CreateJobParams): Promise<ProviderResult<{ id: string }>> {
    const postData = formatPayload(params.payload);
    const httpHeaders = formatHeaders(params.headers);

    const payload: Record<string, any> = {
      name: params.name,
      expression: params.expression,
      timezone: params.timezone || 'UTC',
      url: params.url,
      httpMethod: params.httpMethod || 'POST',
      http_method: params.httpMethod || 'POST',
      instances: params.instances ?? 1,
      notify: params.notify ?? true,
      timeout: params.timeout ?? 30,
    };

    if (httpHeaders) {
      payload.httpHeaders = httpHeaders;
      payload.http_headers = httpHeaders;
    }
    if (postData) {
      payload.postData = postData;
      payload.post_data = postData;
    }
    if (params.delay || params.randomDelay) {
      payload.delay = params.delay ?? params.randomDelay;
      payload.random_delay = params.randomDelay ?? params.delay;
    }
    if (params.status) {
      payload.status = params.status;
    }

    let res = await fastcronCall('cron_add', payload, this.apiKey);

    // Fallback retry without delay fields if FastCron rejected delay syntax
    if (!res.success && (payload.delay || payload.random_delay)) {
      delete payload.delay;
      delete payload.random_delay;
      res = await fastcronCall('cron_add', payload, this.apiKey);
    }

    if (!res.success) {
      return { success: false, error: res.error, raw: res.data };
    }

    const id = res.data?.id ?? res.data?.data?.id ?? (Array.isArray(res.data?.ids) ? res.data.ids[0] : null);
    return {
      success: true,
      id: id ? String(id) : undefined,
      data: { id: String(id) },
      raw: res.data,
    };
  }

  async update(id: string | number, patch: UpdateJobParams): Promise<ProviderResult<{ id: string }>> {
    const payload: Record<string, any> = { id: Number(id) || id };

    if (patch.name !== undefined) payload.name = patch.name;
    if (patch.expression !== undefined) payload.expression = patch.expression;
    if (patch.timezone !== undefined) payload.timezone = patch.timezone;
    if (patch.url !== undefined) payload.url = patch.url;
    if (patch.httpMethod !== undefined) {
      payload.httpMethod = patch.httpMethod;
      payload.http_method = patch.httpMethod;
    }
    if (patch.headers !== undefined) {
      const h = formatHeaders(patch.headers);
      payload.httpHeaders = h;
      payload.http_headers = h;
    }
    if (patch.payload !== undefined) {
      const p = formatPayload(patch.payload);
      payload.postData = p;
      payload.post_data = p;
    }
    if (patch.instances !== undefined) payload.instances = patch.instances;
    if (patch.notify !== undefined) payload.notify = patch.notify;
    if (patch.timeout !== undefined) payload.timeout = patch.timeout;
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.enabled !== undefined) payload.status = patch.enabled ? 'enabled' : 'disabled';

    const res = await fastcronCall('cron_edit', payload, this.apiKey);
    if (!res.success) {
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
    const res = await fastcronCall('cron_delete', { id: Number(id) || id }, this.apiKey);
    return {
      success: res.success,
      error: res.error,
      raw: res.data,
    };
  }

  async triggerNow(id: string | number, payload?: Record<string, any>): Promise<ProviderResult> {
    const params: Record<string, any> = { id: Number(id) || id };
    if (payload) {
      params.postData = JSON.stringify(payload);
      params.post_data = JSON.stringify(payload);
    }
    const res = await fastcronCall('cron_run', params, this.apiKey);
    return {
      success: res.success,
      error: res.error,
      raw: res.data,
    };
  }

  async list(keyword?: string): Promise<ProviderResult<{ jobs: CronJob[] }>> {
    const params = keyword ? { keyword } : {};
    const res = await fastcronCall('cron_list', params, this.apiKey);
    if (!res.success) {
      return { success: false, error: res.error, raw: res.data };
    }

    const list: any[] = Array.isArray(res.data)
      ? res.data
      : Array.isArray(res.data?.data)
        ? res.data.data
        : Array.isArray(res.data?.jobs)
          ? res.data.jobs
          : [];

    const jobs: CronJob[] = list.map((j) => {
      const isPaused = isFastCronJobPaused(j);

      return {
        id: String(j.id),
        name: j.name || '',
        expression: j.expression || j.cron_expression || '',
        timezone: j.timezone || 'UTC',
        url: j.url || '',
        status: isPaused ? 'disabled' : 'enabled',
        enabled: !isPaused,
        nextRun: j.next_run_at || j.cron_next || null,
        lastRun: j.last_run_at || null,
        lastStatus: j.last_status || null,
        lastHttpCode: j.last_http_code || null,
        postData: parsePostData(j.post_data || j.postdata),
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
    const res = await fastcronCall('cron_get', { id: Number(id) || id }, this.apiKey);
    if (!res.success) {
      return { success: false, error: res.error, raw: res.data };
    }

    const j = res.data?.data || res.data?.job || res.data;
    if (!j) {
      return { success: false, error: 'Job not found', raw: res.data };
    }

    const isPaused = isFastCronJobPaused(j);

    const job: CronJob = {
      id: String(j.id),
      name: j.name || '',
      expression: j.expression || j.cron_expression || '',
      timezone: j.timezone || 'UTC',
      url: j.url || '',
      status: isPaused ? 'disabled' : 'enabled',
      enabled: !isPaused,
      nextRun: j.next_run_at || j.cron_next || null,
      lastRun: j.last_run_at || null,
      lastStatus: j.last_status || null,
      lastHttpCode: j.last_http_code || null,
      postData: parsePostData(j.post_data || j.postdata),
      raw: j,
    };

    return {
      success: true,
      data: { job },
      raw: res.data,
    };
  }

  async logs(id: string | number): Promise<ProviderResult<{ logs: CronLog[] }>> {
    const res = await fastcronCall('cron_logs', { id: Number(id) || id }, this.apiKey);
    if (!res.success) {
      return { success: false, error: res.error, raw: res.data };
    }

    const list: any[] = Array.isArray(res.data)
      ? res.data
      : Array.isArray(res.data?.data)
        ? res.data.data
        : Array.isArray(res.data?.logs)
          ? res.data.logs
          : Array.isArray(res.data?.data?.logs)
            ? res.data.data.logs
            : [];

    const logs: CronLog[] = list.map((l) => ({
      date: l.date || l.created_at || l.time || '',
      http_status: l.http_status ?? l.http_status_code ?? l.status_code ?? null,
      status: l.status || (l.http_status_code === 200 || l.http_status === 200 ? 'OK' : 'ERROR'),
      output: l.output || l.response || l.body || '',
      response_time: l.response_time ?? l.duration ?? null,
      raw: l,
    }));

    return {
      success: true,
      data: { logs },
      raw: res.data,
    };
  }

  async next(id: string | number): Promise<ProviderResult<{ next: Array<string | number> }>> {
    const res = await fastcronCall('cron_next', { id: Number(id) || id }, this.apiKey);
    if (!res.success) {
      return { success: false, error: res.error, raw: res.data };
    }

    const list: any[] = Array.isArray(res.data)
      ? res.data
      : Array.isArray(res.data?.data)
        ? res.data.data
        : Array.isArray(res.data?.next)
          ? res.data.next
          : [];

    return {
      success: true,
      data: { next: list },
      raw: res.data,
    };
  }

  async enable(id: string | number): Promise<ProviderResult> {
    const res = await fastcronCall('cron_enable', { id: Number(id) || id }, this.apiKey);
    return {
      success: res.success,
      error: res.error,
      raw: res.data,
    };
  }

  async disable(id: string | number): Promise<ProviderResult> {
    const res = await fastcronCall('cron_disable', { id: Number(id) || id }, this.apiKey);
    return {
      success: res.success,
      error: res.error,
      raw: res.data,
    };
  }
}
