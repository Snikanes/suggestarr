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
  /** post an embed and pre-seed it with the given reactions */
  post(embed: SuggestionEmbed, reactions: string[]): Promise<PostedMessage>;
  edit(message: PostedMessage, embed: SuggestionEmbed): Promise<void>;
  /** plain-text channel message, e.g. a cycle failure report */
  notice(text: string): Promise<void>;
  /**
   * Reactions already on a message. Discord does not replay reactions
   * that arrived while the gateway was disconnected, so this is the only
   * way to catch up on them after a restart.
   */
  reactionsOn(message: PostedMessage): Promise<ReactionSnapshot[]>;
  onReaction(handler: (event: ReactionEvent) => Promise<void>): void;
  onCommand(handler: (event: CommandEvent) => Promise<CommandReply>): void;
}
