/**
 * Development / e2e seed. Deterministic (faker seeded) and destructive:
 * it truncates every table before inserting. Run with `pnpm db:seed`.
 *
 * Fixed accounts (password for all: Password123!):
 *   alice@example.com (alice), bob@example.com (bob), carol@example.com (carol)
 * alice's invite link is /join/welcome-from-alice (carol joined through it).
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { faker } from '@faker-js/faker';
import { PrismaPg } from '@prisma/adapter-pg';
import { extractEntities } from '@beso/shared';
import argon2 from 'argon2';
import sharp from 'sharp';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { ActivityType, NotificationType, ReactionType } from '../src/generated/prisma/enums.js';
import { TABLES } from '../src/prisma/tables.js';
import { placeholderAvatar, placeholderPostImage } from './placeholders.js';

const FAKER_SEED = 20261015;
const FAKE_USER_COUNT = 20;
export const SEED_PASSWORD = 'Password123!';

export /** alice's invite code: `/join/welcome-from-alice` (F1). */
const SEED_INVITE_CODE = 'welcome-from-alice';

const FIXED_USERS = [
  { email: 'alice@example.com', username: 'alice', name: 'Alice Anderson', city: 'Sofia' },
  { email: 'bob@example.com', username: 'bob', name: 'Bob Brown', city: 'Plovdiv' },
  { email: 'carol@example.com', username: 'carol', name: 'Carol Clark', city: 'Varna' },
] as const;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set');
}

/**
 * The seed truncates every table and wipes the upload folders: it must never meet a database
 * that is not a developer's own (review L13). `SEED_FORCE=1` is the explicit override.
 */
function assertSeedTarget(url: string): void {
  if (process.env.SEED_FORCE === '1') return;
  const host = new URL(url).hostname;
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  if (process.env.NODE_ENV === 'production' || !local) {
    throw new Error(
      `Refusing to seed "${host}" (NODE_ENV=${process.env.NODE_ENV ?? 'development'}): the seed destroys every table. Set SEED_FORCE=1 if you really mean it.`,
    );
  }
}
assertSeedTarget(databaseUrl);

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const uploadsDir = path.resolve(process.env.UPLOADS_DIR ?? './uploads');

/**
 * Writes a generated file into the uploads dir, records its owner and size, and returns the
 * storage key.
 */
async function seedFile(
  kind: 'avatar' | 'post' | 'message',
  ownerId: string,
  data: Buffer,
): Promise<string> {
  const key = `${kind}/${randomUUID()}.webp`;
  const file = path.join(uploadsDir, key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  const { width, height } = await sharp(data).metadata();
  await prisma.upload.create({ data: { key, ownerId, kind, width, height, bytes: data.length } });
  return key;
}

/** Pictures for a post: generated files of the author's, attached in order. */
async function seedPostImages(
  postId: string,
  authorId: string,
  captions: string[],
  size?: { width: number; height: number },
): Promise<void> {
  const keys: string[] = [];
  for (const [index, caption] of captions.entries()) {
    const image = await placeholderPostImage(caption, `${postId}-${index}`, size);
    keys.push(await seedFile('post', authorId, image));
  }
  await prisma.postImage.createMany({
    data: keys.map((key, position) => ({ postId, position, key })),
  });
}

/** Pictures for a chat message: generated files of the sender's, as the rows that attach them. */
async function seedMessageImages(
  senderId: string,
  pictures: { caption: string; width: number; height: number }[],
): Promise<{ position: number; key: string }[]> {
  const rows: { position: number; key: string }[] = [];
  for (const [position, { caption, ...size }] of pictures.entries()) {
    // The caption leads the seed of the colour, so the pictures of one message differ.
    const image = await placeholderPostImage(caption, `${caption}-${senderId}`, size);
    rows.push({ position, key: await seedFile('message', senderId, image) });
  }
  return rows;
}

/** Usernames must satisfy the shared rule (lowercase letters, digits, underscores) and be unique. */
function seedUsername(raw: string, taken: Set<string>): string {
  const base =
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 27) || 'user';
  let candidate = base;
  let suffix = 1;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `${base}_${suffix}`;
  }
  taken.add(candidate);
  return candidate;
}

