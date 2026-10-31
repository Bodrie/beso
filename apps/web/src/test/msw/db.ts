import {
  type Activity,
  type Comment,
  type ConversationKind,
  type ConversationRole,
  type Message,
  type Notification,
  type Post,
  type ReactionSummary,
  type Report,
  type Session,
  type ReactionType,
  type Revision,
  type UserPrivate,
  type UserPublic,
} from '@beso/shared';
import { type EarnedAchievement } from '@beso/shared/achievements';
import { alice, bob, carol, makePost, resetFixtureSequence, testId } from '../fixtures';

type Follow = { followerId: string; followingId: string };

/** A conversation as the "server" stores it; the viewer-specific shape is derived per request. */
export type MockConversation = {
  id: string;
  kind: ConversationKind;
  title: string | null;
  pictureUrl: string | null;
  createdById: string | null;
  createdAt: string;
  members: {
    userId: string;
    role: ConversationRole;
    joinedAt: string;
    lastReadAt: string | null;
  }[];
};
let conversationSequence = 0;

/** In-memory backend state for MSW handlers. Reset between tests by `resetMocks()`. */
export const mockDb = {
  /** The signed-in user (a reference into `users`), or null for no session. */
  user: null as UserPrivate | null,
  /** Whether POST /auth/refresh succeeds. */
  refreshable: false,
  users: [] as UserPrivate[],
  follows: [] as Follow[],
  blocks: [] as { blockerId: string; blockedId: string }[],
  mutes: [] as { muterId: string; mutedId: string }[],
  reports: [] as (Report & { reporterId: string })[],
  /** Members an admin suspended (ids). */
  suspended: [] as string[],
  posts: [] as Post[],
  comments: [] as Comment[],
  activities: [] as Activity[],
  /** The signed-in user's notifications, newest first (the handlers do not filter by recipient). */
  notifications: [] as Notification[],
  conversations: [] as MockConversation[],
  messages: [] as Message[],
  reactions: [] as { commentId: string; userId: string; type: ReactionType }[],
  commentRevisions: new Map<string, Revision[]>(),
  postRevisions: new Map<string, Revision[]>(),
  messageRevisions: new Map<string, Revision[]>(),
  uploads: 0,
  /** The last file the fake API received, for asserting what left the browser. */
  lastUpload: null as { name: string; type: string; size: number } | null,
  /** Which file became which key (uploads run in parallel, so their order is not the keys'). */
  uploadedNames: new Map<string, string>(),
  /** The length the fake API "read" from each voice upload, by key. */
  voiceDurations: new Map<string, number>(),
  /** Links the fake API "mailed"; tests read the token here instead of an inbox. */
  emailTokens: [] as { token: string; kind: 'verify' | 'reset' | 'change'; email: string }[],
  /** The signed-in user's devices, as GET /auth/sessions lists them. */
  sessions: [] as Session[],
  /** The body of the last registration, for asserting what the form sent (e.g. the bot-check token). */
  lastRegistration: null as Record<string, unknown> | null,
  /** Invite codes (F1): code → the member it belongs to. alice's is the seed's. */
  inviteCodes: new Map<string, string>(),
  /** `GET /push/config`: null is a server with push switched off (the default). */
  pushPublicKey: null as string | null,
  /** Endpoints of the push subscriptions the fake API holds (ADR 0022). */
  pushEndpoints: [] as string[],
  /** Earned badges (F2), whoever holds them. */
  achievements: [] as (EarnedAchievement & { userId: string })[],
  /** The signed-in member's series counts, as `GET /users/me/achievements` answers them. */
  achievementProgress: {} as Record<string, number>,
  /**
   * A poll's real counts by post id (F3), for polls whose stored copy hides them from the
   * signed-in member; a vote reveals these. Without an entry the stored counts are the truth.
   */
  pollCounts: new Map<string, number[]>(),
  calls: {
    me: 0,
    refresh: 0,
    login: 0,
    logout: 0,
    passwordChanges: 0,
    forgot: 0,
    exports: 0,
    deletions: 0,
    notificationsRead: 0,
    achievementLists: 0,
  },
};

const clone = (user: UserPrivate): UserPrivate => ({ ...user, counts: { ...user.counts } });

export function resetMockDb(): void {
  mockDb.user = null;
  mockDb.refreshable = false;
  mockDb.users = [alice, bob, carol].map(clone);
  mockDb.follows = [];
  mockDb.blocks = [];
  mockDb.mutes = [];
  mockDb.reports = [];
  mockDb.suspended = [];
  mockDb.posts = [];
  mockDb.comments = [];
  mockDb.activities = [];
  mockDb.notifications = [];
  mockDb.conversations = [];
  conversationSequence = 0;
  mockDb.messages = [];
  mockDb.reactions = [];
  mockDb.commentRevisions = new Map();
  mockDb.postRevisions = new Map();
  mockDb.messageRevisions = new Map();
  mockDb.uploads = 0;
  mockDb.lastUpload = null;
  mockDb.uploadedNames = new Map();
  mockDb.voiceDurations = new Map();
  mockDb.emailTokens = [];
  mockDb.sessions = [];
  mockDb.lastRegistration = null;
  mockDb.inviteCodes = new Map([['welcome-from-alice', alice.id]]);
  mockDb.pushPublicKey = null;
  mockDb.pushEndpoints = [];
  mockDb.achievements = [];
  mockDb.achievementProgress = {};
  mockDb.pollCounts = new Map();
  mockDb.calls = {
    me: 0,
    refresh: 0,
    login: 0,
    logout: 0,
    passwordChanges: 0,
    forgot: 0,
    exports: 0,
    deletions: 0,
    notificationsRead: 0,
    achievementLists: 0,
  };
  resetFixtureSequence();
}

