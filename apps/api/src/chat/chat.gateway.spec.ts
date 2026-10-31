import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Activity, Notification, UserSummary } from '@beso/shared';
import type { Server } from 'socket.io';
import { mockDeep } from 'vitest-mock-extended';
import type { Env } from '../config/env.js';
import type { ConversationsService } from '../conversations/conversations.service.js';
import { ActivityRecordedEvent } from '../events/activity.events.js';
import { MessageUpdatedEvent } from '../events/conversation.events.js';
import { NotificationCreatedEvent } from '../events/notification.events.js';
import { AccessTokensService } from '../tokens/access-tokens.service.js';
import type { UsersService } from '../users/users.service.js';
import {
  CONNECT_LIMIT,
  ChatGateway,
  MAX_SOCKETS_PER_USER,
  PRESENCE_BROADCAST_DELAY_MS,
  PRESENCE_ROOM,
} from './chat.gateway.js';
import { PresenceService } from './presence.service.js';

type ChatSocket = Parameters<ChatGateway['handleConnection']>[0];

const jwt = new JwtService({
  secret: 'unit-test-secret-unit-test-secret-unit-test',
  signOptions: { expiresIn: 60 },
});

/** The defaults, as the real `ConfigService` would answer without the variables set. */
const limits = {
  SOCKET_MAX_PER_USER: MAX_SOCKETS_PER_USER,
  SOCKET_CONNECTS_PER_MINUTE: CONNECT_LIMIT.limit,
};
const config = {
  get: (key: keyof typeof limits) => limits[key],
} as unknown as ConfigService<Env, true>;

const summary = (n: number): UserSummary => ({
  id: `0199b6a0-0000-7000-8000-00000000000${n}`,
  username: `user${n}`,
  name: `User ${n}`,
  avatarUrl: null,
  ring: null,
});

function connectedSocket(userId: string) {
  const socket = {
    id: `socket-${userId}`,
    data: { userId, expiresAt: null },
    disconnected: false,
    conn: { close: vi.fn() },
    join: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    once: vi.fn(),
  };
  return { socket, chatSocket: socket as unknown as ChatSocket };
}

