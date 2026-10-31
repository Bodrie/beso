import {
  SOCKET_EVENTS,
  apiErrorSchema,
  conversationListSchema,
  conversationReadPayloadSchema,
  conversationSchema,
  markReadAckSchema,
  markReadResultSchema,
  messageAckSchema,
  messageListSchema,
  messageSchema,
  presenceUpdateSchema,
  revisionListSchema,
  typingUpdateSchema,
  uploadResponseSchema,
  voiceUploadResponseSchema,
} from '@beso/shared';
import { JwtService } from '@nestjs/jwt';
import sharp from 'sharp';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { MAX_SOCKETS_PER_USER } from '../src/chat/chat.gateway.js';
import { type TestApp, createTestApp } from './setup/app.js';
import { type CreatedUser, type TestAgent, createUser } from './setup/factories.js';
import {
  collectUntil,
  connect,
  connectError,
  connected,
  disconnected,
  sessionFor,
  until,
  waitFor,
} from './setup/sockets.js';
import { fakeOpusFile } from './setup/ogg.js';

function png(): Promise<Buffer> {
  return sharp({ create: { width: 320, height: 200, channels: 3, background: '#3366aa' } })
    .png()
    .toBuffer();
}

async function uploadPicture(agent: TestAgent, kind: string) {
  const response = await agent
    .post(`/api/v1/uploads?kind=${kind}`)
    .attach('file', await png(), 'pic.png')
    .expect(201);
  return uploadResponseSchema.parse(response.body);
}

/** The direct conversation between the agent's user and `userId` (idempotent). */
async function directWith(agent: TestAgent, userId: string) {
  const response = await agent.put(`/api/v1/conversations/direct/${userId}`).expect(200);
  return conversationSchema.parse(response.body);
}

async function listFor(agent: TestAgent) {
  return conversationListSchema.parse((await agent.get('/api/v1/conversations').expect(200)).body);
}

const presenceIds = (payload: unknown): string[] =>
  presenceUpdateSchema
    .parse(payload)
    .map((u) => u.id)
    .toSorted();

