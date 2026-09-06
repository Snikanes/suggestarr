import { describe, expect, it, vi } from 'vitest';
import { CycleScheduler } from '../../src/scheduler.js';

const schedule = {
  cron: '0 18 * * *',
  timezone: 'Europe/Oslo',
  batchSize: 10,
  upcomingSlots: 3,
  expireAfterDays: 2,
  runOnStart: false,
};

describe('CycleScheduler', () => {
  it('arms a cron job and reports the next fire', () => {
    const scheduler = new CycleScheduler({ schedule, run: async () => undefined });
    expect(scheduler.nextRun()).toBeNull();

    scheduler.start();
    const next = scheduler.nextRun();
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(next!).getTime()).toBeGreaterThan(Date.now());

    scheduler.stop();
    expect(scheduler.nextRun()).toBeNull();
  });

  it('is idempotent on start and stop', () => {
    const scheduler = new CycleScheduler({ schedule, run: async () => undefined });
    scheduler.start();
    const next = scheduler.nextRun();
    scheduler.start();

    expect(scheduler.nextRun()).toBe(next);
    scheduler.stop();
    scheduler.stop();
    expect(scheduler.nextRun()).toBeNull();
  });

  it('runs one cycle per tick', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new CycleScheduler({ schedule, run });

    await expect(scheduler.tick()).resolves.toBe(true);
    await expect(scheduler.tick()).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('refuses to start a second cycle while one is in flight', async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const logger = { info: vi.fn(), error: vi.fn() };
    const scheduler = new CycleScheduler({ schedule, run, logger });

    const first = scheduler.tick();
    await expect(scheduler.tick()).resolves.toBe(false);
    release();

    await expect(first).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith({}, 'previous cycle still running, skipping this tick');

    // ... and the scheduler is usable again afterwards
    const second = scheduler.tick();
    release();
    await expect(second).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('survives a cycle that throws', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const scheduler = new CycleScheduler({
      schedule,
      logger,
      run: async () => {
        throw new Error('boom');
      },
    });

    await expect(scheduler.tick()).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'cycle threw, schedule continues',
    );
    // not wedged: the next tick still runs
    await expect(scheduler.tick()).resolves.toBe(false);
  });

  it('works without a logger at all', async () => {
    let release: () => void = () => undefined;
    const scheduler = new CycleScheduler({
      schedule,
      run: () => new Promise<void>((resolve) => (release = resolve)),
    });

    const first = scheduler.tick();
    await expect(scheduler.tick()).resolves.toBe(false); // logs the skip via the noop logger
    release();
    await first;

    const throwing = new CycleScheduler({
      schedule,
      run: async () => {
        throw new Error('boom');
      },
    });
    await expect(throwing.tick()).resolves.toBe(false);
  });

  it('runs a cycle on demand when the process is signalled', async () => {
    const run = vi.fn(async () => undefined);
    const logger = { info: vi.fn(), error: vi.fn() };
    const scheduler = new CycleScheduler({ schedule, run, logger });

    const stop = scheduler.listenForTriggers(['SIGUSR1']);
    process.emit('SIGUSR1');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(logger.info).toHaveBeenCalledWith(
      { signal: 'SIGUSR1' },
      'manual cycle requested by signal',
    );

    // ... and stops listening once disposed
    stop();
    process.emit('SIGUSR1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses a signalled cycle while one is already running', async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const scheduler = new CycleScheduler({ schedule, run });
    const stop = scheduler.listenForTriggers(['SIGUSR1']);

    process.emit('SIGUSR1');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    process.emit('SIGUSR1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(run).toHaveBeenCalledTimes(1); // the overlap guard held
    release();
    stop();
  });

  it('listens on SIGUSR1 by default', async () => {
    const run = vi.fn(async () => undefined);
    const stop = new CycleScheduler({ schedule, run }).listenForTriggers();

    process.emit('SIGUSR1');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    stop();
  });

  it('logs the armed schedule with its timezone', () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    new CycleScheduler({ schedule, run: async () => undefined, logger }).start();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ cron: '0 18 * * *', timezone: 'Europe/Oslo' }),
      'cycle schedule armed',
    );
  });

  it('fires the cycle when the cron matches', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new CycleScheduler({
      schedule: { ...schedule, cron: '* * * * * *' }, // every second
      run,
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    scheduler.stop();

    expect(run).toHaveBeenCalled();
  });
});
