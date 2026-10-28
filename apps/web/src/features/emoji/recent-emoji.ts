import { z } from 'zod';

const KEY = 'beso.emoji.recent';
/** Two rows of the picker. */
export const RECENT_MAX = 18;

const recentSchema = z.array(z.object({ emoji: z.string(), label: z.string() }));
export type RecentEmoji = z.infer<typeof recentSchema>[number];

/**
 * The emoji picked last in this browser, newest first: a convenience of the device, like the
 * keyboard's own row, not an account preference (those live in `users.settings`).
 */
export function recentEmoji(): RecentEmoji[] {
  try {
    const parsed = recentSchema.safeParse(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
    return parsed.success ? parsed.data.slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Puts `pick` first and returns the row as it is now. */
export function rememberEmoji(pick: RecentEmoji): RecentEmoji[] {
  const next = [pick, ...recentEmoji().filter((item) => item.emoji !== pick.emoji)].slice(
    0,
    RECENT_MAX,
  );
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode and the like: the row lasts as long as the picker.
  }
  return next;
}