resetMockDb();

/** Registers the user if needed and returns the stored copy (handlers mutate that one). */
export function upsertUser(user: UserPrivate): UserPrivate {
  const existing = mockDb.users.find((candidate) => candidate.id === user.id);
  if (existing) return existing;
  const stored = clone(user);
  mockDb.users.push(stored);
  return stored;
}

export function signedInAs(user: UserPrivate): UserPrivate {
  mockDb.user = upsertUser(user);
  return mockDb.user;
}

export function seedFollow(followerId: string, followingId: string): void {
  mockDb.follows.push({ followerId, followingId });
}

export function seedConversation(
  kind: ConversationKind,
  memberIds: string[],
  options: {
    title?: string;
    pictureUrl?: string | null;
    createdById?: string;
    createdAt?: string;
  } = {},
): MockConversation {
  conversationSequence += 1;
  const createdAt = options.createdAt ?? '2026-10-15T08:00:00.000Z';
  const createdById = options.createdById ?? (kind === 'group' ? memberIds[0] : null) ?? null;
  const conversation: MockConversation = {
    id: testId('conversation', conversationSequence),
    kind,
    title: options.title ?? null,
    pictureUrl: options.pictureUrl ?? null,
    createdById,
    createdAt,
    // Like the API: the creator of a group is its admin.
    members: memberIds.map((userId) => ({
      userId,
      role: kind === 'group' && userId === createdById ? 'admin' : 'member',
      joinedAt: createdAt,
      lastReadAt: null,
    })),
  };
  mockDb.conversations.push(conversation);
  return conversation;
}

/** The direct thread between two people, created on first use (like the API). */
export function seedDirect(aId: string, bId: string): MockConversation {
  const pair = [aId, bId].toSorted().join(':');
  const existing = mockDb.conversations.find(
    (c) =>
      c.kind === 'direct' &&
      c.members
        .map((m) => m.userId)
        .toSorted()
        .join(':') === pair,
  );
  return existing ?? seedConversation('direct', [aId, bId]);
}

/** Moves a member's read mark (null clears it). */
export function seedReadMark(conversationId: string, userId: string, readAt: string | null): void {
  const member = mockDb.conversations
    .find((c) => c.id === conversationId)
    ?.members.find((m) => m.userId === userId);
  if (member) member.lastReadAt = readAt;
}

/** Seeds `count` posts, newest first, and returns them in that order. */
export function seedPosts(count: number, overrides: Partial<Post> = {}): Post[] {
  const posts = Array.from({ length: count }, () => makePost(overrides));
  mockDb.posts.push(...posts);
  return posts;
}

/** The public shape of a stored user as seen by `viewerId`, with live counts and flags. */
export function toPublic(user: UserPrivate, viewerId: string | null): UserPublic {
  const follows = mockDb.follows;
  const blocked = mockDb.blocks.some((b) => b.blockerId === viewerId && b.blockedId === user.id);
  const blockedMe = mockDb.blocks.some((b) => b.blockerId === user.id && b.blockedId === viewerId);
  const muted = mockDb.mutes.some((m) => m.muterId === viewerId && m.mutedId === user.id);
  // Like the API: either side of a block gets who it is and the flags, nothing else.
  if (blocked || blockedMe) {
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      avatarUrl: user.avatarUrl,
      bio: null,
      city: null,
      website: null,
      coverUrl: null,
      createdAt: user.createdAt,
      counts: { posts: 0, followers: 0, following: 0 },
      followedByMe: false,
      followsMe: false,
      blocked,
      blockedMe,
      muted,
      pinnedPostId: null,
      ring: user.ring,
      featuredBadges: [],
    };
  }
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    city: user.city,
    website: user.website,
    coverUrl: user.coverUrl,
    createdAt: user.createdAt,
    counts: {
      posts: mockDb.posts.filter((post) => post.author.id === user.id).length,
      followers: follows.filter((follow) => follow.followingId === user.id).length,
      following: follows.filter((follow) => follow.followerId === user.id).length,
    },
    followedByMe: viewerId
      ? follows.some((follow) => follow.followerId === viewerId && follow.followingId === user.id)
      : false,
    followsMe: viewerId
      ? follows.some((follow) => follow.followerId === user.id && follow.followingId === viewerId)
      : false,
    blocked: false,
    blockedMe: false,
    muted,
    pinnedPostId: user.pinnedPostId,
    ring: user.ring,
    featuredBadges: user.settings.showAchievements ? user.featuredBadges : [],
  };
}

/** Index-based cursor pagination over an already sorted list, mirroring `{ items, nextCursor }`. */
export function paginate<T extends { id: string }>(
  items: T[],
  url: URL,
): { items: T[]; nextCursor: string | null } {
  const limit = Number(url.searchParams.get('limit') ?? 20);
  const cursor = url.searchParams.get('cursor');
  const start = cursor ? items.findIndex((item) => item.id === cursor) + 1 : 0;
  const page = items.slice(start, start + limit);
  const last = page.at(-1);
  return { items: page, nextCursor: last && start + limit < items.length ? last.id : null };
}

/** Reaction summary of a comment as `viewerId` sees it, from the reactions table. */
export function reactionsFor(commentId: string, viewerId: string): ReactionSummary {
  const counts: Record<ReactionType, number> = { LIKE: 0, LOVE: 0, LAUGH: 0, WOW: 0, SAD: 0 };
  let total = 0;
  let mine: ReactionType | null = null;
  for (const reaction of mockDb.reactions) {
    if (reaction.commentId !== commentId) continue;
    counts[reaction.type] += 1;
    total += 1;
    if (reaction.userId === viewerId) mine = reaction.type;
  }
  return { counts, total, mine };
}
