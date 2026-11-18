import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MESSAGE_MAX_IMAGES, SOCKET_EVENTS, type StoredImage } from '@beso/shared';
import { http } from 'msw/http';
import { deferred } from '@/test/deferred';
import { captureDownloads } from '@/test/downloads';
import { alice, bob, makeMessage, testId } from '@/test/fixtures';
import { seedDirect, seedReadMark } from '@/test/msw/db';
import { apiError, mockDb, signedInAs } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderApp } from '@/test/render';
import { fakeSocket } from '@/test/socket-mock';

const picture = (n: number): StoredImage => ({
  url: `http://localhost/api/v1/uploads/message/${testId('message', 900 + n)}.webp`,
  width: 64,
  height: 64,
});
const savedAs = (image: StoredImage) => `beso-${image.url.split('/').pop()}`;

/** Bob's picture, a line of text, then Alice's picture: a thread with two pictures in it. */
function seedPictures() {
  const withBob = seedDirect(alice.id, bob.id);
  const his = makeMessage(withBob.id, bob.id, '', { images: [picture(1)] });
  const text = makeMessage(withBob.id, alice.id, 'Nice one');
  const mine = makeMessage(withBob.id, alice.id, 'Mine', { images: [picture(2)] });
  mockDb.messages.push(his, text, mine);
  seedReadMark(withBob.id, alice.id, mine.createdAt);
  return withBob;
}

/** Bob's three pictures in one message, then one of Alice's: four pictures, two messages. */
function seedPile() {
  const withBob = seedDirect(alice.id, bob.id);
  const pile = makeMessage(withBob.id, bob.id, 'From the trip', {
    images: [picture(1), picture(2), picture(3)],
  });
  const mine = makeMessage(withBob.id, alice.id, '', { images: [picture(4)] });
  mockDb.messages.push(pile, mine);
  seedReadMark(withBob.id, alice.id, mine.createdAt);
  return withBob;
}

const photo = (name: string) => new File(['png'], name, { type: 'image/png' });
/** The picture a thread button shows on top. */
const sourceOf = (button: HTMLElement | undefined) =>
  [...(button?.querySelectorAll('img') ?? [])].at(-1)?.getAttribute('src');

afterEach(() => vi.restoreAllMocks());

