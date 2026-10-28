import { expect, test } from '@playwright/test';
import { openHome } from './helpers.js';

test('the emoji picker inserts the pick at the caret and remembers it', async ({ page }) => {
  await openHome(page);
  const composer = page.getByLabel('New post');
  await composer.fill('Hello');
  await page.getByRole('button', { name: 'Add emoji' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('searchbox', { name: 'Search emoji' }).fill('grinning face');
  await picker.getByRole('gridcell', { name: 'Grinning face', exact: true }).click();
  await expect(composer).toHaveValue('Hello😀');
  // One pick closes the picker and the caret is back in the composer, not on the button.
  await expect(picker).toBeHidden();
  await expect(composer).toBeFocused();

  await page.getByRole('button', { name: 'Add emoji' }).click();
  await expect(
    page
      .getByRole('dialog')
      .getByRole('group', { name: 'Recently used' })
      .getByRole('button', { name: 'Grinning face' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test.describe('with a touch screen', () => {
  test.use({ hasTouch: true });

  test('phones keep their keyboard: the composers offer no picker', async ({ page }) => {
    await openHome(page);
    await expect(page.getByLabel('New post')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add emoji' })).toHaveCount(0);
  });
});
