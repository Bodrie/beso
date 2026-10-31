import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { type AccountExport, type DeleteAccountData } from '@beso/shared';
import { ACHIEVEMENT_BY_KEY, achievementName } from '@beso/shared/achievements';
import { AssetsService } from '../assets/assets.service.js';
import { EmailTokensService } from '../auth/email-tokens.service.js';
import { verifyPassword } from '../auth/password.js';
import { validationError } from '../common/errors.js';
import { EmailService } from '../email/email.service.js';
import { SessionsRevokedEvent } from '../events/auth.events.js';
import { promoteIfNoAdminSql } from '../conversations/roles.js';
import { ConversationDeletedEvent, ConversationLeftEvent } from '../events/conversation.events.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { toUserPrivate, userPrivateSelect } from '../users/users.mapper.js';

const iso = (date: Date): string => date.toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Accounts that never confirm their address stay closed and are removed (ADR 0012, C6): one
 * warning mail, then erasure. Both counted in days since registration; the daily jobs apply it.
 */
export const UNVERIFIED_ACCOUNT_POLICY = { warnAfterDays: 23, deleteAfterDays: 30 } as const;

/** The member's own account as a whole: a copy of it, and its end (ADR 0012). */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
    private readonly email: EmailService,
    private readonly emailTokens: EmailTokensService,
    private readonly events: EventEmitter2,
    private readonly assets: AssetsService,
  ) {}

  /** Everything the account holds, as the shared `accountExportSchema` describes it. */
  async export(userId: string): Promise<AccountExport> {
    // The profile select carries the viewer-relative follow flags under the same relation names
    // as the lists below, so the two are read separately.
    const profile = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: userPrivateSelect(userId),
    });
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        posts: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            content: true,
            images: { select: { key: true }, orderBy: { position: 'asc' } },
            createdAt: true,
            editedAt: true,
            hashtags: { select: { tag: true }, orderBy: { tag: 'asc' } },
            revisions: { select: { content: true, editedAt: true }, orderBy: { editedAt: 'asc' } },
            achievementKey: true,
            poll: {
              select: {
                closesAt: true,
                options: {
                  select: { text: true, _count: { select: { votes: true } } },
                  orderBy: { position: 'asc' },
                },
              },
            },
          },
        },
        comments: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            postId: true,
            parentId: true,
            content: true,
            createdAt: true,
            editedAt: true,
            revisions: { select: { content: true, editedAt: true }, orderBy: { editedAt: 'asc' } },
          },
        },
        postLikes: { select: { postId: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
        bookmarks: { select: { postId: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
        reposts: { select: { postId: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
        commentReactions: {
          select: { commentId: true, type: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
        pollVotes: {
          select: { postId: true, createdAt: true, option: { select: { text: true } } },
          orderBy: { createdAt: 'asc' },
        },
        messageReactions: {
          select: { messageId: true, type: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
        following: {
          select: { createdAt: true, followee: { select: { id: true, username: true } } },
          orderBy: { createdAt: 'asc' },
        },
        followers: {
          select: { createdAt: true, follower: { select: { id: true, username: true } } },
          orderBy: { createdAt: 'asc' },
        },
        inviteCode: true,
        invitedBy: { select: { id: true, username: true } },
        achievements: {
          select: { key: true, earnedAt: true },
          orderBy: [{ earnedAt: 'asc' }, { key: 'asc' }],
        },
        sentMessages: {
          select: {
            id: true,
            conversationId: true,
            content: true,
            imageKey: true,
            voiceKey: true,
            sharedPostId: true,
            replyToId: true,
            createdAt: true,
            editedAt: true,
            conversation: { select: { title: true } },
            revisions: { select: { content: true, editedAt: true }, orderBy: { editedAt: 'asc' } },
          },
          orderBy: { createdAt: 'asc' },
        },
        uploads: {
          select: { key: true, kind: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    const url = (key: string | null) => (key === null ? null : this.assets.url(key));
    return {
      exportedAt: iso(new Date()),
      user: toUserPrivate(profile, this.assets.base),
      posts: user.posts.map((post) => ({
        id: post.id,
        content: post.content,
        imageUrls: post.images.map((image) => this.assets.url(image.key)),
        hashtags: post.hashtags.map((hashtag) => hashtag.tag),
        achievementKey: post.achievementKey,
        poll: post.poll
          ? {
              closesAt: iso(post.poll.closesAt),
              options: post.poll.options.map((option) => ({
                text: option.text,
                votes: option._count.votes,
              })),
            }
          : null,
        createdAt: iso(post.createdAt),
        editedAt: post.editedAt === null ? null : iso(post.editedAt),
        revisions: post.revisions.map((r) => ({ content: r.content, editedAt: iso(r.editedAt) })),
      })),
      comments: user.comments.map((comment) => ({
        id: comment.id,
        postId: comment.postId,
        parentId: comment.parentId,
        content: comment.content,
        createdAt: iso(comment.createdAt),
        editedAt: comment.editedAt === null ? null : iso(comment.editedAt),
        revisions: comment.revisions.map((r) => ({
          content: r.content,
          editedAt: iso(r.editedAt),
        })),
      })),
      likes: user.postLikes.map((like) => ({
        postId: like.postId,
        createdAt: iso(like.createdAt),
      })),
      bookmarks: user.bookmarks.map((bookmark) => ({
        postId: bookmark.postId,
        createdAt: iso(bookmark.createdAt),
      })),
      reposts: user.reposts.map((repost) => ({
        postId: repost.postId,
        createdAt: iso(repost.createdAt),
      })),
      reactions: user.commentReactions.map((reaction) => ({
        commentId: reaction.commentId,
        type: reaction.type,
        createdAt: iso(reaction.createdAt),
      })),
      pollVotes: user.pollVotes.map((vote) => ({
        postId: vote.postId,
        option: vote.option.text,
        createdAt: iso(vote.createdAt),
      })),
      following: user.following.map((follow) => ({
        userId: follow.followee.id,
        username: follow.followee.username,
        since: iso(follow.createdAt),
      })),
      followers: user.followers.map((follow) => ({
        userId: follow.follower.id,
        username: follow.follower.username,
        since: iso(follow.createdAt),
      })),
      invite: {
        code: user.inviteCode,
        invitedBy: user.invitedBy
          ? { userId: user.invitedBy.id, username: user.invitedBy.username }
          : null,
      },
      achievements: user.achievements.flatMap((achievement) => {
        const definition = ACHIEVEMENT_BY_KEY.get(achievement.key);
        return definition
          ? [
              {
                key: achievement.key,
                title: achievementName(definition),
                earnedAt: iso(achievement.earnedAt),
              },
            ]
          : [];
      }),
      messages: user.sentMessages.map((message) => ({
        id: message.id,
        conversationId: message.conversationId,
        conversationTitle: message.conversation.title,
        content: message.content,
        imageUrl: url(message.imageKey),
        voiceUrl: url(message.voiceKey),
        sharedPostId: message.sharedPostId,
        replyToId: message.replyToId,
        createdAt: iso(message.createdAt),
        editedAt: message.editedAt === null ? null : iso(message.editedAt),
        revisions: message.revisions.map((r) => ({
          content: r.content,
          editedAt: iso(r.editedAt),
        })),
      })),
      messageReactions: user.messageReactions.map((reaction) => ({
        messageId: reaction.messageId,
        type: reaction.type,
        createdAt: iso(reaction.createdAt),
      })),
      uploads: user.uploads.map((upload) => ({
        key: upload.key,
        kind: upload.kind,
        url: this.assets.url(upload.key),
        createdAt: iso(upload.createdAt),
      })),
    };
  }

  /**
   * The member's own request (ADR 0012): the password is checked first, then the account is
   * erased and a last mail confirms it.
   */
  async delete(userId: string, input: DeleteAccountData): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true, email: true, name: true },
    });
    if (!(await verifyPassword(user.passwordHash, input.password))) {
      throw validationError({ password: 'Wrong password' });
    }
    await this.erase(userId);
    void this.email
      .sendAccountDeleted({ email: user.email, name: user.name })
      .catch((error: unknown) =>
        this.logger.warn({ err: error }, 'Could not send the account deletion notice'),
      );
    this.logger.log({ userId }, 'Account deleted');
  }

  /**
   * Housekeeping (JobsService): one mail, with a fresh confirmation link, to every account
   * created before `before` that never confirmed its address, saying when it will be removed.
   * Stamped on the row so it goes out once; an account that already had its share of
   * confirmation mails this hour is skipped and picked up by the next run.
   */
  async warnUnverified(before: Date, now: Date): Promise<number> {
    const users = await this.prisma.user.findMany({
      where: { emailVerifiedAt: null, expiryWarnedAt: null, createdAt: { lt: before } },
      select: { id: true, email: true, name: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    let sent = 0;
    for (const user of users) {
      // oxlint-disable-next-line no-await-in-loop -- one account at a time keeps the mail rate flat
      const token = await this.emailTokens.issue(user.id, 'verify_email', now);
      if (!token) {
        this.logger.log({ userId: user.id }, 'Expiry warning skipped (mail limit reached)');
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- see above
      await this.email.sendUnverifiedExpiry(user, token, {
        afterDays: UNVERIFIED_ACCOUNT_POLICY.deleteAfterDays,
        on: new Date(user.createdAt.getTime() + UNVERIFIED_ACCOUNT_POLICY.deleteAfterDays * DAY_MS),
      });
      // oxlint-disable-next-line no-await-in-loop -- see above
      await this.prisma.user.update({ where: { id: user.id }, data: { expiryWarnedAt: now } });
      sent += 1;
    }
    return sent;
  }

  /**
   * Housekeeping (JobsService): accounts created before `before` that never confirmed their
   * address are erased like a member's own request, without the last mail (the address was
   * never shown to be anyone's).
   */
  async eraseUnverified(before: Date): Promise<number> {
    const users = await this.prisma.user.findMany({
      where: { emailVerifiedAt: null, createdAt: { lt: before } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const user of users) {
      // oxlint-disable-next-line no-await-in-loop -- one transaction at a time
      await this.erase(user.id);
      this.logger.log({ userId: user.id }, 'Unverified account removed');
    }
    return users.length;
  }

  /**
   * Erases the account (ADR 0012): one transaction deletes the user row (everything else
   * cascades), the direct threads and the groups where this was the last member, and keeps
   * the denormalised counters of what remains correct; afterwards the files go, the sockets
   * are cut and the other members are told.
   */
  async erase(userId: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        uploads: { select: { key: true } },
        conversations: {
          select: {
            conversationId: true,
            conversation: {
              select: { kind: true, pictureKey: true, members: { select: { userId: true } } },
            },
          },
        },
      },
    });

    const removed: { id: string; others: string[] }[] = [];
    const left: { id: string; remaining: string[] }[] = [];
    // Pictures of the groups that go with this account but were set by someone else: their
    // uploads stay behind without a reference (the member's own files leave with the rows).
    const ownKeys = new Set(user.uploads.map((upload) => upload.key));
    const orphanedPictures: string[] = [];
    for (const membership of user.conversations) {
      const others = membership.conversation.members
        .map((member) => member.userId)
        .filter((memberId) => memberId !== userId);
      if (membership.conversation.kind === 'direct' || others.length === 0) {
        removed.push({ id: membership.conversationId, others });
        const picture = membership.conversation.pictureKey;
        if (picture !== null && !ownKeys.has(picture)) orphanedPictures.push(picture);
      } else {
        left.push({ id: membership.conversationId, remaining: others });
      }
    }

    await this.prisma.$transaction([
      // Other people's comments must not keep counting reactions that go with this account.
      this.prisma.$executeRaw`
        UPDATE comments c SET reactions_count = c.reactions_count - 1
        FROM comment_reactions r
        WHERE r.comment_id = c.id AND r.user_id = ${userId}::uuid`,
      // Nor other people's posts the reposts and quotes that go with it (ADR 0017).
      this.prisma.$executeRaw`
        UPDATE posts p SET repost_count = p.repost_count - 1
        FROM reposts r
        WHERE r.post_id = p.id AND r.user_id = ${userId}::uuid`,
      this.prisma.$executeRaw`
        UPDATE posts p SET repost_count = p.repost_count - 1
        FROM posts q
        WHERE q.quoted_post_id = p.id AND q.author_id = ${userId}::uuid AND p.author_id <> ${userId}::uuid`,
      this.prisma.conversation.deleteMany({
        where: { id: { in: removed.map((conversation) => conversation.id) } },
      }),
      this.prisma.user.delete({ where: { id: userId } }),
      // Groups that stay: their newest message may have been this member's, and the member
      // may have been their last admin.
      ...(left.length > 0
        ? [
            this.prisma.$executeRaw`
              UPDATE conversations c
              SET last_message_at = (SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id)
              WHERE c.id IN (${Prisma.join(left.map((group) => Prisma.sql`${group.id}::uuid`))})`,
            ...left.map((group) => this.prisma.$executeRaw(promoteIfNoAdminSql(group.id))),
          ]
        : []),
    ]);

    await this.events.emitAsync(SessionsRevokedEvent.EVENT, new SessionsRevokedEvent(userId));
    await Promise.all([
      ...left.map((group) =>
        this.events.emitAsync(
          ConversationLeftEvent.EVENT,
          new ConversationLeftEvent(group.id, userId, group.remaining),
        ),
      ),
      ...removed
        .filter((conversation) => conversation.others.length > 0)
        .map((conversation) =>
          this.events.emitAsync(
            ConversationDeletedEvent.EVENT,
            new ConversationDeletedEvent(conversation.id, conversation.others),
          ),
        ),
    ]);
    await this.uploads.deleteFiles(user.uploads.map((upload) => upload.key));
    await Promise.all(orphanedPictures.map((key) => this.uploads.discard(key)));
  }
}
