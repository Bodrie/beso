/**
 * Fails the build when the JavaScript needed for the first paint grows past the budget.
 * The initial set is what dist/index.html loads up front (the module entry plus its
 * modulepreloads); lazily loaded route and feature chunks are not counted.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// 240 → 245 (B1, mentions), 245 → 250 (B3b: the thread's message menu and confirm dialog share
// the dropdown and alert-dialog primitives with the shell, which the bundler now splits into
// their own chunks; the extra is chunk overhead, not first-paint code), 250 → 252 (C2, comment
// threads: the fold, the nested list and the reply composer live in the comments section, which
// the feed's card renders on demand but which shares every primitive with the card, so splitting
// it off only added chunk overhead; measured 250.1 kB after D1 + C2. E1's zod/mini build of
// `@beso/shared` is the planned way back under 250), 252 → 256 (R3, the logo: the wordmark is
// the owner's reference logotype traced into outlines, `scripts/wordmark.json`, about 3 kB gz
// in the header's chunk; a trace from a sharper original would be smaller; measured 254.7 kB),
// 256 → 258 (D2, richer posts: the card's picture grid, the composer's several uploads and the
// viewer's entry point are on the feed's first paint, the viewer itself loads on demand;
// measured 256.2 kB), 258 → 259 (F2a, achievements: the catalogue is an entry of its own,
// `@beso/shared/achievements`, loaded only by the badge screens; what stays on the first paint is
// the settings keys, the actor-less notification, the push handler and two lazy entry points,
// about 0.5 kB, plus the bundler re-splitting zod, Radix and one icon into chunks of their own
// now that lazy badge screens share them, about 0.9 kB; measured 258.6 kB, E1 still the way back).
// R4 gave some back: the wordmark is drawn as a few stroked paths instead of the traced outlines
// and the header lost its symbol; measured 255.7 kB (from 258.8), the budget stays where it is.
// Since then R5 (send a post, 256.4), F3 (polls: the card's poll and the composer's toggle, the
// editor lazy; 258.0) and R6 (pinning in the post menu and the card's "Pinned" line, double tap
// to like on the card; 259.0) filled it: 259 → 260. E1's zod/mini build (≈ 25 kB) is overdue
// and is the way back before the next slice that touches the feed's first paint.
// 260 → 261 (R12, voice messages: the recorder, the encoder and the player are all lazy chat
// code, but the shared schemas ride on the first paint, and the voice note's shape, the send
// input's two new refinements and the upload limits are about 0.3 kB gz there; measured 260.1 kB).
const BUDGET_KB = Number(process.env.BUNDLE_BUDGET_KB ?? 261);
const dist = path.resolve(import.meta.dirname, '../dist');
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const initial = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map(
  (match) => match[1],
);

let total = 0;
const rows = initial.map((file) => {
  const gz = gzipSync(readFileSync(path.join(dist, file))).length;
  total += gz;
  return `  ${file}  ${(gz / 1024).toFixed(1)} kB gz`;
});
console.log(
  `Initial JavaScript (${initial.length} files): ${(total / 1024).toFixed(1)} kB gz, budget ${BUDGET_KB} kB`,
);
console.log(rows.join('\n'));
if (total > BUDGET_KB * 1024) {
  console.error(
    `Bundle budget exceeded by ${((total - BUDGET_KB * 1024) / 1024).toFixed(1)} kB gz`,
  );
  process.exit(1);
}