describe('chat', () => {
  let t: TestApp;
  let alice: CreatedUser;
  let bob: CreatedUser;
  let carol: CreatedUser;
  let aliceSession: { agent: TestAgent; token: string };
  let bobSession: { agent: TestAgent; token: string };
  let carolSession: { agent: TestAgent; token: string };
  const sockets: Socket[] = [];

  beforeAll(async () => {
    t = await createTestApp({ listen: true });
    alice = await createUser(t.prisma);
    bob = await createUser(t.prisma);
    carol = await createUser(t.prisma);
    aliceSession = await sessionFor(t, alice);
    bobSession = await sessionFor(t, bob);
    carolSession = await sessionFor(t, carol);
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('handshake', () => {
    it('refuses sockets without a valid session', async () => {
      const anonymous = connect(t, {});
      const forged = connect(t, { token: 'not-a-token' });
      sockets.push(anonymous, forged);

      expect((await connectError(anonymous)).message).toBe('Unauthorized');
      expect((await connectError(forged)).message).toBe('Unauthorized');
    });

    it('refuses handshakes from foreign origins even with a valid session', async () => {
      const foreign = connect(t, { token: aliceSession.token, origin: 'https://evil.example' });
      const ours = connect(t, { token: aliceSession.token, origin: 'http://localhost:5173' });
      sockets.push(foreign, ours);
      await expect(connectError(foreign)).resolves.toBeInstanceOf(Error);
      await connected(ours);
    });

    it('refuses expired tokens and tokens without a subject', async () => {
      const jwt = t.app.get(JwtService);
      const expired = connect(t, {
        token: await jwt.signAsync({ sub: alice.id }, { expiresIn: -10 }),
      });
      const noSubject = connect(t, { token: await jwt.signAsync({ role: 'admin' }) });
      sockets.push(expired, noSubject);

      expect((await connectError(expired)).message).toBe('Unauthorized');
      expect((await connectError(noSubject)).message).toBe('Unauthorized');
    });

    it('disconnects a socket whose user no longer exists', async () => {
      const ghost = await createUser(t.prisma);
      const { token } = await sessionFor(t, ghost);
      await t.prisma.user.delete({ where: { id: ghost.id } });
      const socket = connect(t, { token });
      sockets.push(socket);

      const gone = disconnected(socket);
      await connected(socket);
      expect(await gone).toBe('io server disconnect');
    });

    it('caps the number of sockets per user', async () => {
      const opened = Array.from({ length: MAX_SOCKETS_PER_USER }, () =>
        connect(t, { token: carolSession.token }),
      );
      const extra = connect(t, { token: carolSession.token });
      sockets.push(...opened, extra);
      await Promise.all(opened.map(connected));

      expect((await connectError(extra)).message).toBe('Too many connections');
    });

    it('closes a socket when its access token expires', async () => {
      const jwt = t.app.get(JwtService);
      const shortLived = connect(t, {
        token: await jwt.signAsync({ sub: alice.id }, { expiresIn: 1 }),
      });
      sockets.push(shortLived);

      const gone = disconnected(shortLived);
      await connected(shortLived);
      expect(await gone).toBe('io server disconnect');
    });
  });

  it('tracks presence per user, from the cookie or an auth token', async () => {
    const aliceSocket = connect(t, { cookie: `access_token=${aliceSession.token}` });
    const aliceTab2 = connect(t, { token: aliceSession.token });
    const bobSocket = connect(t, { token: bobSession.token });
    sockets.push(aliceSocket, aliceTab2, bobSocket);

    const first = waitFor<unknown>(aliceSocket, SOCKET_EVENTS.presenceUpdate);
    await connected(aliceSocket);
    expect(presenceIds(await first)).toEqual([alice.id]);

    // A second tab gets the current list itself; nobody else is told.
    const tabList = waitFor<unknown>(aliceTab2, SOCKET_EVENTS.presenceUpdate);
    await connected(aliceTab2);
    expect(presenceIds(await tabList)).toEqual([alice.id]);

    const withBob = waitFor<unknown>(
      aliceSocket,
      SOCKET_EVENTS.presenceUpdate,
      (p) => presenceIds(p).length === 2,
    );
    const bobInitial = waitFor<unknown>(bobSocket, SOCKET_EVENTS.presenceUpdate);
    await connected(bobSocket);
    expect(presenceIds(await withBob)).toEqual([alice.id, bob.id].toSorted());
    expect(presenceIds(await bobInitial)).toEqual([alice.id, bob.id].toSorted());

    // Closing one of Alice's tabs must not report her offline: Bob sees nothing until Alice fully leaves.
    const afterAliceLeft = waitFor<unknown>(bobSocket, SOCKET_EVENTS.presenceUpdate);
    aliceTab2.disconnect();
    aliceSocket.disconnect();
    expect(presenceIds(await afterAliceLeft)).toEqual([bob.id]);
  });

  it('delivers persisted messages to every member only, with history, the list and read receipts', async () => {
    const aliceSocket = connect(t, { token: aliceSession.token });
    const aliceTab2 = connect(t, { token: aliceSession.token });
    const bobSocket = connect(t, { token: bobSession.token });
    const carolSocket = connect(t, { token: carolSession.token });
    sockets.push(aliceSocket, aliceTab2, bobSocket, carolSocket);
    await Promise.all([
      connected(aliceSocket),
      connected(aliceTab2),
      connected(bobSocket),
      connected(carolSocket),
    ]);

    const direct = await directWith(aliceSession.agent, bob.id);
    expect(direct).toMatchObject({
      kind: 'direct',
      title: null,
      lastMessage: null,
      unreadCount: 0,
    });
    expect(direct.members.map((m) => m.user.id).toSorted()).toEqual([alice.id, bob.id].toSorted());
    // Nothing said yet: the thread is not listed.
    expect((await listFor(bobSession.agent)).items).toEqual([]);

    const bobReceives = waitFor<unknown>(bobSocket, SOCKET_EVENTS.messageNew);
    const aliceTabReceives = waitFor<unknown>(aliceTab2, SOCKET_EVENTS.messageNew);
    const carolSaw = collectUntil<unknown>(
      carolSocket,
      SOCKET_EVENTS.messageNew,
      Promise.all([bobReceives, aliceTabReceives]),
    );
    const ack = messageAckSchema.parse(
      await aliceSocket.emitWithAck(SOCKET_EVENTS.messageSend, {
        conversationId: direct.id,
        content: '  hello bob  ',
      }),
    );
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    expect(ack.message).toMatchObject({
      conversationId: direct.id,
      senderId: alice.id,
      content: 'hello bob',
    });
    expect(messageSchema.parse(await bobReceives).id).toBe(ack.message.id);
    expect(messageSchema.parse(await aliceTabReceives).id).toBe(ack.message.id);
    expect(await carolSaw).toEqual([]);

    // HTTP sending reaches open sockets the same way.
    const bobReceivesHttp = waitFor<unknown>(bobSocket, SOCKET_EVENTS.messageNew);
    const viaHttp = messageSchema.parse(
      (
        await aliceSession.agent
          .post(`/api/v1/conversations/${direct.id}/messages`)
          .send({ content: 'and via http' })
          .expect(201)
      ).body,
    );
    expect(messageSchema.parse(await bobReceivesHttp).id).toBe(viaHttp.id);

    const history = messageListSchema.parse(
      (await bobSession.agent.get(`/api/v1/conversations/${direct.id}/messages`).expect(200)).body,
    );
    expect(history.items.map((m) => m.content)).toEqual(['and via http', 'hello bob']);

    const bobList = await listFor(bobSession.agent);
    expect(bobList.items).toHaveLength(1);
    expect(bobList.items[0]).toMatchObject({
      id: direct.id,
      lastMessage: { id: viaHttp.id },
      unreadCount: 2,
    });
    // Writing counts as reading: the sender has nothing unread and a read call changes nothing.
    expect((await listFor(aliceSession.agent)).items[0]?.unreadCount).toBe(0);
    const aliceRead = markReadResultSchema.parse(
      (await aliceSession.agent.post(`/api/v1/conversations/${direct.id}/read`).expect(200)).body,
    );
    expect(aliceRead.readAt).toBe(viaHttp.createdAt);

    const aliceNotified = waitFor<unknown>(aliceSocket, SOCKET_EVENTS.conversationRead);
    const carolSawRead = collectUntil<unknown>(
      carolSocket,
      SOCKET_EVENTS.conversationRead,
      aliceNotified,
    );
    const readAck = markReadAckSchema.parse(
      await bobSocket.emitWithAck(SOCKET_EVENTS.messageRead, { conversationId: direct.id }),
    );
    expect(readAck.ok).toBe(true);
    expect(conversationReadPayloadSchema.parse(await aliceNotified)).toMatchObject({
      conversationId: direct.id,
      userId: bob.id,
    });
    expect(await carolSawRead).toEqual([]);

    const bobAsSeenByAlice = (await listFor(aliceSession.agent)).items[0]?.members.find(
      (member) => member.user.id === bob.id,
    );
    expect(bobAsSeenByAlice?.lastReadAt).not.toBeNull();
    expect(bobAsSeenByAlice?.lastReadAt ?? '').toBe(readAck.ok ? readAck.readAt : '');
    expect((await listFor(bobSession.agent)).items[0]?.unreadCount).toBe(0);
  });

  it('validates socket payloads and reports errors in the ack', async () => {
    const aliceSocket = connect(t, { token: aliceSession.token });
    const carolSocket = connect(t, { token: carolSession.token });
    sockets.push(aliceSocket, carolSocket);
    await Promise.all([connected(aliceSocket), connected(carolSocket)]);
    const direct = await directWith(aliceSession.agent, bob.id);

    const empty = messageAckSchema.parse(
      await aliceSocket.emitWithAck(SOCKET_EVENTS.messageSend, {
        conversationId: direct.id,
        content: '  ',
      }),
    );
    expect(empty).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', fields: { content: expect.any(String) } },
    });

    const ghost = messageAckSchema.parse(
      await aliceSocket.emitWithAck(SOCKET_EVENTS.messageSend, {
        conversationId: '00000000-0000-7000-8000-000000000000',
        content: 'hi',
      }),
    );
    expect(ghost).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    // Not a member: the conversation does not exist as far as Carol is concerned.
    const outsider = messageAckSchema.parse(
      await carolSocket.emitWithAck(SOCKET_EVENTS.messageSend, {
        conversationId: direct.id,
        content: 'let me in',
      }),
    );
    expect(outsider).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const outsiderRead = markReadAckSchema.parse(
      await carolSocket.emitWithAck(SOCKET_EVENTS.messageRead, { conversationId: direct.id }),
    );
    expect(outsiderRead).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    const badRead = markReadAckSchema.parse(
      await aliceSocket.emitWithAck(SOCKET_EVENTS.messageRead, { conversationId: 'nope' }),
    );
    expect(badRead).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', fields: { conversationId: expect.any(String) } },
    });
  });

  it('sends pictures: an owned upload of kind "message", text optional', async () => {
    const aliceSocket = connect(t, { token: aliceSession.token });
    const bobSocket = connect(t, { token: bobSession.token });
    sockets.push(aliceSocket, bobSocket);
    await Promise.all([connected(aliceSocket), connected(bobSocket)]);
    const direct = await directWith(aliceSession.agent, bob.id);

    const picture = await uploadPicture(aliceSession.agent, 'message');
    expect(picture.key).toMatch(/^message\//);
    expect(picture.width).toBe(320);

    const bobReceives = waitFor<unknown>(bobSocket, SOCKET_EVENTS.messageNew);
    const ack = messageAckSchema.parse(
      await aliceSocket.emitWithAck(SOCKET_EVENTS.messageSend, {
        conversationId: direct.id,
        imageKey: picture.key,
      }),
    );
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    // The picture comes with its size (D2); `imageUrl` stays for tabs opened before.
    const image = { url: picture.url, width: picture.width, height: picture.height };
    expect(ack.message).toMatchObject({ content: '', image, imageUrl: picture.url });
    expect(messageSchema.parse(await bobReceives).image).toEqual(image);

    // Text and picture together over HTTP; the picture shows up in history and the list.
    const both = await uploadPicture(aliceSession.agent, 'message');
    const viaHttp = messageSchema.parse(
      (
        await aliceSession.agent
          .post(`/api/v1/conversations/${direct.id}/messages`)
          .send({ content: ' look ', imageKey: both.key })
          .expect(201)
      ).body,
    );
    expect(viaHttp).toMatchObject({
      content: 'look',
      image: { url: both.url },
      imageUrl: both.url,
    });
    const history = messageListSchema.parse(
      (await bobSession.agent.get(`/api/v1/conversations/${direct.id}/messages`).expect(200)).body,
    );
    expect(history.items[0]).toMatchObject({ id: viaHttp.id, imageUrl: both.url });
    expect((await listFor(bobSession.agent)).items[0]?.lastMessage).toMatchObject({
      id: viaHttp.id,
      imageUrl: both.url,
    });

    // Neither text nor picture.
    const nothing = messageAckSchema.parse(
      await aliceSocket.emitWithAck(SOCKET_EVENTS.messageSend, { conversationId: direct.id }),
    );
    expect(nothing).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', fields: { content: expect.any(String) } },
    });

    // Uploads of another kind, and other people's uploads, are refused on the key.
    const postPicture = await uploadPicture(aliceSession.agent, 'post');
    const wrongKind = await aliceSession.agent
      .post(`/api/v1/conversations/${direct.id}/messages`)
      .send({ imageKey: postPicture.key })
      .expect(400);
    expect(apiErrorSchema.parse(wrongKind.body).fields).toHaveProperty('imageKey');
    const bobsPicture = await uploadPicture(bobSession.agent, 'message');
    const notMine = await aliceSession.agent
      .post(`/api/v1/conversations/${direct.id}/messages`)
      .send({ imageKey: bobsPicture.key })
      .expect(400);
    expect(apiErrorSchema.parse(notMine.body).fields).toEqual({ imageKey: 'Unknown upload' });
  });

  it('sends voice messages: Opus the browser encoded, alone, at most 30 seconds', async () => {
    const aliceSocket = connect(t, { token: aliceSession.token });
    const bobSocket = connect(t, { token: bobSession.token });
    sockets.push(aliceSocket, bobSocket);
    await Promise.all([connected(aliceSocket), connected(bobSocket)]);
    const direct = await directWith(aliceSession.agent, bob.id);
    const uploadVoice = (agent: TestAgent, file: Buffer) =>
      agent.post('/api/v1/uploads/voice').attach('file', file, 'voice.ogg');

    // The length comes from the file, and the file comes back as audio.
    const clip = voiceUploadResponseSchema.parse(
      (await uploadVoice(aliceSession.agent, fakeOpusFile(3000)).expect(201)).body,
    );
    expect(clip.key).toMatch(/^voice\/.*\.ogg$/);
    expect(clip.durationMs).toBe(3000);
    const served = await request(t.server).get(`/api/v1/uploads/${clip.key}`).expect(200);
    expect(served.headers['content-type']).toMatch(/^audio\/ogg/);
    await request(t.server)
      .get(`/api/v1/uploads/${clip.key.replace('.ogg', '.webp')}`)
      .expect(404);

    // Too long, or not Ogg Opus at all.
    const tooLong = await uploadVoice(aliceSession.agent, fakeOpusFile(30_001)).expect(400);
    expect(apiErrorSchema.parse(tooLong.body).fields).toHaveProperty('file');
    await uploadVoice(aliceSession.agent, await png()).expect(415);

    // Sent over the socket with its waveform; everyone gets the clip as the message.
    const peaks = [0.1, 0.6, 1, 0.4];
    const bobReceives = waitFor<unknown>(bobSocket, SOCKET_EVENTS.messageNew);
    const ack = messageAckSchema.parse(
      await aliceSocket.emitWithAck(SOCKET_EVENTS.messageSend, {
        conversationId: direct.id,
        voiceKey: clip.key,
        voicePeaks: peaks,
      }),
    );
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    const voice = { url: clip.url, durationMs: 3000, peaks };
    expect(ack.message).toMatchObject({ content: '', image: null, voice });
    expect(messageSchema.parse(await bobReceives).voice).toEqual(voice);
    expect((await listFor(bobSession.agent)).items[0]?.lastMessage?.voice).toEqual(voice);

    // Alone: no text or picture with it; only an own upload of the voice kind.
    const withText = messageAckSchema.parse(
      await aliceSocket.emitWithAck(SOCKET_EVENTS.messageSend, {
        conversationId: direct.id,
        voiceKey: clip.key,
        content: 'and this',
      }),
    );
    expect(withText).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', fields: { voiceKey: expect.any(String) } },
    });
    const picture = await uploadPicture(aliceSession.agent, 'message');
    const wrongKind = await aliceSession.agent
      .post(`/api/v1/conversations/${direct.id}/messages`)
      .send({ voiceKey: picture.key })
      .expect(400);
    expect(apiErrorSchema.parse(wrongKind.body).fields).toHaveProperty('voiceKey');
    const bobsClip = voiceUploadResponseSchema.parse(
      (await uploadVoice(bobSession.agent, fakeOpusFile(1000)).expect(201)).body,
    );
    const notMine = await aliceSession.agent
      .post(`/api/v1/conversations/${direct.id}/messages`)
      .send({ voiceKey: bobsClip.key })
      .expect(400);
    expect(apiErrorSchema.parse(notMine.body).fields).toEqual({ voiceKey: 'Unknown upload' });

    // No text to edit; deleting takes the file with it.
    await aliceSession.agent
      .patch(`/api/v1/conversations/${direct.id}/messages/${ack.message.id}`)
      .send({ content: 'words' })
      .expect(400);
    const deleted = messageSchema.parse(
      (
        await aliceSession.agent
          .delete(`/api/v1/conversations/${direct.id}/messages/${ack.message.id}`)
          .expect(200)
      ).body,
    );
    expect(deleted.voice).toBeNull();
    await request(t.server).get(`/api/v1/uploads/${clip.key}`).expect(404);
  });

  it('relays typing to the other members only and drops bad or foreign signals', async () => {
    const aliceSocket = connect(t, { token: aliceSession.token });
    const aliceTab2 = connect(t, { token: aliceSession.token });
    const bobSocket = connect(t, { token: bobSession.token });
    const carolSocket = connect(t, { token: carolSession.token });
    sockets.push(aliceSocket, aliceTab2, bobSocket, carolSocket);
    await Promise.all([
      connected(aliceSocket),
      connected(aliceTab2),
      connected(bobSocket),
      connected(carolSocket),
    ]);
    const direct = await directWith(aliceSession.agent, bob.id);

    const bobStopped = waitFor<unknown>(
      bobSocket,
      SOCKET_EVENTS.typingUpdate,
      (payload) => !typingUpdateSchema.parse(payload).typing,
    );
    const bobSaw = collectUntil<unknown>(bobSocket, SOCKET_EVENTS.typingUpdate, bobStopped);
    const carolSaw = collectUntil<unknown>(carolSocket, SOCKET_EVENTS.typingUpdate, bobStopped);
    const aliceSaw = collectUntil<unknown>(aliceTab2, SOCKET_EVENTS.typingUpdate, bobStopped);

    aliceSocket.emit(SOCKET_EVENTS.typing, { conversationId: direct.id, typing: true });
    aliceSocket.emit(SOCKET_EVENTS.typing, { conversationId: 'nope', typing: true });
    // Carol is not in this conversation: nothing is relayed for her.
    carolSocket.emit(SOCKET_EVENTS.typing, { conversationId: direct.id, typing: true });
    aliceSocket.emit(SOCKET_EVENTS.typing, { conversationId: direct.id, typing: false });

    expect(await bobSaw).toEqual([
      { conversationId: direct.id, userId: alice.id, typing: true },
      { conversationId: direct.id, userId: alice.id, typing: false },
    ]);
    expect(await carolSaw).toEqual([]);
    expect(await aliceSaw).toEqual([]);
  });

  it('rate limits socket sends per user', async () => {
    const spammer = await createUser(t.prisma);
    const { agent, token } = await sessionFor(t, spammer);
    const socket = connect(t, { token });
    sockets.push(socket);
    await connected(socket);
    const direct = await directWith(agent, bob.id);

    const results = [];
    for (let i = 0; i < 61; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential on purpose: the window counts calls
      const ack = await socket.emitWithAck(SOCKET_EVENTS.messageSend, {
        conversationId: direct.id,
        content: `m${i}`,
      });
      results.push(messageAckSchema.parse(ack));
    }
    expect(results.slice(0, 60).every((r) => r.ok)).toBe(true);
    expect(results[60]).toMatchObject({ ok: false, error: { code: 'TOO_MANY_REQUESTS' } });
  });

  it('rate limits typing signals per user by dropping them', async () => {
    const chatterbox = await createUser(t.prisma);
    const { agent, token } = await sessionFor(t, chatterbox);
    const socket = connect(t, { token });
    const bobSocket = connect(t, { token: bobSession.token });
    sockets.push(socket, bobSocket);
    await Promise.all([connected(socket), connected(bobSocket)]);
    const direct = await directWith(agent, bob.id);

    const received: unknown[] = [];
    bobSocket.on(SOCKET_EVENTS.typingUpdate, (payload: unknown) => received.push(payload));
    for (let i = 0; i < 125; i += 1) {
      socket.emit(SOCKET_EVENTS.typing, { conversationId: direct.id, typing: true });
    }
    // The limiter decides on receipt; the relays drain one after another, then nothing more comes.
    await until(() => received.length >= 120);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toHaveLength(120);
  });

  it('cuts every open socket when all sessions are revoked', async () => {
    const victim = await createUser(t.prisma);
    const session = await sessionFor(t, victim);
    const socket = connect(t, { token: session.token });
    sockets.push(socket);
    await connected(socket);

    const gone = disconnected(socket);
    await session.agent.post('/api/v1/auth/logout-all').expect(204);
    expect(await gone).toBe('io server disconnect');
  });

  it('requires a session on the HTTP endpoints', async () => {
    await request(t.server).get('/api/v1/conversations').expect(401);
    await request(t.server).put(`/api/v1/conversations/direct/${bob.id}`).expect(401);
    await request(t.server)
      .post(`/api/v1/conversations/${bob.id}/messages`)
      .send({ content: 'x' })
      .expect(401);
  });
});

