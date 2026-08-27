export interface CreateJobParams {
  name: string;
  expression: string;
  timezone?: string;
  url: string;
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string> | string;
  payload?: Record<string, any> | string;
  notify?: boolean;
  timeout?: number;
  instances?: number;
  delay?: number;
  randomDelay?: number;
  status?: 'enabled' | 'disabled';
}

export interface UpdateJobParams {
  name?: string;
  expression?: string;
  timezone?: string;
  url?: string;
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string> | string;
  payload?: Record<string, any> | string;
  notify?: boolean;
  timeout?: number;
  instances?: number;
  delay?: number;
  randomDelay?: number;
  status?: 'enabled' | 'disabled';
  enabled?: boolean;
}

export interface CronJob {
  id: string | number;
  name: string;
  expression: string;
  timezone: string;
  url: string;
  status: 'enabled' | 'disabled' | 'paused';
  enabled: boolean;
  nextRun?: number | string | null;
  lastRun?: number | string | null;
  lastStatus?: string | null;
  lastHttpCode?: number | null;
  postData?: any;
  raw?: any;
}

export interface CronLog {
  date: string;
  http_status?: number | string | null;
  status?: string;
  output?: string;
  response_time?: number;
  raw?: any;
}

export interface ProviderResult<T = any> {
  success: boolean;
  id?: string;
  data?: T;
  error?: string;
  raw?: any;
}

export interface CronProvider {
  readonly providerName: 'fastcron' | 'cronjoborg';

  create(params: CreateJobParams): Promise<ProviderResult<{ id: string }>>;
  update(id: string | number, patch: UpdateJobParams): Promise<ProviderResult<{ id: string }>>;
  remove(id: string | number): Promise<ProviderResult>;
  triggerNow(id: string | number, payload?: Record<string, any>): Promise<ProviderResult>;
  list(keyword?: string): Promise<ProviderResult<{ jobs: CronJob[] }>>;
  get(id: string | number): Promise<ProviderResult<{ job: CronJob }>>;
  logs(id: string | number): Promise<ProviderResult<{ logs: CronLog[] }>>;
  next(id: string | number): Promise<ProviderResult<{ next: Array<string | number> }>>;
  enable(id: string | number): Promise<ProviderResult>;
  disable(id: string | number): Promise<ProviderResult>;
}
