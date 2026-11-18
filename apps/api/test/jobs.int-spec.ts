import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { SchedulerRegistry } from '@nestjs/schedule';
import { uploadResponseSchema } from '@beso/shared';
import sharp from 'sharp';
import request from 'supertest';
import { EmailTokensService } from '../src/auth/email-tokens.service.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { type TestApp, createTestApp } from './setup/app.js';
import { type CreatedUser, type TestAgent, createUser, login } from './setup/factories.js';
import { readOutbox, tokenIn, waitForEmail } from './setup/outbox.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** The jobs' clock: a minute ahead of the rows the tests create, so those count as fresh. */
const now = new Date(Date.now() + 60_000);
const ago = (ms: number): Date => new Date(now.getTime() - ms);

const fileOf = (key: string): string => path.join(process.env.UPLOADS_DIR ?? '', key);

async function agentFor(t: TestApp, user: CreatedUser): Promise<TestAgent> {
  const agent = request.agent(t.server);
  await login(agent, user.email);
  return agent;
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

describe('daily jobs', () => {
  let t: TestApp;
  let jobs: JobsService;

  const registered = async (user: CreatedUser, daysAgo: number): Promise<void> => {
    await t.prisma.user.update({ where: { id: user.id }, data: { createdAt: ago(daysAgo * DAY) } });
  };

  beforeAll(async () => {
    t = await createTestApp();
    jobs = t.app.get(JobsService);
  });

  afterAll(async () => {
    await t.app.close();
  });

  // JOBS_ENABLED=false in the test environment: the clock below is the only one that runs them.
  it('runs on no timer in tests', () => {
    expect(t.app.get(SchedulerRegistry).getCronJobs().size).toBe(0);
  });

  it('removes uploads nobody attached within a day, rows and files', async () => {
    const alice = await createUser(t.prisma);
    const agent = await agentFor(t, alice);
    const orphan = await uploadPicture(agent);
    const attached = await uploadPicture(agent);
    const fresh = await uploadPicture(agent);
    await agent.post('/api/v1/posts').send({ content: 'with a picture', imageKeys: [attached] });
    // Pictures sent in a chat message are attached too, the second of them as much as the first.
    const sent = [await uploadPicture(agent, 'message'), await uploadPicture(agent, 'message')];
    const unsent = await uploadPicture(agent, 'message');
    const bob = await createUser(t.prisma);
    const direct = await agent.put(`/api/v1/conversations/direct/${bob.id}`).expect(200);
    await agent
      .post(`/api/v1/conversations/${direct.body.id}/messages`)
      .send({ imageKeys: sent })
      .expect(201);
    await t.prisma.upload.updateMany({
      where: { key: { in: [orphan, attached, unsent, ...sent] } },
      data: { createdAt: ago(25 * HOUR) },
    });

    await jobs.runDaily(now);

    const rows = await t.prisma.upload.findMany({ where: { ownerId: alice.id } });
    expect(rows.map((row) => row.key).toSorted()).toEqual([attached, fresh, ...sent].toSorted());
    expect(existsSync(fileOf(orphan))).toBe(false);
    expect(existsSync(fileOf(unsent))).toBe(false);
    for (const key of sent) expect(existsSync(fileOf(key))).toBe(true);
    expect(existsSync(fileOf(attached))).toBe(true);
    expect(existsSync(fileOf(fresh))).toBe(true);
  });

  it('records the size of uploads stored before sizes were kept, and goes on past a missing file', async () => {
    const agent = await agentFor(t, await createUser(t.prisma));
    const older = await uploadPicture(agent);
    const missing = await uploadPicture(agent);
    await t.prisma.upload.updateMany({
      where: { key: { in: [older, missing] } },
      data: { width: null, height: null, bytes: null },
    });
    rmSync(fileOf(missing));

    await jobs.runDaily(now);

    const rows = await t.prisma.upload.findMany({
      where: { key: { in: [older, missing] } },
      select: { key: true, width: true, height: true, bytes: true },
    });
    expect(rows.find((row) => row.key === older)).toMatchObject({ width: 64, height: 64 });
    expect(rows.find((row) => row.key === older)?.bytes).toBeGreaterThan(0);
    expect(rows.find((row) => row.key === missing)).toMatchObject({ width: null, bytes: null });
  });

  it('drops expired tokens and keeps the live and the rotated ones', async () => {
    const user = await createUser(t.prisma);
    const hash = (raw: string): string => t.app.get(EmailTokensService).hash(raw);
    await t.prisma.emailToken.createMany({
      data: [
        { userId: user.id, kind: 'verify_email', tokenHash: hash('gone'), expiresAt: ago(1) },
        { userId: user.id, kind: 'password_reset', tokenHash: hash('live'), expiresAt: ago(-HOUR) },
      ],
    });
    await t.prisma.refreshToken.createMany({
      data: [
        { userId: user.id, tokenHash: hash('r-gone'), expiresAt: ago(1) },
        { userId: user.id, tokenHash: hash('r-live'), expiresAt: ago(-DAY) },
        // Rotated tokens are what reuse detection looks for: they stay until they expire.
        {
          userId: user.id,
          tokenHash: hash('r-rotated'),
          expiresAt: ago(-DAY),
          revokedAt: ago(HOUR),
        },
      ],
    });

    await jobs.runDaily(now);

    const emailTokens = await t.prisma.emailToken.findMany({ where: { userId: user.id } });
    expect(emailTokens.map((token) => token.tokenHash)).toEqual([hash('live')]);
    const refreshTokens = await t.prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(refreshTokens.map((token) => token.tokenHash).toSorted()).toEqual(
      [hash('r-live'), hash('r-rotated')].toSorted(),
    );
  });

  it('forgets notifications older than ninety days, read or not', async () => {
    const member = await createUser(t.prisma);
    const fan = await createUser(t.prisma);
    await t.prisma.notification.createMany({
      data: [
        { userId: member.id, type: 'USER_FOLLOWED', actorId: fan.id, createdAt: ago(91 * DAY) },
        {
          userId: fan.id,
          type: 'USER_FOLLOWED',
          actorId: member.id,
          createdAt: ago(89 * DAY),
          readAt: ago(88 * DAY),
        },
      ],
    });

    await jobs.runDaily(now);

    const left = await t.prisma.notification.findMany({
      where: { userId: { in: [member.id, fan.id] }, type: 'USER_FOLLOWED' },
    });
    expect(left.map((row) => row.userId)).toEqual([fan.id]);
  });

  it('warns an unconfirmed account once, with a working link and the removal date', async () => {
    const waiting = await createUser(t.prisma, { emailVerifiedAt: null });
    const young = await createUser(t.prisma, { emailVerifiedAt: null });
    const member = await createUser(t.prisma);
    await registered(waiting, 24);
    await registered(young, 10);
    await registered(member, 40);

    await jobs.runDaily(now);

    const mail = await waitForEmail(waiting.email, /account will be removed/);
    const removalDate = ago(24 * DAY - 30 * DAY).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    expect(mail.text).toContain(`will be removed after ${removalDate}`);
    const row = await t.prisma.user.findUniqueOrThrow({
      where: { id: waiting.id },
      select: { expiryWarnedAt: true },
    });
    expect(row.expiryWarnedAt).toEqual(now);
    await request(t.server)
      .post('/api/v1/auth/verify-email')
      .send({ token: tokenIn(mail) })
      .expect(200);

    // The next day nobody is warned twice, and the young and the confirmed accounts hear nothing.
    await jobs.runDaily(new Date(now.getTime() + DAY));
    const outbox = await readOutbox();
    expect(outbox.filter((entry) => entry.to === waiting.email)).toHaveLength(1);
    expect(outbox.filter((entry) => [young.email, member.email].includes(entry.to))).toEqual([]);
  });

  it('erases an account still unconfirmed after thirty days, its threads with it, without a mail', async () => {
    const stale = await createUser(t.prisma, { emailVerifiedAt: null });
    await registered(stale, 31);
    const other = await createUser(t.prisma);
    const agent = await agentFor(t, other);
    const thread = await agent.put(`/api/v1/conversations/direct/${stale.id}`).expect(200);
    await agent
      .post(`/api/v1/conversations/${thread.body.id}/messages`)
      .send({ content: 'Are you there?' })
      .expect(201);

    await jobs.runDaily(now);

    expect(await t.prisma.user.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await t.prisma.conversation.findUnique({ where: { id: thread.body.id } })).toBeNull();
    expect((await readOutbox()).filter((entry) => entry.to === stale.email)).toEqual([]);
    expect(await t.prisma.user.findUnique({ where: { id: other.id } })).not.toBeNull();
  });

  it('awards tenure and what listeners missed; a pre-badge account silently, suspended ones not', async () => {
    const veteran = await createUser(t.prisma);
    await registered(veteran, 40);
    const old = await createUser(t.prisma);
    await registered(old, 200);
    await t.prisma.post.create({ data: { authorId: old.id, content: 'From long ago' } });
    await t.prisma.user.update({ where: { id: old.id }, data: { achievementsCheckedAt: null } });
    const suspended = await createUser(t.prisma);
    await registered(suspended, 40);
    await t.prisma.user.update({
      where: { id: suspended.id },
      data: { suspendedAt: new Date() },
    });

    await jobs.runDaily(now);

    const keysOf = async (userId: string) =>
      (await t.prisma.userAchievement.findMany({ where: { userId } })).map((row) => row.key);
    const badgeNotes = (userId: string) =>
      t.prisma.notification.findMany({ where: { userId, type: 'ACHIEVEMENT_EARNED' } });
    expect(await keysOf(veteran.id)).toContain('member-1m');
    expect((await badgeNotes(veteran.id)).map((row) => row.achievementKey)).toContain('member-1m');
    expect(await keysOf(old.id)).toEqual(expect.arrayContaining(['member-6m', 'first-post']));
    expect(await badgeNotes(old.id)).toEqual([]);
    expect(await keysOf(suspended.id)).toEqual([]);

    // A second run finds nothing new.
    const before = await t.prisma.notification.count({ where: { type: 'ACHIEVEMENT_EARNED' } });
    await jobs.runDaily(now);
    expect(await t.prisma.notification.count({ where: { type: 'ACHIEVEMENT_EARNED' } })).toBe(
      before,
    );
  });

  describe('frequent jobs', () => {
    it('tell the author and the voters once when a poll closes, never before', async () => {
      const [author, voter, other, muter] = await Promise.all([
        createUser(t.prisma),
        createUser(t.prisma),
        createUser(t.prisma),
        createUser(t.prisma),
      ]);
      const asked = (closesAt: Date) =>
        t.prisma.post.create({
          data: {
            authorId: author.id,
            content: 'Tea or coffee?',
            poll: {
              create: {
                closesAt,
                options: {
                  create: ['Tea', 'Coffee'].map((text, position) => ({ text, position })),
                },
              },
            },
          },
          select: { id: true, poll: { select: { options: { select: { id: true } } } } },
        });
      const [closed, open] = await Promise.all([asked(ago(60_000)), asked(ago(-HOUR))]);
      const option = closed.poll?.options[0]?.id ?? '';
      await t.prisma.pollVote.createMany({
        data: [voter, other, muter].map((user) => ({
          postId: closed.id,
          userId: user.id,
          optionId: option,
        })),
      });
      await t.prisma.mute.create({ data: { muterId: muter.id, mutedId: author.id } });

      await jobs.runFrequent(now);

      const told = await t.prisma.notification.findMany({
        where: { type: 'POLL_ENDED' },
        select: { userId: true, actorId: true, postId: true },
      });
      expect(told).toHaveLength(3);
      expect(told).toEqual(
        expect.arrayContaining([
          { userId: author.id, actorId: null, postId: closed.id },
          { userId: voter.id, actorId: author.id, postId: closed.id },
          { userId: other.id, actorId: author.id, postId: closed.id },
        ]),
      );
      const stamps = await t.prisma.poll.findMany({
        where: { postId: { in: [closed.id, open.id] } },
        select: { postId: true, endedNotifiedAt: true },
      });
      expect(stamps.find((row) => row.postId === closed.id)?.endedNotifiedAt).toEqual(now);
      expect(stamps.find((row) => row.postId === open.id)?.endedNotifiedAt).toBeNull();

      await jobs.runFrequent(now);
      expect(await t.prisma.notification.count({ where: { type: 'POLL_ENDED' } })).toBe(3);
    });
  });
});
