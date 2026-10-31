import dayjs from 'dayjs';

/**
 * Compact relative time for timelines: "just now", "5m", "3h", "2d", then a date.
 * `now` is injectable for tests.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const date = dayjs(then);
  return date.year() === dayjs(now).year() ? date.format('MMM D') : date.format('MMM D, YYYY');
}

/** Full date and time, for tooltips on relative timestamps. */
export function formatDateTime(iso: string): string {
  return dayjs(iso).format('MMM D, YYYY [at] HH:mm');
}

/** "https://example.com/path/" → "example.com/path", for showing a website link. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** "Today", "Yesterday", then "Oct 3" / "Oct 3, 2025": separators in a message thread. */
export function formatDayLabel(iso: string, now: number = Date.now()): string {
  const date = dayjs(iso);
  const today = dayjs(now).startOf('day');
  if (date.isSame(today, 'day')) return 'Today';
  if (date.isSame(today.subtract(1, 'day'), 'day')) return 'Yesterday';
  return date.year() === today.year() ? date.format('MMM D') : date.format('MMM D, YYYY');
}

export function formatTime(iso: string): string {
  return dayjs(iso).format('HH:mm');
}

/** "0:07", "1:30": the length or position of a clip, whole seconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const counted = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * "3 days left", "5 hours left", "12 minutes left": how long a poll stays open. Rounded, so a
 * poll asked for three days or one hour says so at first; days down to 23 hours, hours down to
 * an hour.
 */
export function formatTimeLeft(iso: string, now: number = Date.now()): string {
  const left = Date.parse(iso) - now;
  if (left > 23 * HOUR_MS) return `${counted(Math.round(left / DAY_MS), 'day')} left`;
  if (left > 59 * MINUTE_MS) return `${counted(Math.round(left / HOUR_MS), 'hour')} left`;
  if (left >= MINUTE_MS) return `${counted(Math.round(left / MINUTE_MS), 'minute')} left`;
  return 'Less than a minute left';
}
