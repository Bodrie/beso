const SIZE = 2;
const EMOJI_FONTS =
  "'Apple Color Emoji', 'Noto Color Emoji', 'Twemoji Mozilla', 'Android Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', EmojiSymbols, sans-serif";

let context: CanvasRenderingContext2D | null | undefined;

function canvas(): CanvasRenderingContext2D | null {
  if (context === undefined) {
    try {
      context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    } catch {
      context = null;
    }
  }
  return context;
}

/**
 * Whether the browser draws `emoji` as one colour glyph: the canvas check emoji pickers share.
 * Drawn twice in different fill colours on a 2 px canvas: a colour emoji ignores the fill and
 * both draws match; text (a missing glyph's box, a black-and-white presentation) takes the fill
 * and they differ; a sequence the font does not know falls apart into several glyphs, which the
 * width gives away. Without a canvas (jsdom, a blocked context) everything counts as drawn, so
 * the picker shows the whole set rather than nothing.
 */
export function drawsAsEmoji(emoji: string): boolean {
  const ctx = canvas();
  if (!ctx) return true;
  ctx.canvas.width = SIZE;
  ctx.canvas.height = SIZE;
  ctx.font = `${SIZE}px ${EMOJI_FONTS}`;
  ctx.textBaseline = 'middle';
  if (ctx.measureText(emoji).width >= SIZE * 2) return false;
  const draw = (fill: string): Uint8ClampedArray => {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = fill;
    ctx.fillText(emoji, 0, 0);
    return ctx.getImageData(0, 0, SIZE, SIZE).data;
  };
  const blue = draw('#00f');
  const red = draw('#f00');
  return blue.every((value, index) => value === red[index]);
}
