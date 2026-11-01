import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SOCKET_EVENTS } from '@beso/shared';
import { alice, bob, carol, makeMessage, makeUser, testId } from '@/test/fixtures';
import { intersectAll } from '@/test/intersection-observer';
import { seedConversation, seedDirect, seedReadMark, upsertUser } from '@/test/msw/db';
import { mockDb, signedInAs } from '@/test/msw/handlers';
import { renderApp } from '@/test/render';
import { fakeSocket } from '@/test/socket-mock';

const list = () => screen.getByRole('list', { name: 'Conversations' });
const rowsOf = () => within(list()).getAllByRole('link');
const readEvents = () => fakeSocket.emitted.filter((e) => e.event === SOCKET_EVENTS.messageRead);
const membersList = (dialog: HTMLElement) =>
  within(within(dialog).getByRole('list', { name: 'Members' })).getAllByRole('listitem');

/** A message lands in the mock store and is pushed over the fake socket. */
const push = (message: ReturnType<typeof makeMessage>) => {
  mockDb.messages.push(message);
  act(() => fakeSocket.serverEmit(SOCKET_EVENTS.messageNew, message));
  return message;
};

describe('chat follow-ups', () => {
  it('lets me take a message back and shows the other side doing the same', async () => {
    signedInAs(alice);
    const withBob = seedDirect(alice.id, bob.id);
    const mine = makeMessage(withBob.id, alice.id, 'Oops, wrong chat');
    const his = makeMessage(withBob.id, bob.id, 'Haha');
    mockDb.messages.push(mine, his);
    seedReadMark(withBob.id, alice.id, his.createdAt);
    seedReadMark(withBob.id, bob.id, his.createdAt);
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });
    await within(log).findByText('Oops, wrong chat');

    // Only my own messages offer the menu.
    expect(within(log).getAllByRole('button', { name: 'Message options' })).toHaveLength(1);
    await user.click(within(log).getByRole('button', { name: 'Message options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete message' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete this message?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(await within(log).findByText('Message deleted')).toBeInTheDocument();
    expect(within(log).queryByText('Oops, wrong chat')).toBeNull();
    expect(mockDb.messages.find((m) => m.id === mine.id)?.deletedAt).not.toBeNull();
    expect(within(log).queryByRole('button', { name: 'Message options' })).toBeNull();

    // Bob takes his back: the push replaces his bubble and the list snippet.
    act(() =>
      fakeSocket.serverEmit(SOCKET_EVENTS.messageDeleted, {
        ...his,
        content: '',
        deletedAt: new Date().toISOString(),
      }),
    );
    await waitFor(() => expect(within(log).queryByText('Haha')).toBeNull());
    expect(within(log).getAllByText('Message deleted')).toHaveLength(2);
    expect(rowsOf()[0]).toHaveTextContent('Message deleted');
  });

  it('shows a system line centred, counts it for nobody and reads nothing for it', async () => {
    signedInAs(alice);
    const group = seedConversation('group', [bob.id, alice.id], {
      title: 'Trip',
      createdById: bob.id,
    });
    const hello = makeMessage(group.id, bob.id, 'Hello');
    mockDb.messages.push(hello);
    seedReadMark(group.id, alice.id, hello.createdAt);
    renderApp(`/messages/${group.id}`);
    const log = await screen.findByRole('log', { name: 'Group Trip' });
    await within(log).findByText('Hello');
    await waitFor(() => expect(fakeSocket.connected).toBe(true));
    const readsBefore = readEvents().length;

    push(
      makeMessage(group.id, bob.id, '', {
        kind: 'system',
        system: {
          type: 'members_added',
          actor: { id: bob.id, name: 'Bob Brown' },
          users: [{ id: carol.id, name: 'Carol Clark' }],
          title: null,
        },
        createdAt: new Date().toISOString(),
      }),
    );
    expect(await within(log).findByText('Bob Brown added Carol Clark')).toBeInTheDocument();
    expect(rowsOf()[0]).toHaveTextContent('Bob Brown added Carol Clark');
    expect(within(rowsOf()[0] ?? log).queryByText(/Unread/)).toBeNull();
    expect(screen.queryByText(/\d+ unread/)).toBeNull();
    expect(readEvents()).toHaveLength(readsBefore);
  });

  it('gives admins a rename field and member options; plain members get neither', async () => {
    signedInAs(alice);
    const group = seedConversation('group', [alice.id, bob.id, carol.id], { title: 'Trip' });
    renderApp(`/messages/${group.id}`);
    const user = userEvent.setup();
    await screen.findByRole('log', { name: 'Group Trip' });

    // Rename from the thread header (Enter saves).
    await user.click(screen.getByRole('button', { name: 'Rename group' }));
    const field = screen.getByRole('textbox', { name: 'Group name' });
    await user.clear(field);
    await user.type(field, 'Weekend{Enter}');
    expect(await screen.findByRole('log', { name: 'Group Weekend' })).toBeInTheDocument();
    expect(rowsOf()[0]).toHaveTextContent('Weekend');
    expect(mockDb.messages.at(-1)?.system).toMatchObject({ type: 'renamed', title: 'Weekend' });

    await user.click(screen.getByRole('button', { name: 'Group members' }));
    const dialog = await screen.findByRole('dialog', { name: 'Weekend' });
    expect(membersList(dialog)[0]).toHaveTextContent('Alice Anderson (you)Admin');
    expect(membersList(dialog)[1]).toHaveTextContent('@bob');

    await user.click(within(dialog).getByRole('button', { name: 'Options for Bob Brown' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Make admin' }));
    await waitFor(() => expect(membersList(dialog)[1]).toHaveTextContent('Admin'));
    expect(group.members.find((m) => m.userId === bob.id)?.role).toBe('admin');

    await user.click(within(dialog).getByRole('button', { name: 'Options for Carol Clark' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from group' }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Remove Carol Clark from the group?',
    });
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(membersList(dialog)).toHaveLength(2));
    expect(group.members.map((m) => m.userId)).toEqual([alice.id, bob.id]);
    expect(mockDb.messages.at(-1)?.system).toMatchObject({ type: 'member_removed' });
    await user.keyboard('{Escape}');
  });

  it('leaves the rename field behind when another chat is opened', async () => {
    signedInAs(alice);
    const group = seedConversation('group', [alice.id, bob.id], { title: 'Trip' });
    const withBob = seedDirect(alice.id, bob.id);
    const hi = makeMessage(withBob.id, bob.id, 'Hi there');
    mockDb.messages.push(hi);
    seedReadMark(withBob.id, alice.id, hi.createdAt);
    renderApp(`/messages/${group.id}`);
    const user = userEvent.setup();
    await screen.findByRole('log', { name: 'Group Trip' });
    await user.click(screen.getByRole('button', { name: 'Rename group' }));
    expect(screen.getByRole('textbox', { name: 'Group name' })).toBeInTheDocument();

    await user.click(within(list()).getByRole('link', { name: /Bob Brown/ }));
    expect(
      await screen.findByRole('log', { name: 'Conversation with Bob Brown' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Group name' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Bob Brown' })).toBeInTheDocument();
    // Back in the group the field is closed too.
    await user.click(within(list()).getByRole('link', { name: /Trip/ }));
    await screen.findByRole('log', { name: 'Group Trip' });
    expect(screen.queryByRole('textbox', { name: 'Group name' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rename group' })).toBeInTheDocument();
  });

  it('shows a plain member neither the rename field nor the member options', async () => {
    signedInAs(bob);
    const group = seedConversation('group', [alice.id, bob.id], { title: 'Trip' });
    renderApp(`/messages/${group.id}`);
    const user = userEvent.setup();
    await screen.findByRole('log', { name: 'Group Trip' });
    expect(screen.queryByRole('button', { name: 'Rename group' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Group members' }));
    const dialog = await screen.findByRole('dialog', { name: 'Trip' });
    expect(membersList(dialog)[0]).toHaveTextContent('Alice AndersonAdmin');
    expect(within(dialog).queryByRole('button', { name: /Options for/ })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Rename' })).toBeNull();
  });

  it('offers a pill for messages that arrive while scrolled up through the history', async () => {
    signedInAs(alice);
    const withBob = seedDirect(alice.id, bob.id);
    const first = makeMessage(withBob.id, bob.id, 'First');
    mockDb.messages.push(first);
    seedReadMark(withBob.id, alice.id, first.createdAt);
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });
    await within(log).findByText('First');

    // jsdom has no layout: the scroll position comes from these metrics.
    Object.defineProperties(log, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 400, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    });
    fireEvent.scroll(log);
    push(
      makeMessage(withBob.id, bob.id, 'Are you there?', { createdAt: new Date().toISOString() }),
    );
    expect(await screen.findByRole('button', { name: /^1 new message/ })).toBeInTheDocument();
    push(
      makeMessage(withBob.id, bob.id, 'Hello?', {
        createdAt: new Date(Date.now() + 1000).toISOString(),
      }),
    );
    const pill = await screen.findByRole('button', { name: /^2 new messages/ });
    await user.click(pill);
    expect(screen.queryByRole('button', { name: /^\d+ new message/ })).toBeNull();
    expect(log.scrollTop).toBe(2000);
  });

  it('puts the unread total in the tab title', async () => {
    signedInAs(alice);
    const withBob = seedDirect(alice.id, bob.id);
    const [, second] = [
      makeMessage(withBob.id, bob.id, 'Lunch?'),
      makeMessage(withBob.id, bob.id, 'At noon?'),
    ].map((message) => {
      mockDb.messages.push(message);
      return message;
    });
    seedReadMark(withBob.id, bob.id, second?.createdAt ?? null);
    // A phone, where the list is the page: a wide screen would open (and read) the thread at once.
    window.innerWidth = 390;
    renderApp('/messages');
    const user = userEvent.setup();
    await waitFor(() => expect(document.title).toBe('(2) Messages · BeSo'));
    await user.click(within(list()).getByRole('link', { name: /Bob Brown/ }));
    await screen.findByRole('log', { name: 'Conversation with Bob Brown' });
    await waitFor(() => expect(document.title).toBe('Bob Brown · Messages · BeSo'));
  });

  it('loads more conversations as the list is scrolled', async () => {
    signedInAs(alice);
    for (let index = 0; index < 23; index += 1) {
      const other = makeUser({
        id: testId('user', 100 + index),
        username: `member${index}`,
        name: `Member ${String(index).padStart(2, '0')}`,
      });
      upsertUser(other);
      const direct = seedDirect(alice.id, other.id);
      mockDb.messages.push(makeMessage(direct.id, other.id, `Hi from ${index}`));
    }
    renderApp('/messages');
    await screen.findByRole('list', { name: 'Conversations' });
    await waitFor(() => expect(rowsOf()).toHaveLength(20));
    intersectAll();
    await waitFor(() => expect(rowsOf()).toHaveLength(23));
    // Newest activity first, all the way down.
    expect(rowsOf()[0]).toHaveTextContent('Member 22');
    expect(rowsOf()[22]).toHaveTextContent('Member 00');
  });
  it('edits my message in place, keeps the history, and follows an edit pushed by the other side', async () => {
    signedInAs(alice);
    const withBob = seedDirect(alice.id, bob.id);
    const mine = makeMessage(withBob.id, alice.id, 'Teh plan');
    const his = makeMessage(withBob.id, bob.id, 'Sounds good');
    mockDb.messages.push(mine, his);
    seedReadMark(withBob.id, alice.id, his.createdAt);
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });
    await within(log).findByText('Teh plan');

    await user.click(within(log).getByRole('button', { name: 'Message options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit message' }));
    const editor = within(log).getByLabelText('Edit message');
    await user.clear(editor);
    await user.type(editor, 'The plan{Enter}');
    expect(await within(log).findByText('The plan')).toBeInTheDocument();
    expect(within(log).queryByLabelText('Edit message')).toBeNull();
    expect(mockDb.messages.find((m) => m.id === mine.id)).toMatchObject({ content: 'The plan' });
    await user.click(within(log).getByRole('button', { name: 'edited' }));
    const history = await screen.findByRole('list', { name: 'Previous versions' });
    expect(within(history).getByText('Teh plan')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // Bob's edit arrives by push: his bubble and the list snippet change, nothing is read.
    act(() =>
      fakeSocket.serverEmit(SOCKET_EVENTS.messageUpdated, {
        ...his,
        content: 'Sounds great',
        editedAt: new Date().toISOString(),
      }),
    );
    expect(await within(log).findByText('Sounds great')).toBeInTheDocument();
    expect(within(log).queryByText('Sounds good')).toBeNull();
    expect(rowsOf()[0]).toHaveTextContent('Sounds great');
    expect(readEvents()).toHaveLength(0);
  });

  it('reacts to a message, sees the pills follow a pushed reaction, and takes its own back', async () => {
    signedInAs(alice);
    const withBob = seedDirect(alice.id, bob.id);
    const his = makeMessage(withBob.id, bob.id, 'Pizza tonight?');
    mockDb.messages.push(his);
    seedReadMark(withBob.id, alice.id, his.createdAt);
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });
    await within(log).findByText('Pizza tonight?');

    await user.click(within(log).getByRole('button', { name: 'Add reaction' }));
    await user.click(await screen.findByRole('button', { name: 'Love' }));
    expect(await within(log).findByRole('button', { name: 'Love 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() =>
      expect(mockDb.messages.find((m) => m.id === his.id)?.reactions).toEqual([
        { userId: alice.id, type: 'LOVE' },
      ]),
    );

    // Bob reacts too: the count follows; a reaction is nobody's unread and reads nothing.
    his.reactions = [
      { userId: alice.id, type: 'LOVE' },
      { userId: bob.id, type: 'LOVE' },
    ];
    act(() => fakeSocket.serverEmit(SOCKET_EVENTS.messageUpdated, { ...his }));
    expect(await within(log).findByRole('button', { name: 'Love 2' })).toBeInTheDocument();
    expect(readEvents()).toHaveLength(0);

    await user.click(within(log).getByRole('button', { name: 'Love 2' }));
    expect(await within(log).findByRole('button', { name: 'Love 1' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await waitFor(() =>
      expect(mockDb.messages.find((m) => m.id === his.id)?.reactions).toEqual([
        { userId: bob.id, type: 'LOVE' },
      ]),
    );
  });

  it('opens the reaction picker over a message held with a finger', async () => {
    signedInAs(alice);
    const withBob = seedDirect(alice.id, bob.id);
    const his = makeMessage(withBob.id, bob.id, 'Hold this one');
    mockDb.messages.push(his);
    seedReadMark(withBob.id, alice.id, his.createdAt);
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });
    const text = await within(log).findByText('Hold this one');

    fireEvent.pointerDown(text, {
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 5,
      clientY: 5,
    });
    const love = await screen.findByRole('button', { name: 'Love' });
    // Someone else's message: reactions only, nothing to edit.
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    fireEvent.pointerUp(text);
    await user.click(love);
    expect(await within(log).findByRole('button', { name: 'Love 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByRole('button', { name: 'Love' })).toBeNull();
    await waitFor(() =>
      expect(mockDb.messages.find((m) => m.id === his.id)?.reactions).toEqual([
        { userId: alice.id, type: 'LOVE' },
      ]),
    );
  });

  it('a held own message offers edit and delete under the reactions', async () => {
    signedInAs(alice);
    const withBob = seedDirect(alice.id, bob.id);
    const mine = makeMessage(withBob.id, alice.id, 'Mine to edit');
    mockDb.messages.push(mine);
    seedReadMark(withBob.id, alice.id, mine.createdAt);
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });
    const text = await within(log).findByText('Mine to edit');

    fireEvent.pointerDown(text, {
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 5,
      clientY: 5,
    });
    expect(await screen.findByRole('button', { name: 'Delete message' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Love' })).toBeInTheDocument();
    fireEvent.pointerUp(text);
    await user.click(screen.getByRole('button', { name: 'Edit message' }));

    expect(await within(log).findByRole('textbox', { name: 'Edit message' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Love' })).toBeNull();
  });
});
