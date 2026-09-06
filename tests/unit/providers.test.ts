import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  HeuristicProvider,
  LlmApiError,
  LlmTimeoutError,
  OllamaProvider,
  OpenAiProvider,
  createProvider,
} from '../../src/agent/providers/index.js';
import type { LlmConfig } from '../../src/config.js';

const OPENAI = 'http://openai.test/v1';
const ANTHROPIC = 'http://anthropic.test';
const OLLAMA = 'http://ollama.test';

/** Bodies msw saw, so request serialization can be asserted per provider. */
const seen: { url: string; headers: Record<string, string>; body: any }[] = [];

async function capture(request: Request): Promise<void> {
  seen.push({
    url: request.url,
    headers: Object.fromEntries(request.headers),
    body: await request.clone().json(),
  });
}

const server = setupServer(
  http.post(`${OPENAI}/chat/completions`, async ({ request }) => {
    await capture(request);
    return HttpResponse.json({
      choices: [{ message: { content: '{"decisions":[]}' } }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    });
  }),
  http.post(`${ANTHROPIC}/v1/messages`, async ({ request }) => {
    await capture(request);
    return HttpResponse.json({
      content: [
        { type: 'thinking' },
        { type: 'text', text: '{"decisions":' },
        { type: 'text', text: '[]}' },
      ],
      usage: { input_tokens: 200, output_tokens: 12 },
    });
  }),
  http.post(`${OLLAMA}/api/chat`, async ({ request }) => {
    await capture(request);
    return HttpResponse.json({
      message: { content: '{"decisions":[]}' },
      prompt_eval_count: 77,
      eval_count: 9,
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  seen.length = 0;
});
afterAll(() => server.close());

describe('OpenAiProvider', () => {
  const provider = new OpenAiProvider({ baseUrl: OPENAI, apiKey: 'sk-test', model: 'gpt-4o-mini' });

  it('sends a bearer-authed deterministic JSON-mode chat request', async () => {
    const completion = await provider.complete('sys', 'usr');

    expect(completion).toEqual({ text: '{"decisions":[]}', inputTokens: 120, outputTokens: 30 });
    expect(seen[0]?.headers.authorization).toBe('Bearer sk-test');
    expect(seen[0]?.headers['content-type']).toContain('application/json');
    expect(seen[0]?.body).toMatchObject({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
    });
    // the API enforces the verdict schema, not just "some JSON"
    expect(seen[0]?.body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'judge_verdicts', strict: true },
    });
    expect(seen[0]?.body.response_format.json_schema.schema.required).toEqual(['decisions']);
  });

  it('reports missing usage as null rather than zero', async () => {
    server.use(
      http.post(`${OPENAI}/chat/completions`, () =>
        HttpResponse.json({ choices: [{ message: { content: 'ok' } }] }),
      ),
    );
    expect(await provider.complete('s', 'u')).toEqual({
      text: 'ok',
      inputTokens: null,
      outputTokens: null,
    });
  });

  it('passes API errors through with status and body', async () => {
    server.use(
      http.post(`${OPENAI}/chat/completions`, () =>
        HttpResponse.json({ error: 'bad key' }, { status: 401 }),
      ),
    );
    const err = (await provider.complete('s', 'u').catch((e) => e)) as LlmApiError;

    expect(err).toBeInstanceOf(LlmApiError);
    expect(err.status).toBe(401);
    expect(err.provider).toBe('openai');
    expect(err.body).toContain('bad key');
    expect(err.message).toContain('openai API error 401');
  });

  it('rejects an empty completion', async () => {
    server.use(
      http.post(`${OPENAI}/chat/completions`, () =>
        HttpResponse.json({ choices: [{ message: { content: null } }] }),
      ),
    );
    await expect(provider.complete('s', 'u')).rejects.toThrow(/empty completion/);
  });

  it('rethrows a network failure as-is rather than calling it a timeout', async () => {
    server.use(http.post(`${OPENAI}/chat/completions`, () => HttpResponse.error()));
    const err = (await provider.complete('s', 'u').catch((e) => e)) as Error;

    expect(err).not.toBeInstanceOf(LlmTimeoutError);
    expect(err).not.toBeInstanceOf(LlmApiError);
    expect(err.message).toMatch(/fetch/i);
  });

  it('times out instead of hanging', async () => {
    server.use(
      http.post(`${OPENAI}/chat/completions`, async () => {
        await delay(200);
        return HttpResponse.json({ choices: [{ message: { content: 'late' } }] });
      }),
    );
    const slow = new OpenAiProvider({
      baseUrl: OPENAI,
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      timeoutMs: 20,
    });
    const err = (await slow.complete('s', 'u').catch((e) => e)) as LlmTimeoutError;

    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect(err.provider).toBe('openai');
    expect(err.timeoutMs).toBe(20);
  });
});

describe('AnthropicProvider', () => {
  const provider = new AnthropicProvider({
    baseUrl: ANTHROPIC,
    apiKey: 'ant-key',
    model: 'claude-opus-5',
  });

  it('sends the system prompt out-of-band and joins text blocks', async () => {
    const completion = await provider.complete('sys', 'usr');

    expect(completion).toEqual({ text: '{"decisions":[]}', inputTokens: 200, outputTokens: 12 });
    expect(seen[0]?.headers['x-api-key']).toBe('ant-key');
    expect(seen[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(seen[0]?.body).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 16000,
      system: 'sys',
      messages: [{ role: 'user', content: 'usr' }],
    });
    expect(seen[0]?.body.output_config.format).toMatchObject({ type: 'json_schema' });
  });

  it('never sends sampling parameters — they are a 400 on current models', async () => {
    await provider.complete('sys', 'usr');

    expect(seen[0]?.body).not.toHaveProperty('temperature');
    expect(seen[0]?.body).not.toHaveProperty('top_p');
    expect(seen[0]?.body).not.toHaveProperty('top_k');
  });

  it('passes an effort setting through, and omits it when unset', async () => {
    await provider.complete('s', 'u');
    expect(seen[0]?.body.output_config).not.toHaveProperty('effort');

    seen.length = 0;
    const thrifty = new AnthropicProvider({
      baseUrl: ANTHROPIC,
      apiKey: 'ant-key',
      model: 'claude-opus-5',
      effort: 'low',
    });
    await thrifty.complete('s', 'u');
    expect(seen[0]?.body.output_config).toMatchObject({ effort: 'low' });
  });

  it('defaults to the public API host and honours a max_tokens override', async () => {
    server.use(
      http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
        await capture(request);
        return HttpResponse.json({ content: [{ type: 'text', text: 'hi' }] });
      }),
    );
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', maxTokens: 100 });

    expect(await p.complete('s', 'u')).toEqual({
      text: 'hi',
      inputTokens: null,
      outputTokens: null,
    });
    expect(seen[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen[0]?.body.max_tokens).toBe(100);
  });

  it('rejects a reply with no text blocks', async () => {
    server.use(
      http.post(`${ANTHROPIC}/v1/messages`, () => HttpResponse.json({ content: [] })),
    );
    await expect(provider.complete('s', 'u')).rejects.toThrow(/no text content/);
  });

  it('passes API errors through', async () => {
    server.use(
      http.post(`${ANTHROPIC}/v1/messages`, () =>
        HttpResponse.text('overloaded', { status: 529 }),
      ),
    );
    const err = (await provider.complete('s', 'u').catch((e) => e)) as LlmApiError;
    expect(err.status).toBe(529);
    expect(err.provider).toBe('anthropic');
  });
});

describe('OllamaProvider', () => {
  const provider = new OllamaProvider({ baseUrl: OLLAMA, model: 'llama3.1' });

  it('requests unstreamed JSON-format output and maps eval counts to tokens', async () => {
    const completion = await provider.complete('sys', 'usr');

    expect(completion).toEqual({ text: '{"decisions":[]}', inputTokens: 77, outputTokens: 9 });
    expect(seen[0]?.body).toMatchObject({
      model: 'llama3.1',
      stream: false,
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
    });
    // a schema, not the bare "json" mode
    expect(seen[0]?.body.format.required).toEqual(['decisions']);
  });

  it('rejects an empty message', async () => {
    server.use(http.post(`${OLLAMA}/api/chat`, () => HttpResponse.json({ message: {} })));
    await expect(provider.complete('s', 'u')).rejects.toThrow(/empty message/);
  });

  it('passes API errors through', async () => {
    server.use(
      http.post(`${OLLAMA}/api/chat`, () =>
        HttpResponse.json({ error: 'model not found' }, { status: 404 }),
      ),
    );
    const err = (await provider.complete('s', 'u').catch((e) => e)) as LlmApiError;
    expect(err.status).toBe(404);
    expect(err.provider).toBe('ollama');
  });
});

describe('createProvider', () => {
  const base: LlmConfig = {
    provider: 'openai',
    baseUrl: OPENAI,
    model: 'gpt-4o-mini',
    timeoutMs: 1000,
    apiKey: 'sk-test',
  };

  it('builds each configured backend', () => {
    expect(createProvider(base).name).toBe('openai');
    expect(createProvider({ ...base, provider: 'anthropic' }).name).toBe('anthropic');
    expect(createProvider({ ...base, provider: 'ollama' }).name).toBe('ollama');
    expect(createProvider({ ...base, provider: 'mock' })).toBeInstanceOf(HeuristicProvider);
  });

  it('carries the configured model through', () => {
    expect(createProvider({ ...base, model: 'gpt-5' }).model).toBe('gpt-5');
  });

  it('passes the effort dial to Anthropic', async () => {
    const provider = createProvider({
      ...base,
      provider: 'anthropic',
      baseUrl: ANTHROPIC,
      model: 'claude-opus-5',
      effort: 'medium',
    });
    await provider.complete('s', 'u');

    expect(seen[0]?.body.output_config).toMatchObject({ effort: 'medium' });
  });

  it('demands a key for the hosted providers but not for local ones', () => {
    const { apiKey: _drop, ...keyless } = base;
    expect(() => createProvider(keyless)).toThrow(/LLM_API_KEY is required when LLM_PROVIDER=openai/);
    expect(() => createProvider({ ...keyless, provider: 'anthropic' })).toThrow(/anthropic/);
    expect(() => createProvider({ ...keyless, provider: 'ollama' })).not.toThrow();
    expect(() => createProvider({ ...keyless, provider: 'mock' })).not.toThrow();
  });
});
