import { Cron } from 'croner';
import type { Logger } from 'pino';
import type { ScheduleConfig } from './config.js';

export interface SchedulerDeps {
  schedule: ScheduleConfig;
  /** one cycle; must never reject — failures belong in the report */
  run: () => Promise<unknown>;
  logger?: Pick<Logger, 'info' | 'error'>;
}

const NOOP_LOGGER = { info: () => undefined, error: () => undefined };

/**
 * The only thing that starts a suggestion cycle (§2 — there is no
 * `/suggest`). Overlapping runs are refused rather than queued: a cycle
 * that outlives its interval means something is wrong upstream, and a
 * second concurrent run would double-post.
 */
export class CycleScheduler {
  private job: Cron | null = null;
  private running = false;
  private readonly logger: Pick<Logger, 'info' | 'error'>;

  constructor(private readonly deps: SchedulerDeps) {
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  start(): void {
    if (this.job) return;
    this.job = new Cron(
      this.deps.schedule.cron,
      { timezone: this.deps.schedule.timezone, protect: true },
      async () => {
        await this.tick();
      },
    );
    this.logger.info(
      { cron: this.deps.schedule.cron, timezone: this.deps.schedule.timezone, next: this.nextRun() },
      'cycle schedule armed',
    );
  }

  stop(): void {
    this.job?.stop();
    this.job = null;
  }

  /** ISO timestamp of the next fire, or null when not scheduled. */
  nextRun(): string | null {
    return this.job?.nextRun()?.toISOString() ?? null;
  }

  /**
   * Run a cycle on demand when the process gets one of these signals —
   * `kill -SIGUSR1 <pid>` / `docker kill -s SIGUSR1 suggestarr`.
   *
   * The overlap guard in `tick()` still applies, so a manual trigger
   * during a running cycle is refused rather than doubling up. Returns a
   * disposer so shutdown can unhook cleanly.
   */
  listenForTriggers(signals: NodeJS.Signals[] = ['SIGUSR1']): () => void {
    const installed: [NodeJS.Signals, () => void][] = [];

    for (const signal of signals) {
      // The signal name comes from the closure, not the handler argument,
      // so the log line is right however the process was signalled.
      const handler = (): void => {
        this.logger.info({ signal }, 'manual cycle requested by signal');
        void this.tick();
      };
      process.on(signal, handler);
      installed.push([signal, handler]);
    }

    return () => {
      for (const [signal, handler] of installed) process.off(signal, handler);
    };
  }

  /** Run one cycle now, unless one is already in flight. */
  async tick(): Promise<boolean> {
    if (this.running) {
      this.logger.info({}, 'previous cycle still running, skipping this tick');
      return false;
    }
    this.running = true;
    try {
      await this.deps.run();
      return true;
    } catch (e) {
      // A cycle should report its own failures; anything reaching here is
      // a bug, and must not kill the scheduler.
      this.logger.error({ err: e }, 'cycle threw, schedule continues');
      return false;
    } finally {
      this.running = false;
    }
  }
}
