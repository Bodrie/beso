import {
  createGroupSchema,
  markReadAckSchema,
  markReadPayloadSchema,
  messageAckSchema,
  replyRefSchema,
  sendMessagePayloadSchema,
  sendMessageSchema,
  setGroupPictureSchema,
} from './conversations.js';

const ID = '01a13ed6-d3ec-71cb-b39f-fbc256a293b9';

describe('sendMessageSchema', () => {
  it('trims and bounds content', () => {
    expect(sendMessageSchema.parse({ content: ' hi ' })).toEqual({ content: 'hi' });
    expect(sendMessageSchema.safeParse({ content: '' }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ content: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('accepts a picture without text, but not a picture of another kind', () => {
    expect(sendMessageSchema.parse({ imageKey: `message/${ID}.webp` })).toEqual({
      content: '',
      imageKey: `message/${ID}.webp`,
    });
    expect(sendMessageSchema.safeParse({ imageKey: `post/${ID}.webp` }).success).toBe(false);
  });

  it('accepts a post to send, with or without text', () => {
    expect(sendMessageSchema.parse({ postId: ID })).toEqual({ content: '', postId: ID });
    expect(sendMessageSchema.parse({ postId: ID.toUpperCase(), content: 'look' })).toEqual({
      content: 'look',
      postId: ID,
    });
    expect(sendMessageSchema.safeParse({ postId: 'nope' }).success).toBe(false);
    expect(sendMessagePayloadSchema.safeParse({ conversationId: ID, postId: ID }).success).toBe(
      true,
    );
    expect(sendMessagePayloadSchema.safeParse({ conversationId: ID, content: '' }).success).toBe(
      false,
    );
  });

  it('requires a conversation on the socket event', () => {
    expect(sendMessagePayloadSchema.safeParse({ content: 'hi' }).success).toBe(false);
    expect(sendMessagePayloadSchema.safeParse({ content: 'hi', conversationId: ID }).success).toBe(
      true,
    );
  });
});

describe('client-supplied ids', () => {
  it('are lower-cased so text keys and comparisons match what the database stores', () => {
    const upper = ID.toUpperCase();
    expect(sendMessagePayloadSchema.parse({ content: 'hi', conversationId: upper })).toMatchObject({
      conversationId: ID,
    });
    expect(markReadPayloadSchema.parse({ conversationId: upper })).toEqual({ conversationId: ID });
    expect(createGroupSchema.parse({ title: 'Trip', memberIds: [upper] }).memberIds).toEqual([ID]);
  });
});

describe('createGroupSchema', () => {
  it('needs a name and at least one other member', () => {
    expect(createGroupSchema.parse({ title: ' Trip ', memberIds: [ID] })).toEqual({
      title: 'Trip',
      memberIds: [ID],
    });
    expect(createGroupSchema.safeParse({ title: '', memberIds: [ID] }).success).toBe(false);
    expect(createGroupSchema.safeParse({ title: 'Trip', memberIds: [] }).success).toBe(false);
  });
});

describe('messageAckSchema', () => {
  it('discriminates success from failure', () => {
    const failure = {
      ok: false,
      error: { statusCode: 404, code: 'NOT_FOUND', message: 'Conversation not found' },
    };
    expect(messageAckSchema.parse(failure)).toEqual(failure);
    expect(messageAckSchema.safeParse({ ok: true }).success).toBe(false);
  });
});

describe('markReadAckSchema', () => {
  it('carries the read time on success and an error envelope on failure', () => {
    expect(
      markReadAckSchema.safeParse({ ok: true, readAt: '2026-10-16T10:00:00.000Z' }).success,
    ).toBe(true);
    expect(markReadAckSchema.safeParse({ ok: false }).success).toBe(false);
  });
});

describe('replies', () => {
  it('name the answered message on send and carry its quote on the message', () => {
    expect(sendMessageSchema.parse({ content: 'yes', replyToId: ID.toUpperCase() })).toEqual({
      content: 'yes',
      replyToId: ID,
    });
    // A reply still needs something of its own to say.
    expect(sendMessageSchema.safeParse({ replyToId: ID }).success).toBe(false);
    const quote = { id: ID, senderId: ID, excerpt: 'Lunch?', attachment: null, deleted: false };
    expect(replyRefSchema.parse(quote)).toEqual(quote);
    expect(replyRefSchema.parse({ unavailable: true })).toEqual({ unavailable: true });
  });
});

describe('setGroupPictureSchema', () => {
  it('takes an upload of kind "group" and nothing else', () => {
    expect(setGroupPictureSchema.parse({ pictureKey: `group/${ID}.webp` })).toEqual({
      pictureKey: `group/${ID}.webp`,
    });
    expect(setGroupPictureSchema.safeParse({ pictureKey: `avatar/${ID}.webp` }).success).toBe(
      false,
    );
    expect(setGroupPictureSchema.safeParse({}).success).toBe(false);
  });
});
