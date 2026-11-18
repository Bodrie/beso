import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  accountExportSchema,
  apiErrorSchema,
  commentSchema,
  conversationSchema,
  postSchema,
  uploadResponseSchema,
} from '@beso/shared';
import sharp from 'sharp';
import { type Socket, io } from 'socket.io-client';
import request from 'supertest';
import { type TestApp, createTestApp } from './setup/app.js';
import {
  TEST_PASSWORD,
  type CreatedUser,
  type TestAgent,
  cookiesFrom,
  createUser,
  login,
} from './setup/factories.js';
import { waitForEmail } from './setup/outbox.js';

async function agentFor(t: TestApp, user: CreatedUser): Promise<TestAgent> {
  const agent = request.agent(t.server);
  await login(agent, user.email);
  return agent;
}

async function createPost(agent: TestAgent, content: string, imageKeys?: string[]) {
  const response = await agent.post('/api/v1/posts').send({ content, imageKeys }).expect(201);
  return postSchema.parse(response.body);
}

async function uploadPicture(agent: TestAgent, kind = 'post'): Promise<string> {
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#333' } })
    .png()
    .toBuffer();
  const response = await agent
    .post(`/api/v1/uploads?kind=${kind}`)
    .attach('file', image, 'pic.png')
    .expect(201);
  return uploadResponseSchema.parse(response.body).key;
}

/** Logs in and keeps the access token, which the socket handshake needs as a cookie header. */
async function sessionFor(
  t: TestApp,
  user: CreatedUser,
): Promise<{ agent: TestAgent; token: string }> {
  const agent = request.agent(t.server);
  const response = await agent
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: TEST_PASSWORD })
    .expect(200);
  return { agent, token: cookiesFrom(response.headers['set-cookie']).access_token ?? '' };
}

/** A connected socket for that session. */
function connectAs(t: TestApp, token: string): Promise<Socket> {
  const socket = io(t.baseUrl, {
    transports: ['websocket'],
    autoConnect: false,
    reconnection: false,
    extraHeaders: { cookie: `access_token=${token}` },
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
    socket.connect();
  });
}

const waitFor = (socket: Socket, event: string): Promise<unknown> =>
  new Promise((resolve) => socket.once(event, resolve));

