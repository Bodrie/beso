import type { Conversation, SystemLine } from '@beso/shared';
import { alice, bob, carol, makeMessage, summaryOf } from '@/test/fixtures';
import {
  conversationName,
  directPeer,
  isAdmin,
  messagePreview,
  reactionSummaryOf,
  readBy,
  seenText,
  systemLineText,
  typingText,
} from './conversation-display';

const T0 = '2026-10-16T10:00:00.000Z';
const T1 = '2026-10-16T10:05:00.000Z';
const T2 = '2026-10-16T10:10:00.000Z';
const POST_ID = '01a13f00-0000-7000-8000-000000000001';

function conversation(
  kind: Conversation['kind'],
  marks: Record<string, string | null>,
  title: string | null = null,
): Conversation {
  const members = [alice, bob, carol]
    .filter((user) => user.id in marks)
    .map((user) => ({
      user: summaryOf(user),
      role: 'member' as const,
      joinedAt: T0,
      lastReadAt: marks[user.id] ?? null,
    }));
  return {
    id: '01a14300-0000-7000-8000-000000000001',
    kind,
    title,
    pictureUrl: null,
    createdById: alice.id,
    createdAt: T0,
    lastMessageAt: T1,
    members,
    lastMessage: null,
    unreadCount: 0,
  };
}

describe('directPeer / conversationName', () => {
  it('names a direct thread after the other person and a group after its title', () => {
    const direct = conversation('direct', { [alice.id]: null, [bob.id]: null });
    expect(directPeer(direct, alice.id)?.id).toBe(bob.id);
    expect(conversationName(direct, alice.id)).toBe('Bob Brown');
    const group = conversation('group', { [alice.id]: null, [bob.id]: null }, 'Trip');
    expect(directPeer(group, alice.id)).toBeNull();
    expect(conversationName(group, alice.id)).toBe('Trip');
  });
});

describe('typingText', () => {
  it('reads naturally for one, two and many people', () => {
    expect(typingText([])).toBeNull();
    expect(typingText(['Bob'])).toBe('Bob is typing…');
    expect(typingText(['Bob', 'Carol'])).toBe('Bob and Carol are typing…');
    expect(typingText(['Bob', 'Carol', 'Dan'])).toBe('Bob, Carol and 1 other are typing…');
    expect(typingText(['Bob', 'Carol', 'Dan', 'Eve'])).toBe('Bob, Carol and 2 others are typing…');
  });
});

describe('readBy / seenText', () => {
  it('counts a member as having read a message once their mark passed it', () => {
    const group = conversation('group', { [alice.id]: T2, [bob.id]: T1, [carol.id]: T0 }, 'Trip');
    expect(readBy(group, alice.id, T1).map((m) => m.user.id)).toEqual([bob.id]);
    expect(readBy(group, alice.id, T2)).toEqual([]);
  });

  it('says "Seen" in a direct thread and names readers in a group', () => {
    const direct = conversation('direct', { [alice.id]: T2, [bob.id]: T1 });
    expect(seenText(direct, alice.id, T1)).toBe('Seen');
    expect(seenText(direct, alice.id, T2)).toBeNull();

    const group = conversation('group', { [alice.id]: T2, [bob.id]: T1, [carol.id]: null }, 'Trip');
    expect(seenText(group, alice.id, T1)).toBe('Seen by Bob');
    const everyone = conversation(
      'group',
      { [alice.id]: T2, [bob.id]: T1, [carol.id]: T1 },
      'Trip',
    );
    expect(seenText(everyone, alice.id, T1)).toBe('Seen by everyone');
  });
});

/** A system line by Alice, recorded under a name she no longer carries. */
const line = (
  type: SystemLine['type'],
  users: { id: string; name: string }[] = [],
  title: string | null = null,
) => ({ type, actor: { id: alice.id, name: 'Old Name' }, users, title });

