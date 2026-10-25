export interface AuthUser {
  id: string;
  email: string;
  provider: 'email' | 'google';
}

export interface AuthCapabilities {
  email: boolean;
  google: boolean;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public retryAfter = 0) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Cookies stay on this origin; account credentials never enter browser storage. */
export async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', extraHeaders: Record<string, string> = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result: unknown = await response.json().catch(() => null);
    const payload = result !== null && typeof result === 'object' ? result as Record<string, unknown> : {};
    if (!response.ok) {
      const retryAfter = Number(payload.retryAfter ?? response.headers.get('Retry-After'));
      throw new ApiError(
        typeof payload.error === 'string' ? payload.error : '账号服务暂时无法连接，请稍后再试。',
        response.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0,
      );
    }
    if (result === null) throw new ApiError('账号服务暂时无法连接，进度仍会保存在当前浏览器。', 503);
    return result as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(controller.signal.aborted
      ? '连接超时了，请稍后再试。进度仍会保存在当前浏览器。'
      : '暂时无法连接账号服务，请检查网络后再试。', 0);
  } finally {
    clearTimeout(timeout);
  }
}