describe('ChatGateway', () => {
  let users: ReturnType<typeof mockDeep<UsersService>>;
  let presence: PresenceService;
  let gateway: ChatGateway;
  let broadcast: ReturnType<typeof vi.fn>;
  let server: { to: ReturnType<typeof vi.fn>; use: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    users = mockDeep<UsersService>();
    presence = new PresenceService();
    gateway = new ChatGateway(
      new AccessTokensService(jwt),
      users,
      presence,
      mockDeep<ConversationsService>(),
      config,
    );
    broadcast = vi.fn();
    server = { to: vi.fn(() => ({ emit: broadcast })), use: vi.fn() };
    gateway.server = server as unknown as Server;
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    vi.useRealTimers();
  });

  it('pushes a new notification to the recipient alone', () => {
    const recipient = summary(1);
    const notification: Notification = {
      id: '0199b6a0-0000-7000-8000-0000000000aa',
      type: 'POST_LIKED',
      achievementKey: null,
      actor: summary(2),
      post: { id: '0199b6a0-0000-7000-8000-0000000000bb', excerpt: 'Hello' },
      comment: null,
      readAt: null,
      createdAt: '2026-10-20T10:00:00.000Z',
    };

    gateway.onNotificationCreated(new NotificationCreatedEvent(recipient.id, notification));

    expect(server.to).toHaveBeenCalledWith([`user:${recipient.id}`]);
    expect(broadcast).toHaveBeenCalledWith('notification:new', notification);
  });

  it('pushes a new activity to the followers it names, and to nobody when it names none', () => {
    const [bob, alice, carol] = [summary(1), summary(2), summary(3)];
    const activity: Activity = {
      id: '0199b6a0-0000-7000-8000-0000000000ee',
      type: 'POST_CREATED',
      actor: bob,
      post: { id: '0199b6a0-0000-7000-8000-0000000000ff', excerpt: 'Hello' },
      comment: null,
      targetUser: null,
      createdAt: '2026-10-22T10:00:00.000Z',
    };

    gateway.onActivityRecorded(new ActivityRecordedEvent(activity, [alice.id, carol.id]));
    expect(server.to).toHaveBeenCalledWith([`user:${alice.id}`, `user:${carol.id}`]);
    expect(broadcast).toHaveBeenCalledWith('activity:new', activity);

    // socket.io would broadcast to everyone for an empty room list.
    server.to.mockClear();
    gateway.onActivityRecorded(new ActivityRecordedEvent(activity, []));
    expect(server.to).not.toHaveBeenCalled();
  });

  it('pushes an edited or reacted-to message to every member, the actor included', () => {
    const [alice, bob] = [summary(1), summary(2)];
    const message = {
      id: '0199b6a0-0000-7000-8000-0000000000cc',
      conversationId: '0199b6a0-0000-7000-8000-0000000000dd',
      senderId: alice.id,
      kind: 'user' as const,
      content: 'fixed',
      image: null,
      voice: null,
      imageUrl: null,
      sharedPost: null,
      replyTo: null,
      editedAt: '2026-10-20T10:01:00.000Z',
      deletedAt: null,
      system: null,
      reactions: [{ userId: bob.id, type: 'LIKE' as const }],
      createdAt: '2026-10-20T10:00:00.000Z',
    };

    gateway.onMessageUpdated(new MessageUpdatedEvent(message, [alice.id, bob.id], bob.id));

    expect(server.to).toHaveBeenCalledWith([`user:${alice.id}`, `user:${bob.id}`]);
    expect(broadcast).toHaveBeenCalledWith('message:updated', message);
  });

  it('survives a failing lookup at connection: logs, closes the transport, registers nothing', async () => {
    users.summary.mockRejectedValue(new Error('connection pool timeout'));
    const { socket, chatSocket } = connectedSocket(summary(1).id);

    // Nest ignores the returned promise; it must never reject.
    await expect(gateway.handleConnection(chatSocket)).resolves.toBeUndefined();

    expect(socket.conn.close).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
    expect(presence.list()).toEqual([]);
  });

  it('sends one presence list for a burst of arrivals, to registered sockets only', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const people = [summary(1), summary(2), summary(3)];
    const sockets = people.map((person) => connectedSocket(person.id));
    for (const [i, person] of people.entries()) {
      users.summary.mockResolvedValueOnce(person);
      // oxlint-disable-next-line no-await-in-loop -- one after the other, like real handshakes
      await gateway.handleConnection(sockets[i]?.chatSocket as ChatSocket);
    }
    expect(broadcast).not.toHaveBeenCalled();
    for (const { socket } of sockets) expect(socket.join).toHaveBeenCalledWith(PRESENCE_ROOM);

    vi.advanceTimersByTime(PRESENCE_BROADCAST_DELAY_MS);
    expect(server.to).toHaveBeenCalledWith(PRESENCE_ROOM);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('presence:update', people);
  });

  it('refuses a user who keeps reconnecting, even though no socket stays open', async () => {
    gateway.afterInit(server as unknown as Server);
    const middleware = server.use.mock.calls[0]?.[0] as (
      socket: unknown,
      next: (error?: Error) => void,
    ) => void;
    const token = await jwt.signAsync({ sub: summary(1).id });
    const handshake = () => {
      const socket = { handshake: { headers: {}, auth: { token } }, data: {} };
      return new Promise<{ socket: typeof socket; error?: Error }>((resolve) =>
        middleware(socket, (error) => resolve({ socket, error })),
      );
    };

    for (let i = 0; i < CONNECT_LIMIT.limit; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential on purpose
      const { socket, error } = await handshake();
      expect(error).toBeUndefined();
      gateway.handleDisconnect(socket as unknown as ChatSocket);
    }
    expect((await handshake()).error?.message).toBe('Too many connections');
  });
});
