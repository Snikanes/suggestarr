import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  REST,
  Routes,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Message,
  type SendableChannels,
} from 'discord.js';
import type { DiscordConfig } from '../config.js';
import { buildCommands, type CommandJson } from './commands.js';
import type { SuggestionEmbed } from './embeds.js';
import type {
  CommandEvent,
  CommandReply,
  ComponentEvent,
  DiscordGateway,
  MessageComponents,
  PostedMessage,
  ReactionEvent,
  ReactionSnapshot,
} from './gateway.js';

/**
 * The one place discord.js appears. Everything above it works against the
 * DiscordGateway interface, so the approve/reject logic is exercised by
 * the fake gateway instead of a mocked client.
 *
 * Intents are the minimum for this bot: guild messages and reactions.
 * Message Content is deliberately NOT requested — suggestions are driven
 * by reactions and slash commands, so the privileged intent is not needed.
 * Partials are required because a reaction can arrive for a message that
 * was posted before this process started and is therefore uncached.
 */
export class DiscordJsGateway implements DiscordGateway {
  private readonly client: Client;
  private reactionHandler?: (event: ReactionEvent) => Promise<void>;
  private componentHandler?: (event: ComponentEvent) => Promise<CommandReply>;
  private commandHandler?: (event: CommandEvent) => Promise<CommandReply>;

  constructor(
    private readonly cfg: DiscordConfig,
    private readonly commands: CommandJson[] = buildCommands(),
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
    });
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      if (!this.reactionHandler) return;
      if (reaction.partial) await reaction.fetch();
      await this.reactionHandler({
        messageId: reaction.message.id,
        channelId: reaction.message.channelId,
        emoji: reaction.emoji.name ?? '',
        userId: user.id,
        userIsBot: user.bot ?? false,
      });
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (interaction.isStringSelectMenu()) {
        if (!this.componentHandler) return;
        // Radarr's lookup + add can outlast Discord's three-second
        // acknowledgement window, so acknowledge before doing the work.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const reply = await this.componentHandler({
          customId: interaction.customId,
          values: interaction.values,
          messageId: interaction.message.id,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          userIsBot: interaction.user.bot,
        });
        await interaction.editReply({ content: reply.text });
        return;
      }
      if (!interaction.isChatInputCommand() || !this.commandHandler) return;
      const options: Record<string, string | number | undefined> = {};
      for (const option of interaction.options.data) {
        options[option.name] = option.value as string | number | undefined;
      }
      // `/add` reaches Radarr (lookup + add, plus the one-off root folder
      // and quality profile reads), which routinely outlasts Discord's
      // three-second window on the first call after an idle spell. Every
      // command reply is ephemeral, so the visibility is known up front
      // and the deferral costs nothing.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const reply = await this.commandHandler({
        name: interaction.commandName,
        options,
        userId: interaction.user.id,
      });
      await interaction.editReply({ content: reply.text });
    });

    await this.registerCommands();
    await this.client.login(this.cfg.botToken);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  async post(
    embed: SuggestionEmbed,
    reactions: string[],
    components?: MessageComponents,
  ): Promise<PostedMessage> {
    const channel = await this.textChannel();
    const message = await channel.send({
      embeds: [toDiscordEmbed(embed)],
      components: toActionRows(components),
    });
    for (const emoji of reactions) await message.react(emoji);
    return { channelId: message.channelId, messageId: message.id };
  }

  async edit(
    target: PostedMessage,
    embed: SuggestionEmbed,
    components?: MessageComponents,
  ): Promise<void> {
    const message = await this.fetchMessage(target);
    // An empty array is what strips a resolved message's dropdown.
    await message.edit({ embeds: [toDiscordEmbed(embed)], components: toActionRows(components) });
  }

  async notice(text: string): Promise<void> {
    const channel = await this.textChannel();
    await channel.send({ content: text });
  }

  async reactionsOn(target: PostedMessage): Promise<ReactionSnapshot[]> {
    const message = await this.fetchMessage(target);
    const snapshots: ReactionSnapshot[] = [];

    for (const reaction of message.reactions.cache.values()) {
      // The bot seeds ✅/❌ itself, so its own reactions must not count.
      const users = await reaction.users.fetch();
      snapshots.push({
        emoji: reaction.emoji.name ?? '',
        userIds: users.filter((u) => !u.bot).map((u) => u.id),
      });
    }
    return snapshots;
  }

  onReaction(handler: (event: ReactionEvent) => Promise<void>): void {
    this.reactionHandler = handler;
  }

  onComponent(handler: (event: ComponentEvent) => Promise<CommandReply>): void {
    this.componentHandler = handler;
  }

  onCommand(handler: (event: CommandEvent) => Promise<CommandReply>): void {
    this.commandHandler = handler;
  }

  /**
   * Guild-scoped registration when a guild id is configured (updates are
   * instant); global otherwise (can take up to an hour to propagate).
   */
  private async registerCommands(): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(this.cfg.botToken);
    const route = this.cfg.guildId
      ? Routes.applicationGuildCommands(this.cfg.clientId, this.cfg.guildId)
      : Routes.applicationCommands(this.cfg.clientId);
    await rest.put(route, { body: this.commands });
  }

  private async textChannel(): Promise<SendableChannels> {
    const channel = await this.client.channels.fetch(this.cfg.channelId);
    if (!channel || !channel.isSendable()) {
      throw new Error(
        `Discord channel ${this.cfg.channelId} is not a text channel the bot can post in`,
      );
    }
    return channel;
  }

  private async fetchMessage(target: PostedMessage): Promise<Message> {
    const channel = await this.client.channels.fetch(target.channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel ${target.channelId} is not readable`);
    }
    return channel.messages.fetch(target.messageId);
  }
}

/** Internal component shape -> a discord.js action row, or none at all. */
export function toActionRows(
  components?: MessageComponents,
): ActionRowBuilder<StringSelectMenuBuilder>[] {
  if (!components) return [];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(components.customId)
    .setPlaceholder(components.placeholder)
    .addOptions(
      components.options.map((o) => {
        const option = new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value);
        if (o.description) option.setDescription(o.description);
        return option;
      }),
    );
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
}

/** Internal embed shape -> discord.js embed JSON. */
export function toDiscordEmbed(embed: SuggestionEmbed): Record<string, unknown> {
  return {
    title: embed.title,
    ...(embed.url ? { url: embed.url } : {}),
    description: embed.description,
    color: embed.color,
    fields: embed.fields.map((f) => ({ name: f.name, value: f.value, inline: f.inline })),
    ...(embed.imageUrl ? { thumbnail: { url: embed.imageUrl } } : {}),
    footer: { text: embed.footer },
  };
}