describe('group lifecycle pushes', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ listen: true });
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('tells every member about a new group, a newcomer and a leaver, and the leaver about the end', async () => {
    const [alice, bob, carol] = await Promise.all([
      createUser(t.prisma),
      createUser(t.prisma),
      createUser(t.prisma),
    ]);
    const aliceSession = await sessionFor(t, alice);
    const bobSession = await sessionFor(t, bob);
    const carolSession = await sessionFor(t, carol);
    const bobSocket = connect(t, { cookie: `access_token=${bobSession.token}` });
    const carolSocket = connect(t, { cookie: `access_token=${carolSession.token}` });
    await Promise.all([connected(bobSocket), connected(carolSocket)]);

    // Creation reaches bob (a member) but not carol (not yet).
    const bobTold = waitFor<{ conversationId: string }>(bobSocket, 'conversation:update');
    const carolHeard = collectUntil<unknown>(carolSocket, 'conversation:update', bobTold);
    const created = await aliceSession.agent
      .post('/api/v1/conversations')
      .send({ title: 'Lifecycle', memberIds: [bob.id] })
      .expect(201);
    const groupId = (created.body as { id: string }).id;
    expect((await bobTold).conversationId).toBe(groupId);
    expect(await carolHeard).toEqual([]);

    // Adding carol: she and bob both hear "update".
    const bobAgain = waitFor<{ conversationId: string }>(bobSocket, 'conversation:update');
    const carolNow = waitFor<{ conversationId: string }>(carolSocket, 'conversation:update');
    await aliceSession.agent
      .post(`/api/v1/conversations/${groupId}/members`)
      .send({ userIds: [carol.id] })
      .expect(200);
    expect((await bobAgain).conversationId).toBe(groupId);
    expect((await carolNow).conversationId).toBe(groupId);

    // Bob leaves: bob gets "removed", carol gets "update".
    const bobRemoved = waitFor<{ conversationId: string }>(bobSocket, 'conversation:removed');
    const carolUpdated = waitFor<{ conversationId: string }>(carolSocket, 'conversation:update');
    await bobSession.agent.delete(`/api/v1/conversations/${groupId}/members/me`).expect(204);
    expect((await bobRemoved).conversationId).toBe(groupId);
    expect((await carolUpdated).conversationId).toBe(groupId);

    bobSocket.close();
    carolSocket.close();
  });
});

