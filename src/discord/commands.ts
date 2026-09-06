/**
 * Slash command definitions as plain JSON, in Discord's application
 * command schema. Kept free of discord.js so the shapes can be asserted
 * in tests and posted with a bare REST call.
 *
 * Deliberately no `/suggest`: cycles are scheduled, never hand-triggered.
 */
const INTEGER = 4;

export interface CommandOptionJson {
  type: number;
  name: string;
  description: string;
  required: boolean;
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

export const COMMANDS: CommandJson[] = [
  {
    name: 'add',
    description: 'Approve a pending suggestion, or force-add a title the agent dropped',
    options: [tmdbIdOption(true, 'TMDB id of the movie to add')],
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
