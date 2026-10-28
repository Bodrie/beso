import { apiErrorSchema, authResponseSchema, verifyEmailResponseSchema } from '@beso/shared';
import { io } from 'socket.io-client';
import request from 'supertest';
import { EMAIL_TOKEN_POLICY } from '../src/auth/email-tokens.service.js';
import { type TestApp, createTestApp } from './setup/app.js';
import {
  TEST_PASSWORD,
  type TestAgent,
  cookiesFrom,
  createUser,
  login,
} from './setup/factories.js';
import { readOutbox, tokenIn, waitForEmail, waitForEmails } from './setup/outbox.js';

const VERIFY_SUBJECT = /Confirm your email/;
const RESET_SUBJECT = /Reset your/;
const CHANGED_SUBJECT = /password was changed/;

let counter = 0;

/** Registers through the API; the agent holds the new, still unverified session. */
async function registerMember(t: TestApp) {
  counter += 1;
  const member = {
    email: `fresh${counter}@example.com`,
    username: `fresh${counter}`,
    name: `Fresh ${counter}`,
    password: TEST_PASSWORD,
  };
  const agent: TestAgent = request.agent(t.server);
  const response = await agent.post('/api/v1/auth/register').send(member).expect(201);
  return { member, agent, user: authResponseSchema.parse(response.body).user };
}