describe('systemLineText / messagePreview', () => {
  const group = conversation('group', { [alice.id]: T1, [bob.id]: T1 }, 'Trip');

  it('names people who are still in by their current name and the others as recorded', () => {
    const added = line('members_added', [
      { id: bob.id, name: 'Bob Brown' },
      { id: carol.id, name: 'Carol (then)' },
    ]);
    // Alice is a member (current name), Carol is not (stored name); Bob reads as "you" to Bob.
    expect(systemLineText(added, group, carol.id)).toBe('Alice Anderson added Bob Brown and you');
    expect(systemLineText(added, group, alice.id)).toBe('You added Bob Brown and Carol (then)');
    expect(systemLineText(line('member_left'), group, bob.id)).toBe(
      'Alice Anderson left the group',
    );
    expect(systemLineText(line('member_removed', [{ id: bob.id, name: 'B' }]), group, bob.id)).toBe(
      'Alice Anderson removed you',
    );
    expect(systemLineText(line('renamed', [], 'Weekend'), group, bob.id)).toBe(
      'Alice Anderson renamed the group to “Weekend”',
    );
    expect(systemLineText(line('group_created', [], 'Trip'), group, bob.id)).toBe(
      'Alice Anderson created the group',
    );
    expect(systemLineText(line('admin_added', [{ id: bob.id, name: 'B' }]), group, bob.id)).toBe(
      'Alice Anderson made you an admin',
    );
    expect(
      systemLineText(line('admin_removed', [{ id: bob.id, name: 'B' }]), group, alice.id),
    ).toBe('You removed Bob Brown as admin');
    expect(systemLineText(line('picture_changed'), group, bob.id)).toBe(
      'Alice Anderson changed the group picture',
    );
    expect(systemLineText(line('picture_removed'), group, alice.id)).toBe(
      'You removed the group picture',
    );
  });

  it("sums a message's reactions from the viewer's side", () => {
    expect(
      reactionSummaryOf(
        [
          { userId: alice.id, type: 'LIKE' },
          { userId: bob.id, type: 'LIKE' },
          { userId: carol.id, type: 'WOW' },
        ],
        bob.id,
      ),
    ).toEqual({ counts: { LIKE: 2, LOVE: 0, LAUGH: 0, WOW: 1, SAD: 0 }, total: 3, mine: 'LIKE' });
    expect(reactionSummaryOf([], alice.id)).toEqual({
      counts: { LIKE: 0, LOVE: 0, LAUGH: 0, WOW: 0, SAD: 0 },
      total: 0,
      mine: null,
    });
  });

  const post = (content: string, sharedPost: { id: string } | { unavailable: true }) =>
    messagePreview(makeMessage(group.id, bob.id, content, { sharedPost }), group, alice.id);

  it('previews a sent post by its text, else as a post, gone or not', () => {
    expect(post('look', { id: POST_ID })).toBe('look');
    expect(post('', { id: POST_ID })).toBe('Post');
    expect(post('', { unavailable: true })).toBe('Post');
  });

  it('previews a deleted message, a system line and a picture', () => {
    expect(messagePreview(makeMessage(group.id, bob.id, 'hi'), group, alice.id)).toBe('hi');
    expect(
      messagePreview(makeMessage(group.id, bob.id, '', { deletedAt: T2 }), group, alice.id),
    ).toBe('Message deleted');
    expect(
      messagePreview(
        makeMessage(group.id, bob.id, '', {
          image: { url: 'http://localhost/pic.webp', width: 64, height: 64 },
        }),
        group,
        alice.id,
      ),
    ).toBe('Picture');
    expect(
      messagePreview(
        makeMessage(group.id, alice.id, '', { kind: 'system', system: line('renamed', [], 'X') }),
        group,
        bob.id,
      ),
    ).toBe('Alice Anderson renamed the group to “X”');
  });

  it('knows who is an admin', () => {
    const withAdmin = conversation('group', { [alice.id]: T1, [bob.id]: T1 }, 'Trip');
    const first = withAdmin.members[0];
    if (first) first.role = 'admin';
    expect(isAdmin(withAdmin, alice.id)).toBe(true);
    expect(isAdmin(withAdmin, bob.id)).toBe(false);
  });
});
