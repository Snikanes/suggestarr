# Suggestarr

Suggestarr watches your Radarr library, discovers new movies on TMDB, asks an LLM to judge which
ones are actually worth your disk space, and posts the survivors to Discord. React ✅ and the movie
is added to Radarr as monitored — your existing *arr stack takes it from there. React ❌ and it is
never suggested again.

**Movies only.** There is no Sonarr integration and no series support anywhere in the model.

Every verdict, kept or dropped, is written to a local SQLite decision log along with the agent's
reasoning, so you can see *why* something was suggested — or why something you wanted never showed
up — and tune the prompt from evidence rather than vibes.

```
TMDB ──► candidacy filters ──► LLM judge ──► Discord embed ──► ✅ ──► Radarr ──► qBittorrent
Radarr library ─┘                   ▲                         └─ ❌ ──► never again
                                    └── taste profile (recent additions + your past answers)
```

## Requirements

- Node 22+
- Radarr, reachable over HTTP, with an API key
- A TMDB API key (free)
- A Discord bot token, application id, and a channel to post in
- An LLM: OpenAI, Anthropic, or a local Ollama — or `mock`, which needs neither key nor network

## Setup

```bash
npm install
cp .env.example .env    # then fill it in
npm run typecheck && npm test
```

`.env` is read from the working directory at startup — Node's own loader, no `dotenv` dependency.
**Real environment variables always win over the file**, so exporting `RADARR_URL=...` for one run
overrides what `.env` says, and in Docker (where Compose sets the environment directly) a stray
`.env` can never override the container's config. A missing `.env` is fine: the environment alone
is enough.

Point `RADARR_URL` at your instance and paste the API key (Settings → General in Radarr). `LLM_PROVIDER=mock` is a good first run: it uses an offline heuristic judge, so you can
watch the whole pipeline work before spending a token.

## Commands

| Command | What it does |
|---|---|
| `npm run library` | List what Radarr currently holds — a connectivity check |
| `npm run judge` | Run one cycle and print the verdicts. No Discord involved |
| `npm run cycle` | Run one cycle **and post it to Discord**, then exit |
| `npm run bot` | Start the Discord bot and the cycle schedule. This is the real thing |
| `npm run report:decisions` | Prompt-version scoreboard, agent/human mismatches, what is pending |
| `npm run report:html [path]` | The same evidence as a standalone HTML page you'd actually read |
| `npm test` / `npm run test:coverage` | The full suite, every integration mocked |

## How a cycle works

1. **Library**: Radarr is read for everything you own. If Radarr is unreachable the cycle stops —
   Suggestarr will not suggest a movie it cannot prove you lack.
2. **Discovery**: TMDB trending, movies releasing from tomorrow onward, and "more like what you
   own", seeded from your own library. Each source walks `DISCOVERY_PAGES` pages (20 titles each)
   and fails independently.
3. **Filters**: minimum rating and vote count, optional year floor and genre include/exclude,
   dedupe against the library and against anything already judged. **Unreleased films skip the
   rating/vote floor** — they cannot have been rated yet, and holding them to it would delete the
   most interesting source outright.
4. **Judge**: one LLM call per cycle, capped at `SUGGESTARR_BATCH_SIZE` candidates — best-rated
   released films, plus `DISCOVERY_UPCOMING_SLOTS` slots held for the most anticipated unreleased
   ones (ranked by TMDB popularity, since they have no score). Unused slots go back to the other
   side. The reply must be strict JSON; a malformed answer gets exactly one corrective retry, and a
   candidate the model forgets is treated as a **drop**, never as an approval.
5. **Post**: kept titles become Discord embeds with the poster, TMDB score and the agent's
   reasoning. Dropped titles stay in the log, reachable via `/decisions`.
6. **Answer**: ✅ resolves the movie through Radarr's own lookup and adds it monitored with
   search-on-add; ❌ records a permanent no. Either way the decision row gets its outcome.
7. **Unanswered**: after `SUGGESTARR_EXPIRE_AFTER_DAYS` (default 2) a suggestion nobody reacted to
   expires. That is **not** a no — the embed greys out, the title goes back in the pool, and a later
   cycle can suggest it again. Only a real ✅/❌ retires a title for good.

