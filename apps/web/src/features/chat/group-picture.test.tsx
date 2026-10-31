import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SOCKET_EVENTS } from '@beso/shared';
import { alice, bob } from '@/test/fixtures';
import { seedConversation } from '@/test/msw/db';
import { mockDb, signedInAs } from '@/test/msw/handlers';
import { renderApp } from '@/test/render';
import { fakeSocket } from '@/test/socket-mock';

const { cropImage } = vi.hoisted(() => ({
  cropImage: vi.fn(
    async (
      _src: string,
      _area: { x: number; y: number; width: number; height: number },
      _output: { width: number; height: number },
      source: { name: string },
    ) => new File(['cropped'], `cropped-${source.name}`, { type: 'image/png' }),
  ),
}));
// Canvas drawing is out of jsdom's reach; the helper has tests of its own.
vi.mock('@/features/uploads/crop-image', () => ({ cropImage }));

/** jsdom loads no picture: this stand-in reports a frame at once so "Use this" is possible. */
vi.mock('react-easy-crop', async () => {
  const { useEffect, useRef } = await import('react');
  type Area = { x: number; y: number; width: number; height: number };
  type Props = {
    cropperProps?: Record<string, unknown>;
    onCropComplete?: (area: Area, pixels: Area) => void;
    onMediaLoaded?: (size: unknown) => void;
    setCropperRef?: (ref: { current: HTMLDivElement | null }) => void;
  };
  function FakeCropper({ cropperProps, onCropComplete, onMediaLoaded, setCropperRef }: Props) {
    const frame = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
      setCropperRef?.(frame);
      onMediaLoaded?.({});
      const area = { x: 0, y: 0, width: 200, height: 200 };
      onCropComplete?.(area, area);
    }, [setCropperRef, onMediaLoaded, onCropComplete]);
    // The library's frame is a focusable div; the role and name come in through `cropperProps`.
    const frameProps = { tabIndex: 0, ...cropperProps };
    return <div role="application" {...frameProps} ref={frame} />;
  }
  return { default: FakeCropper };
});

const PICTURE = 'http://localhost/api/v1/uploads/group/0f0f0f0f-0000-7000-8000-000000000001.webp';
// The group's picture is found by its marker: its image never loads in jsdom, the frame renders.

describe('group picture', () => {
  beforeEach(() => {
    cropImage.mockClear();
  });

  it('lets an admin set the picture from the members dialog and take it away again', async () => {
    signedInAs(alice);
    const group = seedConversation('group', [alice.id, bob.id], { title: 'Trip' });
    renderApp(`/messages/${group.id}`);
    const user = userEvent.setup();
    const log = await screen.findByRole('log', { name: 'Group Trip' });
    expect(document.querySelector('[data-group-picture]')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Group members' }));
    const dialog = await screen.findByRole('dialog', { name: 'Trip' });
    const file = new File(['pixels'], 'trip.png', { type: 'image/png' });
    await user.upload(within(dialog).getByLabelText('Choose group picture'), file);
    // The file goes through the cropper in the avatar's frame first.
    await within(dialog).findByRole('application', { name: 'Group picture position' });
    expect(mockDb.uploads).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'Use this' }));

    await waitFor(() => expect(mockDb.uploads).toBe(1));
    expect(cropImage).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      { width: 512, height: 512 },
      file,
    );
    expect(mockDb.lastUpload).toMatchObject({ name: 'cropped-trip.png', type: 'image/png' });
    // The upload is set on the group as soon as it is done, with no Save button.
    await waitFor(() => expect(group.pictureUrl).toMatch(/\/uploads\/group\//));
    await waitFor(() => expect(document.querySelector('[data-group-picture]')).toBeInTheDocument());
    expect(
      within(dialog).getByRole('button', { name: 'Change group picture' }),
    ).toBeInTheDocument();
    // The server's line reaches the thread like any message.
    act(() => fakeSocket.serverEmit(SOCKET_EVENTS.messageNew, mockDb.messages.at(-1)));
    expect(await within(log).findByText('You changed the group picture')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Remove group picture' }));
    await waitFor(() => expect(group.pictureUrl).toBeNull());
    await waitFor(() =>
      expect(document.querySelector('[data-group-picture]')).not.toBeInTheDocument(),
    );
    expect(
      await within(dialog).findByRole('button', { name: 'Upload group picture' }),
    ).toBeInTheDocument();
    act(() => fakeSocket.serverEmit(SOCKET_EVENTS.messageNew, mockDb.messages.at(-1)));
    expect(await within(log).findByText('You removed the group picture')).toBeInTheDocument();
  });

  it('shows a group picture to members without offering to change it', async () => {
    signedInAs(alice);
    const group = seedConversation('group', [bob.id, alice.id], {
      title: 'Trip',
      createdById: bob.id,
      pictureUrl: PICTURE,
    });
    renderApp(`/messages/${group.id}`);
    const user = userEvent.setup();
    await screen.findByRole('log', { name: 'Group Trip' });
    expect(document.querySelector('[data-group-picture]')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Group members' }));
    const dialog = await screen.findByRole('dialog', { name: 'Trip' });
    expect(within(dialog).queryByRole('button', { name: /group picture/i })).toBeNull();
    expect(within(dialog).queryByLabelText('Choose group picture')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename group' })).toBeNull();
  });
});