describe('DELETE /users/me', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ listen: true });
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('refuses a wrong password on its field and changes nothing', async () => {
    const me = await createUser(t.prisma);
    const agent = await agentFor(t, me);

    const response = await agent
      .delete('/api/v1/users/me')
      .send({ password: 'not-it' })
      .expect(400);
    const error = apiErrorSchema.parse(response.body);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.fields).toHaveProperty('password', 'Wrong password');
    expect(await t.prisma.user.count({ where: { id: me.id } })).toBe(1);
    await agent.get('/api/v1/auth/me').expect(200);
  });

  it('erases the account, what hangs off it, its files and its sessions', async () => {
    const me = await createUser(t.prisma);
    const friend = await createUser(t.prisma);
    const third = await createUser(t.prisma);
    const { agent, token } = await sessionFor(t, me);
    const { agent: friendAgent, token: friendToken } = await sessionFor(t, friend);

    // My content and traces on other people's content.
    const key = await uploadPicture(agent);
    const second = await uploadPicture(agent);
    const myPost = await createPost(agent, 'Mine, with two pictures', [key, second]);
    const theirPost = await createPost(friendAgent, 'Theirs');
    await agent.post(`/api/v1/posts/${theirPost.id}/comments`).send({ content: 'me' }).expect(201);
    await agent.put(`/api/v1/posts/${theirPost.id}/like`).expect(204);
    const theirComment = commentSchema.parse(
      (
        await friendAgent
          .post(`/api/v1/posts/${theirPost.id}/comments`)
          .send({ content: 'theirs' })
          .expect(201)
      ).body,
    );
    await agent
      .put(`/api/v1/comments/${theirComment.id}/reaction`)
      .send({ type: 'LOVE' })
      .expect(200);
    await agent.put(`/api/v1/users/${friend.id}/follow`).expect(204);

    // A direct thread, a group that goes on without me, and a group where I am the last one.
    const direct = conversationSchema.parse(
      (await agent.put(`/api/v1/conversations/direct/${friend.id}`).expect(200)).body,
    );
    await agent.post(`/api/v1/conversations/${direct.id}/messages`).send({ content: 'hi' });
    const group = conversationSchema.parse(
      (
        await agent
          .post('/api/v1/conversations')
          .send({ title: 'Stays', memberIds: [friend.id, third.id] })
          .expect(201)
      ).body,
    );
    const sent = await uploadPicture(agent, 'message');
    await agent
      .post(`/api/v1/conversations/${group.id}/messages`)
      .send({ content: 'with a picture', imageKeys: [sent] })
      .expect(201);
    await agent.post(`/api/v1/conversations/${group.id}/messages`).send({ content: 'newest' });
    const solo = conversationSchema.parse(
      (
        await agent
          .post('/api/v1/conversations')
          .send({ title: 'Solo soon', memberIds: [third.id] })
          .expect(201)
      ).body,
    );
    const thirdAgent = await agentFor(t, third);
    await thirdAgent.delete(`/api/v1/conversations/${solo.id}/members/me`).expect(204);

    const mySocket = await connectAs(t, token);
    const friendSocket = await connectAs(t, friendToken);
    const disconnected = waitFor(mySocket, 'disconnect');
    const removed = waitFor(friendSocket, 'conversation:removed');
    const updated = waitFor(friendSocket, 'conversation:update');

    const response = await agent
      .delete('/api/v1/users/me')
      .send({ password: TEST_PASSWORD })
      .expect(204);
    const cleared = response.get('Set-Cookie') ?? [];
    expect(cleared.some((header) => header.startsWith('access_token=;'))).toBe(true);
    expect(cleared.some((header) => header.startsWith('refresh_token=;'))).toBe(true);

    // Sessions: the socket is cut, the cookies no longer open anything.
    await disconnected;
    await agent.get('/api/v1/auth/me').expect(401);
    expect(await t.prisma.refreshToken.count({ where: { userId: me.id } })).toBe(0);

    // Rows: the account and its own content are gone, counters elsewhere are right.
    expect(await t.prisma.user.count({ where: { id: me.id } })).toBe(0);
    expect(await t.prisma.post.count({ where: { id: myPost.id } })).toBe(0);
    const theirs = postSchema.parse(
      (await friendAgent.get(`/api/v1/posts/${theirPost.id}`).expect(200)).body,
    );
    expect(theirs).toMatchObject({ likeCount: 0, commentCount: 1 });
    expect(
      await t.prisma.comment.findUniqueOrThrow({
        where: { id: theirComment.id },
        select: { reactionsCount: true },
      }),
    ).toEqual({ reactionsCount: 0 });
    expect(await t.prisma.follow.count({ where: { followerId: me.id } })).toBe(0);

    // Conversations: the direct thread and the solo group are gone, the other group goes on.
    expect(await t.prisma.conversation.count({ where: { id: { in: [direct.id, solo.id] } } })).toBe(
      0,
    );
    expect(await removed).toEqual({ conversationId: direct.id });
    expect(await updated).toEqual({ conversationId: group.id });
    const stays = await t.prisma.conversation.findUniqueOrThrow({
      where: { id: group.id },
      select: {
        lastMessageAt: true,
        members: { select: { userId: true, role: true }, orderBy: { joinedAt: 'asc' } },
        messages: true,
      },
    });
    expect(stays.members.map((member) => member.userId).toSorted()).toEqual(
      [friend.id, third.id].toSorted(),
    );
    // I was the group's only admin: the longest-standing member takes over.
    expect(stays.members.filter((member) => member.role === 'admin')).toHaveLength(1);
    expect(stays.messages).toEqual([]);
    expect(stays.lastMessageAt).toBeNull();

    // Files and the last mail.
    expect(await t.prisma.upload.count({ where: { ownerId: me.id } })).toBe(0);
    for (const file of [key, second, sent]) {
      expect(existsSync(path.join(process.env.UPLOADS_DIR ?? '', file))).toBe(false);
    }
    const mail = await waitForEmail(me.email, /account was deleted/);
    expect(mail.text).toContain(me.name);

    mySocket.close();
    friendSocket.close();
  });

  // Here and not next to the export tests: the throttler sits in front of the auth guard, so
  // this anonymous call would spend the per-address export budget of that describe's app.
  it('refuses an export without a session', async () => {
    await request(t.server).get('/api/v1/users/me/export').expect(401);
  });

  it('works for an account that never confirmed its address', async () => {
    const agent: TestAgent = request.agent(t.server);
    await agent
      .post('/api/v1/auth/register')
      .send({
        email: 'leaving@example.com',
        username: 'leaving',
        name: 'Leaving Early',
        password: TEST_PASSWORD,
      })
      .expect(201);

    await agent.delete('/api/v1/users/me').send({ password: TEST_PASSWORD }).expect(204);
    expect(await t.prisma.user.count({ where: { username: 'leaving' } })).toBe(0);
  });
});

