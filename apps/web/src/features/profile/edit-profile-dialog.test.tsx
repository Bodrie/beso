import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { alice } from '@/test/fixtures';
import { mockDb, signedInAs } from '@/test/msw/handlers';
import { renderApp } from '@/test/render';

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
// Canvas drawing is out of jsdom's reach; the helper has tests of its own. The rest of the
// module (the fit zoom) is real.
vi.mock('@/features/uploads/crop-image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/uploads/crop-image')>()),
  cropImage,
}));

/**
 * jsdom never loads the picture, so the real cropper would never measure it. This stand-in
 * keeps the contract `ImageCropper` relies on: it reports the frame once "loaded" and after
 * every move or zoom (mapped to pixels of a 1200×400 picture shown at 600×200), moves on the
 * arrow keys by `keyboardStep`, and hands its focusable frame back through `setCropperRef`.
 */
vi.mock('react-easy-crop', async () => {
  const { useEffect, useRef } = await import('react');
  type Point = { x: number; y: number };
  type Area = { x: number; y: number; width: number; height: number };
  type Props = {
    crop: Point;
    zoom: number;
    keyboardStep?: number;
    cropperProps?: Record<string, unknown>;
    onCropChange: (crop: Point) => void;
    onCropComplete?: (area: Area, pixels: Area) => void;
    onMediaLoaded?: (size: unknown) => void;
    setCropperRef?: (ref: { current: HTMLDivElement | null }) => void;
  };
  function FakeCropper({
    crop,
    zoom,
    keyboardStep = 1,
    cropperProps,
    onCropChange,
    onCropComplete,
    onMediaLoaded,
    setCropperRef,
  }: Props) {
    const frame = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
      setCropperRef?.(frame);
      // A 3:1 picture: it covers the cover's frame exactly and fits a third of the way into the avatar's.
      onMediaLoaded?.({ naturalWidth: 1200, naturalHeight: 400 });
    }, [setCropperRef, onMediaLoaded]);
    useEffect(() => {
      const width = Math.round(600 / zoom);
      const height = Math.round(200 / zoom);
      const area = { x: 300 - crop.x - width / 2, y: 100 - crop.y - height / 2, width, height };
      onCropComplete?.(area, area);
    }, [crop.x, crop.y, zoom, onCropComplete]);
    // The library's frame is a focusable div; the role and name come in through `cropperProps`.
    const frameProps = { tabIndex: 0, ...cropperProps };
    return (
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- an `application` frame that takes the arrow keys, exactly as the library's does
      <div
        role="application"
        {...frameProps}
        ref={frame}
        data-zoom={zoom}
        onKeyDown={(event) => {
          const next = { ...crop };
          if (event.key === 'ArrowLeft') next.x -= keyboardStep;
          else if (event.key === 'ArrowRight') next.x += keyboardStep;
          else if (event.key === 'ArrowUp') next.y -= keyboardStep;
          else if (event.key === 'ArrowDown') next.y += keyboardStep;
          else return;
          onCropChange(next);
        }}
      />
    );
  }
  return { default: FakeCropper };
});

async function openDialog() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
  return { user, dialog: await screen.findByRole('dialog', { name: 'Edit profile' }) };
}

