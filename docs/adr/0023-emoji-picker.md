# ADR 0023: Emoji picker

Date: 2026-10-28 · Status: Accepted

## Context

The composers (posts, chat) opened `emoji-picker-react` 4 in a popover: 82 kB gzipped of JavaScript with its data inside, every emoji in the DOM at once, a theme prop and CSS variables of its own rather than our tokens, and on a phone a tap on the smiley first closed the keyboard and then slid a popover over the composer. The owner asked (2026-10-28) whether this is the right library and for a better way on phones.

## Decision

- **frimousse** (Liveblocks, 0.4; React 18/19, MIT) draws the picker: headless parts (`Root`, `Search`, `Viewport`, `List` with our own row, cell and header components), virtualised rows, keyboard navigation with ARIA grid semantics, native glyphs; the picker's chunk is 10.6 kB gzipped where the old one was 82. `emoji-mart` was ruled out (its React wrapper peers React ≤ 18 and was last published in 2024); `emoji-picker-react` 5 (October 2026) now has primitives and glyph detection too, but remains several times the size for the same result.
- **The data is ours to serve.** frimousse's loader fetches Emojibase from jsDelivr at runtime and keeps it in `localStorage`; ours (`resolveEmojiData` in `features/emoji/emoji-data.ts`) reads `emojibase-data`'s `en/data.json` and `messages.json` as hashed assets of the build (Vite `?url`: immutable like every asset, 97.5 + 1.6 kB gzipped once per release, parsed with zod), so no third party sees who opens the picker and the data is the pinned version's. The mapping keeps the shape frimousse builds itself, minus every emoji newer than the browser draws (`emoji-support.ts`: a 2 px canvas drawn in two colours, tried once per Unicode release) and the country flags where none draws (Windows).
- **Phones keep their keyboard.** The button is `pointer-coarse:hidden`: every phone keyboard has an emoji panel that swaps in place, and no popover can do that over a closing keyboard. With a fine pointer the popover opens; one pick closes it and the composer keeps the caret (`onCloseAutoFocus` is prevented after a pick, so the focus is not pulled back to the button).
- **Recently used** is a row of the browser's last 18 picks (`recent-emoji.ts`, `localStorage`): a convenience of the device, like the keyboard's own row, not an account preference, so it stays out of `users.settings`.

## Consequences

- One dependency less with a theme of its own; dark mode comes from the tokens. The picker's chunk and the data assets load on the first open only; the first paint is unchanged (the swap re-sliced `next-themes` and lucide's factory into an extra initial file, so `vite.config.ts` now pins those long-lived runtimes into the `react` chunk).
- Skin tones are not offered (as before); a tone preference belongs in `users.settings` if asked for (backlog). An in-place panel on phones (the keyboard's measured height, as Telegram Web does it) is backlog too.
- `e2e/emoji.spec.ts` picks for real; the jsdom tests mock `./emoji-data` (so the canvas check never runs there).
