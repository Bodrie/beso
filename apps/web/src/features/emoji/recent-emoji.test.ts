import { RECENT_MAX, recentEmoji, rememberEmoji } from './recent-emoji';

describe('recent emoji', () => {
  it('starts empty, remembers newest first and keeps one entry per emoji', () => {
    expect(recentEmoji()).toEqual([]);
    rememberEmoji({ emoji: '😀', label: 'Grinning face' });
    rememberEmoji({ emoji: '👋', label: 'Waving hand' });
    expect(recentEmoji().map((item) => item.emoji)).toEqual(['👋', '😀']);
    rememberEmoji({ emoji: '😀', label: 'Grinning face' });
    expect(recentEmoji().map((item) => item.emoji)).toEqual(['😀', '👋']);
  });

  it('holds two rows of the picker and drops the oldest beyond them', () => {
    for (let index = 0; index < RECENT_MAX + 3; index += 1) {
      rememberEmoji({ emoji: `e${index}`, label: `Emoji ${index}` });
    }
    const row = recentEmoji();
    expect(row).toHaveLength(RECENT_MAX);
    expect(row[0]?.emoji).toBe(`e${RECENT_MAX + 2}`);
    expect(row.at(-1)?.emoji).toBe('e3');
  });

  it('ignores whatever else is in the storage', () => {
    localStorage.setItem('beso.emoji.recent', '{"not": "a list"}');
    expect(recentEmoji()).toEqual([]);
    localStorage.setItem('beso.emoji.recent', 'not json');
    expect(recentEmoji()).toEqual([]);
    expect(rememberEmoji({ emoji: '😀', label: 'Grinning face' })).toEqual([
      { emoji: '😀', label: 'Grinning face' },
    ]);
  });
});
