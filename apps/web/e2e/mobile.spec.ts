import { expect, test } from '@playwright/test';
import { USERS, contextAs, openHome } from './helpers.js';

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  // Carol's conversations are shared by two tests here; keep them in order.
  test.describe.configure({ mode: 'default' });

  test('messages: empty state, new conversation, thread and back to the list', async ({
    browser,
  }) => {
    // Carol has no conversations in the seed.
    const carol = await (await contextAs(browser, 'carol')).newPage();
    await carol.setViewportSize({ width: 390, height: 844 });
    await carol.goto('/messages');
    await expect(carol.getByText('No conversations yet.')).toBeVisible();

    await carol.getByRole('button', { name: 'New message' }).click();
    const dialog = carol.getByRole('dialog', { name: 'New message' });
    await dialog.getByRole('searchbox').fill('bob');
    await dialog.getByRole('button', { name: /Bob Brown/ }).click();
    await expect(carol).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
    await expect(carol.getByRole('link', { name: 'Back to conversations' })).toBeVisible();
    // The conversation is the whole screen under the header: as wide as the header (the viewport
    // less the scrollbar gutter headless Chromium reserves; a phone has none), starting where it
    // ends and reaching the bottom, with no frame or padding around it.
    const header = await carol.getByRole('banner').boundingBox();
    const panel = await carol.getByRole('region', { name: 'Conversation' }).boundingBox();
    if (!header || !panel) throw new Error('The header or the conversation has no box');
    expect(panel).toMatchObject({ x: 0, width: header.width });
    expect(panel.y).toBeCloseTo(header.y + header.height, 0);
    expect(panel.y + panel.height).toBeCloseTo(844, 0);
    const text = `Hi from a phone ${Date.now()}`;
    await carol.getByRole('textbox', { name: `Message ${USERS.bob.name}` }).fill(text);
    await carol.keyboard.press('Enter');
    await expect(
      carol.getByRole('log', { name: `Conversation with ${USERS.bob.name}` }).getByText(text),
    ).toBeVisible();

    await carol.getByRole('link', { name: 'Back to conversations' }).click();
    await expect(carol).toHaveURL(/\/messages$/);
    await expect(
      carol.getByRole('list', { name: 'Conversations' }).getByRole('listitem').first(),
    ).toContainText(text);
    await carol.context().close();
  });

  test('profile tabs and the navigation sheet', async ({ page }) => {
    await openHome(page);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('link', { name: 'People' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
    // Below xl the suggestions sit inline on the page.
    await expect(page.getByRole('list', { name: 'Suggestions' })).toBeVisible();

    await page.goto(`/u/${USERS.bob.username}`);
    await page.getByRole('link', { name: 'Followers', exact: true }).click();
    await expect(page).toHaveURL(/\/followers$/);
    await expect(
      page.getByRole('list', { name: 'Followers' }).getByRole('listitem').first(),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Posts', exact: true }).click();
    await expect(page.getByRole('feed', { name: `Posts by ${USERS.bob.name}` })).toBeVisible();
  });

  test('a new message shows a bubble row at the top and opens as a full-width panel', async ({
    page,
    browser,
  }) => {
    // Carol on her phone, alice writing to her from the desktop.
    const carol = await (await contextAs(browser, 'carol')).newPage();
    await carol.setViewportSize({ width: 390, height: 844 });
    await openHome(carol);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/messages/with/carol');
    const text = `For your phone ${Date.now()}`;
    await page.getByRole('textbox', { name: `Message ${USERS.carol.name}` }).fill(text);
    await page.keyboard.press('Enter');

    const row = carol.getByRole('list', { name: 'Chat bubbles' });
    const bubble = row.getByRole('button', { name: /Open chat with Alice Anderson/ });
    await expect(bubble).toBeVisible();
    await bubble.click();
    const panel = carol.getByRole('dialog', { name: 'Chat with Alice Anderson' });
    await expect(panel.getByText(text)).toBeVisible();
    await panel.getByRole('button', { name: 'Minimise chat with Alice Anderson' }).click();
    await expect(panel).toBeHidden();
    await expect(bubble).toBeVisible();
    await carol.context().close();
  });

  test.describe('with a touch screen', () => {
    test.use({ hasTouch: true });

    test('messages carry no icons; a press-and-hold offers reactions and options', async ({
      page,
    }) => {
      await openHome(page);
      await page.goto('/messages/with/carol');
      const log = page.getByRole('log', { name: `Conversation with ${USERS.carol.name}` });
      await expect(log).toBeVisible();
      const text = `Held on a phone ${Date.now()}`;
      await page.getByRole('textbox', { name: `Message ${USERS.carol.name}` }).fill(text);
      await page.keyboard.press('Enter');
      const bubble = log.getByText(text);
      await expect(bubble).toBeVisible();
      // Measure the confirmed bubble: the optimistic one is swapped for it when the ack lands.
      await expect(log.getByText('Sending…')).toHaveCount(0);
      // A coarse pointer: no per-message toolbar at all.
      await expect(page.getByRole('button', { name: 'Add reaction' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Message options' })).toHaveCount(0);

      // A real touch held on the bubble (Playwright has no long press; CDP sends the touch).
      const box = await bubble.boundingBox();
      if (!box) throw new Error('The bubble has no box');
      const cdp = await page.context().newCDPSession(page);
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await expect(page.getByRole('button', { name: 'Love' })).toBeVisible();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(page.getByRole('button', { name: 'Love' })).toBeVisible();
      await page.getByRole('button', { name: 'Edit message' }).tap();
      await expect(log.getByRole('textbox', { name: 'Edit message' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Love' })).toBeHidden();
    });

    test('two quick taps on a post like it', async ({ page }) => {
      await openHome(page);
      const text = `Tap tap ${Date.now()}`;
      await page.getByLabel('New post').fill(text);
      await page.getByRole('button', { name: 'Post', exact: true }).tap();
      const post = page.getByRole('article').filter({ hasText: text }).first();
      const like = post.getByRole('button', { name: /^Like/ });
      await expect(like).toHaveAttribute('aria-pressed', 'false');

      const box = await post.getByText(text, { exact: true }).boundingBox();
      if (!box) throw new Error('The text has no box');
      const point = { x: box.x + 8, y: box.y + box.height / 2 };
      await page.touchscreen.tap(point.x, point.y);
      await page.touchscreen.tap(point.x, point.y);
      await expect(like).toHaveAttribute('aria-pressed', 'true');
      await expect(like).toContainText('1');

      await post.getByRole('button', { name: 'Post options' }).tap();
      await page.getByRole('menuitem', { name: 'Delete post' }).tap();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).tap();
      await expect(page.getByRole('article').filter({ hasText: text })).toHaveCount(0);
    });

    test('a comment held with a finger offers reactions and its options', async ({ page }) => {
      await openHome(page);
      const article = page
        .getByRole('article')
        .filter({ has: page.getByRole('button', { name: /^Comments [1-9]/ }) })
        .first();
      await article.getByRole('button', { name: /^Comments \d+/ }).click();
      const comments = page.getByRole('region', { name: 'Comments' });
      // The author's name (the avatar link is aria-hidden): a held link must not open either.
      const bubble = comments.getByRole('listitem').first().getByRole('link').first();
      await expect(bubble).toBeVisible();
      await expect(comments.getByRole('button', { name: 'Add reaction' })).toHaveCount(0);
      await expect(comments.getByRole('button', { name: 'Comment options' })).toHaveCount(0);

      // The touch lands where the box is on screen, so the comment must be on screen first.
      await bubble.scrollIntoViewIfNeeded();
      const box = await bubble.boundingBox();
      if (!box) throw new Error('The comment has no box');
      const cdp = await page.context().newCDPSession(page);
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await expect(page.getByRole('button', { name: 'Love' })).toBeVisible();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(page.getByRole('button', { name: 'Love' })).toBeVisible();
      await expect(page.getByRole('button', { name: /^(Report|Edit) comment$/ })).toBeVisible();
      // The held author link did not open.
      await expect(page).toHaveURL(/\/$/);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Love' })).toBeHidden();
    });
  });
});
