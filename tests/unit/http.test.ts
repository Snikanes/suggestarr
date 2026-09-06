import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { arrFetch, ArrApiError, type ArrEndpoint } from '../../src/arr/http.js';

const endpoint: ArrEndpoint = { baseUrl: 'http://arr.test:1234', apiKey: 'test-key' };

const server = setupServer(
  http.get('http://arr.test:1234/api/v3/things', ({ request }) => {
    return HttpResponse.json(
      { id: 1, apiKeySeen: request.headers.get('X-Api-Key'), ct: request.headers.get('Content-Type') },
    );
  }),
  http.get('http://arr.test:1234/api/v3/unauthorized', () =>
    HttpResponse.json({ status: 401, message: 'Invalid API Key' }, { status: 401 }),
  ),
  http.delete('http://arr.test:1234/api/v3/thing/1', () =>
    new HttpResponse(null, { status: 204 }),
  ),
  http.post('http://arr.test:1234/api/v3/thing', async ({ request }) =>
    HttpResponse.json({ ok: true, body: await request.json() }, { status: 201 }),
  ),
);

beforeEach(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); server.close(); });

describe('arrFetch', () => {
  it('sends X-Api-Key and Content-Type headers and parses JSON', async () => {
    const res = await arrFetch<{ id: number; apiKeySeen: string | null; ct: string | null }>(
      endpoint,
      '/api/v3/things',
    );
    expect(res).toEqual({ id: 1, apiKeySeen: 'test-key', ct: 'application/json' });
  });

  it('POSTs JSON body and parses the response', async () => {
    const res = await arrFetch<{ ok: boolean; body: { hello: string } }>(
      endpoint,
      '/api/v3/thing',
      { method: 'POST', body: JSON.stringify({ hello: 'world' }) },
    );
    expect(res).toEqual({ ok: true, body: { hello: 'world' } });
  });

  it('returns undefined for 204 No Content', async () => {
    const res = await arrFetch<undefined>(endpoint, '/api/v3/thing/1', { method: 'DELETE' });
    expect(res).toBeUndefined();
  });

  it('throws ArrApiError with status and body for non-2xx', async () => {
    await expect(arrFetch(endpoint, '/api/v3/unauthorized')).rejects.toMatchObject({
      name: 'ArrApiError',
      status: 401,
      body: expect.stringContaining('Invalid API Key'),
      message: expect.stringContaining('401'),
    });
  });

  it('throws ArrApiError with empty body when the body is not text', async () => {
    server.use(
      http.get('http://arr.test:1234/api/v3/unauthorized', () =>
        new HttpResponse(null, { status: 502, statusText: 'Bad Gateway' }),
      ),
    );
    const err = await arrFetch(endpoint, '/api/v3/unauthorized').catch((e) => e);
    expect(err).toBeInstanceOf(ArrApiError);
    expect((err as ArrApiError).status).toBe(502);
    expect((err as ArrApiError).body).toBe('');
  });
});
