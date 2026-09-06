import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { loadConfig, loadDotEnv, requireDiscord, type Config } from './config.js';
import { AgentClient } from './agent/agent.js';
import { createProvider } from './agent/providers/index.js';
import { ArrAdder } from './arr/adder.js';
import { ArrApiError } from './arr/http.js';
import { RadarrClient } from './arr/radarr.js';
import type { Title } from './arr/types.js';
import { runCycle, type CycleReport } from './cycle.js';
import { buildCommands } from './discord/commands.js';
import { DiscordJsGateway } from './discord/discordjs.js';
import { SuggestionService } from './discord/service.js';
import { checkHealth, formatHealth } from './health.js';
import { writeReport } from './report.js';
import { CycleScheduler } from './scheduler.js';
import { Store } from './state/db.js';
import { createMigrator, migrate } from './state/migrator.js';
import { TmdbClient } from './tmdb/client.js';

// Before anything reads process.env. A real environment variable always
// wins over the file, so this is a no-op in the container.
const dotEnvLoaded = loadDotEnv();

const config = loadConfig();
const logger = pino({ name: 'suggestarr', level: config.logLevel });
logger.debug({ dotEnvLoaded }, dotEnvLoaded ? 'loaded .env' : 'no .env file, using the environment');

function clients(config: Config) {
  return {
    radarr: new RadarrClient(config.radarr),
    tmdb: new TmdbClient(config.tmdb),
    agent: new AgentClient(createProvider(config.llm)),
  };
}

function printTitle(t: Title): void {
  const year = t.year ? ` (${t.year})` : '';
  const state = t.monitored ? 'monitored' : 'not monitored';
  const file = t.hasFile ? 'on disk' : 'no file';
  console.log(`  ${t.title}${year} — ${state}, ${file}`);
}

async function library(): Promise<void> {
  const { radarr } = clients(config);
  try {
    const titles = await radarr.listTitles();
    console.log(`\nRadarr — ${titles.length} movies:`);
    for (const t of titles) printTitle(t);
  } catch (err) {
    logger.error(err, 'could not reach Radarr');
    console.error(
      `\nRadarr — FAILED: ${err instanceof ArrApiError ? err.message : (err as Error).message}`,
    );
    process.exitCode = 1;
  }
}

function printReport(report: CycleReport, store: Store): void {
  if (report.failures.length) {
    console.error('\nProblems:');
    for (const f of report.failures) console.error(`  ! ${f}`);
  }
  if (report.runId === null) {
    console.log(
      `\nNo run recorded — ${report.candidates} candidates after filtering ` +
        `(${report.libraryTitles} library titles` +
        `${report.libraryAvailable ? '' : ', Radarr unreachable'}).`,
    );
    return;
  }

  console.log(
    `\nRun #${report.runId} — ${report.kept}/${report.judged} kept` +
      (report.posted ? `, ${report.posted} posted to Discord` : '') +
      (report.expired ? `, ${report.expired} expired` : ''),
  );
  for (const d of store.listDecisions({ limit: report.judged }).reverse()) {
    const year = d.year ? ` (${d.year})` : '';
    const mark = d.verdict === 'keep' ? '✅' : '❌';
    console.log(`${mark} ${d.title}${year}`);
    console.log(`      ${d.reason}`);
  }
}

/** Everything a cycle needs, minus the Discord service. */
function cycleDeps(store: Store) {
  return {
    store,
    ...clients(config),
    prefs: config.discovery,
    batchSize: config.schedule.batchSize,
    upcomingSlots: config.schedule.upcomingSlots,
    expireAfterDays: config.schedule.expireAfterDays,
    pages: config.discoveryPages,
    ...(config.tasteNotes !== undefined ? { userNotes: config.tasteNotes } : {}),
    logger,
  };
}

/** One cycle, printed to the console. No Discord involved. */
async function judge(): Promise<void> {
  const store = await Store.open(config.dbPath, logger);
  try {
    const report = await runCycle(cycleDeps(store));
    printReport(report, store);
  } finally {
    store.close();
  }
}

