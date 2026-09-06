/** Raised for any non-2xx response from an LLM backend. */
export class LlmApiError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'LlmApiError';
  }
}

/** Raised when a backend does not answer within the configured budget. */
export class LlmTimeoutError extends Error {
  constructor(
    readonly provider: string,
    readonly timeoutMs: number,
  ) {
    super(`${provider} did not respond within ${timeoutMs}ms`);
    this.name = 'LlmTimeoutError';
  }
}

export const DEFAULT_TIMEOUT_MS = 60_000;

export interface PostJsonOptions {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}

/**
 * POST JSON to an LLM backend with a hard timeout.
 * Non-2xx becomes LlmApiError (body truncated — provider errors can be
 * huge HTML pages); an aborted request becomes LlmTimeoutError.
 */
export async function postJson<T>(opts: PostJsonOptions): Promise<T> {
  let res: Response;
  try {
    res = await fetch(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    if (isTimeout(e)) throw new LlmTimeoutError(opts.provider, opts.timeoutMs);
    throw e;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new LlmApiError(
      `${opts.provider} API error ${res.status}: ${body.slice(0, 300)}`,
      opts.provider,
      res.status,
      body,
    );
  }
  return (await res.json()) as T;
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}
