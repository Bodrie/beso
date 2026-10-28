/**
 * The one source of the brand drawing. `pnpm brand` writes:
 *   - apps/web/src/components/logo-paths.ts: the wordmark "Be•So" as SVG paths;
 *   - apps/web/public/favicon.ico (16/32/48), icon.svg (follows the tab's theme),
 *     apple-touch-icon.png (180, white on the accent), the installed app's icons for
 *     manifest.webmanifest (icon-192.png, icon-512.png, icon-maskable-512.png with the icon inside
 *     the safe circle) and badge-96.png (white on nothing: Android's status bar icon for a push
 *     notification), all of them the open o;
 *   - apps/web/public/mail-logo.png: the wordmark on a white tile, the picture every mail shows
 *     in its header (hosted by the web app, see apps/api/src/email/brand.ts), and
 *     apps/api/src/email/mail-logo.ts with its path and CSS size.
 * Rendering uses the API's `sharp`; the generated modules go through Prettier, so the tree
 * stays clean. `--preview <file.png>` also writes a sheet with the wordmark on both themes and
 * the icons.
 */
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'apps/api/package.json'));
const sharp = require('sharp');

const webPublic = path.join(root, 'apps/web/public');
const webPaths = path.join(root, 'apps/web/src/components/logo-paths.ts');
const mailPng = path.join(webPublic, 'mail-logo.png');
const emailModule = path.join(root, 'apps/api/src/email/mail-logo.ts');
const previewArg = process.argv.indexOf('--preview');
const preview = previewArg === -1 ? null : process.argv[previewArg + 1];

// The accent is the web's `--primary` in both themes; the foregrounds are `--foreground`.
const ACCENT = '#006aaf';
const ACCENT_DARK = '#4bc6fa';
const FG = '#121921';
const FG_DARK = '#e4e8ed';
const MAIL_TEXT = '#1c2330';

/**
 * The wordmark, "Be•So", is drawn rather than set (the owner's reference, 2026-10-22, was a
 * rounded monoline logotype): one even stroke with round ends, letters built from circles.
 * Everything is a centre line on a 48-tall box. The outer edges of the letters stand on y = 42;
 * the lowercase bowls reach up to 18, the capitals to 6. "Be" takes the text colour, "So" and
 * the dot the accent. The o is open: its top-right quarter breaks off and floats outward. That
 * o on its own is the icon.
 */
const STROKE = 4.05;
/** Space between two letters, outer edge to outer edge. */
const GAP = 4.8;

const f = (n) => Number(n.toFixed(2));
const at = (cx, cy, r, deg) => [
  f(cx + r * Math.cos((deg * Math.PI) / 180)),
  f(cy + r * Math.sin((deg * Math.PI) / 180)),
];
const circle = (cx, cy, r) =>
  `M${f(cx - r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)} Z`;

/** B: a stem and two bowls, the lower one larger; the bowls' straight runs make it as wide as the e. */
function letterB(x, top, base) {
  const middle = top + 0.47 * (base - top);
  const r1 = (middle - top) / 2;
  const r2 = (base - middle) / 2;
  const x1 = x + 8;
  const x2 = x + 9.5;
  return {
    d: `M${f(x)} ${f(top)} V${f(base)} M${f(x)} ${f(top)} H${f(x1)} A${f(r1)} ${f(r1)} 0 0 1 ${f(x1)} ${f(middle)} H${f(x)} M${f(x1)} ${f(middle)} H${f(x2)} A${f(r2)} ${f(r2)} 0 0 1 ${f(x2)} ${f(base)} H${f(x)}`,
    right: x2 + r2,
  };
}

/** The open o: the circle without its top-right quarter, which floats outward on a wider one. */
function openO(cx, cy, r, stroke) {
  const [a1x, a1y] = at(cx, cy, r, -100);
  const [a2x, a2y] = at(cx, cy, r, 2);
  const R = r + stroke + (1.6 * r) / 9.7;
  const [b1x, b1y] = at(cx, cy, R, -68);
  const [b2x, b2y] = at(cx, cy, R, -24);
  return {
    d: `M${a1x} ${a1y} A${f(r)} ${f(r)} 0 1 0 ${a2x} ${a2y} M${b1x} ${b1y} A${f(R)} ${f(R)} 0 0 1 ${b2x} ${b2y}`,
    right: Math.max(cx + r, b2x),
  };
}