/** Mails that are sent without being awaited: give them a moment before asserting there are none. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

describe('email verification and password reset', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ listen: true });
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('registration', () => {
    it('starts unverified, mails a link, and keeps the app closed until the link is used', async () => {
      const { member, agent, user } = await registerMember(t);
      expect(user.emailVerifiedAt).toBeNull();

      const mail = await waitForEmail(member.email, VERIFY_SUBJECT);
      expect(mail.text).toContain(`Hi ${member.name}`);
      expect(mail.text).toContain('http://localhost:5173/verify-email?token=');
      // The logo is the picture the web app serves, never an attachment.
      expect(mail.html).toContain('src="http://localhost:5173/mail-logo.png"');

      // The session exists, but only the verification routes answer.
      expect(
        authResponseSchema.parse((await agent.get('/api/v1/auth/me').expect(200)).body).user.id,
      ).toBe(user.id);
      const closed = await agent.get('/api/v1/posts').expect(403);
      expect(apiErrorSchema.parse(closed.body)).toMatchObject({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Confirm your email address to continue',
      });
      await agent.post('/api/v1/posts').send({ content: 'hi' }).expect(403);

      // The socket is closed too.
      const socket = io(t.baseUrl, {
        transports: ['websocket'],
        autoConnect: false,
        reconnection: false,
        auth: {
          token: cookiesFrom(
            (
              await agent
                .post('/api/v1/auth/login')
                .send({ email: member.email, password: member.password })
                .expect(200)
            ).headers['set-cookie'],
          ).access_token,
        },
      });
      const refused = await new Promise<string>((resolve) => {
        socket.once('connect', () => resolve('connected'));
        socket.once('connect_error', (error) => resolve(error.message));
        socket.connect();
      });
      socket.disconnect();
      expect(refused).toBe('Unauthorized');

      // A browser without a session of this account (another device, or anyone the link was
      // forwarded to) confirms the address but is not signed in: the link is not a password.
      const other: TestAgent = request.agent(t.server);
      const verified = await other
        .post('/api/v1/auth/verify-email')
        .send({ token: tokenIn(mail) })
        .expect(200);
      expect(verifyEmailResponseSchema.parse(verified.body)).toEqual({ user: null });
      expect(verified.headers['set-cookie']).toBeUndefined();
      await other.get('/api/v1/posts').expect(401);
      await login(other, member.email);
      await other.get('/api/v1/posts').expect(200);

      // Single use.
      const reused = await other
        .post('/api/v1/auth/verify-email')
        .send({ token: tokenIn(mail) })
        .expect(400);
      expect(apiErrorSchema.parse(reused.body).fields).toHaveProperty('token');

      // The first browser still carries an "unverified" token until it refreshes.
      await agent.get('/api/v1/posts').expect(403);
      await agent.post('/api/v1/auth/refresh').expect(200);
      await agent.get('/api/v1/posts').expect(200);
    });

    it('continues the session of the browser that registered, verified from then on', async () => {
      const { member, agent, user } = await registerMember(t);
      const mail = await waitForEmail(member.email, VERIFY_SUBJECT);

      const response = await agent
        .post('/api/v1/auth/verify-email')
        .send({ token: tokenIn(mail) })
        .expect(200);
      const body = verifyEmailResponseSchema.parse(response.body);
      expect(body.user?.id).toBe(user.id);
      expect(body.user?.emailVerifiedAt).not.toBeNull();
      // A new access token; the refresh token is left alone (no rotation outside /refresh).
      const cookies = cookiesFrom(response.headers['set-cookie']);
      expect(cookies.access_token).toBeTruthy();
      expect(cookies.refresh_token).toBeUndefined();
      await agent.get('/api/v1/posts').expect(200);
      await agent.post('/api/v1/auth/refresh').expect(200);
    });

    it("never signs a browser into someone else's account, nor out of its own", async () => {
      // Whoever registered an address they do not own sends its link to the owner.
      const { member } = await registerMember(t);
      const mail = await waitForEmail(member.email, VERIFY_SUBJECT);
      const owner = await createUser(t.prisma);
      const ownerBrowser: TestAgent = request.agent(t.server);
      await login(ownerBrowser, owner.email);

      const response = await ownerBrowser
        .post('/api/v1/auth/verify-email')
        .send({ token: tokenIn(mail) })
        .expect(200);
      expect(verifyEmailResponseSchema.parse(response.body)).toEqual({ user: null });
      expect(response.headers['set-cookie']).toBeUndefined();
      const me = authResponseSchema.parse(
        (await ownerBrowser.get('/api/v1/auth/me').expect(200)).body,
      );
      expect(me.user.id).toBe(owner.id);
    });

    it('mails a fresh link on request, which voids the previous one, and stops after three', async () => {
      const { member, agent } = await registerMember(t);
      const first = await waitForEmail(member.email, VERIFY_SUBJECT);

      await agent.post('/api/v1/auth/verify-email/resend').expect(204);
      const mails = (await readOutbox()).filter(
        (m) => m.to === member.email && VERIFY_SUBJECT.test(m.subject),
      );
      expect(mails).toHaveLength(2);
      const second = mails[1];
      if (!second) return;
      expect(tokenIn(second)).not.toBe(tokenIn(first));

      await agent
        .post('/api/v1/auth/verify-email')
        .send({ token: tokenIn(first) })
        .expect(400);
      await agent
        .post('/api/v1/auth/verify-email')
        .send({ token: tokenIn(second) })
        .expect(200);

      // Verified now: more requests are a no-op and nothing new is mailed.
      await agent.post('/api/v1/auth/verify-email/resend').expect(204);
      await agent.post('/api/v1/auth/verify-email/resend').expect(204);
      const after = (await readOutbox()).filter((m) => m.to === member.email);
      expect(after).toHaveLength(2);
      // 3 per hour from one address.
      await agent.post('/api/v1/auth/verify-email/resend').expect(429);
    });

    it('rejects garbage, expired and foreign-kind tokens the same way', async () => {
      const { member } = await registerMember(t);
      const mail = await waitForEmail(member.email, VERIFY_SUBJECT);
      await request(t.server).post('/api/v1/auth/verify-email').send({ token: 'nope' }).expect(400);
      await request(t.server).post('/api/v1/auth/verify-email').send({}).expect(400);
      // A verification token is not a reset token.
      await request(t.server)
        .post('/api/v1/auth/reset-password')
        .send({ token: tokenIn(mail), newPassword: 'Another123!' })
        .expect(400);
      await t.prisma.emailToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      await request(t.server)
        .post('/api/v1/auth/verify-email')
        .send({ token: tokenIn(mail) })
        .expect(400);
    });
  });

  describe('forgot and reset password', () => {
    it('answers 204 for any address and only mails real accounts', async () => {
      await request(t.server)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'nobody@example.com' })
        .expect(204);
      await request(t.server).post('/api/v1/auth/forgot-password').send({ email: 'x' }).expect(400);
      await settle();
      expect((await readOutbox()).some((m) => m.to === 'nobody@example.com')).toBe(false);
    });

    it('resets the password, ends every other session, verifies the address and signs in', async () => {
      const user = await createUser(t.prisma, { emailVerifiedAt: null });
      const oldLogin = await request(t.server)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      const oldRefresh = cookiesFrom(oldLogin.headers['set-cookie']).refresh_token;

      await request(t.server)
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(204);
      const mail = await waitForEmail(user.email, RESET_SUBJECT);
      expect(mail.text).toContain('http://localhost:5173/reset-password?token=');

      const browser: TestAgent = request.agent(t.server);
      const weak = await browser
        .post('/api/v1/auth/reset-password')
        .send({ token: tokenIn(mail), newPassword: 'short' })
        .expect(400);
      expect(apiErrorSchema.parse(weak.body).fields).toHaveProperty('newPassword');

      const done = await browser
        .post('/api/v1/auth/reset-password')
        .send({ token: tokenIn(mail), newPassword: 'Brand-new-1' })
        .expect(200);
      const me = authResponseSchema.parse(done.body).user;
      expect(me.id).toBe(user.id);
      // The link proved the address: the account opens even though it never verified before.
      expect(me.emailVerifiedAt).not.toBeNull();
      await browser.get('/api/v1/posts').expect(200);
      // The owner is told, in case it was not them.
      expect((await waitForEmail(user.email, CHANGED_SUBJECT)).text).toContain(
        'http://localhost:5173/forgot-password',
      );

      // Once only, old sessions are gone, and only the new password works.
      await browser
        .post('/api/v1/auth/reset-password')
        .send({ token: tokenIn(mail), newPassword: 'Brand-new-2' })
        .expect(400);
      // The old session is out, and its leftover cookie, presented as often as anyone likes,
      // cannot end the session the reset opened.
      for (let i = 0; i < 2; i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- sequential on purpose
        await request(t.server)
          .post('/api/v1/auth/refresh')
          .set('Cookie', `refresh_token=${oldRefresh}`)
          .expect(401);
      }
      await browser.post('/api/v1/auth/refresh').expect(200);
      await browser.get('/api/v1/posts').expect(200);
      await request(t.server)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(401);
      await request(t.server)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'Brand-new-1' })
        .expect(200);
    });

    it('voids an outstanding reset link when the password is changed from inside the app', async () => {
      const user = await createUser(t.prisma);
      const agent: TestAgent = request.agent(t.server);
      await login(agent, user.email);
      await request(t.server)
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(204);
      const mail = await waitForEmail(user.email, RESET_SUBJECT);

      await agent
        .post('/api/v1/auth/password')
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'Changed-inside-1' })
        .expect(204);
      await waitForEmail(user.email, CHANGED_SUBJECT);
      await request(t.server)
        .post('/api/v1/auth/reset-password')
        .send({ token: tokenIn(mail), newPassword: 'Via-link-1' })
        .expect(400);
    });
  });
});

// A fresh app: the per-address throttlers above have counted this test client already.
describe('email limits per account', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  /** Mails of this kind the account had "earlier this hour", each older than the cooldown. */
  const alreadyMailed = (userId: string, kind: 'verify_email' | 'password_reset', count: number) =>
    t.prisma.emailToken.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        userId,
        kind,
        tokenHash: `earlier-${userId}-${kind}-${i}`,
        createdAt: new Date(Date.now() - (10 + i) * 60_000),
        expiresAt: new Date(Date.now() + 60_000),
      })),
    });

  it('keeps every reset link good until one is used, with a pause between two mails', async () => {
    const user = await createUser(t.prisma);
    const forgot = () =>
      request(t.server)
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email })
        .expect(204);

    await forgot();
    const [first] = await waitForEmails(user.email, RESET_SUBJECT, 1);
    // Asked again at once (by anyone, from anywhere): still one mail.
    await forgot();
    await settle();
    expect(
      (await readOutbox()).filter((m) => m.to === user.email && RESET_SUBJECT.test(m.subject)),
    ).toHaveLength(1);

    // After the cooldown a second link goes out, and it does not void the first one.
    await t.prisma.emailToken.updateMany({
      where: { userId: user.id },
      data: { createdAt: new Date(Date.now() - 2 * EMAIL_TOKEN_POLICY.password_reset.cooldownMs) },
    });
    await forgot();
    const [, second] = await waitForEmails(user.email, RESET_SUBJECT, 2);
    if (!first || !second) throw new Error('expected two reset mails');

    await request(t.server)
      .post('/api/v1/auth/reset-password')
      .send({ token: tokenIn(first), newPassword: 'Brand-new-1' })
      .expect(200);
    // Using one voids the others.
    await request(t.server)
      .post('/api/v1/auth/reset-password')
      .send({ token: tokenIn(second), newPassword: 'Brand-new-2' })
      .expect(400);
  });

  it('caps reset mails per account per hour, still answering 204', async () => {
    const user = await createUser(t.prisma);
    await alreadyMailed(user.id, 'password_reset', EMAIL_TOKEN_POLICY.password_reset.perHour);

    await request(t.server)
      .post('/api/v1/auth/forgot-password')
      .send({ email: user.email })
      .expect(204);
    await settle();
    expect((await readOutbox()).some((m) => m.to === user.email)).toBe(false);
  });

  it('caps confirmation mails per account per hour', async () => {
    const { member, agent, user } = await registerMember(t);
    await waitForEmail(member.email, VERIFY_SUBJECT);
    await alreadyMailed(user.id, 'verify_email', EMAIL_TOKEN_POLICY.verify_email.perHour - 1);

    const refused = await agent.post('/api/v1/auth/verify-email/resend').expect(429);
    expect(apiErrorSchema.parse(refused.body)).toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'Enough emails were sent for now. Try again later.',
    });
    expect((await readOutbox()).filter((m) => m.to === member.email)).toHaveLength(1);
  });
});