describe('EditProfileDialog', () => {
  beforeEach(() => {
    cropImage.mockClear();
  });

  it('saves changed fields and shows them on the profile', async () => {
    signedInAs(alice);
    renderApp('/u/alice');
    const { user, dialog } = await openDialog();

    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Alice A.');
    await user.type(within(dialog).getByLabelText('Bio'), 'Hello from the tests');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Profile updated')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Alice A.' })).toBeInTheDocument();
    expect(screen.getByText('Hello from the tests')).toBeInTheDocument();
    expect(mockDb.user).toMatchObject({
      name: 'Alice A.',
      bio: 'Hello from the tests',
      city: 'Sofia',
    });
  });

  it('moves to the new address when the username changes', async () => {
    signedInAs(alice);
    renderApp('/u/alice');
    const { user, dialog } = await openDialog();

    await user.clear(within(dialog).getByLabelText('Username'));
    await user.type(within(dialog).getByLabelText('Username'), 'alice_new');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByText('@alice_new')).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('attaches server conflicts to the field', async () => {
    signedInAs(alice);
    renderApp('/u/alice');
    const { user, dialog } = await openDialog();

    await user.clear(within(dialog).getByLabelText('Username'));
    await user.type(within(dialog).getByLabelText('Username'), 'bob');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(await within(dialog).findByText('This username is taken')).toBeInTheDocument();
  });

  it('frames a new avatar with the keyboard and the zoom buttons, uploads the crop, sends its key', async () => {
    signedInAs(alice);
    renderApp('/u/alice');
    const { user, dialog } = await openDialog();

    const file = new File(['png-bytes'], 'me.png', { type: 'image/png' });
    await user.upload(within(dialog).getByLabelText('Choose avatar'), file);
    const frame = await within(dialog).findByRole('application', { name: 'Avatar position' });
    await waitFor(() => expect(frame).toHaveFocus());
    expect(mockDb.uploads).toBe(0);

    await user.keyboard('{ArrowRight}{ArrowRight}');
    await user.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    expect(frame).toHaveAttribute('data-zoom', '1.25');
    await user.click(within(dialog).getByRole('button', { name: 'Use this' }));

    await waitFor(() => expect(mockDb.uploads).toBe(1));
    // Two nudges of 10px to the right and one zoom step, as the stand-in maps them to pixels.
    expect(cropImage).toHaveBeenCalledWith(
      expect.stringMatching(/^blob:/),
      { x: 40, y: 20, width: 480, height: 160 },
      { width: 512, height: 512 },
      file,
    );
    expect(mockDb.lastUpload).toMatchObject({ name: 'cropped-me.png', type: 'image/png' });
    expect(within(dialog).queryByRole('application')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Change avatar' })).toHaveFocus(),
    );

    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockDb.user?.avatarUrl).toMatch(/uploads\/avatar\//));
    expect(await screen.findByText('Profile updated')).toBeInTheDocument();
  });

  it('zooms out to fit the whole picture inside the frame', async () => {
    signedInAs(alice);
    renderApp('/u/alice');
    const { user, dialog } = await openDialog();

    const file = new File(['png-bytes'], 'wide.png', { type: 'image/png' });
    await user.upload(within(dialog).getByLabelText('Choose avatar'), file);
    const frame = await within(dialog).findByRole('application', { name: 'Avatar position' });
    // A 3:1 picture in a square frame: "Fit" zooms out to a third, and that is as far as it goes.
    await user.click(within(dialog).getByRole('button', { name: 'Fit the whole picture' }));
    expect(frame).toHaveAttribute('data-zoom', '0.33');
    expect(within(dialog).getByRole('slider', { name: 'Zoom' })).toHaveAttribute('min', '0.33');
    expect(within(dialog).getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Fit the whole picture' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Use this' }));

    await waitFor(() => expect(mockDb.uploads).toBe(1));
    // The framed area reaches past the picture on every side; the helper fills what it leaves bare.
    expect(cropImage).toHaveBeenLastCalledWith(
      expect.any(String),
      { x: -609, y: -203, width: 1818, height: 606 },
      { width: 512, height: 512 },
      file,
    );
  });

  it('frames the cover at 3:1', async () => {
    signedInAs(alice);
    renderApp('/u/alice');
    const { user, dialog } = await openDialog();

    const file = new File(['jpeg-bytes'], 'beach.jpg', { type: 'image/jpeg' });
    await user.upload(within(dialog).getByLabelText('Choose cover'), file);
    await within(dialog).findByRole('application', { name: 'Cover position' });
    await user.click(within(dialog).getByRole('button', { name: 'Use this' }));

    await waitFor(() => expect(mockDb.uploads).toBe(1));
    expect(cropImage).toHaveBeenLastCalledWith(
      expect.any(String),
      { x: 0, y: 0, width: 600, height: 200 },
      { width: 1800, height: 600 },
      file,
    );
    expect(mockDb.lastUpload?.name).toBe('cropped-beach.jpg');
  });

  it('cancelling the cropper keeps the current picture and uploads nothing', async () => {
    const avatarUrl =
      'http://localhost/api/v1/uploads/avatar/0f0f0f0f-0000-7000-8000-000000000001.webp';
    signedInAs(alice).avatarUrl = avatarUrl;
    renderApp('/u/alice');
    const { user, dialog } = await openDialog();

    const file = new File(['png-bytes'], 'other.png', { type: 'image/png' });
    await user.upload(within(dialog).getByLabelText('Choose avatar'), file);
    await within(dialog).findByRole('application', { name: 'Avatar position' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));

    const change = await within(dialog).findByRole('button', { name: 'Change avatar' });
    await waitFor(() => expect(change).toHaveFocus());
    expect(dialog.querySelector(`img[src="${avatarUrl}"]`)).toBeInTheDocument();
    expect(mockDb.uploads).toBe(0);
    expect(cropImage).not.toHaveBeenCalled();
  });

  it('refuses a file of the wrong type before the cropper opens', async () => {
    signedInAs(alice);
    renderApp('/u/alice');
    const user = userEvent.setup({ applyAccept: false });
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit profile' });

    const file = new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' });
    await user.upload(within(dialog).getByLabelText('Choose avatar'), file);

    expect(
      await screen.findByText('Choose a JPEG, PNG, WebP, GIF or AVIF image.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('application')).not.toBeInTheDocument();
  });

  it('closes without a request when nothing changed', async () => {
    signedInAs(alice);
    renderApp('/u/alice');
    const { user, dialog } = await openDialog();
    const before = mockDb.user?.updatedAt;

    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockDb.user?.updatedAt).toBe(before);
  });
});