function drawWordmark() {
  const s = STROKE;
  const r = (24 - s) / 2; // a lowercase bowl's outer edge spans the x-height
  const base = 42 - s / 2;
  const cy = base - r;
  const top = 6 + s / 2;
  const H = base - top;

  const B = letterB(s / 2 + 0.5, top, base);
  let right = B.right + s / 2;

  // e: a bar across the middle, then over the top and round to an open end at the lower right.
  const ecx = right + GAP + r + s / 2;
  const [ex, ey] = at(ecx, cy, r, 38);
  const E = `M${f(ecx - r)} ${f(cy)} H${f(ecx + r)} A${f(r)} ${f(r)} 0 1 0 ${ex} ${ey}`;
  right = ecx + r + s / 2;

  // The dot, a little wider than the stroke, in line with the bar of the e.
  const dotR = 0.75 * s;
  const dcx = right + GAP + dotR;
  const dot = circle(dcx, cy, dotR);
  right = dcx + dotR;

  // S: two arcs meeting on the centre line, the lower one larger.
  const rt = (0.47 * H) / 2;
  const rb = H / 2 - rt;
  const scx = right + GAP + rb + s / 2 + 0.4;
  const [sx, sy] = at(scx, top + rt, rt, -30);
  const [tx, ty] = at(scx, base - rb, rb, 150);
  const S = `M${sx} ${sy} A${f(rt)} ${f(rt)} 0 1 0 ${f(scx)} ${f(top + 2 * rt)} A${f(rb)} ${f(rb)} 0 1 1 ${tx} ${ty}`;
  right = scx + rb + s / 2;

  const O = openO(right + GAP + r + s / 2 - 0.4, cy, r, s);
  return {
    width: Math.ceil(O.right + s / 2 + 0.5),
    be: `${B.d} ${E}`,
    so: `${S} ${O.d}`,
    dot,
  };
}

const WORDMARK = drawWordmark();
const wordmarkPaths = ({ text, accent }) =>
  `<g fill="none" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"><path d="${WORDMARK.be}" stroke="${text}"/><path d="${WORDMARK.so}" stroke="${accent}"/></g><path d="${WORDMARK.dot}" fill="${accent}"/>`;
const wordmarkSvg = (colors, background = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WORDMARK.width} 48">${background}${wordmarkPaths(colors)}</svg>`;

/**
 * The icon: the open o alone on a 48×48 canvas. Its gap is worked out for the stroke it is drawn
 * with, so the bolder small sizes keep the broken-off piece apart.
 */
const iconPath = (stroke) => openO(21.5, 26.5, 12.5, stroke).d;
const iconSvg = ({ color, stroke }, background = '', scale = 1) => {
  const offset = f(24 - 24 * scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${background}<g transform="translate(${offset} ${offset}) scale(${scale})"><path d="${iconPath(stroke)}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
};

const png = (svg, size) =>
  sharp(Buffer.from(svg), { density: 600 }).resize(size, size).png().toBuffer();
/** The generated modules go through Prettier (root config), so `pnpm brand` leaves a clean tree. */
const writeModule = async (file, code) =>
  writeFile(
    file,
    await prettier.format(code, { ...(await prettier.resolveConfig(file)), filepath: file }),
  );

// The web component reads the same paths.
await writeModule(
  webPaths,
  `// Generated by scripts/brand-assets.mjs (\`pnpm brand\`); do not edit by hand.\n\n/**\n * "Be•So" as centre lines on a 48-tall box (outer edges: capitals 6..42, lowercase 18..42),\n * drawn with a round stroke \`strokeWidth\` wide; the dot is a fill.\n */\nexport const WORDMARK = {\n  viewBox: '0 0 ${WORDMARK.width} 48',\n  strokeWidth: ${STROKE},\n  be: '${WORDMARK.be}',\n  so: '${WORDMARK.so}',\n  dot: '${WORDMARK.dot}',\n} as const;\n`,
);

// favicon.ico: the open o in the accent, bolder at the small sizes.
const sizes = [16, 32, 48];
const pngs = await Promise.all(
  sizes.map((size) =>
    png(iconSvg({ color: ACCENT, stroke: size === 16 ? 7 : size === 32 ? 6 : 5.5 }), size),
  ),
);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const directory = sizes.map((size, index) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size, 0);
  entry.writeUInt8(size, 1);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngs[index].length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += pngs[index].length;
  return entry;
});
await writeFile(
  path.join(webPublic, 'favicon.ico'),
  Buffer.concat([header, ...directory, ...pngs]),
);

