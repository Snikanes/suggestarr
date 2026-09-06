import { describe, expect, it } from 'vitest';
import { FakeGateway } from '../../src/discord/fake.js';
import { buildSuggestionEmbed } from '../../src/discord/embeds.js';
import { matrixCandidate } from '../fixtures/agent.js';

const embed = buildSuggestionEmbed(
  matrixCandidate,
  { remoteId: 603, keep: true, reason: 'Good.' },
  { model: 'm', promptVersion: 'v1' },
);

describe('FakeGateway', () => {
  it('tracks the connection lifecycle', async () => {
    const gateway = new FakeGateway();
    expect(gateway.started).toBe(false);

    await gateway.start();
    expect(gateway.started).toBe(true);

    await gateway.stop();
    expect(gateway.started).toBe(false);
  });

  it('hands out increasing message ids on the configured channel', async () => {
    const gateway = new FakeGateway('channel-42');
    const first = await gateway.post(embed, ['✅']);
    const second = await gateway.post(embed, []);

    expect(first).toEqual({ channelId: 'channel-42', messageId: 'msg-1' });
    expect(second.messageId).toBe('msg-2');
    expect(gateway.posted[0]?.reactions).toEqual(['✅']);
  });

  it('replaces the stored embed on edit and records the edit', async () => {
    const gateway = new FakeGateway();
    const message = await gateway.post(embed, []);
    await gateway.edit(message, { ...embed, title: 'Edited' });

    expect(gateway.embedOf(message.messageId)?.title).toBe('Edited');
    expect(gateway.edits).toHaveLength(1);
  });

  it('tolerates an edit for a message it never posted', async () => {
    const gateway = new FakeGateway();
    await gateway.edit({ channelId: 'c', messageId: 'nope' }, embed);

    expect(gateway.edits).toHaveLength(1);
    expect(gateway.embedOf('nope')).toBeUndefined();
  });

  it('reports the reactions standing on a message', async () => {
    const gateway = new FakeGateway();
    const message = await gateway.post(embed, ['✅']);

    expect(await gateway.reactionsOn(message)).toEqual([]);

    gateway.seedReaction(message.messageId, '✅', ['user-7']);
    gateway.seedReaction(message.messageId, '❌', []);
    expect(await gateway.reactionsOn(message)).toEqual([
      { emoji: '✅', userIds: ['user-7'] },
      { emoji: '❌', userIds: [] },
    ]);
  });

  it('throws for a message that no longer exists', async () => {
    const gateway = new FakeGateway();
    const message = await gateway.post(embed, []);
    gateway.deleteMessage(message.messageId);

    await expect(gateway.reactionsOn(message)).rejects.toThrow(/Unknown Message/);
  });

  it('refuses to drive handlers that were never registered', async () => {
    const gateway = new FakeGateway();
    await expect(gateway.react('msg-1', '✅')).rejects.toThrow(/no reaction handler/);
    await expect(gateway.command('status')).rejects.toThrow(/no command handler/);
  });
});