Answers given while the bot was offline are not lost: at startup it reads the reactions already
sitting on every pending suggestion and applies them (a ❌ wins if both are present). Discord never
replays reactions to a gateway that was disconnected, so without this a ✅ pressed overnight would
sit unnoticed.

### Running a cycle on demand

Discord has deliberately no `/suggest` command — a scheduled cycle (`SUGGESTARR_SCHEDULE`, evaluated
in `SUGGESTARR_TZ`) is the only thing that fires one from the chat side. Operator-side there are
three ways to run one now:

| Want | Do |
|---|---|
| See what it would suggest, no Discord, no cost with `mock` | `npm run judge` |
| A real cycle posted to Discord, then exit | `npm run cycle` |
| A cycle inside the bot that is already running | `kill -SIGUSR1 <pid>` |
| A cycle every time the bot boots | `SUGGESTARR_RUN_ON_START=true` |

In Docker the signal is `docker kill -s SIGUSR1 suggestarr`. The bot logs its own pid at startup.
The scheduler's overlap guard applies to manual triggers too, so signalling during a running cycle
is refused rather than doubling up — and the schedule itself is unaffected either way.

`npm run cycle` exits when the cycle is done, so nothing is listening for reactions afterwards —
but they are not lost: the next `npm run bot` reads them off the messages at startup and applies
them.

## Discord commands

| Command | Purpose |
|---|---|
| `/add <tmdb_id>` | Approve a pending suggestion, or force-add a movie the agent dropped |
| `/skip <tmdb_id>` | Record a permanent no |
| `/decisions [tmdb_id]` | Audit the verdicts, including everything the agent dropped |
| `/status` | What is pending, and the lifetime approve/reject/force-add tally |

The bot needs no privileged intents: reactions and slash commands only, no Message Content.

## The learning loop

Each cycle feeds the agent what it has learned about you:

- titles you accepted,
- titles you rejected (do not suggest anything like this again),
- titles it **dropped and you added anyway** — the highest-value signal, because it is the only one
  that shows what the agent is blind to,
- and what you recently added to Radarr and actually have on disk.

That snapshot is hashed into every verdict row next to the prompt version, so `npm run
report:decisions` can show whether a prompt edit actually lowered how often you overrule the agent.

## Configuration

Every setting is an environment variable; see `.env.example` for the annotated list. The ones worth
knowing:

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `mock` | `openai`, `anthropic`, `ollama`, or `mock` |
| `LLM_MODEL` / `LLM_BASE_URL` | per provider | Override the provider defaults |
| `LLM_EFFORT` | provider default | Anthropic thinking depth: `low`…`max` |
| `SUGGESTARR_SCHEDULE` | `0 18 * * *` | Cron expression for the cycle |
| `SUGGESTARR_TZ` | `Europe/Oslo` | Timezone the cron is evaluated in |
| `SUGGESTARR_BATCH_SIZE` | `10` | Max candidates per agent call |
| `SUGGESTARR_EXPIRE_AFTER_DAYS` | `2` | Unanswered suggestions expire and return to the pool |
| `DISCOVERY_UPCOMING_SLOTS` | `3` | Batch slots reserved for unreleased films |
| `DISCOVERY_PAGES` | `3` | TMDB pages walked per source (20 titles each) |
| `DISCOVERY_EXEMPT_UPCOMING` | `true` | Waive the rating/vote floor for unreleased films |
| `SUGGESTARR_TASTE_NOTES` | — | Free-text preferences, always sent to the agent |
| `DISCOVERY_MIN_RATING` / `DISCOVERY_MIN_VOTES` | `6` / `100` | Candidate quality floor |
| `RADARR_ROOT_FOLDER` / `RADARR_QUALITY_PROFILE` | first available | Where approvals land |
| `SUGGESTARR_DB_PATH` | `./data/suggestarr.db` | SQLite state |

## Deployment

Suggestarr ships as a container that behaves like the other *arr services on the host: `PUID`/`PGID`/`TZ`/`UMASK_SET`, a `/config` volume, `restart: unless-stopped`, and a healthcheck.

```bash
docker compose build suggestarr
docker compose up -d suggestarr
docker logs -f suggestarr
```

`docker-compose.yml` defines the suggestarr service only — the rest of the *arr stack (Radarr,
gluetun, qBittorrent and friends) is managed separately on the host. Two things about it are
deliberate:

