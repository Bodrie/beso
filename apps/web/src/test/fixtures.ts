import { emptyReactions } from '@/features/comments/reactions';
import type {
  Activity,
  ActivityType,
  Comment,
  Message,
  Notification,
  NotificationType,
  Poll,
  Post,
  StoredImage,
  UserPrivate,
  UserSummary,
} from '@beso/shared';

export const TEST_PASSWORD = 'Password123!';

const BASE_TIME = Date.UTC(2026, 9, 15, 10, 0, 0);
let sequence = 0;

/** Deterministic, valid (v7-shaped) UUIDs so failures are readable. */
export function testId(
  kind:
    | 'user'
    | 'post'
    | 'comment'
    | 'activity'
    | 'message'
    | 'conversation'
    | 'notification'
    | 'report'
    | 'option',
  n: number,
): string {
  const prefix = {
    user: '01a13e00',
    post: '01a13f00',
    comment: '01a14000',
    activity: '01a14100',
    message: '01a14200',
    conversation: '01a14300',
    notification: '01a14400',
    report: '01a14500',
    option: '01a14600',
  }[kind];
  return `${prefix}-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

export function makeUser(overrides: Partial<UserPrivate> = {}): UserPrivate {
  return {
    id: testId('user', 1),
    username: 'alice',
    name: 'Alice Anderson',
    avatarUrl: null,
    bio: null,
    city: 'Sofia',
    website: null,
    coverUrl: null,
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
    counts: { posts: 0, followers: 0, following: 0 },
    followedByMe: false,
    followsMe: false,
    blocked: false,
    blockedMe: false,
    muted: false,
    pinnedPostId: null,
    ring: null,
    featuredBadges: [],
    email: 'alice@example.com',
    pendingEmail: null,
    role: 'member',
    emailVerifiedAt: '2026-10-15T10:05:00.000Z',
    avatarPreset: null,
    coverPreset: null,
    settings: {
      chatBubbles: true,
      messageSound: false,
      browserNotifications: false,
      pushMessages: true,
      pushSocial: true,
      pushPreviews: true,
      showRing: true,
      showAchievements: true,
      hideGettingStarted: false,
      timeZone: 'Europe/Sofia',
    },
    ...overrides,
  };
}

export const alice = makeUser();
export const bob = makeUser({
  id: testId('user', 2),
  username: 'bob',
  name: 'Bob Brown',
  email: 'bob@example.com',
  city: 'Plovdiv',
  bio: 'Builds things.',
});
export const carol = makeUser({
  id: testId('user', 3),
  username: 'carol',
  name: 'Carol Clark',
  email: 'carol@example.com',
  city: 'Varna',
});

export function summaryOf(user: UserPrivate): UserSummary {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    avatarUrl: user.avatarUrl,
    ring: user.ring,
  };
}

/** A stored post picture as responses carry it; `n` keeps the URLs apart. */
export function makeImage(n: number, width: number | null = 1200, height: number | null = 800) {
  const image: StoredImage = {
    url: `http://localhost/api/v1/uploads/post/${testId('post', 800 + n)}.webp`,
    width,
    height,
  };
  return image;
}

/** Each call is one minute older than the previous one, so lists sort newest-first. */
export function makePost(overrides: Partial<Post> = {}): Post {
  sequence += 1;
  const createdAt = new Date(BASE_TIME - sequence * 60_000).toISOString();
  return {
    id: testId('post', sequence),
    content: `Post number ${sequence}`,
    images: [],
    imageUrl: null,
    author: summaryOf(bob),
    likeCount: 0,
    commentCount: 0,
    likedByMe: false,
    bookmarkedByMe: false,
    repostCount: 0,
    repostedByMe: false,
    quotedPost: null,
    poll: null,
    achievement: null,
    repost: null,
    editedAt: null,
    mentions: [],
    hashtags: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

/**
 * A poll as the signed-in member sees it (F3): `counts` null hides them (not voted, still open,
 * not the author). Closes in a day unless said otherwise.
 */
export function makePoll(
  texts: readonly string[],
  {
    counts = null,
    myVote = null,
    closesAt = new Date(Date.now() + 24 * 3_600_000).toISOString(),
    closed = false,
    totalVotes,
  }: {
    counts?: readonly number[] | null;
    myVote?: number | null;
    closesAt?: string;
    closed?: boolean;
    totalVotes?: number;
  } = {},
): Poll {
  const ids = texts.map(() => {
    sequence += 1;
    return testId('option', sequence);
  });
  return {
    options: texts.map((text, index) => ({
      id: ids[index] ?? '',
      text,
      votes: counts ? (counts[index] ?? 0) : null,
    })),
    totalVotes: totalVotes ?? counts?.reduce((sum, count) => sum + count, 0) ?? 0,
    myVote: myVote === null ? null : (ids[myVote] ?? null),
    closesAt,
    closed,
  };
}

export function makeComment(postId: string, overrides: Partial<Comment> = {}): Comment {
  sequence += 1;
  const createdAt = new Date(BASE_TIME - sequence * 60_000).toISOString();
  return {
    id: testId('comment', sequence),
    postId,
    parentId: null,
    content: `Comment number ${sequence}`,
    author: summaryOf(bob),
    editedAt: null,
    reactions: emptyReactions(),
    mentions: [],
    replyCount: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

export function makeActivity(type: ActivityType, overrides: Partial<Activity> = {}): Activity {
  sequence += 1;
  return {
    id: testId('activity', sequence),
    type,
    actor: summaryOf(bob),
    post: null,
    comment: null,
    targetUser: null,
    createdAt: new Date(BASE_TIME - sequence * 60_000).toISOString(),
    ...overrides,
  };
}

/** Each call is one minute older than the previous one, so a list reads newest first; unread by default. */
export function makeNotification(
  type: NotificationType,
  overrides: Partial<Notification> = {},
): Notification {
  sequence += 1;
  return {
    id: testId('notification', sequence),
    type,
    actor: summaryOf(bob),
    achievementKey: null,
    post: null,
    comment: null,
    readAt: null,
    createdAt: new Date(BASE_TIME - sequence * 60_000).toISOString(),
    ...overrides,
  };
}

/** A badge the signed-in member earned (F2): the one notification without an actor. */
export const makeBadgeNotification = (key: string, overrides: Partial<Notification> = {}) =>
  makeNotification('ACHIEVEMENT_EARNED', { actor: null, achievementKey: key, ...overrides });

/** Each call is one minute newer than the previous one, so threads read top to bottom. */
export function makeMessage(
  conversationId: string,
  senderId: string,
  content: string,
  overrides: Partial<Message> = {},
): Message {
  sequence += 1;
  return {
    id: testId('message', sequence),
    conversationId,
    senderId,
    kind: 'user',
    content,
    image: null,
    voice: null,
    imageUrl: null,
    sharedPost: null,
    replyTo: null,
    editedAt: null,
    deletedAt: null,
    system: null,
    reactions: [],
    createdAt: new Date(BASE_TIME - 3_600_000 + sequence * 60_000).toISOString(),
    ...overrides,
  };
}

export function resetFixtureSequence(): void {
  sequence = 0;
}
