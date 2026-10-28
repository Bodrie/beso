import dataUrl from 'emojibase-data/en/data.json?url';
import messagesUrl from 'emojibase-data/en/messages.json?url';
import type { EmojiData, EmojiDataResolver } from 'frimousse';
import { z } from 'zod';
import { drawsAsEmoji } from './emoji-support';

// The parts of Emojibase's dataset (https://emojibase.dev/docs/datasets/) the picker reads;
// zod drops the rest, so the rows stay small.
const skinSchema = z.object({
  emoji: z.string(),
  /** 1–5, or several for a pair with two tones. */
  tone: z.union([z.number(), z.array(z.number())]).optional(),
});
const emojiSchema = z.object({
  emoji: z.string(),
  label: z.string(),
  version: z.number(),
  group: z.number().optional(),
  subgroup: z.number().optional(),
  tags: z.array(z.string()).optional(),
  skins: z.array(skinSchema).optional(),
});
const messageSchema = z.object({ key: z.string(), message: z.string(), order: z.number() });
export const emojiRowsSchema = z.array(emojiSchema);
export const emojiMessagesSchema = z.object({
  groups: z.array(messageSchema),
  subgroups: z.array(messageSchema),
  skinTones: z.array(z.object({ key: z.string(), message: z.string() })),
});
export type EmojiRow = z.infer<typeof emojiSchema>;
export type EmojiMessages = z.infer<typeof emojiMessagesSchema>;

type SkinTones = EmojiData['skinTones'];
type DataEmoji = EmojiData['emojis'][number];

/** Emojibase numbers the tones 1–5 in this order. */
const SKIN_TONE_KEYS: readonly (keyof SkinTones)[] = [
  'light',
  'medium-light',
  'medium',
  'medium-dark',
  'dark',
];
/** The tones and hair styles on their own: never a category of the picker. */
const COMPONENT_GROUP = 'component';
const FLAG_SUBGROUPS: ReadonlySet<string> = new Set(['country-flag', 'subdivision-flag']);
/** The flag the drawing check tries: Windows draws no country flag at all. */
const SAMPLE_FLAG = '🇪🇺';

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

type ToEmojiDataOptions = {
  locale?: string;
  /** Whether the browser draws an emoji as one colour glyph; the canvas check by default. */
  drawable?: (emoji: string) => boolean;
};

/**
 * The dataset in the shape frimousse's own loader would build from the same files, minus every
 * emoji newer than what this browser draws (the newest Unicode release whose first emoji
 * renders) and the country flags where none renders. Skin tone variants ride on their base
 * emoji; the component group and the regional indicators (which have no group) are left out.
 */
export function toEmojiData(
  rows: readonly EmojiRow[],
  messages: EmojiMessages,
  { locale = 'en', drawable = drawsAsEmoji }: ToEmojiDataOptions = {},
): EmojiData {
  const componentGroup = messages.groups.find((group) => group.key === COMPONENT_GROUP)?.order;
  const flagSubgroups = new Set(
    messages.subgroups.filter((sub) => FLAG_SUBGROUPS.has(sub.key)).map((sub) => sub.order),
  );
  const isFlag = (row: EmojiRow): boolean =>
    row.subgroup !== undefined && flagSubgroups.has(row.subgroup);
  const listed = rows.filter((row) => row.group !== undefined && row.group !== componentGroup);
  const newest = newestDrawableVersion(listed, drawable);
  const flags = drawable(SAMPLE_FLAG);
  return {
    locale,
    categories: messages.groups
      .filter((group) => group.key !== COMPONENT_GROUP)
      .map((group) => ({ index: group.order, label: capitalize(group.message) })),
    skinTones: skinToneLabels(messages),
    emojis: listed
      .filter((row) => row.version <= newest && (flags || !isFlag(row)))
      .map((row) => toDataEmoji(row, isFlag(row))),
  };
}

/** The newest Unicode release whose first emoji the browser draws; everything when none does. */
function newestDrawableVersion(
  rows: readonly EmojiRow[],
  drawable: (emoji: string) => boolean,
): number {
  const firstOf = new Map<number, string>();
  for (const row of rows) if (!firstOf.has(row.version)) firstOf.set(row.version, row.emoji);
  const versions = [...firstOf.keys()].toSorted((a, b) => b - a);
  const drawn = versions.find((version) => drawable(firstOf.get(version) ?? ''));
  return drawn ?? versions[0] ?? 0;
}

function skinToneLabels(messages: EmojiMessages): SkinTones {
  const label = (key: keyof SkinTones): string =>
    capitalize(messages.skinTones.find((tone) => tone.key === key)?.message ?? key);
  return {
    light: label('light'),
    'medium-light': label('medium-light'),
    medium: label('medium'),
    'medium-dark': label('medium-dark'),
    dark: label('dark'),
  };
}

function toDataEmoji(row: EmojiRow, countryFlag: boolean): DataEmoji {
  const aliases = (row.skins ?? [])
    .filter((skin) => Array.isArray(skin.tone))
    .map((skin) => skin.emoji);
  return {
    emoji: row.emoji,
    category: row.group ?? 0,
    version: row.version,
    label: capitalize(row.label),
    tags: row.tags ?? [],
    countryFlag: countryFlag || undefined,
    skins: skinsOf(row),
    aliases: aliases.length > 0 ? aliases : undefined,
  };
}

function skinsOf(row: EmojiRow): DataEmoji['skins'] {
  const byTone = new Map<number, string>();
  for (const skin of row.skins ?? []) {
    if (typeof skin.tone === 'number') byTone.set(skin.tone, skin.emoji);
  }
  if (byTone.size === 0) return undefined;
  const at = (index: number): string => byTone.get(index + 1) ?? row.emoji;
  return {
    light: at(SKIN_TONE_KEYS.indexOf('light')),
    'medium-light': at(SKIN_TONE_KEYS.indexOf('medium-light')),
    medium: at(SKIN_TONE_KEYS.indexOf('medium')),
    'medium-dark': at(SKIN_TONE_KEYS.indexOf('medium-dark')),
    dark: at(SKIN_TONE_KEYS.indexOf('dark')),
  };
}

async function fetchJson(url: string, signal: AbortSignal | undefined): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  const body: unknown = await response.json();
  return body;
}

/**
 * frimousse's own loader fetches Emojibase from jsDelivr at runtime and keeps it in
 * `localStorage`; this one reads the English files as hashed assets of the build (cached like
 * every asset, once per release), so no third party sees who opens the picker and the data is
 * the pinned version's. frimousse keeps the result for the page's life.
 */
export const resolveEmojiData: EmojiDataResolver = async (locale, { signal }) => {
  const [rows, messages] = await Promise.all([
    fetchJson(dataUrl, signal),
    fetchJson(messagesUrl, signal),
  ]);
  return toEmojiData(emojiRowsSchema.parse(rows), emojiMessagesSchema.parse(messages), { locale });
};
