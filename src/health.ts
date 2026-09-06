import type { RadarrClient } from './arr/radarr.js';
import type { Store } from './state/db.js';

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealthReport {
  ok: boolean;
  checks: HealthCheck[];
}

export interface HealthDeps {
  store: Store;
  radarr: RadarrClient;
}

/**
 * What the container's HEALTHCHECK asks: can this process still do its
 * job? Config has already parsed by the time we get here (loading it is
 * what starts the process), so the checks are the two moving parts: the
 * database opens, and Radarr answers.
 */
export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  const checks = await Promise.all([
    check('database', async () => {
      const pending = deps.store.pendingSuggestions().length;
      return `${pending} pending suggestion(s)`;
    }),
    check('radarr', async () => `v${(await deps.radarr.systemStatus()).version}`),
  ]);

  return { ok: checks.every((c) => c.ok), checks };
}

async function check(name: string, run: () => Promise<string>): Promise<HealthCheck> {
  try {
    return { name, ok: true, detail: await run() };
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export function formatHealth(report: HealthReport): string {
  return [
    ...report.checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`),
    report.ok ? 'healthy' : 'unhealthy',
  ].join('\n');
}
