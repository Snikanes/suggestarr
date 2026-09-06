import { z } from 'zod';
import type { DiscoveryPrefs } from './discovery/filters.js';

/**
 * Load a `.env` file into `process.env`, if there is one.
 *
 * Nothing does this for us: npm does not read `.env`, and neither does
 * `tsx` or `node` unless asked. Node's own loader is used rather than a
 * dependency, and it leaves already-set variables alone — so a real
 * environment variable (what Docker Compose passes) always beats the
 * file, and a stray `.env` can never override the container's config.
 *
 * Returns whether a file was actually read; a missing one is normal.
 */
export function loadDotEnv(path = '.env'): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch {
    // No file (ENOENT) or an unreadable one: env vars alone must do.
    return false;
  }
}

export type LlmProviderName = 'openai' | 'anthropic' | 'ollama' | 'mock';

/** Per-provider fallbacks, applied when the env leaves them unset. */
const PROVIDER_DEFAULTS: Record<
  LlmProviderName,
  { baseUrl: string; model: string; timeoutMs: number }
> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', timeoutMs: 60_000 },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', timeoutMs: 60_000 },
  ollama: { baseUrl: 'http://localhost:11434', model: 'llama3.1', timeoutMs: 180_000 },
  mock: { baseUrl: '', model: 'heuristic-1', timeoutMs: 0 },
};

const envSchema = z.object({
  RADARR_URL: z.string().url().default('http://localhost:7878'),
  RADARR_API_KEY: z.string().min(1),
  TMDB_API_KEY: z.string().min(1),
  TMDB_BASE_URL: z.string().url().default('https://api.themoviedb.org/3'),
  LLM_PROVIDER: z.enum(['openai', 'anthropic', 'ollama', 'mock']).default('mock'),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  LLM_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  DISCORD_BOT_TOKEN: z.string().min(1).optional(),
  DISCORD_CHANNEL_ID: z.string().min(1).optional(),
  DISCORD_CLIENT_ID: z.string().min(1).optional(),
  DISCORD_GUILD_ID: z.string().min(1).optional(),
  RADARR_ROOT_FOLDER: z.string().min(1).optional(),
  RADARR_QUALITY_PROFILE: z.string().min(1).optional(),
  ARR_SEARCH_ON_ADD: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SUGGESTARR_SCHEDULE: z.string().min(1).default('0 18 * * *'),
  SUGGESTARR_TZ: z.string().min(1).default('Europe/Oslo'),
  SUGGESTARR_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(10),
  SUGGESTARR_EXPIRE_AFTER_DAYS: z.coerce.number().positive().max(365).default(2),
  SUGGESTARR_TASTE_NOTES: z.string().min(1).optional(),
  SUGGESTARR_RUN_ON_START: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DISCOVERY_PAGES: z.coerce.number().int().positive().max(10).default(3),
  DISCOVERY_UPCOMING_SLOTS: z.coerce.number().int().nonnegative().max(50).default(3),
  DISCOVERY_EXEMPT_UPCOMING: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  DISCOVERY_MIN_RATING: z.coerce.number().min(0).max(10).default(6),
  DISCOVERY_MIN_VOTES: z.coerce.number().int().nonnegative().default(100),
  DISCOVERY_YEAR_FROM: z.coerce.number().int().positive().optional(),
  DISCOVERY_INCLUDE_GENRES: z.string().optional(),
  DISCOVERY_EXCLUDE_GENRES: z.string().optional(),
  SUGGESTARR_DB_PATH: z.string().min(1).default('./data/suggestarr.db'),
  SUGGESTARR_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
});