/**
 * The Discord half of `cycle` and `bot`: gateway, service, and the slash
 * commands.
 *
 * `/add`'s quality-profile choices are baked in at registration time, so
 * they are read from Radarr here. A Radarr that is down at startup costs
 * only the choice list — the command still registers, and the bot still
 * runs.
 */
async function discordDeps(
  store: Store,
): Promise<{ gateway: DiscordJsGateway; service: SuggestionService; channelId: string }> {
  const discordConfig = requireDiscord(config);
  const adder = new ArrAdder(new RadarrClient(config.radarr), config.placement);
  const profiles = await adder.qualityProfiles().catch((e: Error) => {
    logger.warn({ err: e.message }, 'could not read Radarr quality profiles for /add');
    return [];
  });
  const gateway = new DiscordJsGateway(discordConfig, buildCommands(profiles));
  const service = new SuggestionService({ store, gateway, adder, logger });
  return { gateway, service, channelId: discordConfig.channelId };
}

/**
 * One full cycle, posted to Discord, then exit — the manual counterpart
 * to the schedule, for a first run or an out-of-band top-up.
 *
 * The process is gone once it returns, so the ✅/❌ on what it posts are
 * only acted on while `bot` is running. The suggestions stay pending in
 * the database until then; nothing is lost, but nothing is added either.
 */
async function cycleOnce(): Promise<void> {
  const store = await Store.open(config.dbPath, logger);
  const { gateway, service } = await discordDeps(store);

  try {
    await gateway.start();
    const report = await runCycle({ ...cycleDeps(store), service });
    printReport(report, store);
    if (report.posted > 0) {
      console.log(
        `\nPosted ${report.posted} suggestion(s). React in Discord once \`npm run bot\` is up.`,
      );
    }
  } finally {
    await gateway.stop();
    store.close();
  }
}

/** The real thing: Discord bot up, one cycle now, then serve reactions. */
async function bot(): Promise<void> {
  const store = await Store.open(config.dbPath, logger);
  const { gateway, service, channelId } = await discordDeps(store);

  service.register();
  await gateway.start();
  logger.info({ channel: channelId }, 'discord gateway up');

  // Answers given while the bot was down are not replayed by Discord —
  // read them off the messages themselves before arming the schedule.
  const caughtUp = await service.reconcilePending();
  if (caughtUp.approved || caughtUp.rejected) {
    console.log(
      `Caught up on ${caughtUp.approved} approval(s) and ${caughtUp.rejected} rejection(s) ` +
        'made while the bot was offline.',
    );
  }

  const scheduler = new CycleScheduler({
    schedule: config.schedule,
    logger,
    run: () => runCycle({ ...cycleDeps(store), service }),
  });
  scheduler.start();

  // A cycle on demand, without restarting the bot. This overrides Node's
  // default use of SIGUSR1 to open the inspector, which a long-running
  // container has no use for.
  const stopTriggers = scheduler.listenForTriggers(['SIGUSR1']);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    stopTriggers();
    scheduler.stop();
    await gateway.stop();
    store.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info(
    { next: scheduler.nextRun(), batchSize: config.schedule.batchSize, pid: process.pid },
    'waiting for the next scheduled cycle (SIGUSR1 runs one now)',
  );

  if (config.schedule.runOnStart) await scheduler.tick();
}

/** A standalone HTML view of the decision log, for actually reading it. */
async function reportHtml(): Promise<void> {
  const store = await Store.open(config.dbPath, logger);
  try {
    const path = process.argv[3] ?? 'suggestarr-decisions.html';
    writeReport(store, path);
    console.log(`Wrote ${path}`);
  } finally {
    store.close();
  }
}

/** Container HEALTHCHECK: exits non-zero when anything is wrong. */
async function health(): Promise<void> {
  const store = await Store.open(config.dbPath, logger);
  try {
    const { radarr } = clients(config);
    const report = await checkHealth({ store, radarr });
    console.log(formatHealth(report));
    if (!report.ok) process.exitCode = 1;
  } finally {
    store.close();
  }
}

