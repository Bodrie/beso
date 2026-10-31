import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  type Message,
  type Notification,
  type PushConfig,
  type PushPayload,
  type PushSubscriptionInput,
  type UserSettings,
  notificationPush,
  pushExcerpt,
} from '@beso/shared';
import { unauthorized } from '../common/errors.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { Env } from '../config/env.js';
import { PushSubscribedEvent } from '../events/user.events.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toUserSettings } from '../users/users.mapper.js';
import { PUSH_SENDER, type PushOptions, type PushSender } from './push.sender.js';

/** Devices one member may have; a new one beyond that replaces the one seen longest ago. */
export const MAX_PUSH_DEVICES = 10;

const MESSAGE_PUSH: PushOptions = { ttlSeconds: 24 * 60 * 60, urgency: 'high' };
const SOCIAL_PUSH: PushOptions = { ttlSeconds: 24 * 60 * 60, urgency: 'normal' };

type Recipient = {
  id: string;
  settings: UserSettings;
  subscriptions: { id: string; endpoint: string; p256dh: string; auth: string }[];
};

/**
 * Web push (ADR 0022): the subscriptions of the members' browsers and the delivery of
 * notifications and messages to them. Switched off (no VAPID keys) it stores nothing and
 * sends nothing, and `GET /push/config` says so.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  readonly publicKey: string | null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUSH_SENDER) private readonly sender: PushSender | null,
    config: ConfigService<Env, true>,
    private readonly events: EventEmitter2,
  ) {
    this.publicKey = sender ? (config.get('VAPID_PUBLIC_KEY', { infer: true }) ?? null) : null;
  }

  get enabled(): boolean {
    return this.publicKey !== null;
  }

  config(): PushConfig {
    return { publicKey: this.publicKey };
  }

  /**
   * Stores (or moves to this member and sign-in) the browser's subscription. The sign-in comes
   * from the access token: a token from before sign-ins had ids answers 401, which the web
   * client meets with one refresh and a retry.
   */
  async subscribe(user: AuthUser, input: PushSubscriptionInput, userAgent?: string): Promise<void> {
    if (!user.signInId) throw unauthorized('Refresh the session to switch push on');
    const data = {
      userId: user.id,
      signInId: user.signInId,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: userAgent?.slice(0, 255) ?? null,
      lastSeenAt: new Date(),
    };
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: { endpoint: input.endpoint, ...data },
      update: data,
    });
    const devices = await this.prisma.pushSubscription.findMany({
      where: { userId: user.id },
      select: { id: true },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
      skip: MAX_PUSH_DEVICES,
    });
    if (devices.length > 0) {
      await this.prisma.pushSubscription.deleteMany({
        where: { id: { in: devices.map((device) => device.id) } },
      });
    }
    await this.events.emitAsync(PushSubscribedEvent.EVENT, new PushSubscribedEvent(user.id));
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }

  /**
   * Drops the subscriptions whose sign-in has no live refresh token any more: signed out,
   * ended from another device, or expired. With `userId` for one member (right after a session
   * ends), without for everyone (the daily job). Returns the count.
   */
  async pruneEnded(now: Date, userId?: string): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM push_subscriptions AS ps
      WHERE (${userId ?? null}::uuid IS NULL OR ps.user_id = ${userId ?? null}::uuid)
        AND NOT EXISTS (
          SELECT 1 FROM refresh_tokens AS rt
          WHERE rt.sign_in_id = ps.sign_in_id
            AND rt.revoked_at IS NULL
            AND rt.expires_at > ${now}
        )`;
  }

  /**
   * A notification, to the recipient's devices when they want social pushes. Badges stay in the
   * app (the bell and a toast): they come in bursts and the daily sweep's at night (ADR 0021).
   */
  async notify(userId: string, notification: Notification): Promise<void> {
    if (!this.enabled || notification.type === 'ACHIEVEMENT_EARNED') return;
    const payload = notificationPush(notification);
    await this.deliver([userId], (recipient) => (recipient.settings.pushSocial ? payload : null), {
      ...SOCIAL_PUSH,
    });
  }

  /** A chat message, to every member but the sender who wants message pushes. */
  async message(message: Message, memberIds: readonly string[]): Promise<void> {
    if (!this.enabled || message.kind !== 'user' || message.deletedAt !== null) return;
    const recipients = memberIds.filter((id) => id !== message.senderId);
    if (recipients.length === 0) return;
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: message.conversationId },
      select: { kind: true, title: true },
    });
    const sender = await this.prisma.user.findUnique({
      where: { id: message.senderId },
      select: { name: true },
    });
    if (!conversation || !sender) return;
    const title =
      conversation.kind === 'group'
        ? `${sender.name} · ${conversation.title ?? 'Group'}`
        : sender.name;
    const words = message.content.trim()
      ? pushExcerpt(message.content)
      : message.image
        ? 'Sent a picture'
        : message.voice
          ? 'Sent a voice message'
          : message.sharedPost
            ? 'Sent a post'
            : 'New message';
    await this.deliver(
      recipients,
      (recipient): PushPayload | null =>
        recipient.settings.pushMessages
          ? {
              title,
              body: recipient.settings.pushPreviews ? words : 'New message',
              url: `/messages/${message.conversationId}`,
              // The tag the tab's own notification uses (MessageAlerts): one per conversation.
              tag: message.conversationId,
              timestamp: Date.parse(message.createdAt),
            }
          : null,
      // Only the newest message of a conversation waits for an offline device.
      { ...MESSAGE_PUSH, topic: message.conversationId.replaceAll('-', '') },
    );
  }

  /**
   * Sends to every device of the recipients that `build` gives a payload for. One failure
   * never stops the others; a subscription the push service no longer knows is deleted.
   */
  private async deliver(
    userIds: readonly string[],
    build: (recipient: Recipient) => PushPayload | null,
    options: PushOptions,
  ): Promise<void> {
    if (!this.sender) return;
    const sender = this.sender;
    const rows = await this.prisma.user.findMany({
      where: { id: { in: [...userIds] }, pushSubscriptions: { some: {} } },
      select: {
        id: true,
        settings: true,
        pushSubscriptions: { select: { id: true, endpoint: true, p256dh: true, auth: true } },
      },
    });
    const sends = rows.flatMap((row) => {
      const recipient: Recipient = {
        id: row.id,
        settings: toUserSettings(row.settings),
        subscriptions: row.pushSubscriptions,
      };
      const payload = build(recipient);
      if (!payload) return [];
      const body = JSON.stringify(payload);
      return recipient.subscriptions.map(async (subscription) => {
        try {
          const target = {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          };
          const result = await sender.send(target, body, options);
          if (result === 'gone') {
            await this.prisma.pushSubscription.deleteMany({ where: { id: subscription.id } });
          }
        } catch (error) {
          this.logger.warn(
            { err: error, userId: row.id, service: new URL(subscription.endpoint).host },
            'Push not delivered',
          );
        }
      });
    });
    await Promise.all(sends);
  }
}