export interface LlmConfig {
  provider: LlmProviderName;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** absent for providers that need no credential (ollama, mock) */
  apiKey?: string;
  /** thinking depth / cost dial, Anthropic only; unset = provider default */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** Where approved titles land. Names are resolved against the Radarr API. */
export interface ArrPlacement {
  rootFolder?: string;
  qualityProfile?: string;
  searchOnAdd: boolean;
}

/**
 * Present only when the bot is configured. `library`, `discover` and
 * `judge` run happily without it; `bot` does not.
 */
export interface DiscordConfig {
  botToken: string;
  channelId: string;
  clientId: string;
  guildId?: string;
}

/** When cycles run, and how big each one is. */
export interface ScheduleConfig {
  /** cron expression, evaluated in `timezone` */
  cron: string;
  timezone: string;
  /** max candidates handed to the agent per cycle */
  batchSize: number;
  /** how many of those slots are held for unreleased films */
  upcomingSlots: number;
  /**
   * Days before an unanswered suggestion is closed out. Expiry is not a
   * "no" — the title goes back in the pool and can be suggested again.
   */
  expireAfterDays: number;
  /** run one cycle at boot instead of waiting for the first cron fire */
  runOnStart: boolean;
}

export interface Config {
  radarr: { baseUrl: string; apiKey: string };
  tmdb: { baseUrl: string; apiKey: string };
  llm: LlmConfig;
  placement: ArrPlacement;
  discord?: DiscordConfig;
  schedule: ScheduleConfig;
  discovery: DiscoveryPrefs;
  /** TMDB pages walked per broad discovery source */
  discoveryPages: number;
  /** static taste notes, merged with the learned profile each cycle */
  tasteNotes?: string;
  dbPath: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug';
}

/**
 * Load and validate configuration from process environment.
 * Throws with a readable summary on invalid/missing values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  const defaults = PROVIDER_DEFAULTS[e.LLM_PROVIDER];
  const includeGenres = parseGenreIds(e.DISCOVERY_INCLUDE_GENRES);
  const excludeGenres = parseGenreIds(e.DISCOVERY_EXCLUDE_GENRES);

  return {
    radarr: { baseUrl: e.RADARR_URL, apiKey: e.RADARR_API_KEY },
    tmdb: { baseUrl: e.TMDB_BASE_URL, apiKey: e.TMDB_API_KEY },
    llm: {
      provider: e.LLM_PROVIDER,
      baseUrl: e.LLM_BASE_URL ?? defaults.baseUrl,
      model: e.LLM_MODEL ?? defaults.model,
      timeoutMs: e.LLM_TIMEOUT_MS ?? defaults.timeoutMs,
      ...(e.LLM_API_KEY ? { apiKey: e.LLM_API_KEY } : {}),
      ...(e.LLM_EFFORT ? { effort: e.LLM_EFFORT } : {}),
    },
    placement: {
      ...(e.RADARR_ROOT_FOLDER ? { rootFolder: e.RADARR_ROOT_FOLDER } : {}),
      ...(e.RADARR_QUALITY_PROFILE ? { qualityProfile: e.RADARR_QUALITY_PROFILE } : {}),
      searchOnAdd: e.ARR_SEARCH_ON_ADD,
    },
    ...(e.DISCORD_BOT_TOKEN && e.DISCORD_CHANNEL_ID && e.DISCORD_CLIENT_ID
      ? {
          discord: {
            botToken: e.DISCORD_BOT_TOKEN,
            channelId: e.DISCORD_CHANNEL_ID,
            clientId: e.DISCORD_CLIENT_ID,
            ...(e.DISCORD_GUILD_ID ? { guildId: e.DISCORD_GUILD_ID } : {}),
          },
        }
      : {}),
    schedule: {
      cron: e.SUGGESTARR_SCHEDULE,
      timezone: e.SUGGESTARR_TZ,
      batchSize: e.SUGGESTARR_BATCH_SIZE,
      upcomingSlots: e.DISCOVERY_UPCOMING_SLOTS,
      expireAfterDays: e.SUGGESTARR_EXPIRE_AFTER_DAYS,
      runOnStart: e.SUGGESTARR_RUN_ON_START,
    },
    discovery: {
      minRating: e.DISCOVERY_MIN_RATING,
      minVotes: e.DISCOVERY_MIN_VOTES,
      exemptUpcoming: e.DISCOVERY_EXEMPT_UPCOMING,
      ...(e.DISCOVERY_YEAR_FROM !== undefined ? { yearFrom: e.DISCOVERY_YEAR_FROM } : {}),
      ...(includeGenres.length ? { includeGenres } : {}),
      ...(excludeGenres.length ? { excludeGenres } : {}),
    },
    discoveryPages: e.DISCOVERY_PAGES,
    ...(e.SUGGESTARR_TASTE_NOTES ? { tasteNotes: e.SUGGESTARR_TASTE_NOTES } : {}),
    dbPath: e.SUGGESTARR_DB_PATH,
    logLevel: e.SUGGESTARR_LOG_LEVEL,
  };
}

/** "18,28" -> [18, 28]; blanks and non-numbers are dropped. */
function parseGenreIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * The bot needs a token, a channel and an application id. Missing any of
 * them is a configuration mistake, not a runtime condition to handle.
 */
export function requireDiscord(config: Config): DiscordConfig {
  if (!config.discord) {
    throw new Error(
      'Discord is not configured: set DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID and DISCORD_CLIENT_ID',
    );
  }
  return config.discord;
}
