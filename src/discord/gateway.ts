import type { SuggestionEmbed } from './embeds.js';

export interface PostedMessage {
  channelId: string;
  messageId: string;
}

export interface ReactionEvent {
  messageId: string;
  channelId: string;
  /** the emoji as a unicode string, e.g. "✅" */
  emoji: string;
  userId: string;
  userIsBot: boolean;
}

/** Who has already reacted to a message, bots excluded. */
export interface ReactionSnapshot {
  emoji: string;
  /** ids of the non-bot users who reacted */
  userIds: string[];
}

/** One entry in a select menu. */
export interface SelectOption {
  label: string;
  value: string;
  description?: string;
}

/**
 * A single select menu attached under a message's embed.
 *
 * Reactions cannot carry a dropdown — a menu is a message component, and
 * a click on it arrives as an interaction rather than a reaction. Absent
 * means the message has no components at all, which is also how a
 * resolved message loses the menu it was posted with.
 */
export interface MessageComponents {
  customId: string;
  placeholder: string;
  options: SelectOption[];
}

/** Someone used a message component. */
export interface ComponentEvent {
  customId: string;
  /** the chosen option values; one entry for a single-choice menu */
  values: string[];
  messageId: string;
  channelId: string;
  userId: string;
  userIsBot: boolean;
}

export interface CommandEvent {
  name: string;
  options: Record<string, string | number | undefined>;
  userId: string;
}

export interface CommandReply {
  text: string;
  /** true = only the invoking user sees it */
  ephemeral: boolean;
}

/**
 * Everything the suggestion logic needs from Discord, and nothing more.
 *
 * Keeping this seam narrow is what lets the whole approve/reject flow be
 * tested against an in-memory fake, with discord.js appearing only in the
 * one adapter that implements it.
 */
export interface DiscordGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** post an embed, pre-seed the given reactions, attach any components */
  post(
    embed: SuggestionEmbed,
    reactions: string[],
    components?: MessageComponents,
  ): Promise<PostedMessage>;
  /** edit an embed; omitting `components` strips whatever was there */
  edit(
    message: PostedMessage,
    embed: SuggestionEmbed,
    components?: MessageComponents,
  ): Promise<void>;
  /** plain-text channel message, e.g. a cycle failure report */
  notice(text: string): Promise<void>;
  /**
   * Reactions already on a message. Discord does not replay reactions
   * that arrived while the gateway was disconnected, so this is the only
   * way to catch up on them after a restart. Component interactions have
   * no equivalent — they are simply lost — which is why reactions remain
   * the answer path that survives downtime.
   */
  reactionsOn(message: PostedMessage): Promise<ReactionSnapshot[]>;
  onReaction(handler: (event: ReactionEvent) => Promise<void>): void;
  onComponent(handler: (event: ComponentEvent) => Promise<CommandReply>): void;
  onCommand(handler: (event: CommandEvent) => Promise<CommandReply>): void;
}
