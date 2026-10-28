import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { EmojiPickerButton } from './emoji-picker-button';
import { rememberEmoji } from './recent-emoji';

// The data is a build asset fetched at runtime; the picker's own loading is not under test.
vi.mock('./emoji-data', () => ({
  resolveEmojiData: () => ({
    locale: 'en',
    emojis: [{ emoji: '😀', category: 0, label: 'Grinning face', version: 1, tags: ['smile'] }],
    categories: [{ index: 0, label: 'Smileys & emotion' }],
    skinTones: {
      light: 'Light',
      'medium-light': 'Medium-light',
      medium: 'Medium',
      'medium-dark': 'Medium-dark',
      dark: 'Dark',
    },
  }),
}));

describe('EmojiPickerButton', () => {
  it('opens the picker with its search box, and a recent pick closes it with the emoji', async () => {
    const user = userEvent.setup();
    rememberEmoji({ emoji: '👋', label: 'Waving hand' });
    const onPick = vi.fn();
    renderWithProviders(<EmojiPickerButton onPick={onPick} />);

    await user.click(screen.getByRole('button', { name: 'Add emoji' }));
    expect(await screen.findByRole('searchbox', { name: 'Search emoji' })).toBeInTheDocument();
    const recent = screen.getByRole('group', { name: 'Recently used' });
    await user.click(screen.getByRole('button', { name: 'Waving hand' }));
    expect(onPick).toHaveBeenCalledWith('👋');
    await waitFor(() => expect(recent).not.toBeInTheDocument());
  });

  it('shows no recently used row before the first pick', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EmojiPickerButton onPick={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Add emoji' }));
    await screen.findByRole('searchbox', { name: 'Search emoji' });
    expect(screen.queryByRole('group', { name: 'Recently used' })).not.toBeInTheDocument();
  });
});
