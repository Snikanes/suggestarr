import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadDotEnv, requireDiscord } from '../../src/config.js';

const validEnv = {
  RADARR_URL: 'http://localhost:7878',
  RADARR_API_KEY: 'r-key',
  TMDB_API_KEY: 't-key',
  SUGGESTARR_LOG_LEVEL: 'debug',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    expect(loadConfig(validEnv)).toEqual({
      radarr: { baseUrl: 'http://localhost:7878', apiKey: 'r-key' },
      tmdb: { baseUrl: 'https://api.themoviedb.org/3', apiKey: 't-key' },
      llm: { provider: 'mock', baseUrl: '', model: 'heuristic-1', timeoutMs: 0 },
      placement: { searchOnAdd: true },
      schedule: {
        cron: '0 18 * * *',
        timezone: 'Europe/Oslo',
        batchSize: 10,
        upcomingSlots: 3,
        expireAfterDays: 2,
        runOnStart: false,
      },
      discovery: { minRating: 6, minVotes: 100, exemptUpcoming: true },
      discoveryPages: 3,
      dbPath: './data/suggestarr.db',
      logLevel: 'debug',
    });
  });

  it('applies defaults for URL and log level', () => {
    const config = loadConfig({
      RADARR_API_KEY: 'r-key',
      TMDB_API_KEY: 't-key',
    } as NodeJS.ProcessEnv);
    expect(config.radarr.baseUrl).toBe('http://localhost:7878');
    expect(config.tmdb.baseUrl).toBe('https://api.themoviedb.org/3');
    expect(config.logLevel).toBe('info');
    expect(config.llm.provider).toBe('mock');
    expect(config.dbPath).toBe('./data/suggestarr.db');
  });

  it('applies per-provider LLM defaults', () => {
    const openai = loadConfig({ ...validEnv, LLM_PROVIDER: 'openai', LLM_API_KEY: 'sk' }).llm;
    expect(openai).toEqual({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      timeoutMs: 60_000,
      apiKey: 'sk',
    });

    const anthropic = loadConfig({ ...validEnv, LLM_PROVIDER: 'anthropic' }).llm;
    expect(anthropic.baseUrl).toBe('https://api.anthropic.com');
    expect(anthropic.model).toBe('claude-opus-5');
    expect(anthropic.apiKey).toBeUndefined();
    expect(anthropic.effort).toBeUndefined();

    const ollama = loadConfig({ ...validEnv, LLM_PROVIDER: 'ollama' }).llm;
    expect(ollama.baseUrl).toBe('http://localhost:11434');
    expect(ollama.model).toBe('llama3.1');
    expect(ollama.timeoutMs).toBe(180_000);
  });

  it('lets the environment override every LLM default', () => {
    expect(
      loadConfig({
        ...validEnv,
        LLM_PROVIDER: 'openai',
        LLM_API_KEY: 'sk-live',
        LLM_MODEL: 'gpt-5',
        LLM_BASE_URL: 'http://gateway.local/v1',
        LLM_TIMEOUT_MS: '5000',
        SUGGESTARR_DB_PATH: '/data/db.sqlite',
      }),
    ).toMatchObject({
      llm: {
        provider: 'openai',
        baseUrl: 'http://gateway.local/v1',
        model: 'gpt-5',
        timeoutMs: 5000,
        apiKey: 'sk-live',
      },
      dbPath: '/data/db.sqlite',
    });
  });

  it('reads the effort dial and rejects an unknown level', () => {
    expect(loadConfig({ ...validEnv, LLM_EFFORT: 'low' }).llm.effort).toBe('low');
    expect(() => loadConfig({ ...validEnv, LLM_EFFORT: 'ludicrous' })).toThrow(/LLM_EFFORT/);
  });

  it('rejects an unknown LLM provider and a non-numeric timeout', () => {
    expect(() => loadConfig({ ...validEnv, LLM_PROVIDER: 'llamafile' })).toThrow(/LLM_PROVIDER/);
    expect(() => loadConfig({ ...validEnv, LLM_TIMEOUT_MS: 'soon' })).toThrow(/LLM_TIMEOUT_MS/);
    expect(() => loadConfig({ ...validEnv, LLM_BASE_URL: 'nope' })).toThrow(/LLM_BASE_URL/);
  });

  it('reads placement and leaves unset names to the Radarr defaults', () => {
    expect(
      loadConfig({
        ...validEnv,
        RADARR_ROOT_FOLDER: '/movies-4k',
        RADARR_QUALITY_PROFILE: 'Ultra-HD',
        ARR_SEARCH_ON_ADD: 'false',
      }).placement,
    ).toEqual({ rootFolder: '/movies-4k', qualityProfile: 'Ultra-HD', searchOnAdd: false });
  });

  it('exposes Discord config only when token, channel and client id are all set', () => {
    expect(loadConfig(validEnv).discord).toBeUndefined();
    expect(
      loadConfig({ ...validEnv, DISCORD_BOT_TOKEN: 't', DISCORD_CHANNEL_ID: 'c' }).discord,
    ).toBeUndefined();

    expect(
      loadConfig({
        ...validEnv,
        DISCORD_BOT_TOKEN: 't',
        DISCORD_CHANNEL_ID: 'c',
        DISCORD_CLIENT_ID: 'a',
        DISCORD_GUILD_ID: 'g',
      }).discord,
    ).toEqual({ botToken: 't', channelId: 'c', clientId: 'a', guildId: 'g' });
  });

  it('requireDiscord explains what is missing, and returns the config when present', () => {
    expect(() => requireDiscord(loadConfig(validEnv))).toThrow(/DISCORD_BOT_TOKEN/);
    const configured = loadConfig({
      ...validEnv,
      DISCORD_BOT_TOKEN: 't',
      DISCORD_CHANNEL_ID: 'c',
      DISCORD_CLIENT_ID: 'a',
    });
    expect(requireDiscord(configured).botToken).toBe('t');
  });

  it('rejects a non-boolean ARR_SEARCH_ON_ADD', () => {
    expect(() => loadConfig({ ...validEnv, ARR_SEARCH_ON_ADD: 'yes' })).toThrow(
      /ARR_SEARCH_ON_ADD/,
    );
  });

  it('reads the schedule, batch size and run-on-start flag', () => {
    expect(
      loadConfig({
        ...validEnv,
        SUGGESTARR_SCHEDULE: '30 7 * * 1',
        SUGGESTARR_TZ: 'UTC',
        SUGGESTARR_BATCH_SIZE: '25',
        SUGGESTARR_RUN_ON_START: 'true',
      }).schedule,
    ).toEqual({
      cron: '30 7 * * 1',
      timezone: 'UTC',
      batchSize: 25,
      upcomingSlots: 3,
      expireAfterDays: 2,
      runOnStart: true,
    });
  });

  it('reads the expiry window', () => {
    expect(loadConfig({ ...validEnv, SUGGESTARR_EXPIRE_AFTER_DAYS: '7' }).schedule.expireAfterDays).toBe(7);
    expect(() => loadConfig({ ...validEnv, SUGGESTARR_EXPIRE_AFTER_DAYS: '0' })).toThrow(
      /SUGGESTARR_EXPIRE_AFTER_DAYS/,
    );
  });

  it('reads the discovery depth and the upcoming reservation', () => {
    const config = loadConfig({
      ...validEnv,
      DISCOVERY_PAGES: '5',
      DISCOVERY_UPCOMING_SLOTS: '0',
      DISCOVERY_EXEMPT_UPCOMING: 'false',
    });

    expect(config.discoveryPages).toBe(5);
    expect(config.schedule.upcomingSlots).toBe(0);
    expect(config.discovery.exemptUpcoming).toBe(false);
  });

  it('rejects a nonsense discovery depth or reservation', () => {
    expect(() => loadConfig({ ...validEnv, DISCOVERY_PAGES: '0' })).toThrow(/DISCOVERY_PAGES/);
    expect(() => loadConfig({ ...validEnv, DISCOVERY_PAGES: '99' })).toThrow(/DISCOVERY_PAGES/);
    expect(() => loadConfig({ ...validEnv, DISCOVERY_UPCOMING_SLOTS: '-1' })).toThrow(
      /DISCOVERY_UPCOMING_SLOTS/,
    );
    expect(() => loadConfig({ ...validEnv, DISCOVERY_EXEMPT_UPCOMING: 'maybe' })).toThrow(
      /DISCOVERY_EXEMPT_UPCOMING/,
    );
  });

  it('rejects a batch size that is not a sane positive integer', () => {
    expect(() => loadConfig({ ...validEnv, SUGGESTARR_BATCH_SIZE: '0' })).toThrow(
      /SUGGESTARR_BATCH_SIZE/,
    );
    expect(() => loadConfig({ ...validEnv, SUGGESTARR_BATCH_SIZE: '500' })).toThrow(
      /SUGGESTARR_BATCH_SIZE/,
    );
  });

  it('builds discovery preferences, parsing genre id lists leniently', () => {
    expect(
      loadConfig({
        ...validEnv,
        DISCOVERY_MIN_RATING: '7.5',
        DISCOVERY_MIN_VOTES: '500',
        DISCOVERY_YEAR_FROM: '1990',
        DISCOVERY_INCLUDE_GENRES: '18, 28',
        DISCOVERY_EXCLUDE_GENRES: '99,, oops',
      }).discovery,
    ).toEqual({
      minRating: 7.5,
      minVotes: 500,
      exemptUpcoming: true,
      yearFrom: 1990,
      includeGenres: [18, 28],
      excludeGenres: [99],
    });
  });

  it('omits empty genre lists rather than passing empty filters', () => {
    const discovery = loadConfig({ ...validEnv, DISCOVERY_INCLUDE_GENRES: ' , ' }).discovery;
    expect(discovery).not.toHaveProperty('includeGenres');
    expect(discovery).not.toHaveProperty('excludeGenres');
  });

  it('carries static taste notes when set', () => {
    expect(loadConfig(validEnv).tasteNotes).toBeUndefined();
    expect(loadConfig({ ...validEnv, SUGGESTARR_TASTE_NOTES: 'no horror' }).tasteNotes).toBe(
      'no horror',
    );
  });

  it('throws a readable error when the Radarr API key is missing', () => {
    expect(() =>
      loadConfig({ TMDB_API_KEY: 't-key' } as NodeJS.ProcessEnv),
    ).toThrow(/RADARR_API_KEY/);
  });

  it('throws a readable error when the TMDB API key is missing', () => {
    expect(() =>
      loadConfig({ RADARR_API_KEY: 'r-key' } as NodeJS.ProcessEnv),
    ).toThrow(/TMDB_API_KEY/);
  });

  it('throws a readable error for an invalid URL', () => {
    expect(() => loadConfig({ ...validEnv, RADARR_URL: 'not-a-url' })).toThrow(/RADARR_URL/);
  });

  it('throws a readable error for an invalid log level', () => {
    expect(() => loadConfig({ ...validEnv, SUGGESTARR_LOG_LEVEL: 'loud' })).toThrow(
      /SUGGESTARR_LOG_LEVEL/,
    );
  });
});

