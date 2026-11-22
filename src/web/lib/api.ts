/**
 * The one way the app talks to the API. Same origin, so the HttpOnly session cookie travels by
 * itself and the server's Origin check passes; errors arrive in the API's { error: { code, message } }
 * shape and are thrown as ApiError so screens can show the message and branch on the code.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: {
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? 'POST' } : {}),
  });
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, error?.code ?? 'unknown', error?.message ?? 'Something went wrong.');
  }
  return body as T;
}
