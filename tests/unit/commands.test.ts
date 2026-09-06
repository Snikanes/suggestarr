import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../src/discord/commands.js';

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
