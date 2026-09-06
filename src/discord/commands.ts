import type { QualityProfile } from '../arr/adder.js';

/**
 * Slash command definitions as plain JSON, in Discord's application
 * command schema. Kept free of discord.js so the shapes can be asserted
 * in tests and posted with a bare REST call.
 *
 * Deliberately no `/suggest`: cycles are scheduled, never hand-triggered.
 */
const INTEGER = 4;
const STRING = 3;

/** Discord refuses more than 25 choices on an option, or 25 select options. */
export const CHOICE_LIMIT = 25;

export interface CommandChoiceJson {
  name: string;
  value: string;
}

export interface CommandOptionJson {
  type: number;
  name: string;
  description: string;
  required: boolean;
  choices?: CommandChoiceJson[];
}

export interface CommandJson {
  name: string;
  description: string;
  options: CommandOptionJson[];
}

const tmdbIdOption = (required: boolean, description: string): CommandOptionJson => ({
  type: INTEGER,
  name: 'tmdb_id',
  description,
  required,
});

const qualityProfileOption = (profiles: QualityProfile[]): CommandOptionJson => ({
  type: STRING,
  name: 'quality_profile',
  description: 'Quality profile to add at; the configured default when omitted',
  required: false,
  choices: profiles.slice(0, CHOICE_LIMIT).map((p) => ({ name: p.name, value: p.name })),
});

/**
 * The command list, with `/add`'s profile choices filled in from what
 * Radarr currently offers.
 *
 * An empty list drops the option entirely rather than registering an
 * unusable one, so a Radarr outage at startup degrades to a plain
 * `/add tmdb_id:…` instead of blocking command registration.
 */
export function buildCommands(profiles: QualityProfile[] = []): CommandJson[] {
  return [
    {
      name: 'add',
      description: 'Approve a pending suggestion, or force-add a title the agent dropped',
      options: [
        tmdbIdOption(true, 'TMDB id of the movie to add'),
        ...(profiles.length > 0 ? [qualityProfileOption(profiles)] : []),
      ],
    },
    {
      name: 'skip',
      description: 'Reject a title so it is never suggested again',
      options: [tmdbIdOption(true, 'TMDB id of the movie to skip')],
    },
    {
      name: 'decisions',
      description: "Audit the agent's verdicts, including what it dropped",
      options: [tmdbIdOption(false, 'Show every verdict for one TMDB id')],
    },
    {
      name: 'status',
      description: 'What is pending, and the lifetime approve/reject tally',
      options: [],
    },
  ];
}