// icon.svg follows the tab bar's theme; the touch icon is opaque: white on the accent.
await writeFile(
  path.join(webPublic, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><style>.o{stroke:${ACCENT}}@media (prefers-color-scheme:dark){.o{stroke:${ACCENT_DARK}}}</style><path class="o" d="${iconPath(5.5)}" fill="none" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/></svg>\n`,
);
const onAccent = `<rect width="48" height="48" fill="${ACCENT}"/>`;
await writeFile(
  path.join(webPublic, 'apple-touch-icon.png'),
  await png(iconSvg({ color: '#ffffff', stroke: 5.5 }, onAccent, 0.8), 180),
);

// The installed app (manifest.webmanifest): the touch icon's look at the sizes stores and
// launchers ask for. A maskable icon may be cut to any shape down to the inner 80 % circle, so
// its o is drawn at 60 % around the centre, with a bolder line so it does not thin out.
await writeFile(
  path.join(webPublic, 'icon-192.png'),
  await png(iconSvg({ color: '#ffffff', stroke: 5.5 }, onAccent, 0.8), 192),
);
await writeFile(
  path.join(webPublic, 'icon-512.png'),
  await png(iconSvg({ color: '#ffffff', stroke: 5.5 }, onAccent, 0.8), 512),
);
await writeFile(
  path.join(webPublic, 'icon-maskable-512.png'),
  await png(iconSvg({ color: '#ffffff', stroke: 6.5 }, onAccent, 0.6), 512),
);
// Android draws a notification's badge from its alpha channel alone: a white o, bolder.
await writeFile(
  path.join(webPublic, 'badge-96.png'),
  await png(iconSvg({ color: '#ffffff', stroke: 6 }), 96),
);

// The mail header: the wordmark 26 px tall (as in the web's header) on a white tile with the
// card's border, rendered at 4× for sharp screens. The tile is part of the picture because a
// mail client in dark mode (Gmail on Android above all) turns the HTML's light background dark
// and leaves pictures alone: dark letters on a transparent PNG would vanish. Hosted by the web
// app rather than attached (see apps/api/src/email/brand.ts).
const MAIL_HEIGHT = 26;
const MAIL_PAD = { x: 18, y: 12 };
const MAIL_BORDER = 2;
const mailBox = { width: WORDMARK.width + 2 * MAIL_PAD.x, height: 48 + 2 * MAIL_PAD.y };
const mailSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${mailBox.width} ${mailBox.height}"><rect x="${MAIL_BORDER / 2}" y="${MAIL_BORDER / 2}" width="${mailBox.width - MAIL_BORDER}" height="${mailBox.height - MAIL_BORDER}" rx="14" fill="#ffffff" stroke="#e3e7ee" stroke-width="${MAIL_BORDER}"/><g transform="translate(${MAIL_PAD.x} ${MAIL_PAD.y})">${wordmarkPaths({ text: MAIL_TEXT, accent: ACCENT })}</g></svg>`;
const mailSize = {
  width: Math.round((mailBox.width / 48) * MAIL_HEIGHT),
  height: Math.round((mailBox.height / 48) * MAIL_HEIGHT),
};
const mail = await sharp(Buffer.from(mailSvg()), { density: 600 })
  .resize({ height: mailSize.height * 4 })
  .png()
  .toBuffer();
await writeFile(mailPng, mail);
await writeModule(
  emailModule,
  `// Generated by scripts/brand-assets.mjs (\`pnpm brand\`); do not edit by hand.\n/** The logo every mail shows: its path on the web app (\`apps/web/public\`) and its CSS size. */\nexport const MAIL_LOGO = {\n  path: '/mail-logo.png',\n  width: ${mailSize.width},\n  height: ${mailSize.height},\n} as const;\n`,
);

if (preview) {
  const tile = (svg, width) =>
    sharp(Buffer.from(svg), { density: 600 }).resize({ width }).png().toBuffer();
  const bg = (color) => `<rect width="100%" height="100%" fill="${color}"/>`;
  const tiles = await Promise.all([
    tile(wordmarkSvg({ text: FG, accent: ACCENT }, bg('#f6f7f9')), 420),
    tile(wordmarkSvg({ text: FG_DARK, accent: ACCENT_DARK }, bg('#141619')), 420),
    tile(iconSvg({ color: ACCENT, stroke: 6 }, bg('#dddddd')), 120),
    tile(iconSvg({ color: '#ffffff', stroke: 5.5 }, onAccent, 0.8), 120),
    // The mail logo as a light client and a dark one (Gmail's inverted page) show it.
    sharp(mail).resize({ height: 78 }).png().toBuffer(),
  ]);
  const mailTile = (color) =>
    sharp({ create: { width: 420, height: 120, channels: 4, background: color } })
      .composite([{ input: tiles[4], left: 20, top: 21 }])
      .png()
      .toBuffer();
  await sharp({ create: { width: 900, height: 470, channels: 4, background: '#ffffff' } })
    .composite([
      { input: tiles[0], left: 10, top: 20 },
      { input: tiles[1], left: 440, top: 20 },
      { input: tiles[2], left: 10, top: 190 },
      { input: tiles[3], left: 140, top: 190 },
      { input: await mailTile('#f4f6f9'), left: 10, top: 330 },
      { input: await mailTile('#1f2937'), left: 440, top: 330 },
    ])
    .png()
    .toFile(preview);
}

console.log(
  `written: ${path.relative(root, webPaths)}, favicon.ico, icon.svg, apple-touch-icon.png, icon-192.png, icon-512.png, icon-maskable-512.png, badge-96.png, mail-logo.png (${mail.length} bytes, ${mailSize.width}×${mailSize.height}), ${path.relative(root, emailModule)}${preview ? `, ${preview}` : ''}`,
);