describe('read marks reach the reader too', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ listen: true });
  });

  afterAll(async () => {
    await t.app.close();
  });

  it("pushes conversation:read to the reader's other tabs as well as to the others (review L9)", async () => {
    const [alice, bob] = await Promise.all([createUser(t.prisma), createUser(t.prisma)]);
    const aliceSession = await sessionFor(t, alice);
    const bobSession = await sessionFor(t, bob);
    const otherTab = connect(t, { cookie: `access_token=${aliceSession.token}` });
    const bobSocket = connect(t, { cookie: `access_token=${bobSession.token}` });
    await Promise.all([connected(otherTab), connected(bobSocket)]);

    const direct = (
      await aliceSession.agent.put(`/api/v1/conversations/direct/${bob.id}`).expect(200)
    ).body as { id: string };
    await bobSession.agent
      .post(`/api/v1/conversations/${direct.id}/messages`)
      .send({ content: 'hi' })
      .expect(201);

    const tabHears = waitFor<{ conversationId: string; userId: string }>(
      otherTab,
      'conversation:read',
    );
    const bobHears = waitFor<{ conversationId: string; userId: string }>(
      bobSocket,
      'conversation:read',
    );
    await aliceSession.agent.post(`/api/v1/conversations/${direct.id}/read`).expect(200);
    expect(await tabHears).toMatchObject({ conversationId: direct.id, userId: alice.id });
    expect(await bobHears).toMatchObject({ conversationId: direct.id, userId: alice.id });

    otherTab.close();
    bobSocket.close();
  });
});