- **It does not run behind gluetun.** Suggestarr torrents nothing; it needs Discord, TMDB and the
  LLM provider directly. It reaches Radarr through `host.docker.internal:7878` — the port gluetun
  publishes on the host — so Radarr does not need to be in this compose project at all.
- **All state lives in `/config`** (`/usr/plex/bin/suggestarr` on the host), so the decision log
  survives restarts and image rebuilds.

Secrets come from `.env` via `env_file`, never inline in the compose file.

## Tests

`npm test` runs unit tests for every adapter and mapping plus a fully mocked end-to-end pipeline:
TMDB, Radarr and the LLM are stubbed HTTP, Discord is an in-memory fake, and the database is a real
SQLite file in a temp dir. No keys, no network — which is exactly what CI runs.

## Future work

### Discovery filters by taste; it does not search by it

Today the three discovery sources are trending, imminent releases, and "more like what you own"
seeded from a handful of library titles. The first two are global lists — the same ones everybody
else gets — which are then narrowed by the quality floor and the agent. Your taste therefore only
ever *rejects* candidates; it never *goes looking* for them.

That has three costs. The pool is capped by whatever happens to be popular this week. A library
with a distinct shape (mostly 70s thrillers, say) gets a batch of mostly-irrelevant titles, and the
judge drops most of it — tokens spent to say no. And a film that fits perfectly but is neither
trending nor similar-to-one-of-three-seeds simply never surfaces.

The alternative is to drive `/discover/movie` from the library itself: `with_genres`, `with_cast`,
`with_crew`, `with_keywords`, `vote_average.gte`, and release-date windows are all supported, so
"well-reviewed crime films by directors they already own, 1970-1999, that they don't have" is one
query rather than a filter applied after the fact.

**The blocker is metadata we don't have.** Radarr's movie payload gives us title, year, `tmdbId`,
`added` and `hasFile` — no genres, no cast, no crew, no keywords. TMDB has all of it, but only
per-title (`/movie/{id}` plus `credits` and `keywords`). Building a taste profile from a 500-film
library therefore means 500 detail calls, which is only acceptable once: it needs a local metadata
cache (a table keyed by `tmdbId`, filled on a backfill pass, refreshed rarely — a 1994 film's
director does not change), plus polite rate limiting on the first run.

With that cache in place the profile is straightforward: weight each owned title by how recently it
was added and by its outcome (a title you approved counts for more than one that was already there
when you started), then take the top genres, directors and keywords.

Four things are worth deciding before writing any of it:

- **How much of each batch should be targeted?** Probably the same reserved-slot mechanic that
  unreleased films use, so serendipity keeps a guaranteed share.
- **Over-fitting is a real risk.** If discovery only searches for what you already like, the agent
  loses the chance to surprise you — and the drop-then-force-add signal, which the entire decision
  log exists to capture, dries up. Trending should stay in the mix precisely because it is not
  taste-shaped.
- **Does the prompt still need the library summary?** Probably yes: the agent uses it to judge
  redundancy ("you own three of these already"), which targeted discovery makes *more* likely, not
  less.
- **Refresh and gaps.** How often to re-fetch cached metadata, and what to do with library entries
  Radarr never matched to TMDB (`remoteId: null`) — they carry no facets and would be invisible to
  the profile.

### Smaller deferred items

- **Nothing retries a failed add.** When Radarr refuses an approval the suggestion is marked
  `failed` with the error, and the decision deliberately stays pending so a retry is possible — but
  nothing actually retries it. Expiry eventually collects it. Wants either a `/retry` command or an
  automatic re-attempt at the start of a cycle.
- **`excludedIds()` loads every judged id into memory** on every cycle. Fine at hundreds, wasteful
  at tens of thousands; it belongs in the dedupe query as a `NOT EXISTS` subquery.
- **Suggestions don't ping anyone.** A Discord mention only notifies from message *content* (embeds
  never do) and must be the `<@user-id>` form — a literal `@name` looks like a mention and notifies
  nobody. Adding it means a configured user id plus an explicit `allowed_mentions` so a message can
  only ever ping that one target.

## Legal

Suggestarr adds movies to Radarr. It downloads nothing itself; acquisition is your existing
stack's business, through your own indexers and VPN, for personal use.
