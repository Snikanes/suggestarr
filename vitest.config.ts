import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/arr/**',
        'src/tmdb/**',
        'src/discovery/**',
        'src/agent/**',
        'src/state/**',
        'src/discord/**',
        'src/config.ts',
        'src/cycle.ts',
        'src/scheduler.ts',
        'src/health.ts',
        'src/report.ts',
        'src/discovery/**',
      ],
      // The discord.js adapter is the one place a real gateway connection
      // would be needed; its only pure part (toDiscordEmbed) is tested.
      // discordjs.ts is the one adapter needing a real gateway connection
      // (its only pure part, toDiscordEmbed, is tested); gateway.ts is
      // interfaces only and emits no runtime code.
      exclude: ['src/discord/discordjs.ts', 'src/discord/gateway.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
      },
    },
  },
});