describe('chat follow-ups (B3b): pagination, deletion, roles and system lines', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ listen: true });
  });

  afterAll(async () => {
    await t.app.close();
  });

  const createGroup = async (agent: TestAgent, title: string, memberIds: string[]) =>
    conversationSchema.parse(
      (await agent.post('/api/v1/conversations').send({ title, memberIds }).expect(201)).body,
    );
  const say = (agent: TestAgent, conversationId: string, content: string) =>
    agent.post(`/api/v1/conversations/${conversationId}/messages`).send({ content }).expect(201);
  const roleOf = (
    conversation: { members: { user: { id: string }; role: string }[] },
    id: string,
  ) => conversation.members.find((member) => member.user.id === id)?.role;

  it('pages the list by activity: the newest message or, for a quiet group, its creation', async () => {
    const alice = await createUser(t.prisma);
    const others = await Promise.all([
      createUser(t.prisma),
      createUser(t.prisma),
      createUser(t.prisma),
    ]);
    const { agent } = await sessionFor(t, alice);
    const groups: string[] = [];
    for (const [index, other] of others.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- creation order is the point
      groups.push((await createGroup(agent, `Group ${index}`, [other.id])).id);
    }
    // A message in the first group makes it the most recent.
    await say(agent, groups[0] ?? '', 'bump');

    const first = conversationListSchema.parse(
      (await agent.get('/api/v1/conversations?limit=2').expect(200)).body,
    );
    expect(first.items.map((row) => row.id)).toEqual([groups[0], groups[2]]);
    expect(first.nextCursor).not.toBeNull();
    const second = conversationListSchema.parse(
      (await agent.get(`/api/v1/conversations?limit=2&cursor=${first.nextCursor}`).expect(200))
        .body,
    );
    expect(second.items.map((row) => row.id)).toEqual([groups[1]]);
    expect(second.nextCursor).toBeNull();
    await agent.get('/api/v1/conversations?cursor=not-a-cursor').expect(400);
  });

  it('lets the sender take a message back for everyone, and nobody else', async () => {
    const [alice, bob] = await Promise.all([createUser(t.prisma), createUser(t.prisma)]);
    const aliceSession = await sessionFor(t, alice);
    const bobSession = await sessionFor(t, bob);
    const bobSocket = connect(t, { cookie: `access_token=${bobSession.token}` });
    await connected(bobSocket);

    const direct = conversationSchema.parse(
      (await aliceSession.agent.put(`/api/v1/conversations/direct/${bob.id}`).expect(200)).body,
    );
    const message = messageSchema.parse((await say(aliceSession.agent, direct.id, 'secret')).body);
    expect(message).toMatchObject({ kind: 'user', deletedAt: null, system: null });
    expect((await listFor(bobSession.agent)).items[0]?.unreadCount).toBe(1);

    await bobSession.agent
      .delete(`/api/v1/conversations/${direct.id}/messages/${message.id}`)
      .expect(403);
    const pushed = waitFor<unknown>(bobSocket, 'message:deleted');
    const deleted = messageSchema.parse(
      (
        await aliceSession.agent
          .delete(`/api/v1/conversations/${direct.id}/messages/${message.id}`)
          .expect(200)
      ).body,
    );
    expect(deleted).toMatchObject({ id: message.id, content: '', image: null, imageUrl: null });
    expect(deleted.deletedAt).not.toBeNull();
    expect(messageSchema.parse(await pushed)).toEqual(deleted);

    // Nothing left to read; the row stays in the history and as the list snippet.
    const bobList = await listFor(bobSession.agent);
    expect(bobList.items[0]?.unreadCount).toBe(0);
    expect(bobList.items[0]?.lastMessage).toEqual(deleted);
    const history = messageListSchema.parse(
      (await bobSession.agent.get(`/api/v1/conversations/${direct.id}/messages`).expect(200)).body,
    );
    expect(history.items.map((row) => row.id)).toEqual([message.id]);
    // Deleting twice is fine, and unknown ids are 404s.
    await aliceSession.agent
      .delete(`/api/v1/conversations/${direct.id}/messages/${message.id}`)
      .expect(200);
    await aliceSession.agent
      .delete(`/api/v1/conversations/${direct.id}/messages/${direct.id}`)
      .expect(404);
    bobSocket.close();
  });

  it('makes the creator admin; admins rename, promote, demote (never the last) and remove, with system lines', async () => {
    const [alice, bob, carol] = await Promise.all([
      createUser(t.prisma),
      createUser(t.prisma),
      createUser(t.prisma),
    ]);
    const aliceSession = await sessionFor(t, alice);
    const bobSession = await sessionFor(t, bob);
    const carolSession = await sessionFor(t, carol);
    const bobSocket = connect(t, { cookie: `access_token=${bobSession.token}` });
    const carolSocket = connect(t, { cookie: `access_token=${carolSession.token}` });
    await Promise.all([connected(bobSocket), connected(carolSocket)]);

    const group = await createGroup(aliceSession.agent, 'Roles', [bob.id, carol.id]);
    expect(roleOf(group, alice.id)).toBe('admin');
    expect(roleOf(group, bob.id)).toBe('member');

    // Rename: members may not, the admin may; everyone gets the fresh row and a system line.
    await bobSession.agent
      .patch(`/api/v1/conversations/${group.id}`)
      .send({ title: 'Nope' })
      .expect(403);
    const bobUpdated = waitFor<unknown>(bobSocket, 'conversation:update');
    const bobLine = waitFor<unknown>(bobSocket, 'message:new');
    const renamed = conversationSchema.parse(
      (
        await aliceSession.agent
          .patch(`/api/v1/conversations/${group.id}`)
          .send({ title: 'Renamed' })
          .expect(200)
      ).body,
    );
    expect(renamed.title).toBe('Renamed');
    expect(await bobUpdated).toEqual({ conversationId: group.id });
    const line = messageSchema.parse(await bobLine);
    expect(line).toMatchObject({
      kind: 'system',
      senderId: alice.id,
      system: { type: 'renamed', title: 'Renamed', actor: { id: alice.id } },
    });
    expect(renamed.lastMessage?.id).toBe(line.id);
    // A system line is nobody's unread.
    expect((await listFor(bobSession.agent)).items[0]?.unreadCount).toBe(0);

    // Roles: only admins change them; the last admin cannot be demoted.
    await bobSession.agent
      .put(`/api/v1/conversations/${group.id}/members/${carol.id}/role`)
      .send({ role: 'admin' })
      .expect(403);
    const demoteLast = await aliceSession.agent
      .put(`/api/v1/conversations/${group.id}/members/${alice.id}/role`)
      .send({ role: 'member' })
      .expect(400);
    expect(demoteLast.body).toMatchObject({ fields: { role: expect.any(String) } });
    const promoted = conversationSchema.parse(
      (
        await aliceSession.agent
          .put(`/api/v1/conversations/${group.id}/members/${bob.id}/role`)
          .send({ role: 'admin' })
          .expect(200)
      ).body,
    );
    expect(roleOf(promoted, bob.id)).toBe('admin');
    const demoted = conversationSchema.parse(
      (
        await bobSession.agent
          .put(`/api/v1/conversations/${group.id}/members/${alice.id}/role`)
          .send({ role: 'member' })
          .expect(200)
      ).body,
    );
    expect(roleOf(demoted, alice.id)).toBe('member');

    // Removal: members may not; the removed hears "removed", the rest a system line.
    await aliceSession.agent
      .delete(`/api/v1/conversations/${group.id}/members/${carol.id}`)
      .expect(403);
    await bobSession.agent
      .delete(`/api/v1/conversations/${group.id}/members/${bob.id}`)
      .expect(400);
    const carolRemoved = waitFor<unknown>(carolSocket, 'conversation:removed');
    await bobSession.agent
      .delete(`/api/v1/conversations/${group.id}/members/${carol.id}`)
      .expect(204);
    expect(await carolRemoved).toEqual({ conversationId: group.id });
    await carolSession.agent.get(`/api/v1/conversations/${group.id}`).expect(404);
    const history = messageListSchema.parse(
      (await aliceSession.agent.get(`/api/v1/conversations/${group.id}/messages`).expect(200)).body,
    );
    expect(history.items[0]).toMatchObject({
      kind: 'system',
      system: { type: 'member_removed', actor: { id: bob.id }, users: [{ id: carol.id }] },
    });
    // System lines cannot be deleted.
    await bobSession.agent
      .delete(`/api/v1/conversations/${group.id}/messages/${history.items[0]?.id}`)
      .expect(400);

    // The last admin leaving hands the role to the longest-standing member.
    await bobSession.agent.delete(`/api/v1/conversations/${group.id}/members/me`).expect(204);
    const after = conversationSchema.parse(
      (await aliceSession.agent.get(`/api/v1/conversations/${group.id}`).expect(200)).body,
    );
    expect(after.members.map((member) => [member.user.id, member.role])).toEqual([
      [alice.id, 'admin'],
    ]);
    expect(after.lastMessage).toMatchObject({
      kind: 'system',
      system: { type: 'member_left', actor: { id: bob.id } },
    });

    // Adding people writes a line too, and the newcomer gets it with the conversation.
    const carolBack = waitFor<unknown>(carolSocket, 'message:new');
    await aliceSession.agent
      .post(`/api/v1/conversations/${group.id}/members`)
      .send({ userIds: [carol.id] })
      .expect(200);
    expect(messageSchema.parse(await carolBack)).toMatchObject({
      kind: 'system',
      system: { type: 'members_added', actor: { id: alice.id }, users: [{ id: carol.id }] },
    });
    bobSocket.close();
    carolSocket.close();
  });
});

