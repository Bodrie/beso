import 'react-easy-crop/react-easy-crop.css';
import { PROFILE_PICTURE_SIZES, type ProfilePictureKind } from '@beso/shared';
import { cn } from 'cn';
import { MinusIcon, PlusIcon } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useId, useState } from 'react';
import Cropper, { type Area, type MediaSize, type Point } from 'react-easy-crop';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { COVER_ZOOM, cropImage, fitZoom } from './crop-image';

type ImageCropperProps = {
  kind: ProfilePictureKind;
  /** What the field is called in the form ("Avatar", "Cover"); names the cropping area. */
  label: string;
  file: File;
  /** An object URL of `file`, owned by the caller. */
  src: string;
  onConfirm: (file: File) => void;
  onCancel: () => void;
};

const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
/** Pixels per arrow key; Shift makes it a fifth of that. */
const KEYBOARD_STEP = 10;

const clampZoom = (zoom: number, min: number) => Math.min(MAX_ZOOM, Math.max(min, zoom));

/**
 * Lets the member frame a profile picture before it is uploaded: the frame has the ratio the
 * page shows (round for the avatar, 3:1 for the cover), the picture fills it at zoom 1 and can be
 * dragged, nudged with the arrow keys and zoomed by wheel, pinch, the slider or the buttons.
 * Zooming out below 1 (down to "Fit", where the whole picture is inside the frame) leaves room
 * around the picture, which `cropImage` fills with a blurred copy of it. "Use this" draws the
 * framed area to a canvas and hands the file over. Loaded lazily by `ImageField`, so the
 * dialog's first paint carries none of it.
 */
export default function ImageCropper({
  kind,
  label,
  file,
  src,
  onConfirm,
  onCancel,
}: ImageCropperProps) {
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(COVER_ZOOM);
  // Where the whole picture fits inside the frame; known once the picture is measured.
  const [minZoom, setMinZoom] = useState(COVER_ZOOM);
  const [area, setArea] = useState<Area | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The library's own ref to its focusable frame, handed over at mount. */
  const [frame, setFrame] = useState<RefObject<HTMLDivElement | null> | null>(null);
  const hintId = useId();
  const size = PROFILE_PICTURE_SIZES[kind];
  const isCover = kind === 'cover';

  // The focusable frame exists only once the picture's size is known; move focus to it then,
  // the button that opened the file picker is gone.
  useEffect(() => {
    if (loaded) frame?.current?.focus();
  }, [loaded, frame]);

  // Stable callbacks: the cropper compares its props on every update.
  const handleCropComplete = useCallback((_: Area, pixels: Area) => setArea(pixels), []);
  const handleMediaLoaded = useCallback(
    (media: MediaSize) => {
      setMinZoom(fitZoom(size, media));
      setLoaded(true);
    },
    [size],
  );
  const fit = () => {
    setZoom(minZoom);
    setCrop({ x: 0, y: 0 });
  };

  const confirm = async () => {
    if (!area) return;
    setBusy(true);
    try {
      onConfirm(await cropImage(src, area, size, file));
    } catch {
      setBusy(false);
      toast.error('The picture could not be cropped. Try another file.');
    }
  };

  return (
    <div className="space-y-3">
      <div
        className={cn(
          'bg-muted relative w-full overflow-hidden rounded-lg border',
          isCover ? 'aspect-[2/1]' : 'h-64',
        )}
      >
        <Cropper
          image={src}
          crop={crop}
          zoom={zoom}
          aspect={size.width / size.height}
          cropShape={isCover ? 'rect' : 'round'}
          objectFit="cover"
          showGrid={false}
          minZoom={minZoom}
          maxZoom={MAX_ZOOM}
          zoomSpeed={0.5}
          keyboardStep={KEYBOARD_STEP}
          // Covering the frame, the picture may not leave a gap; inside it, it goes anywhere.
          restrictPosition={zoom >= COVER_ZOOM}
          disableAutomaticStylesInjection
          onCropChange={setCrop}
          onZoomChange={(next) => setZoom(clampZoom(next, minZoom))}
          onCropComplete={handleCropComplete}
          onMediaLoaded={handleMediaLoaded}
          setCropperRef={setFrame}
          cropperProps={{
            role: 'application',
            'aria-label': `${label} position`,
            'aria-describedby': hintId,
          }}
        />
      </div>
      <p id={hintId} className="text-muted-foreground text-sm">
        Drag or use the arrow keys to move the picture; pinch, scroll or use the buttons to zoom.
        Zoomed out past the frame, the room around the picture is filled with a blurred copy.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Zoom out"
          disabled={zoom <= minZoom}
          onClick={() => setZoom((current) => clampZoom(current - ZOOM_STEP, minZoom))}
        >
          <MinusIcon aria-hidden="true" />
        </Button>
        <input
          type="range"
          aria-label="Zoom"
          min={minZoom}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          onChange={(event) => setZoom(clampZoom(Number(event.target.value), minZoom))}
          className="accent-primary w-28"
        />
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Zoom in"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => setZoom((current) => clampZoom(current + ZOOM_STEP, minZoom))}
        >
          <PlusIcon aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Fit the whole picture"
          // Nothing to fit when the picture has the frame's proportions, or it fits already.
          disabled={minZoom >= COVER_ZOOM || zoom <= minZoom}
          onClick={fit}
        >
          Fit
        </Button>
        <div className="ms-auto flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Discard
          </Button>
          <Button type="button" size="sm" disabled={!area || busy} onClick={() => void confirm()}>
            {busy ? 'Cropping…' : 'Use this'}
          </Button>
        </div>
      </div>
    </div>
  );
}
