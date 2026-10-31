import {
  activitySchema,
  conversationReadPayloadSchema,
  conversationRefSchema,
  markReadPayloadSchema,
  messageSchema,
  notificationSchema,
  presenceUpdateSchema,
  sendMessagePayloadSchema,
  SOCKET_EVENTS,
  typingUpdateSchema,
} from '@beso/shared';
import type { z } from 'zod';
import { markConversationRead, storeMessage } from './msw/conversations';
import { mockDb } from './msw/db';

type Handler = (...args: unknown[]) => void;
type AckHandler = (payload: unknown) => unknown;

/**
 * Stands in for socket.io-client in jsdom. Tests drive the "server" side with
 * `serverEmit()` and inspect what the app sent through `emitted`.
 */

/** What each server push carries; a test that emits something else is wrong, not the app. */
const PUSH_SCHEMAS: Record<string, z.ZodType> = {
  [SOCKET_EVENTS.presenceUpdate]: presenceUpdateSchema,
  [SOCKET_EVENTS.messageNew]: messageSchema,
  [SOCKET_EVENTS.messageDeleted]: messageSchema,
  [SOCKET_EVENTS.messageUpdated]: messageSchema,
  [SOCKET_EVENTS.conversationRead]: conversationReadPayloadSchema,
  [SOCKET_EVENTS.conversationUpdate]: conversationRefSchema,
  [SOCKET_EVENTS.conversationRemoved]: conversationRefSchema,
  [SOCKET_EVENTS.typingUpdate]: typingUpdateSchema,
  [SOCKET_EVENTS.notificationNew]: notificationSchema,
  [SOCKET_EVENTS.activityNew]: activitySchema,
};
export class FakeSocket {
  connected = false;
  /** Like socket.io's: whether it would reconnect by itself (false once refused or server-closed). */
  active = false;
  emitted: { event: string; payload: unknown }[] = [];
  ackHandlers: Record<string, AckHandler> = {};
  readonly #handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): this {
    const set = this.#handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    this.#handlers.set(event, set);
    return this;
  }

  off(event: string, handler?: Handler): this {
    if (handler) this.#handlers.get(event)?.delete(handler);
    else this.#handlers.delete(event);
    return this;
  }

  connect(): this {
    this.active = true;
    if (!this.connected) {
      this.connected = true;
      queueMicrotask(() => this.fire('connect'));
    }
    return this;
  }

  disconnect(): this {
    this.active = false;
    if (this.connected) {
      this.connected = false;
      this.fire('disconnect', 'io client disconnect');
    }
    return this;
  }

  timeout(): this {
    return this;
  }

  emit(event: string, payload: unknown, ack?: (result: unknown) => void): this {
    this.emitted.push({ event, payload });
    const answer = this.ackHandlers[event]?.(payload);
    if (ack && answer !== undefined) queueMicrotask(() => ack(answer));
    return this;
  }

  async emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.emitted.push({ event, payload });
    const handler = this.ackHandlers[event];
    if (!handler) throw new Error(`No ack handler for ${event}`);
    await Promise.resolve();
    return handler(payload);
  }

  /** A push from the server; the payload must be what the shared contract says the API sends. */
  serverEmit(event: string, ...args: unknown[]): void {
    const schema = PUSH_SCHEMAS[event];
    if (schema) schema.parse(args[0]);
    this.fire(event, ...args);
  }

  /** The server closed the connection (token expiry, revoked sessions). */
  serverDisconnect(): void {
    this.connected = false;
    this.active = false;
    this.fire('disconnect', 'io server disconnect');
  }

  /** The handshake middleware said no (socket.io does not retry this by itself). */
  serverRefuse(message: string): void {
    this.connected = false;
    this.active = false;
    this.fire('connect_error', new Error(message));
  }

  /** The connection dropped (network, a server restart); socket.io stays active and retries. */
  transportClose(): void {
    this.connected = false;
    this.fire('disconnect', 'transport close');
  }

  /** socket.io's own reconnection after `transportClose()` succeeded. */
  reconnect(): void {
    this.connected = true;
    this.fire('connect');
  }

  listenerCount(event: string): number {
    return this.#handlers.get(event)?.size ?? 0;
  }

  reset(): void {
    this.connected = false;
    this.active = false;
    this.emitted = [];
    this.#handlers.clear();
    this.ackHandlers = defaultAckHandlers(this);
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const handler of Array.from(this.#handlers.get(event) ?? [])) handler(...args);
  }
}

const validationFailed = {
  ok: false,
  error: { statusCode: 400, code: 'VALIDATION_ERROR', message: 'Validation failed' },
};
const notFound = {
  ok: false,
  error: { statusCode: 404, code: 'NOT_FOUND', message: 'Conversation not found' },
};

const memberRow = (viewerId: string, conversationId: string) =>
  mockDb.conversations.find(
    (row) => row.id === conversationId && row.members.some((m) => m.userId === viewerId),
  );

/** Mirrors the real gateway: sends persist and are pushed back as `message:new`; reads move the mark. */
function defaultAckHandlers(socket: FakeSocket): Record<string, AckHandler> {
  return {
    [SOCKET_EVENTS.messageSend]: (payload) => {
      const user = mockDb.user;
      const parsed = sendMessagePayloadSchema.safeParse(payload);
      if (!user || !parsed.success) return validationFailed;
      const { conversationId, content, imageKey, postId, replyToId, voiceKey, voicePeaks } =
        parsed.data;
      if (!memberRow(user.id, conversationId)) return notFound;
      const message = storeMessage(
        conversationId,
        user.id,
        content,
        imageKey,
        postId,
        replyToId,
        voiceKey ? { key: voiceKey, peaks: voicePeaks ?? [] } : undefined,
      );
      queueMicrotask(() => socket.serverEmit(SOCKET_EVENTS.messageNew, message));
      return { ok: true, message };
    },
    [SOCKET_EVENTS.messageRead]: (payload) => {
      const user = mockDb.user;
      const parsed = markReadPayloadSchema.safeParse(payload);
      if (!user || !parsed.success) return validationFailed;
      const row = memberRow(user.id, parsed.data.conversationId);
      if (!row) return notFound;
      return { ok: true, readAt: markConversationRead(user.id, row) };
    },
  };
}

export const fakeSocket = new FakeSocket();
fakeSocket.reset();
