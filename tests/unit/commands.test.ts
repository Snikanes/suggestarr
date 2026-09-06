import { describe, expect, it } from 'vitest';
import { buildCommands, CHOICE_LIMIT } from '../../src/discord/commands.js';

const COMMANDS = buildCommands();

describe('slash command definitions', () => {
  it('registers exactly add, skip, decisions and status', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(['add', 'skip', 'decisions', 'status']);
  });

  it('has no /suggest — cycles are scheduled, never hand-triggered', () => {
    expect(COMMANDS.some((c) => c.name === 'suggest')).toBe(false);
  });

  it('requires a tmdb id where it acts, and makes it optional where it reports', () => {
    const required = (name: string) =>
      COMMANDS.find((c) => c.name === name)?.options.find((o) => o.name === 'tmdb_id')?.required;

    expect(required('add')).toBe(true);
    expect(required('skip')).toBe(true);
    expect(required('decisions')).toBe(false);
    expect(COMMANDS.find((c) => c.name === 'status')?.options).toEqual([]);
  });

  it('takes a TMDB id and nothing else — there is no media kind to pick', () => {
    for (const command of COMMANDS) {
      expect(command.options.map((o) => o.name)).toEqual(
        command.name === 'status' ? [] : ['tmdb_id'],
      );
    }
  });

  it('describes every command and option for the Discord UI', () => {
    for (const command of COMMANDS) {
      expect(command.description.length).toBeGreaterThan(10);
      for (const option of command.options) {
        expect(option.description.length).toBeGreaterThan(5);
        expect(option.type).toBe(4); // INTEGER
      }
    }
  });
});

describe('/add quality_profile', () => {
  const profiles = [
    { id: 4, name: 'HD-1080p' },
    { id: 6, name: 'Ultra-HD' },
  ];
  const addOptions = (list: { id: number; name: string }[]) =>
    buildCommands(list).find((c) => c.name === 'add')!.options;

  it('offers every Radarr profile as an optional choice', () => {
    const option = addOptions(profiles).find((o) => o.name === 'quality_profile');
    expect(option?.required).toBe(false);
    expect(option?.type).toBe(3); // STRING
    expect(option?.choices).toEqual([
      { name: 'HD-1080p', value: 'HD-1080p' },
      { name: 'Ultra-HD', value: 'Ultra-HD' },
    ]);
  });

  it('omits the option entirely when Radarr named no profiles', () => {
    expect(addOptions([]).map((o) => o.name)).toEqual(['tmdb_id']);
  });

  it('truncates to what Discord will accept', () => {
    const many = Array.from({ length: CHOICE_LIMIT + 5 }, (_, i) => ({
      id: i,
      name: `profile-${i}`,
    }));
    const option = addOptions(many).find((o) => o.name === 'quality_profile');
    expect(option?.choices).toHaveLength(CHOICE_LIMIT);
    expect(option?.choices?.at(-1)?.name).toBe(`profile-${CHOICE_LIMIT - 1}`);
  });

  it('leaves the other commands alone', () => {
    for (const command of buildCommands(profiles)) {
      if (command.name === 'add') continue;
      expect(command.options.every((o) => o.name === 'tmdb_id')).toBe(true);
    }
  });
});