describe('loadDotEnv', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'suggestarr-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SUGGESTARR_DOTENV_PROBE;
    delete process.env.SUGGESTARR_DOTENV_CONFLICT;
  });

  it('reads a .env file into the environment', () => {
    const path = join(dir, '.env');
    writeFileSync(path, 'SUGGESTARR_DOTENV_PROBE=from-file\n');

    expect(loadDotEnv(path)).toBe(true);
    expect(process.env.SUGGESTARR_DOTENV_PROBE).toBe('from-file');
  });

  it('never overrides a variable the environment already set', () => {
    process.env.SUGGESTARR_DOTENV_CONFLICT = 'from-environment';
    const path = join(dir, '.env');
    writeFileSync(path, 'SUGGESTARR_DOTENV_CONFLICT=from-file\n');

    loadDotEnv(path);
    // This is what keeps a stray .env from overriding Docker's config
    expect(process.env.SUGGESTARR_DOTENV_CONFLICT).toBe('from-environment');
  });

  it('treats a missing file as normal, not an error', () => {
    expect(loadDotEnv(join(dir, 'does-not-exist'))).toBe(false);
    expect(() => loadDotEnv(join(dir, 'does-not-exist'))).not.toThrow();
  });

  it('defaults to ./.env', () => {
    // No file in the test working directory: must report false, not throw
    expect(() => loadDotEnv()).not.toThrow();
  });
});