function pick<T>(items: readonly T[], count: number): T[] {
  return faker.helpers.arrayElements(items, count);
}

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((table) => `"${table}"`).join(', ')} CASCADE`,
  );
  // Generated files from previous runs are orphans once their rows are gone.
  await Promise.all(
    ['avatar', 'cover', 'post', 'message'].map((kind) =>
      rm(path.join(uploadsDir, kind), { recursive: true, force: true }),
    ),
  );
}

async function seed(): Promise<void> {
  faker.seed(FAKER_SEED);
  const passwordHash = await argon2.hash(SEED_PASSWORD, { type: argon2.argon2id });

  await truncateAll();

  // --- users -------------------------------------------------------------
  const takenUsernames = new Set<string>(FIXED_USERS.map((u) => u.username));
  const fakeUsers = Array.from({ length: FAKE_USER_COUNT }, () => {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    return {
      email: faker.internet.email({ firstName, lastName }).toLowerCase(),
      username: seedUsername(faker.internet.username({ firstName, lastName }), takenUsernames),
      name: `${firstName} ${lastName}`,
      city: faker.location.city(),
      bio: faker.helpers.maybe(() => faker.person.bio(), { probability: 0.7 }) ?? null,
      website: faker.helpers.maybe(() => faker.internet.url(), { probability: 0.3 }) ?? null,
    };
  });

  const users = await prisma.user.createManyAndReturn({
    data: [...FIXED_USERS.map((u) => ({ ...u, bio: null, website: null })), ...fakeUsers].map(
      // Demo accounts are born verified; real members confirm their address through the mailed link.
      // alice runs the demo: she reads the reports queue (ADR 0016). Their badges are not counted
      // yet (F2): the first count awards what the seeded data reached, silently, like the
      // accounts that existed before achievements.
      (u) => ({
        ...u,
        passwordHash,
        emailVerifiedAt: new Date(),
        achievementsCheckedAt: null,
        role: u.username === 'alice' ? ('admin' as const) : ('member' as const),
      }),
    ),
    select: { id: true, username: true, name: true },
  });
  const userIds = users.map((u) => u.id);

  // --- invites (F1): alice's link has a fixed code (e2e and the a11y check open /join/<code>),
  // and carol joined through it.
  const [inviter, , invitee] = users;
  if (inviter && invitee) {
    await prisma.user.update({ where: { id: inviter.id }, data: { inviteCode: SEED_INVITE_CODE } });
    await prisma.user.update({ where: { id: invitee.id }, data: { invitedById: inviter.id } });
  }

  for (const user of users) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        avatarKey: await seedFile(
          'avatar',
          user.id,
          await placeholderAvatar(user.username, user.id),
        ),
      },
    });
  }

  await prisma.activity.createMany({
    data: userIds.map((actorId) => ({ actorId, type: ActivityType.USER_REGISTERED })),
  });

  // --- follows -----------------------------------------------------------
  const follows = userIds.flatMap((followerId) =>
    pick(
      userIds.filter((id) => id !== followerId),
      faker.number.int({ min: 3, max: 8 }),
    ).map((followeeId) => ({ followerId, followeeId })),
  );
  await prisma.follow.createMany({ data: follows, skipDuplicates: true });
  await prisma.activity.createMany({
    data: follows.map((f) => ({
      actorId: f.followerId,
      type: ActivityType.USER_FOLLOWED,
      targetUserId: f.followeeId,
    })),
  });

  // --- posts -------------------------------------------------------------
  const posts = await prisma.post.createManyAndReturn({
    data: userIds.flatMap((authorId) =>
      Array.from({ length: faker.number.int({ min: 1, max: 5 }) }, () => ({
        authorId,
        content: faker.lorem.paragraph({ min: 1, max: 3 }).slice(0, 500),
        createdAt: faker.date.recent({ days: 30 }),
      })),
    ),
    select: { id: true, authorId: true, createdAt: true },
  });
  // About a third of the posts carry pictures: mostly one (now and then a tall one), a few up to four.
  for (const post of posts) {
    if (faker.number.int({ min: 1, max: 10 }) <= 3) {
      const count = faker.helpers.weightedArrayElement([
        { weight: 6, value: 1 },
        { weight: 2, value: 2 },
        { weight: 1, value: 3 },
        { weight: 1, value: 4 },
      ]);
      const tall = count === 1 && faker.datatype.boolean({ probability: 0.3 });
      await seedPostImages(
        post.id,
        post.authorId,
        Array.from({ length: count }, () => faker.word.words(2)),
        tall ? { width: 720, height: 960 } : undefined,
      );
    }
  }
  await prisma.activity.createMany({
    data: posts.map((p) => ({
      actorId: p.authorId,
      type: ActivityType.POST_CREATED,
      postId: p.id,
      createdAt: p.createdAt,
    })),
  });

  // --- likes -------------------------------------------------------------
  const likes = posts.flatMap((post) =>
    pick(
      userIds.filter((id) => id !== post.authorId),
      faker.number.int({ min: 0, max: 6 }),
    ).map((userId) => ({ userId, postId: post.id })),
  );
  await prisma.postLike.createMany({ data: likes, skipDuplicates: true });
  await prisma.activity.createMany({
    data: likes.map((l) => ({
      actorId: l.userId,
      type: ActivityType.POST_LIKED,
      postId: l.postId,
    })),
  });

  // --- bookmarks (the demo accounts' private saves) ----------------------
  await prisma.bookmark.createMany({
    data: users.slice(0, FIXED_USERS.length).flatMap((u) =>
      pick(
        posts.filter((p) => p.authorId !== u.id),
        4,
      ).map((p) => ({ userId: u.id, postId: p.id })),
    ),
    skipDuplicates: true,
  });

  // --- reposts and one quote (ADR 0017) -----------------------------------
  const demoUsers = users.slice(0, FIXED_USERS.length);
  const reposts = demoUsers.flatMap((u) =>
    pick(
      posts.filter((p) => p.authorId !== u.id),
      2,
    ).map((p) => ({ userId: u.id, postId: p.id })),
  );
  await prisma.repost.createMany({ data: reposts, skipDuplicates: true });
  await prisma.activity.createMany({
    data: reposts.map((r) => ({
      actorId: r.userId,
      type: ActivityType.POST_REPOSTED,
      postId: r.postId,
      targetUserId: posts.find((p) => p.id === r.postId)?.authorId,
    })),
  });
  const [seedAlice, seedBob] = demoUsers;
  const alicePost = posts.find((p) => p.authorId === seedAlice?.id);
  if (seedAlice && seedBob && alicePost) {
    const quote = await prisma.post.create({
      data: {
        authorId: seedBob.id,
        content: 'This one deserves a second look.',
        quotedPostId: alicePost.id,
        wasQuote: true,
      },
      select: { id: true },
    });
    await prisma.activity.create({
      data: {
        actorId: seedBob.id,
        type: ActivityType.POST_QUOTED,
        postId: quote.id,
        targetUserId: seedAlice.id,
      },
    });
  }
  await prisma.$executeRaw`
    UPDATE posts p SET repost_count =
      (SELECT count(*) FROM reposts r WHERE r.post_id = p.id)
      + (SELECT count(*) FROM posts q WHERE q.quoted_post_id = p.id)`;

  // --- comments ----------------------------------------------------------
  const topLevel = await prisma.comment.createManyAndReturn({
    data: posts.flatMap((post) =>
      Array.from({ length: faker.number.int({ min: 0, max: 4 }) }, () => ({
        postId: post.id,
        authorId: faker.helpers.arrayElement(userIds),
        content: faker.lorem.sentence(),
        createdAt: faker.date.between({ from: post.createdAt, to: new Date() }),
      })),
    ),
    select: { id: true, authorId: true, postId: true, parentId: true, createdAt: true },
  });
  // A few replies (one level, C2), so some threads have something to unfold.
  const replies = await prisma.comment.createManyAndReturn({
    data: topLevel.flatMap((parent) =>
      Array.from({ length: faker.number.int({ min: 0, max: 2 }) }, () => ({
        postId: parent.postId,
        parentId: parent.id,
        authorId: faker.helpers.arrayElement(userIds),
        content: faker.lorem.sentence(),
        createdAt: faker.date.between({ from: parent.createdAt, to: new Date() }),
      })),
    ),
    select: { id: true, authorId: true, postId: true, parentId: true, createdAt: true },
  });
  const comments = [...topLevel, ...replies];
  const parentAuthorOf = new Map(topLevel.map((c) => [c.id, c.authorId]));
  await prisma.activity.createMany({
    data: comments.map((c) => ({
      actorId: c.authorId,
      type: ActivityType.COMMENT_CREATED,
      postId: c.postId,
      commentId: c.id,
      createdAt: c.createdAt,
    })),
  });

  // --- notifications for the demo accounts (what happened to their things) ---
  const demoIds = new Set(users.slice(0, FIXED_USERS.length).map((u) => u.id));
  const authorOf = new Map(posts.map((p) => [p.id, p.authorId]));
  const ownPost = (postId: string, actorId: string) => {
    const authorId = authorOf.get(postId);
    return authorId !== undefined && authorId !== actorId && demoIds.has(authorId)
      ? authorId
      : null;
  };
  await prisma.notification.createMany({
    data: [
      ...follows
        .filter((f) => demoIds.has(f.followeeId))
        .map((f) => ({
          userId: f.followeeId,
          type: NotificationType.USER_FOLLOWED,
          actorId: f.followerId,
        })),
      ...likes.flatMap((l) => {
        const userId = ownPost(l.postId, l.userId);
        return userId
          ? [{ userId, type: NotificationType.POST_LIKED, actorId: l.userId, postId: l.postId }]
          : [];
      }),
      // Like the listener: a reply tells the parent's author, and the post's author unless
      // that is the same person.
      ...comments.flatMap((c) => {
        const userId = ownPost(c.postId, c.authorId);
        const parentAuthorId = c.parentId === null ? null : parentAuthorOf.get(c.parentId);
        return userId && userId !== parentAuthorId
          ? [
              {
                userId,
                type: NotificationType.POST_COMMENTED,
                actorId: c.authorId,
                postId: c.postId,
                commentId: c.id,
                createdAt: c.createdAt,
              },
            ]
          : [];
      }),
      ...replies.flatMap((r) => {
        const userId = r.parentId === null ? undefined : parentAuthorOf.get(r.parentId);
        return userId && userId !== r.authorId && demoIds.has(userId)
          ? [
              {
                userId,
                type: NotificationType.COMMENT_REPLIED,
                actorId: r.authorId,
                postId: r.postId,
                commentId: r.id,
                createdAt: r.createdAt,
              },
            ]
          : [];
      }),
      // carol came through alice's invite (F1).
      ...(inviter && invitee
        ? [{ userId: inviter.id, type: NotificationType.INVITE_JOINED, actorId: invitee.id }]
        : []),
    ],
    skipDuplicates: true,
  });
  // All but the newest few are read, so the bell shows a realistic number.
  for (const userId of demoIds) {
    const newest = await prisma.notification.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 4,
      select: { id: true },
    });
    await prisma.notification.updateMany({
      where: { userId, id: { notIn: newest.map((n) => n.id) } },
      data: { readAt: new Date() },
    });
  }

  // --- comment reactions and a few edits ---------------------------------
  const reactionTypes = Object.values(ReactionType);
  const reactions = comments.flatMap((c) =>
    pick(userIds, faker.number.int({ min: 0, max: 3 })).map((userId) => ({
      commentId: c.id,
      userId,
      type: faker.helpers.arrayElement(reactionTypes),
    })),
  );
  await prisma.commentReaction.createMany({ data: reactions, skipDuplicates: true });
  // The denormalised total that "sort by top" relies on.
  await prisma.$executeRaw`
    UPDATE comments c
    SET reactions_count = (SELECT count(*) FROM comment_reactions r WHERE r.comment_id = c.id)
  `;
  // One edited comment and one edited post, so the "edited" history has something to show.
  const [editedComment] = comments;
  if (editedComment) {
    const current = await prisma.comment.findUniqueOrThrow({
      where: { id: editedComment.id },
      select: { content: true },
    });
    await prisma.$transaction([
      prisma.commentRevision.create({
        data: { commentId: editedComment.id, content: current.content },
      }),
      prisma.comment.update({
        where: { id: editedComment.id },
        data: { content: `${current.content} (clarified)`, editedAt: new Date() },
      }),
    ]);
  }
  const [editedPost] = posts;
  if (editedPost) {
    const current = await prisma.post.findUniqueOrThrow({
      where: { id: editedPost.id },
      select: { content: true },
    });
    await prisma.$transaction([
      prisma.postRevision.create({ data: { postId: editedPost.id, content: current.content } }),
      prisma.post.update({
        where: { id: editedPost.id },
        data: { content: `${current.content} Update: typo fixed.`, editedAt: new Date() },
      }),
    ]);
  }

  // --- tagged posts and mentions between the fixed accounts ------------------
  // Dated a few days back so they sit inside the trending window without topping the feeds.
  const [alice, bob, carol] = users;
  if (alice && bob && carol) {
    const tagged: { author: typeof alice; content: string; pictures?: string[] }[] = [
      {
        author: alice,
        content: 'Who is up for a hike this #weekend? @bob @carol bring the good snacks.',
      },
      {
        author: bob,
        content: 'New #photography set from the coast is up. Thanks @alice for the tip!',
        pictures: ['Dunes', 'Lighthouse', 'Low tide'],
      },
      { author: carol, content: 'First post on #BeSo. Hello everyone, hello @alice!' },
      {
        author: alice,
        content: 'Reading list for the #weekend: https://example.com/reading #beso',
      },
    ];
    const byUsername = new Map(users.map((user) => [user.username, user.id]));
    for (const [index, item] of tagged.entries()) {
      const createdAt = new Date(Date.now() - (2 + index) * 24 * 60 * 60 * 1000);
      const entities = extractEntities(item.content);
      const post = await prisma.post.create({
        data: {
          authorId: item.author.id,
          content: item.content,
          createdAt,
          mentions: {
            create: entities.mentions
              .map((username) => byUsername.get(username))
              .filter((id): id is string => id !== undefined)
              .map((userId) => ({ userId })),
          },
          hashtags: { create: entities.hashtags.map((tag) => ({ tag, createdAt })) },
        },
        select: { id: true },
      });
      if (item.pictures) await seedPostImages(post.id, item.author.id, item.pictures);
      await prisma.activity.create({
        data: {
          actorId: item.author.id,
          type: ActivityType.POST_CREATED,
          postId: post.id,
          createdAt,
        },
      });
    }
  }

  // --- a pinned post: bob shows his photo set first on his profile ------------------------
  if (bob) {
    const photos = await prisma.post.findFirst({
      where: { authorId: bob.id, content: { startsWith: 'New #photography set' } },
      select: { id: true },
    });
    if (photos) {
      await prisma.user.update({ where: { id: bob.id }, data: { pinnedPostId: photos.id } });
    }
  }

  // --- polls (F3): one alice can still vote in, one with its results --------------------
  if (alice && bob && carol) {
    const hour = 60 * 60 * 1000;
    const poll = async (
      author: typeof alice,
      content: string,
      options: string[],
      createdAt: Date,
      closesAt: Date,
      votes: { user: typeof alice; option: number }[],
    ) => {
      const post = await prisma.post.create({
        data: {
          authorId: author.id,
          content,
          createdAt,
          poll: {
            create: {
              closesAt,
              // A closed seed poll counts as announced: a reseed tells nobody anything.
              endedNotifiedAt: closesAt <= new Date() ? closesAt : null,
              options: { create: options.map((text, position) => ({ text, position })) },
            },
          },
        },
        select: {
          id: true,
          poll: { select: { options: { select: { id: true, position: true } } } },
        },
      });
      const optionAt = (index: number) =>
        post.poll?.options.find((option) => option.position === index)?.id ?? '';
      await prisma.pollVote.createMany({
        data: votes.map((vote) => ({
          postId: post.id,
          userId: vote.user.id,
          optionId: optionAt(vote.option),
        })),
      });
      await prisma.activity.create({
        data: { actorId: author.id, type: ActivityType.POST_CREATED, postId: post.id, createdAt },
      });
    };
    await poll(
      bob,
      'Hike on Saturday or Sunday?',
      ['Saturday', 'Sunday', 'Both!'],
      new Date(Date.now() - 2 * hour),
      new Date(Date.now() + 70 * hour),
      [{ user: carol, option: 2 }],
    );
    await poll(
      carol,
      'Best snack for the trail?',
      ['Trail mix', 'Bananas', 'Chocolate'],
      new Date(Date.now() - 30 * hour),
      new Date(Date.now() - 6 * hour),
      [
        { user: alice, option: 2 },
        { user: bob, option: 0 },
      ],
    );
  }

  // --- conversations between the fixed accounts ------------------------------
  if (alice && bob) {
    const direct = await prisma.conversation.create({
      data: {
        kind: 'direct',
        directKey: [alice.id, bob.id].toSorted().join(':'),
        members: { create: [{ userId: alice.id }, { userId: bob.id }] },
      },
      select: { id: true },
    });
    const texts = Array.from({ length: 12 }, (_, i) => ({
      conversationId: direct.id,
      senderId: i % 2 === 0 ? alice.id : bob.id,
      content: faker.lorem.sentence(),
      createdAt: new Date(Date.now() - (12 - i) * 60_000),
    }));
    await prisma.message.createMany({ data: texts });
    // Bob's last text answers Alice's before it, so the thread shows a reply with its quote.
    const [asked, answer] = await Promise.all(
      [texts[10], texts[11]].map((text) =>
        prisma.message.findFirst({
          where: { conversationId: direct.id, createdAt: text?.createdAt },
          select: { id: true },
        }),
      ),
    );
    if (asked && answer) {
      await prisma.message.update({
        where: { id: answer.id },
        data: { replyToId: asked.id, isReply: true },
      });
    }
    // Three pictures from Alice in one message, so the demo thread shows a pile of them...
    await prisma.message.create({
      data: {
        conversationId: direct.id,
        senderId: alice.id,
        content: 'From the weekend',
        images: {
          create: await seedMessageImages(alice.id, [
            { caption: 'Saturday', width: 960, height: 1280 },
            { caption: 'Sunday', width: 1280, height: 720 },
            { caption: 'Monday', width: 1080, height: 1080 },
          ]),
        },
        createdAt: new Date(Date.now() - 45_000),
      },
    });
    // ...and one from Bob, which is what a single photo message looks like.
    const picture = await prisma.message.create({
      data: {
        conversationId: direct.id,
        senderId: bob.id,
        content: 'Look what I found',
        images: {
          create: await seedMessageImages(bob.id, [
            { caption: 'for Alice', width: 1280, height: 720 },
          ]),
        },
        createdAt: new Date(Date.now() - 30_000),
      },
      select: { createdAt: true },
    });
    // Bob is caught up; Alice has not seen Bob's last text and the picture yet.
    await prisma.conversation.update({
      where: { id: direct.id },
      data: {
        lastMessageAt: picture.createdAt,
        members: {
          update: [
            {
              where: { conversationId_userId: { conversationId: direct.id, userId: bob.id } },
              data: { lastReadAt: picture.createdAt },
            },
            {
              where: { conversationId_userId: { conversationId: direct.id, userId: alice.id } },
              data: { lastReadAt: texts[10]?.createdAt },
            },
          ],
        },
      },
    });

    // A group with two more members. Carol stays out: she starts without conversations.
    const others = users.slice(3, 5).map((user) => user.id);
    const groupMembers = [alice.id, bob.id, ...others];
    const group = await prisma.conversation.create({
      data: {
        kind: 'group',
        title: 'Weekend plans',
        createdById: alice.id,
        // The creator is the admin; the others are plain members.
        members: {
          create: groupMembers.map((userId) => ({
            userId,
            role: userId === alice.id ? 'admin' : 'member',
          })),
        },
      },
      select: { id: true },
    });
    const chatter = Array.from({ length: 6 }, (_, i) => ({
      conversationId: group.id,
      senderId: groupMembers[i % groupMembers.length] ?? alice.id,
      content: faker.lorem.sentence(),
      createdAt: new Date(Date.now() - (8 - i) * 5 * 60_000),
    }));
    await prisma.message.createMany({ data: chatter });
    // One message Bob took back, and the line the server wrote when Alice brought the others in.
    const [third, fourth] = users.slice(3, 5);
    await prisma.message.create({
      data: {
        conversationId: group.id,
        senderId: bob.id,
        content: '',
        deletedAt: new Date(Date.now() - 9 * 60_000),
        createdAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    const systemLine = await prisma.message.create({
      data: {
        conversationId: group.id,
        senderId: alice.id,
        kind: 'system',
        content: '',
        systemMeta: {
          type: 'members_added',
          actor: { id: alice.id, name: alice.name },
          users: [third, fourth].flatMap((user) =>
            user ? [{ id: user.id, name: user.name }] : [],
          ),
          title: null,
        },
        createdAt: new Date(Date.now() - 5 * 60_000),
      },
      select: { createdAt: true },
    });
    await prisma.conversation.update({
      where: { id: group.id },
      data: {
        lastMessageAt: systemLine.createdAt,
        members: {
          updateMany: {
            where: { userId: { not: alice.id } },
            data: { lastReadAt: systemLine.createdAt },
          },
          update: {
            where: { conversationId_userId: { conversationId: group.id, userId: alice.id } },
            data: { lastReadAt: chatter[2]?.createdAt },
          },
        },
      },
    });
  }

  console.log(
    `Seeded ${users.length} users (avatars in ${uploadsDir}), ${follows.length} follows, ${posts.length} posts, ${likes.length} likes, ${comments.length} comments, ${reactions.length} reactions.`,
  );
}

try {
  await seed();
} finally {
  await prisma.$disconnect();
}