describe('chat extras (C5): editing, reactions and the new system lines', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ listen: true });
  });

  afterAll(async () => {
    await t.app.close();
  });

  const say = (agent: TestAgent, conversationId: string, content: string) =>
    agent.post(`/api/v1/conversations/${conversationId}/messages`).send({ content }).expect(201);
  const directBetween = async (agent: TestAgent, userId: string) =>
    conversationSchema.parse(
      (await agent.put(`/api/v1/conversations/direct/${userId}`).expect(200)).body,
    );

  it('lets the sender edit the text, keeps the history and pushes the new copy to everyone', async () => {
    const [alice, bob] = await Promise.all([createUser(t.prisma), createUser(t.prisma)]);
    const aliceSession = await sessionFor(t, alice);
    const bobSession = await sessionFor(t, bob);
    const bobSocket = connect(t, { cookie: `access_token=${bobSession.token}` });
    await connected(bobSocket);
    const direct = await directBetween(aliceSession.agent, bob.id);
    const message = messageSchema.parse(
      (await say(aliceSession.agent, direct.id, 'teh text')).body,
    );
    expect(message).toMatchObject({ editedAt: null, reactions: [] });
    const path = `/api/v1/conversations/${direct.id}/messages/${message.id}`;

    await bobSession.agent.patch(path).send({ content: 'nope' }).expect(403);
    await aliceSession.agent.patch(path).send({ content: '  ' }).expect(400);
    // An unchanged text changes nothing.
    const same = messageSchema.parse(
      (await aliceSession.agent.patch(path).send({ content: 'teh text' }).expect(200)).body,
    );
    expect(same.editedAt).toBeNull();

    const pushed = waitFor<unknown>(bobSocket, 'message:updated');
    const edited = messageSchema.parse(
      (await aliceSession.agent.patch(path).send({ content: 'the text' }).expect(200)).body,
    );
    expect(edited).toMatchObject({ id: message.id, content: 'the text' });
    expect(edited.editedAt).not.toBeNull();
    expect(messageSchema.parse(await pushed)).toEqual(edited);
    const revisions = revisionListSchema.parse(
      (await bobSession.agent.get(`${path}/revisions`).expect(200)).body,
    );
    expect(revisions.items.map((revision) => revision.content)).toEqual(['teh text']);
    // The list snippet follows; the edit itself is nothing new to read.
    const bobList = await listFor(bobSession.agent);
    expect(bobList.items[0]?.lastMessage).toEqual(edited);
    expect(bobList.items[0]?.unreadCount).toBe(1);

    // A deleted message cannot be edited any more.
    await aliceSession.agent.delete(path).expect(200);
    await aliceSession.agent.patch(path).send({ content: 'again' }).expect(400);
    bobSocket.close();
  });

  it('takes one reaction per member, switches and removes it, with a push and nobody’s unread', async () => {
    const [alice, bob, carol] = await Promise.all([
      createUser(t.prisma),
      createUser(t.prisma),
      createUser(t.prisma),
    ]);
    const aliceSession = await sessionFor(t, alice);
    const bobSession = await sessionFor(t, bob);
    const carolSession = await sessionFor(t, carol);
    const aliceSocket = connect(t, { cookie: `access_token=${aliceSession.token}` });
    await connected(aliceSocket);
    const direct = await directBetween(aliceSession.agent, bob.id);
    const message = messageSchema.parse(
      (await say(aliceSession.agent, direct.id, 'react to me')).body,
    );
    const path = `/api/v1/conversations/${direct.id}/messages/${message.id}/reaction`;

    const pushed = waitFor<unknown>(aliceSocket, 'message:updated');
    const loved = messageSchema.parse(
      (await bobSession.agent.put(path).send({ type: 'LOVE' }).expect(200)).body,
    );
    expect(loved.reactions).toEqual([{ userId: bob.id, type: 'LOVE' }]);
    expect(messageSchema.parse(await pushed)).toEqual(loved);
    // Switching keeps one entry per member; a second member adds theirs.
    const liked = messageSchema.parse(
      (await bobSession.agent.put(path).send({ type: 'LIKE' }).expect(200)).body,
    );
    expect(liked.reactions).toEqual([{ userId: bob.id, type: 'LIKE' }]);
    const both = messageSchema.parse(
      (await aliceSession.agent.put(path).send({ type: 'WOW' }).expect(200)).body,
    );
    expect(both.reactions).toEqual([
      { userId: bob.id, type: 'LIKE' },
      { userId: alice.id, type: 'WOW' },
    ]);
    const removed = messageSchema.parse((await bobSession.agent.delete(path).expect(200)).body);
    expect(removed.reactions).toEqual([{ userId: alice.id, type: 'WOW' }]);
    await bobSession.agent.delete(path).expect(200);

    // Reactions read nothing and are nobody's unread; outsiders and bad targets are refused.
    expect((await listFor(bobSession.agent)).items[0]?.unreadCount).toBe(1);
    await bobSession.agent.put(path).send({ type: 'HUG' }).expect(400);
    await carolSession.agent.put(path).send({ type: 'LIKE' }).expect(404);
    await aliceSession.agent
      .delete(`/api/v1/conversations/${direct.id}/messages/${message.id}`)
      .expect(200);
    await bobSession.agent.put(path).send({ type: 'LIKE' }).expect(400);
    aliceSocket.close();
  });

  it('writes a line when a group is created and when an admin role changes', async () => {
    const [alice, bob] = await Promise.all([createUser(t.prisma), createUser(t.prisma)]);
    const aliceSession = await sessionFor(t, alice);
    const bobSession = await sessionFor(t, bob);
    const bobSocket = connect(t, { cookie: `access_token=${bobSession.token}` });
    await connected(bobSocket);

    const group = conversationSchema.parse(
      (
        await aliceSession.agent
          .post('/api/v1/conversations')
          .send({ title: 'Lines', memberIds: [bob.id] })
          .expect(201)
      ).body,
    );
    expect(group.lastMessage).toMatchObject({
      kind: 'system',
      senderId: alice.id,
      system: { type: 'group_created', actor: { id: alice.id }, users: [], title: 'Lines' },
    });
    // The line cannot be reacted to.
    await bobSession.agent
      .put(`/api/v1/conversations/${group.id}/messages/${group.lastMessage?.id}/reaction`)
      .send({ type: 'LIKE' })
      .expect(400);

    const promoted = waitFor<unknown>(bobSocket, 'message:new');
    await aliceSession.agent
      .put(`/api/v1/conversations/${group.id}/members/${bob.id}/role`)
      .send({ role: 'admin' })
      .expect(200);
    expect(messageSchema.parse(await promoted)).toMatchObject({
      kind: 'system',
      system: { type: 'admin_added', actor: { id: alice.id }, users: [{ id: bob.id }] },
    });
    await bobSession.agent
      .put(`/api/v1/conversations/${group.id}/members/${alice.id}/role`)
      .send({ role: 'member' })
      .expect(200);
    const history = messageListSchema.parse(
      (await aliceSession.agent.get(`/api/v1/conversations/${group.id}/messages`).expect(200)).body,
    );
    expect(history.items.map((row) => row.system?.type)).toEqual([
      'admin_removed',
      'admin_added',
      'group_created',
    ]);
    expect((await listFor(bobSession.agent)).items[0]?.unreadCount).toBe(0);
    bobSocket.close();
  });

  it('lets admins set and remove a group picture, with system lines, and drops the replaced files', async () => {
    const [alice, bob] = await Promise.all([createUser(t.prisma), createUser(t.prisma)]);
    const aliceSession = await sessionFor(t, alice);
    const bobSession = await sessionFor(t, bob);
    const bobSocket = connect(t, { cookie: `access_token=${bobSession.token}` });
    await connected(bobSocket);
    const group = conversationSchema.parse(
      (
        await aliceSession.agent
          .post('/api/v1/conversations')
          .send({ title: 'Pictured', memberIds: [bob.id] })
          .expect(201)
      ).body,
    );
    expect(group.pictureUrl).toBeNull();
    const direct = await directWith(aliceSession.agent, bob.id);
    expect(direct.pictureUrl).toBeNull();

    // Only an upload of kind `group`, only one's own, only by an admin, only on a group.
    const avatar = await uploadPicture(aliceSession.agent, 'avatar');
    const wrongKind = await aliceSession.agent
      .put(`/api/v1/conversations/${group.id}/picture`)
      .send({ pictureKey: avatar.key })
      .expect(400);
    expect(apiErrorSchema.parse(wrongKind.body).fields).toHaveProperty('pictureKey');
    const bobs = await uploadPicture(bobSession.agent, 'group');
    await bobSession.agent
      .put(`/api/v1/conversations/${group.id}/picture`)
      .send({ pictureKey: bobs.key })
      .expect(403);
    const notMine = await aliceSession.agent
      .put(`/api/v1/conversations/${group.id}/picture`)
      .send({ pictureKey: bobs.key })
      .expect(400);
    expect(apiErrorSchema.parse(notMine.body).fields).toEqual({ pictureKey: 'Unknown upload' });
    const first = await uploadPicture(aliceSession.agent, 'group');
    await aliceSession.agent
      .put(`/api/v1/conversations/${direct.id}/picture`)
      .send({ pictureKey: first.key })
      .expect(400);

    // The picture is framed like an avatar; setting it pushes the row and a line to everyone.
    expect([first.width, first.height]).toEqual([512, 512]);
    const bobUpdated = waitFor<unknown>(bobSocket, 'conversation:update');
    const bobLine = waitFor<unknown>(bobSocket, 'message:new');
    const pictured = conversationSchema.parse(
      (
        await aliceSession.agent
          .put(`/api/v1/conversations/${group.id}/picture`)
          .send({ pictureKey: first.key })
          .expect(200)
      ).body,
    );
    expect(pictured.pictureUrl).toBe(first.url);
    expect(await bobUpdated).toEqual({ conversationId: group.id });
    const line = messageSchema.parse(await bobLine);
    expect(line).toMatchObject({
      kind: 'system',
      senderId: alice.id,
      system: { type: 'picture_changed', actor: { id: alice.id }, users: [], title: null },
    });
    expect(pictured.lastMessage?.id).toBe(line.id);
    expect((await listFor(bobSession.agent)).items[0]).toMatchObject({
      id: group.id,
      pictureUrl: first.url,
      unreadCount: 0,
    });

    // A new picture drops the old file; the same key again changes nothing.
    const second = await uploadPicture(aliceSession.agent, 'group');
    await aliceSession.agent
      .put(`/api/v1/conversations/${group.id}/picture`)
      .send({ pictureKey: second.key })
      .expect(200);
    await request(t.server).get(`/api/v1/uploads/${first.key}`).expect(404);
    await request(t.server).get(`/api/v1/uploads/${second.key}`).expect(200);
    const same = conversationSchema.parse(
      (
        await aliceSession.agent
          .put(`/api/v1/conversations/${group.id}/picture`)
          .send({ pictureKey: second.key })
          .expect(200)
      ).body,
    );
    const history = messageListSchema.parse(
      (await aliceSession.agent.get(`/api/v1/conversations/${group.id}/messages`).expect(200)).body,
    );
    expect(history.items.map((row) => row.system?.type)).toEqual([
      'picture_changed',
      'picture_changed',
      'group_created',
    ]);
    expect(same.lastMessage?.id).toBe(history.items[0]?.id);

    // Removing: members may not; the file goes; a group without a picture is a no-op.
    await bobSession.agent.delete(`/api/v1/conversations/${group.id}/picture`).expect(403);
    const removed = conversationSchema.parse(
      (await aliceSession.agent.delete(`/api/v1/conversations/${group.id}/picture`).expect(200))
        .body,
    );
    expect(removed.pictureUrl).toBeNull();
    expect(removed.lastMessage).toMatchObject({
      kind: 'system',
      system: { type: 'picture_removed', actor: { id: alice.id } },
    });
    await request(t.server).get(`/api/v1/uploads/${second.key}`).expect(404);
    const again = conversationSchema.parse(
      (await aliceSession.agent.delete(`/api/v1/conversations/${group.id}/picture`).expect(200))
        .body,
    );
    expect(again.lastMessage?.id).toBe(removed.lastMessage?.id);

    // The last member out takes the picture's file with the group.
    const third = await uploadPicture(aliceSession.agent, 'group');
    await aliceSession.agent
      .put(`/api/v1/conversations/${group.id}/picture`)
      .send({ pictureKey: third.key })
      .expect(200);
    await bobSession.agent.delete(`/api/v1/conversations/${group.id}/members/me`).expect(204);
    await aliceSession.agent.delete(`/api/v1/conversations/${group.id}/members/me`).expect(204);
    await request(t.server).get(`/api/v1/uploads/${third.key}`).expect(404);
    bobSocket.close();
  });
});