/** `report:decisions` — the prompt-refinement evidence base (§2.4). */
async function reportDecisions(): Promise<void> {
  const store = await Store.open(config.dbPath, logger);
  try {
    console.log('\nPrompt versions (mismatch rate = how often you overruled the agent):');
    for (const s of store.promptVersionStats()) {
      const answered = s.approved + s.rejected + s.forceAdded;
      const mismatches = s.rejected + s.forceAdded;
      const rate = answered ? `${((mismatches / answered) * 100).toFixed(0)}%` : 'n/a';
      console.log(
        `  ${s.promptVersion} / taste ${s.tasteHash}: ${s.decisions} verdicts, ${s.kept} kept, ` +
          `${s.approved} approved, ${s.rejected} rejected, ${s.forceAdded} force-added ` +
          `— mismatch rate ${rate} of ${answered} answered`,
      );
    }

    const mismatches = store.mismatches();
    console.log(`\nMismatches — ${mismatches.length} (agent and you disagreed):`);
    for (const m of mismatches) {
      const year = m.row.year ? ` (${m.row.year})` : '';
      console.log(`  [${m.type}] ${m.row.title}${year} — prompt ${m.row.promptVersion}`);
      console.log(`      agent said: ${m.row.reason}`);
    }

    const pending = store.pendingSuggestions();
    console.log(`\nPending suggestions — ${pending.length}:`);
    for (const p of pending) {
      console.log(`  ${p.remoteId} ${p.title} — posted ${p.postedAt.slice(0, 16)}`);
    }
  } finally {
    store.close();
  }
}

/**
 * Migrations run automatically on every open, so these are for looking
 * at the ledger and for backing one out by hand — not part of the normal
 * startup path.
 */
function openForMigration(): Database.Database {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma('foreign_keys = ON');
  return db;
}

async function migrateUp(): Promise<void> {
  const db = openForMigration();
  try {
    const applied = await migrate(db, logger);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
  } finally {
    db.close();
  }
}

async function migrateStatus(): Promise<void> {
  const db = openForMigration();
  try {
    const migrator = createMigrator(db, logger);
    const executed = (await migrator.executed()).map((m) => m.name);
    const pending = (await migrator.pending()).map((m) => m.name);
    console.log(`Database: ${config.dbPath}`);
    console.log(`\nApplied — ${executed.length}:`);
    for (const name of executed) console.log(`  ✓ ${name}`);
    console.log(`\nPending — ${pending.length}:`);
    for (const name of pending) console.log(`  · ${name}`);
  } finally {
    db.close();
  }
}

/** Revert the newest migration. Destructive: it drops what that step added. */
async function migrateDown(): Promise<void> {
  const db = openForMigration();
  try {
    const reverted = await createMigrator(db, logger).down();
    console.log(reverted.length ? `Reverted: ${reverted[0]?.name}` : 'Nothing to revert.');
  } finally {
    db.close();
  }
}

const [cmd] = process.argv.slice(2);

switch (cmd ?? 'library') {
  case 'library':
    await library();
    break;
  case 'judge':
    await judge();
    break;
  case 'cycle':
    await cycleOnce();
    break;
  case 'bot':
    await bot();
    break;
  case 'health':
    await health();
    break;
  case 'report:decisions':
    await reportDecisions();
    break;
  case 'report:html':
    await reportHtml();
    break;
  case 'migrate':
    await migrateUp();
    break;
  case 'migrate:status':
    await migrateStatus();
    break;
  case 'migrate:down':
    await migrateDown();
    break;
  default:
    console.error(
      `Unknown command: ${cmd}\n` +
        'Usage: suggestarr [library | judge | cycle | bot | health | report:decisions | ' +
          'report:html | migrate | migrate:status | migrate:down]',
    );
    process.exitCode = 1;
}
