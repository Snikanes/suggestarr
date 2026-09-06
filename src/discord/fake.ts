import type { SuggestionEmbed } from './embeds.js';
import type {
  CommandEvent,
  CommandReply,
  DiscordGateway,
  PostedMessage,
  ReactionEvent,
  ReactionSnapshot,
} from './gateway.js';

/**
 * In-memory Discord. Captures what would have been posted and lets a test
 * (or a MOCK_MODE run) drive reactions and commands through exactly the
 * handlers the real gateway would call.
 */
export class FakeGateway implements DiscordGateway {
  readonly posted: (PostedMessage & { embed: SuggestionEmbed; reactions: string[] })[] = [];
  readonly notices: string[] = [];
  readonly edits: (PostedMessage & { embed: SuggestionEmbed })[] = [];
  started = false;

  /** messageId -> reactions already sitting on it */
  private readonly standingReactions = new Map<string, ReactionSnapshot[]>();
  /** messages that no longer exist, to exercise the deleted-message path */
  private readonly deleted = new Set<string>();

  private reactionHandler?: (event: ReactionEvent) => Promise<void>;
  private commandHandler?: (event: CommandEvent) => Promise<CommandReply>;
  private nextId = 1;

  constructor(readonly channelId = 'channel-1') {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async post(embed: SuggestionEmbed, reactions: string[]): Promise<PostedMessage> {
    const message = { channelId: this.channelId, messageId: `msg-${this.nextId++}` };
    this.posted.push({ ...message, embed, reactions });
    return message;
  }

  async edit(message: PostedMessage, embed: SuggestionEmbed): Promise<void> {
    this.edits.push({ ...message, embed });
    const post = this.posted.find((p) => p.messageId === message.messageId);
    if (post) post.embed = embed;
  }

  async notice(text: string): Promise<void> {
    this.notices.push(text);
  }

  onReaction(handler: (event: ReactionEvent) => Promise<void>): void {
    this.reactionHandler = handler;
  }

  onCommand(handler: (event: CommandEvent) => Promise<CommandReply>): void {
    this.commandHandler = handler;
  }

  async reactionsOn(message: PostedMessage): Promise<ReactionSnapshot[]> {
    if (this.deleted.has(message.messageId)) {
      throw new Error(`Unknown Message ${message.messageId}`);
    }
    return this.standingReactions.get(message.messageId) ?? [];
  }

  /** Test driver: a reaction that landed while nothing was listening. */
  seedReaction(messageId: string, emoji: string, userIds: string[] = ['user-1']): void {
    const existing = this.standingReactions.get(messageId) ?? [];
    existing.push({ emoji, userIds });
    this.standingReactions.set(messageId, existing);
  }

  /** Test driver: someone deleted the message out from under us. */
  deleteMessage(messageId: string): void {
    this.deleted.add(messageId);
  }

  /** Test driver: pretend a user reacted to a posted message. */
  async react(messageId: string, emoji: string, opts: { userIsBot?: boolean } = {}): Promise<void> {
    if (!this.reactionHandler) throw new Error('no reaction handler registered');
    await this.reactionHandler({
      messageId,
      channelId: this.channelId,
      emoji,
      userId: 'user-1',
      userIsBot: opts.userIsBot ?? false,
    });
  }

  /** Test driver: pretend a user ran a slash command. */
  async command(
    name: string,
    options: Record<string, string | number | undefined> = {},
  ): Promise<CommandReply> {
    if (!this.commandHandler) throw new Error('no command handler registered');
    return this.commandHandler({ name, options, userId: 'user-1' });
  }

  /** The embed currently shown for a message (post, or latest edit). */
  embedOf(messageId: string): SuggestionEmbed | undefined {
    return this.posted.find((p) => p.messageId === messageId)?.embed;
  }
}
