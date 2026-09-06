import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkHealth, formatHealth } from '../../src/health.js';
import { RadarrClient } from '../../src/arr/radarr.js';
import { Store } from '../../src/state/db.js';

const RADARR = 'http://radarr.test:7878';

const status = (version: string) => ({
  version,
  applicationVersion: version,
  instanceName: 'arr',
  uptime: '1:00:00',
});

const server = setupServer(
  http.get(`${RADARR}/api/v3/systemstatus`, () => HttpResponse.json(status('5.2.6'))),
);

let store: Store;
const deps = () => ({
  store,
  radarr: new RadarrClient({ baseUrl: RADARR, apiKey: 'r' }),
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(async () => {
  store = await Store.open(':memory:');
});
afterEach(() => {
  server.resetHandlers();
  store.close();
});
afterAll(() => server.close());

describe('checkHealth', () => {
  it('is healthy when the database opens and Radarr answers', async () => {
    const report = await checkHealth(deps());

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual([
      { name: 'database', ok: true, detail: '0 pending suggestion(s)' },
      { name: 'radarr', ok: true, detail: 'v5.2.6' },
    ]);
  });

  it('fails as a whole when Radarr is unreachable, and says why', async () => {
    server.use(
      http.get(`${RADARR}/api/v3/systemstatus`, () => HttpResponse.json({}, { status: 500 })),
    );
    const report = await checkHealth(deps());

    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'database')?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'radarr')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('500'),
    });
  });

  it('fails when the database handle is gone', async () => {
    store.close();
    const report = await checkHealth(deps());

    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ name: 'database', ok: false });
    // reopen so afterEach can close it again
    store = await Store.open(':memory:');
  });

  it('renders a report a HEALTHCHECK log can be read from', async () => {
    const healthy = formatHealth(await checkHealth(deps()));
    expect(healthy).toBe(
      ['ok   database: 0 pending suggestion(s)', 'ok   radarr: v5.2.6', 'healthy'].join('\n'),
    );

    server.use(http.get(`${RADARR}/api/v3/systemstatus`, () => HttpResponse.error()));
    const broken = formatHealth(await checkHealth(deps()));
    expect(broken).toContain('FAIL radarr:');
    expect(broken.endsWith('unhealthy')).toBe(true);
  });
});
