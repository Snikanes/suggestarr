export class ArrApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'ArrApiError';
  }
}

export interface ArrEndpoint {
  baseUrl: string;
  apiKey: string;
}

/**
 * Minimal *arr v3 REST helper.
 * - `path` is like `/api/v3/movie` (no leading origin)
 * - Auth via `X-Api-Key` header
 * - JSON in/out; non-2xx responses throw ArrApiError
 */
export async function arrFetch<T>(endpoint: ArrEndpoint, path: string, init: RequestInit = {}): Promise<T> {
  const url = new URL(path, endpoint.baseUrl).toString();
  const res = await fetch(url, {
    ...init,
    headers: {
      'X-Api-Key': endpoint.apiKey,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ArrApiError(`${res.status} ${res.statusText} from ${url}`, res.status, body);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
