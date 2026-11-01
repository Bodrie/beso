/** A region of the source picture in its own pixels, as the cropper reports it. */
export type CropArea = { x: number; y: number; width: number; height: number };

/** The largest output the caller wants; the API resizes to its preset anyway. */
export type CropOutput = { width: number; height: number };

const JPEG_QUALITY = 0.92;
/** Zoom 1 covers the frame; below it the picture sits inside the frame with room around it. */
export const COVER_ZOOM = 1;
const LEAST_ZOOM = 0.1;
/** The backdrop overshoots the canvas so the soft edges of its blur stay out of view. */
const BACKDROP_OVERSHOOT = 1.1;
const BACKDROP_DIM = 'rgba(0, 0, 0, 0.35)';

/**
 * The cropper's zoom at which the whole picture sits inside a frame of these proportions
 * (1 when the two match: the picture then covers the frame exactly), rounded down so the
 * picture stays entirely inside. A picture whose size is not known yet keeps the cover zoom.
 */
export function fitZoom(
  frame: CropOutput,
  media: { naturalWidth?: number; naturalHeight?: number },
): number {
  const picture = (media.naturalWidth ?? 0) / (media.naturalHeight ?? 0);
  const box = frame.width / frame.height;
  if (!Number.isFinite(picture) || picture <= 0) return COVER_ZOOM;
  const fit = Math.min(box / picture, picture / box);
  return Math.max(LEAST_ZOOM, Math.min(COVER_ZOOM, Math.floor(fit * 100) / 100));
}

/**
 * What shows around a picture zoomed out to fit (or dragged off the frame): a blurred, dimmed
 * copy of the whole picture covering the canvas, as photo apps do, so the output is always a
 * full frame and a JPEG needs no alpha. Older Safari has no canvas filter; the copy then stays
 * sharp, and the dimming still keeps it in the background.
 */
function drawBackdrop(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
): void {
  const cover =
    Math.max(width / image.naturalWidth, height / image.naturalHeight) * BACKDROP_OVERSHOOT;
  const coverWidth = Math.round(image.naturalWidth * cover);
  const coverHeight = Math.round(image.naturalHeight * cover);
  context.save();
  if ('filter' in context) context.filter = `blur(${Math.round(Math.max(width, height) / 40)}px)`;
  context.drawImage(
    image,
    Math.round((width - coverWidth) / 2),
    Math.round((height - coverHeight) / 2),
    coverWidth,
    coverHeight,
  );
  context.restore();
  context.fillStyle = BACKDROP_DIM;
  context.fillRect(0, 0, width, height);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener('error', () => reject(new Error('The picture could not be read')), {
      once: true,
    });
    image.src = src;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, JPEG_QUALITY);
  });
}

function renamed(name: string, type: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'picture';
  return `${base}.${type === 'image/jpeg' ? 'jpg' : 'png'}`;
}

/**
 * Draws `area` of the picture at `src` onto a canvas and hands it back as a file for the upload.
 * The result is scaled down to fit `output` (never up: a small source stays small and the API
 * enlarges it as it does today). An area reaching past the picture (the member zoomed out to
 * fit it) is completed with a blurred copy of the picture. JPEG sources stay JPEG; anything
 * else becomes PNG so an alpha channel survives. Browsers orient the picture by its EXIF both
 * when showing it and when drawing it, so the area the member framed is the area drawn.
 */
export async function cropImage(
  src: string,
  area: CropArea,
  output: CropOutput,
  source: Pick<File, 'name' | 'type'>,
): Promise<File> {
  const image = await loadImage(src);
  const scale = Math.min(1, output.width / area.width, output.height / area.height);
  const width = Math.max(1, Math.round(area.width * scale));
  const height = Math.max(1, Math.round(area.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The picture could not be drawn');
  context.imageSmoothingQuality = 'high';
  const inside =
    area.x >= 0 &&
    area.y >= 0 &&
    area.x + area.width <= image.naturalWidth &&
    area.y + area.height <= image.naturalHeight;
  if (inside) {
    context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, width, height);
  } else {
    // Zoomed out, or dragged off the frame: the picture covers only part of the area. The
    // backdrop takes the rest, and the part it does cover lands where it sits in the frame.
    drawBackdrop(context, image, width, height);
    const left = Math.max(0, area.x);
    const top = Math.max(0, area.y);
    const right = Math.min(image.naturalWidth, area.x + area.width);
    const bottom = Math.min(image.naturalHeight, area.y + area.height);
    if (right > left && bottom > top) {
      const scaleX = width / area.width;
      const scaleY = height / area.height;
      context.drawImage(
        image,
        left,
        top,
        right - left,
        bottom - top,
        (left - area.x) * scaleX,
        (top - area.y) * scaleY,
        (right - left) * scaleX,
        (bottom - top) * scaleY,
      );
    }
  }

  const blob = await toBlob(canvas, source.type === 'image/jpeg' ? 'image/jpeg' : 'image/png');
  if (!blob) throw new Error('The picture could not be encoded');
  return new File([blob], renamed(source.name, blob.type), { type: blob.type });
}
