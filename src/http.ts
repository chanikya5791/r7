/** Minimal HTTP client for the tests. Never throws on HTTP status; tests assert on it. */
export interface HttpResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
  durationMs: number;
}

export interface RequestOptions {
  token?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

export async function http<T = any>(method: string, url: string, opts: RequestOptions = {}): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined = opts.rawBody;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  if (opts.rawBody !== undefined) headers['content-type'] ??= 'application/json';
  const started = Date.now();
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // keep raw text
  }
  return { status: res.status, headers: res.headers, body: parsed as T, durationMs: Date.now() - started };
}

export const get = <T = any>(url: string, o?: RequestOptions) => http<T>('GET', url, o);
export const post = <T = any>(url: string, o?: RequestOptions) => http<T>('POST', url, o);
export const patch = <T = any>(url: string, o?: RequestOptions) => http<T>('PATCH', url, o);
export const del = <T = any>(url: string, o?: RequestOptions) => http<T>('DELETE', url, o);
