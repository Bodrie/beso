import path from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { ANONYMOUS, animationsDone, openHome } from './helpers.js';

const PHOTO = path.join(import.meta.dirname, 'fixtures', 'photo.png');

/** WCAG 2.1 A/AA checks; `best-practice` rules are left out on purpose (too opinionated for a feed). */
async function audit(page: Page, label: string): Promise<void> {
  await animationsDone(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const violations = results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'n/a'}): ${violation.help}\n` +
      violation.nodes.map((node) => `    ${node.target.join(' ')}`).join('\n'),
  );
  expect(violations, `axe violations on ${label}`).toEqual([]);
}

test.describe('accessibility (signed out)', () => {
  test.use({ storageState: ANONYMOUS });

  test('sign in and register pages', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await audit(page, '/login');
    await page.goto('/register');
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    await audit(page, '/register');
    await page.goto('/join/welcome-from-alice');
    await expect(
      page.getByRole('heading', { name: 'Alice Anderson invited you to BeSo' }),
    ).toBeVisible();
    await audit(page, '/join/:code');
    await page.goto('/forgot-password');
    await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();
    await audit(page, '/forgot-password');
    await page.goto('/reset-password?token=axe');
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await audit(page, '/reset-password');
    await page.goto('/confirm-email?token=axe');
    await expect(page.getByRole('heading', { name: 'This link did not work' })).toBeVisible();
    await audit(page, '/confirm-email');
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy notice' })).toBeVisible();
    await audit(page, '/privacy');
    await page.goto('/terms');
    await expect(page.getByRole('heading', { level: 1, name: 'Terms of use' })).toBeVisible();
    await audit(page, '/terms');
  });

  test('the waiting room for an unconfirmed address', async ({ page }) => {
    const stamp = Date.now().toString(36);
    await page.goto('/register');
    await page.getByLabel('Username').fill(`axe_${stamp}`);
    await page.getByLabel('Name', { exact: true }).fill('Axe Audit');
    await page.getByLabel('Email').fill(`axe_${stamp}@example.com`);
    await page.getByLabel('Password', { exact: true }).fill('Password123!');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    await audit(page, '/verify-email');
  });
});

test.describe('accessibility (signed in)', () => {
  test('home feed, light and dark', async ({ page }) => {
    await openHome(page);
    await expect(page.getByRole('feed').getByRole('article').first()).toBeVisible();
    await audit(page, '/ (light)');
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await audit(page, '/ (dark)');
  });

  test('a post with three pictures and the picture viewer, light and dark', async ({ page }) => {
    // The seed gives Bob's #photography post three pictures.
    await openHome(page);
    await page.goto('/tags/photography');
    const post = page.getByRole('article').filter({ hasText: 'New #photography set' }).first();
    await expect(post.getByRole('button', { name: 'Open picture 3 of 3' })).toBeVisible();
    await audit(page, '/tags/photography');
    const viewer = page.getByRole('dialog', { name: 'Pictures posted by Bob Brown' });
    const auditViewer = async (theme: string) => {
      await post.getByRole('button', { name: 'Open picture 2 of 3' }).click();
      await expect(viewer.getByRole('img', { name: 'Posted by Bob Brown, 2 of 3' })).toBeVisible();
      await audit(page, `picture viewer (${theme})`);
      await page.keyboard.press('Escape');
      await expect(viewer).toBeHidden();
    };
    await auditViewer('light');
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await auditViewer('dark');
  });

  test('a thread of replies with its composer open', async ({ page }) => {
    await openHome(page);
    const text = `Thread audit ${Date.now()}`;
    await page.getByLabel('New post').fill(text);
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    const post = page.getByRole('article').filter({ hasText: text }).first();
    await post.getByRole('button', { name: /^Comments/ }).click();
    const comments = post.getByRole('region', { name: 'Comments' });
    await comments.getByLabel('Write a comment').fill('Top comment');
    await comments.getByLabel('Write a comment').press('Enter');
    const top = comments.getByRole('listitem').filter({ hasText: 'Top comment' }).first();
    await top.getByRole('button', { name: 'Reply', exact: true }).first().click();
    await comments.getByLabel('Write a reply').fill('A reply');
    await comments.getByLabel('Write a reply').press('Enter');
    await expect(top.getByRole('list', { name: 'Replies' })).toContainText('A reply');
    await top.getByRole('button', { name: 'Reply', exact: true }).first().click();
    await expect(comments.getByLabel('Write a reply')).toBeVisible();
    await audit(page, '/ (a thread of replies)');
    await post.getByRole('button', { name: 'Post options' }).click();
    await page.getByRole('menuitem', { name: 'Delete post' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('article').filter({ hasText: text })).toHaveCount(0);
  });

  test('the admin queue', async ({ page }) => {
    await openHome(page);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
    await audit(page, '/admin');
  });

  test('the report dialog', async ({ page }) => {
    await openHome(page);
    // Someone else's post: only those offer "Report post".
    const other = page
      .getByRole('article')
      .filter({ has: page.getByRole('button', { name: /^Repost \d/ }) })
      .first();
    await other.getByRole('button', { name: 'Post options' }).click();
    await page.getByRole('menuitem', { name: 'Report post' }).click();
    await expect(page.getByRole('dialog', { name: 'Report this post' })).toBeVisible();
    await audit(page, '/ (report dialog)');
  });

  test('the repost popover', async ({ page }) => {
    await openHome(page);
    // Someone else's post: only those carry the repost button.
    const other = page
      .getByRole('article')
      .filter({ has: page.getByRole('button', { name: /^Repost \d/ }) })
      .first();
    await other.getByRole('button', { name: /^Repost \d/ }).click();
    await expect(page.getByLabel('Add your thoughts (optional)')).toBeVisible();
    await audit(page, '/ (repost popover)');
  });

  test('bookmarks', async ({ page }) => {
    await openHome(page);
    await page.goto('/bookmarks');
    await expect(
      page.getByRole('feed', { name: 'Bookmarks' }).getByRole('article').first(),
    ).toBeVisible();
    await audit(page, '/bookmarks');
  });

  test('notifications', async ({ page }) => {
    await openHome(page);
    await page.goto('/notifications');
    await expect(
      page.getByRole('list', { name: 'Notifications' }).getByRole('listitem').first(),
    ).toBeVisible();
    await audit(page, '/notifications');
  });

  test('people, activity and a profile', async ({ page }) => {
    // Ten pages and dialogs audited one after another: the default 30 s ran out on a busy
    // machine (2026-10-22), well before anything was wrong with the pages.
    test.slow();
    await openHome(page);
    await page.goto('/users');
    await expect(
      page.getByRole('list', { name: 'People' }).getByRole('listitem').first(),
    ).toBeVisible();
    await audit(page, '/users');
    await page.goto('/activity');
    await expect(
      page.getByRole('list', { name: 'Activity', exact: true }).getByRole('listitem').first(),
    ).toBeVisible();
    await audit(page, '/activity');
    await page.goto('/explore');
    await expect(
      page.getByRole('feed', { name: 'Latest posts' }).getByRole('article').first(),
    ).toBeVisible();
    await audit(page, '/explore');
    await page.getByRole('tab', { name: 'Popular this week' }).click();
    await expect(
      page.getByRole('feed', { name: 'Popular posts this week' }).getByRole('article').first(),
    ).toBeVisible();
    await audit(page, '/explore?sort=popular');
    await page.goto('/u/bob');
    await expect(page.getByRole('heading', { level: 1, name: 'Bob Brown' })).toBeVisible();
    await audit(page, '/u/bob');
    await page.goto('/u/bob/followers');
    await expect(
      page.getByRole('list', { name: 'Followers' }).getByRole('listitem').first(),
    ).toBeVisible();
    await audit(page, '/u/bob/followers');
    // Badges in their tier colours, locked ones with progress: both themes (F2).
    await page.goto('/u/alice/badges');
    await expect(page.getByRole('region', { name: 'Milestones' })).toBeVisible();
    await audit(page, '/u/alice/badges (light)');
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await audit(page, '/u/alice/badges (dark)');
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.goto('/tags/weekend');
    await expect(page.getByRole('heading', { level: 1, name: '#weekend' })).toBeVisible();
    await expect(
      page.getByRole('feed', { name: 'Posts tagged #weekend' }).getByRole('article').first(),
    ).toBeVisible();
    await audit(page, '/tags/weekend');
    await page.goto('/search?q=weekend');
    await expect(
      page
        .getByRole('feed', { name: /Posts matching/ })
        .getByRole('article')
        .first(),
    ).toBeVisible();
    await audit(page, '/search');
    await page
      .getByRole('feed', { name: /Posts matching/ })
      .getByRole('article')
      .first()
      .locator('a[href^="/p/"]')
      .first()
      .click();
    await expect(page.getByRole('region', { name: 'Comments' })).toBeVisible();
    await audit(page, '/p/:id');
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await audit(page, '/settings');
    await page.getByRole('button', { name: 'Delete account' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete your account?' })).toBeVisible();
    await audit(page, 'delete account dialog');
    await page.keyboard.press('Escape');
  });

  test('messages and the edit profile dialog', async ({ page }) => {
    await openHome(page);
    await page.goto('/messages/with/bob');
    await expect(page.getByRole('log', { name: 'Conversation with Bob Brown' })).toBeVisible();
    // The seeded thread has a message with three pictures: the pile is part of the audit.
    await expect(
      page.getByRole('button', { name: 'Open 3 pictures sent by you' }).first(),
    ).toBeVisible();
    await audit(page, '/messages (direct)');
    await page.getByRole('button', { name: 'New message' }).click();
    await expect(page.getByRole('dialog', { name: 'New message' })).toBeVisible();
    await audit(page, 'new message dialog');
    await page.keyboard.press('Escape');
    await page
      .getByRole('list', { name: 'Conversations' })
      .getByRole('link', { name: /Weekend plans/ })
      .click();
    await expect(page.getByRole('log', { name: 'Group Weekend plans' })).toBeVisible();
    await audit(page, '/messages (group)');
    await page.getByRole('button', { name: 'Group members' }).click();
    await expect(page.getByRole('dialog', { name: 'Weekend plans' })).toBeVisible();
    await audit(page, 'group members dialog');
    await page.keyboard.press('Escape');
    await page.goto('/u/alice');
    await page.getByRole('button', { name: 'Edit profile' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit profile' })).toBeVisible();
    await audit(page, 'edit profile dialog');
    await page.getByLabel('Choose cover').setInputFiles(PHOTO);
    await expect(page.getByRole('application', { name: 'Cover position' })).toBeVisible();
    await audit(page, 'edit profile dialog (cropper)');
  });

  test('keyboard: skip link and focus after navigation', async ({ page }) => {
    await openHome(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();

    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'People' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
    await expect(page.locator('#main')).toBeFocused();
  });

  test('unknown addresses keep the shell', async ({ page }) => {
    await openHome(page);
    await page.goto('/no/such/page');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await audit(page, '404');
  });
});
