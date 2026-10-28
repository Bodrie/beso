import { type EmojiMessages, type EmojiRow, toEmojiData } from './emoji-data';

const messages: EmojiMessages = {
  groups: [
    { key: 'smileys-emotion', message: 'smileys & emotion', order: 0 },
    { key: 'people-body', message: 'people & body', order: 1 },
    { key: 'component', message: 'components', order: 2 },
    { key: 'flags', message: 'flags', order: 9 },
  ],
  subgroups: [
    { key: 'face-smiling', message: 'face smiling', order: 0 },
    { key: 'flag', message: 'other flags', order: 97 },
    { key: 'country-flag', message: 'country flags', order: 98 },
  ],
  skinTones: [
    { key: 'light', message: 'light skin tone' },
    { key: 'medium-light', message: 'medium-light skin tone' },
    { key: 'medium', message: 'medium skin tone' },
    { key: 'medium-dark', message: 'medium-dark skin tone' },
    { key: 'dark', message: 'dark skin tone' },
  ],
};

const rows: EmojiRow[] = [
  { emoji: '🇦', label: 'regional indicator A', version: 0 },
  { emoji: '😀', label: 'grinning face', version: 1, group: 0, subgroup: 0, tags: ['smile'] },
  {
    emoji: '👋',
    label: 'waving hand',
    version: 0.6,
    group: 1,
    subgroup: 16,
    skins: [
      { emoji: '👋🏻', tone: 1 },
      { emoji: '👋🏼', tone: 2 },
      { emoji: '👋🏽', tone: 3 },
      { emoji: '👋🏾', tone: 4 },
      { emoji: '👋🏿', tone: 5 },
    ],
  },
  {
    emoji: '🧑‍🤝‍🧑',
    label: 'people holding hands',
    version: 12,
    group: 1,
    subgroup: 20,
    skins: [
      { emoji: '🧑🏻‍🤝‍🧑🏻', tone: 1 },
      { emoji: '🧑🏻‍🤝‍🧑🏼', tone: [1, 2] },
    ],
  },
  { emoji: '🏻', label: 'light skin tone', version: 1, group: 2, subgroup: 10 },
  { emoji: '🏁', label: 'chequered flag', version: 0.6, group: 9, subgroup: 97 },
  { emoji: '🇪🇺', label: 'flag: European Union', version: 2, group: 9, subgroup: 98 },
  { emoji: '🫩', label: 'face with bags under eyes', version: 16, group: 0, subgroup: 0 },
];

const everything = () => true;

describe('toEmojiData', () => {
  it('lists the groups as categories, capitalised, without the components', () => {
    const data = toEmojiData(rows, messages, { drawable: everything });
    expect(data.categories).toEqual([
      { index: 0, label: 'Smileys & emotion' },
      { index: 1, label: 'People & body' },
      { index: 9, label: 'Flags' },
    ]);
    expect(data.skinTones).toEqual({
      light: 'Light skin tone',
      'medium-light': 'Medium-light skin tone',
      medium: 'Medium skin tone',
      'medium-dark': 'Medium-dark skin tone',
      dark: 'Dark skin tone',
    });
    // Neither the regional indicator (no group) nor the tone swatch (component) is an emoji.
    expect(data.emojis.map((emoji) => emoji.emoji)).toEqual(['😀', '👋', '🧑‍🤝‍🧑', '🏁', '🇪🇺', '🫩']);
  });

  it('carries the skin tones on the base emoji, two-tone pairs as aliases, flags marked', () => {
    const data = toEmojiData(rows, messages, { drawable: everything });
    const wave = data.emojis.find((emoji) => emoji.emoji === '👋');
    expect(wave).toMatchObject({
      label: 'Waving hand',
      category: 1,
      tags: [],
      skins: {
        light: '👋🏻',
        'medium-light': '👋🏼',
        medium: '👋🏽',
        'medium-dark': '👋🏾',
        dark: '👋🏿',
      },
    });
    expect(wave?.countryFlag).toBeUndefined();
    const pair = data.emojis.find((emoji) => emoji.emoji === '🧑‍🤝‍🧑');
    expect(pair?.aliases).toEqual(['🧑🏻‍🤝‍🧑🏼']);
    expect(pair?.skins?.light).toBe('🧑🏻‍🤝‍🧑🏻');
    // A missing tone falls back to the base glyph rather than leaving a hole.
    expect(pair?.skins?.dark).toBe('🧑‍🤝‍🧑');
    expect(data.emojis.find((emoji) => emoji.emoji === '🇪🇺')?.countryFlag).toBe(true);
    expect(data.emojis.find((emoji) => emoji.emoji === '🏁')?.countryFlag).toBeUndefined();
  });

  it('hides the releases the browser does not draw and the country flags when none draws', () => {
    const noNewOnes = toEmojiData(rows, messages, { drawable: (emoji) => emoji !== '🫩' });
    expect(noNewOnes.emojis.map((emoji) => emoji.emoji)).not.toContain('🫩');
    expect(noNewOnes.emojis.map((emoji) => emoji.emoji)).toContain('🧑‍🤝‍🧑');

    const noFlags = toEmojiData(rows, messages, { drawable: (emoji) => emoji !== '🇪🇺' });
    expect(noFlags.emojis.map((emoji) => emoji.emoji)).not.toContain('🇪🇺');
    // Only the country flags go; the chequered one is drawn everywhere.
    expect(noFlags.emojis.map((emoji) => emoji.emoji)).toContain('🏁');

    // A browser that draws nothing we try still gets the whole set, never an empty picker.
    const nothing = toEmojiData(rows, messages, { drawable: () => false });
    expect(nothing.emojis).toHaveLength(5);
  });
});