describe('chat pictures', () => {
  it('pages through the pictures of the thread in the viewer and downloads the one shown', async () => {
    signedInAs(alice);
    const withBob = seedPictures();
    const saved = captureDownloads();
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });

    await user.click(
      await within(log).findByRole('button', { name: 'Open picture sent by Bob Brown' }),
    );
    const viewer = await screen.findByRole('dialog', { name: 'Pictures in this conversation' });
    expect(within(viewer).getByRole('img', { name: 'Sent by Bob Brown, 1 of 2' })).toHaveAttribute(
      'src',
      picture(1).url,
    );
    // Focus starts on Close, so Enter never saves a file by accident.
    await waitFor(() =>
      expect(within(viewer).getByRole('button', { name: 'Close' })).toHaveFocus(),
    );

    await user.click(within(viewer).getByRole('button', { name: 'Next picture' }));
    expect(within(viewer).getByRole('img', { name: 'Sent by you, 2 of 2' })).toHaveAttribute(
      'src',
      picture(2).url,
    );
    await user.click(within(viewer).getByRole('button', { name: 'Download picture' }));
    await waitFor(() => expect(saved).toEqual([savedAs(picture(2))]));
  });

  it('downloads a picture from the toolbar beside its message', async () => {
    signedInAs(alice);
    const withBob = seedPictures();
    const saved = captureDownloads();
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });
    await within(log).findByText('Nice one');

    const his = within(log)
      .getAllByRole('listitem')
      .find((item) =>
        within(item).queryByRole('button', { name: 'Open picture sent by Bob Brown' }),
      );
    if (!his) throw new Error("Bob's picture is not in the thread");
    // Text alone has nothing to download.
    const text = within(log).getByText('Nice one').closest('li');
    expect(text && within(text).queryByRole('button', { name: 'Download picture' })).toBeNull();

    await user.click(within(his).getByRole('button', { name: 'Download picture' }));
    await waitFor(() => expect(saved).toEqual([savedAs(picture(1))]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers the download when a picture is held with a finger, without opening it', async () => {
    signedInAs(alice);
    const withBob = seedPictures();
    const saved = captureDownloads();
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });
    const open = await within(log).findByRole('button', { name: 'Open picture sent by Bob Brown' });

    const hold = { pointerType: 'touch', isPrimary: true, button: 0, clientX: 5, clientY: 5 };
    fireEvent.pointerDown(open, hold);
    const picker = await screen.findByRole('dialog');
    expect(within(picker).getByRole('button', { name: 'Love' })).toBeInTheDocument();
    // Bob's message: his to edit, not mine.
    expect(within(picker).queryByRole('button', { name: 'Edit message' })).toBeNull();
    fireEvent.pointerUp(open);
    fireEvent.click(open);
    // The release is the hold's: the picture did not open behind the picker.
    expect(
      screen.queryByRole('dialog', { name: 'Pictures in this conversation' }),
    ).not.toBeInTheDocument();

    await user.click(within(picker).getByRole('button', { name: 'Download picture' }));
    await waitFor(() => expect(saved).toEqual([savedAs(picture(1))]));
    expect(screen.queryByRole('button', { name: 'Love' })).toBeNull();
  });

  it('a held picture of my own offers the download next to edit and delete', async () => {
    signedInAs(alice);
    const withBob = seedPictures();
    renderApp(`/messages/${withBob.id}`);
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });
    const open = await within(log).findByRole('button', { name: 'Open picture sent by you' });

    fireEvent.pointerDown(open, { pointerType: 'touch', isPrimary: true, button: 0 });
    const picker = await screen.findByRole('dialog');
    expect(
      within(picker)
        .getAllByRole('button')
        .slice(-3)
        .map((button) => button.textContent),
    ).toEqual(['Download picture', 'Edit message', 'Delete message']);
    fireEvent.pointerUp(open);
  });

  it('shows several pictures of one message as a pile that opens the viewer on its first', async () => {
    signedInAs(alice);
    const withBob = seedPile();
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });

    // One button for the three, its number on it; the first picture lies on top.
    const pile = await within(log).findByRole('button', {
      name: 'Open 3 pictures sent by Bob Brown',
    });
    expect(pile).toHaveTextContent('3');
    expect(pile.querySelectorAll('img')).toHaveLength(3);
    expect(sourceOf(pile)).toBe(picture(1).url);
    expect(within(log).getAllByRole('button', { name: /^Open .*picture/ })).toHaveLength(2);
    // The caption stays under it, in the same bubble.
    expect(pile.closest('li')).toHaveTextContent('From the trip');

    await user.click(pile);
    const viewer = await screen.findByRole('dialog', { name: 'Pictures in this conversation' });
    const shown = (name: string) => within(viewer).getByRole('img', { name });
    expect(shown('Sent by Bob Brown, 1 of 4')).toHaveAttribute('src', picture(1).url);
    // Through the rest of the pile in its order, then on to the next message's picture.
    const next = within(viewer).getByRole('button', { name: 'Next picture' });
    await user.click(next);
    expect(shown('Sent by Bob Brown, 2 of 4')).toHaveAttribute('src', picture(2).url);
    await user.click(next);
    expect(shown('Sent by Bob Brown, 3 of 4')).toHaveAttribute('src', picture(3).url);
    await user.click(next);
    expect(shown('Sent by you, 4 of 4')).toHaveAttribute('src', picture(4).url);
  });

  it('downloads every picture of a pile from its toolbar, and offers it on a hold', async () => {
    signedInAs(alice);
    const withBob = seedPile();
    const saved = captureDownloads();
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });
    const pile = await within(log).findByRole('button', {
      name: 'Open 3 pictures sent by Bob Brown',
    });
    const row = pile.closest('li');
    if (!row) throw new Error('The pile is not in a message');

    await user.click(within(row).getByRole('button', { name: 'Download pictures' }));
    await waitFor(() => expect(saved).toEqual([1, 2, 3].map((n) => savedAs(picture(n)))));

    fireEvent.pointerDown(pile, { pointerType: 'touch', isPrimary: true, button: 0 });
    const picker = await screen.findByRole('dialog');
    expect(within(picker).getByRole('button', { name: 'Download pictures' })).toBeInTheDocument();
    fireEvent.pointerUp(pile);
    fireEvent.click(pile);
    // The release is the hold's: the viewer did not open behind the picker.
    expect(
      screen.queryByRole('dialog', { name: 'Pictures in this conversation' }),
    ).not.toBeInTheDocument();
  });

  it('sends several pictures chosen at once as one message, in the order chosen', async () => {
    signedInAs(alice);
    const withBob = seedDirect(alice.id, bob.id);
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });
    const input = screen.getByLabelText('Attach pictures');
    expect(input).toHaveAttribute('multiple');

    await user.upload(input, [photo('one.png'), photo('two.png'), photo('three.png')]);
    const strip = await screen.findByRole('list', { name: '3 pictures to send' });
    expect(within(strip).getAllByRole('img')).toHaveLength(3);
    // One changes their mind about the second, then adds another.
    await user.click(within(strip).getByRole('button', { name: 'Remove image 2' }));
    await user.upload(screen.getByLabelText('Attach pictures'), photo('four.png'));
    await screen.findByRole('list', { name: '3 pictures to send' });
    const send = screen.getByRole('button', { name: 'Send' });
    await waitFor(() => expect(send).toBeEnabled());

    // Hold the ack: the bubble on its way is a pile of the local previews.
    const deliver = fakeSocket.ackHandlers[SOCKET_EVENTS.messageSend];
    const held = deferred();
    fakeSocket.ackHandlers[SOCKET_EVENTS.messageSend] = async (payload) => {
      await held.promise;
      return deliver?.(payload);
    };
    await user.type(screen.getByRole('textbox', { name: 'Message Bob Brown' }), 'Look');
    await user.click(send);
    const sending = await within(log).findByRole('button', { name: 'Open 3 pictures sent by you' });
    expect(sourceOf(sending)).toMatch(/^blob:/);
    expect(screen.queryByRole('list', { name: /pictures to send/ })).not.toBeInTheDocument();

    held.resolve();
    await waitFor(() => expect(within(log).queryByText('Sending…')).not.toBeInTheDocument());
    const sent = mockDb.messages.at(-1);
    expect(sent).toMatchObject({ content: 'Look' });
    expect(sent?.images.map((image) => mockDb.uploadedNames.get(image.url))).toEqual([
      'one.png',
      'three.png',
      'four.png',
    ]);
    // Push and ack confirm the same bubble: one pile, now of the stored pictures.
    const piles = within(log).getAllByRole('button', { name: 'Open 3 pictures sent by you' });
    expect(piles).toHaveLength(1);
    expect(sourceOf(piles[0])).toBe(sent?.images[0]?.url);
    // Without a caption the list would call them by their number.
    expect(
      within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole('listitem')[0],
    ).toHaveTextContent('You: Look');
  });

  it(`takes at most ${MESSAGE_MAX_IMAGES} pictures in a message and says so`, async () => {
    signedInAs(alice);
    const withBob = seedDirect(alice.id, bob.id);
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    await screen.findByRole('log', { name: 'Conversation with Bob Brown' });

    const many = Array.from({ length: MESSAGE_MAX_IMAGES + 2 }, (_, n) => photo(`p${n}.png`));
    await user.upload(screen.getByLabelText('Attach pictures'), many);
    const refusal = `At most ${MESSAGE_MAX_IMAGES} pictures per message.`;
    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(
      within(
        await screen.findByRole('list', { name: `${MESSAGE_MAX_IMAGES} pictures to send` }),
      ).getAllByRole('img'),
    ).toHaveLength(MESSAGE_MAX_IMAGES);
  });

  it('holds the message back while one of its pictures failed, until it is retried', async () => {
    signedInAs(alice);
    const withBob = seedDirect(alice.id, bob.id);
    renderApp(`/messages/${withBob.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Conversation with Bob Brown' });
    // The second upload of the two fails once.
    let calls = 0;
    server.use(
      http.post('*/api/v1/uploads', () => {
        calls += 1;
        return calls === 2
          ? apiError(500, 'INTERNAL_ERROR', 'Storage is having a moment')
          : undefined;
      }),
    );

    await user.upload(screen.getByLabelText('Attach pictures'), [photo('a.png'), photo('b.png')]);
    const strip = await screen.findByRole('list', { name: '2 pictures to send' });
    const retry = await within(strip).findByRole('button', { name: /^Retry ?2$/ });
    expect(within(strip).getByText('Storage is having a moment')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    await user.click(retry);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(
      await within(log).findByRole('button', { name: 'Open 2 pictures sent by you' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(mockDb.messages.at(-1)?.images).toHaveLength(2));
  });
});