describe('GET /users/me/export', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('returns everything the account holds as a named JSON download, twice a minute', async () => {
    const me = await createUser(t.prisma);
    const friend = await createUser(t.prisma);
    const agent = await agentFor(t, me);
    const friendAgent = await agentFor(t, friend);

    const key = await uploadPicture(agent);
    const post = await createPost(agent, 'Exported #keep', [key]);
    await agent.patch(`/api/v1/posts/${post.id}`).send({ content: 'Exported #keep, edited' });
    const theirPost = await createPost(friendAgent, 'Theirs');
    await agent.post(`/api/v1/posts/${theirPost.id}/comments`).send({ content: 'hello' });
    await agent.put(`/api/v1/posts/${theirPost.id}/like`).expect(204);
    await agent.put(`/api/v1/posts/${theirPost.id}/bookmark`).expect(204);
    await agent.put(`/api/v1/posts/${theirPost.id}/repost`).expect(204);
    await agent.put(`/api/v1/users/${friend.id}/follow`).expect(204);
    await friendAgent.put(`/api/v1/users/${me.id}/follow`).expect(204);
    const direct = conversationSchema.parse(
      (await agent.put(`/api/v1/conversations/direct/${friend.id}`).expect(200)).body,
    );
    const pictures = [await uploadPicture(agent, 'message'), await uploadPicture(agent, 'message')];
    await agent
      .post(`/api/v1/conversations/${direct.id}/messages`)
      .send({ content: 'sent', imageKeys: pictures })
      .expect(201);
    await friendAgent
      .post(`/api/v1/conversations/${direct.id}/messages`)
      .send({ content: 'received' });

    const response = await agent.get('/api/v1/users/me/export').expect(200);
    expect(response.get('Content-Disposition')).toMatch(
      new RegExp(`^attachment; filename="beso-export-${me.username}-\\d{4}-\\d{2}-\\d{2}\\.json"$`),
    );
    const data = accountExportSchema.parse(response.body);
    expect(data.user.id).toBe(me.id);
    expect(data.posts).toHaveLength(1);
    expect(data.posts[0]).toMatchObject({
      content: 'Exported #keep, edited',
      hashtags: ['keep'],
      revisions: [{ content: 'Exported #keep' }],
    });
    expect(data.posts[0]?.imageUrls).toEqual([expect.stringContaining(key)]);
    expect(data.comments.map((comment) => comment.content)).toEqual(['hello']);
    expect(data.likes.map((like) => like.postId)).toEqual([theirPost.id]);
    expect(data.bookmarks.map((bookmark) => bookmark.postId)).toEqual([theirPost.id]);
    expect(data.reposts.map((repost) => repost.postId)).toEqual([theirPost.id]);
    expect(data.following.map((follow) => follow.username)).toEqual([friend.username]);
    expect(data.followers.map((follow) => follow.username)).toEqual([friend.username]);
    // Only my own messages, with the conversation they belong to.
    expect(data.messages.map((message) => message.content)).toEqual(['sent']);
    expect(data.messages[0]?.conversationId).toBe(direct.id);
    // Every picture of a message, in its order.
    expect(data.messages[0]?.imageUrls).toEqual(
      pictures.map((picture) => expect.stringContaining(picture)),
    );
    expect(data.uploads.map((upload) => upload.key)).toEqual([key, ...pictures]);

    await agent.get('/api/v1/users/me/export').expect(200);
    const limited = await agent.get('/api/v1/users/me/export').expect(429);
    expect(apiErrorSchema.parse(limited.body).code).toBe('TOO_MANY_REQUESTS');
  });
});
