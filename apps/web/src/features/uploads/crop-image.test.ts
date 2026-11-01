import { cropImage, fitZoom } from './crop-image';

/** jsdom loads no pictures: a stand-in that "loads" as soon as it gets a source. */
class FakeImage extends EventTarget {
  static fails = false;
  /** Large enough for the framed areas below, unless a test shrinks it. */
  static size = { width: 4000, height: 1500 };
  naturalWidth = FakeImage.size.width;
  naturalHeight = FakeImage.size.height;
  #src = '';
  get src() {
    return this.#src;
  }
  set src(value: string) {
    this.#src = value;
    queueMicrotask(() => this.dispatchEvent(new Event(FakeImage.fails ? 'error' : 'load')));
  }
}

const drawImage = vi.fn();
const fillRect = vi.fn();
const context = {
  drawImage,
  fillRect,
  save: vi.fn(),
  restore: vi.fn(),
  filter: 'none',
  fillStyle: '',
  imageSmoothingQuality: 'low',
};

beforeEach(() => {
  FakeImage.fails = false;
  FakeImage.size = { width: 4000, height: 1500 };
  drawImage.mockClear();
  fillRect.mockClear();
  context.filter = 'none';
  context.fillStyle = '';
  context.imageSmoothingQuality = 'low';
  vi.stubGlobal('Image', FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- jsdom draws nothing; the helper only needs these two members
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
  ) {
    callback(new Blob([`${this.width}x${this.height}`], { type: type ?? 'image/png' }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cropImage', () => {
  it('draws the framed area scaled down to the output and keeps a JPEG a JPEG', async () => {
    const file = await cropImage(
      'blob:picture',
      { x: 100, y: 50, width: 3600, height: 1200 },
      { width: 1800, height: 600 },
      { name: 'holiday.jpeg', type: 'image/jpeg' },
    );

    expect(drawImage).toHaveBeenCalledWith(
      expect.any(FakeImage),
      100,
      50,
      3600,
      1200,
      0,
      0,
      1800,
      600,
    );
    expect(context.imageSmoothingQuality).toBe('high');
    expect(file.name).toBe('holiday.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(await file.text()).toBe('1800x600');
  });

  it('never enlarges a small area and turns other formats into PNG', async () => {
    const file = await cropImage(
      'blob:picture',
      { x: 0, y: 0, width: 300, height: 100 },
      { width: 1800, height: 600 },
      { name: 'me.webp', type: 'image/webp' },
    );

    expect(drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 0, 300, 100, 0, 0, 300, 100);
    expect(file.name).toBe('me.png');
    expect(file.type).toBe('image/png');
    expect(await file.text()).toBe('300x100');
  });

  it('fills the room around a picture zoomed out to fit with a blurred, dimmed copy of it', async () => {
    FakeImage.size = { width: 1200, height: 400 };
    const file = await cropImage(
      'blob:picture',
      // Twice the picture in both directions, centred: the member zoomed out past the frame.
      { x: -600, y: -300, width: 2400, height: 1200 },
      { width: 1800, height: 600 },
      { name: 'wide.jpg', type: 'image/jpeg' },
    );

    // The backdrop: the whole picture scaled to cover the 1200×600 canvas with some overshoot.
    expect(drawImage).toHaveBeenNthCalledWith(1, expect.any(FakeImage), -390, -30, 1980, 660);
    expect(context.filter).toBe('blur(30px)');
    expect(context.fillStyle).toBe('rgba(0, 0, 0, 0.35)');
    expect(fillRect).toHaveBeenCalledWith(0, 0, 1200, 600);
    // The picture itself, whole, in the middle of the frame at the area's scale.
    expect(drawImage).toHaveBeenNthCalledWith(
      2,
      expect.any(FakeImage),
      0,
      0,
      1200,
      400,
      300,
      150,
      600,
      200,
    );
    expect(file.type).toBe('image/jpeg');
    expect(await file.text()).toBe('1200x600');
  });

  it('rejects a picture the browser cannot read', async () => {
    FakeImage.fails = true;
    await expect(
      cropImage(
        'blob:broken',
        { x: 0, y: 0, width: 10, height: 10 },
        { width: 512, height: 512 },
        { name: 'x.png', type: 'image/png' },
      ),
    ).rejects.toThrow('could not be read');
    expect(drawImage).not.toHaveBeenCalled();
  });
});

describe('fitZoom', () => {
  it('is the zoom at which the whole picture sits inside the frame, rounded down, 1 when it covers it', () => {
    const square = { width: 512, height: 512 };
    const wide = { width: 1800, height: 600 };
    expect(fitZoom(square, { naturalWidth: 1200, naturalHeight: 400 })).toBe(0.33);
    expect(fitZoom(square, { naturalWidth: 400, naturalHeight: 1200 })).toBe(0.33);
    expect(fitZoom(wide, { naturalWidth: 1200, naturalHeight: 400 })).toBe(1);
    expect(fitZoom(wide, { naturalWidth: 1000, naturalHeight: 1000 })).toBe(0.33);
    expect(fitZoom(square, { naturalWidth: 800, naturalHeight: 800 })).toBe(1);
    // Not measured yet, or nonsense: no zooming out.
    expect(fitZoom(square, {})).toBe(1);
    expect(fitZoom(square, { naturalWidth: 0, naturalHeight: 10 })).toBe(1);
    // Never below a tenth, however thin the picture.
    expect(fitZoom(square, { naturalWidth: 10_000, naturalHeight: 10 })).toBe(0.1);
  });
});
