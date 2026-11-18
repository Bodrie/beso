import path from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { animationsDone, contextAs, openHome } from './helpers.js';

// Both tests talk between alice and bob, so they must not interleave (fullyParallel is on).
test.describe.configure({ mode: 'default' });

test.describe('chat', () => {
  test('two members see each other online and exchange messages live', async ({
    page,
    browser,
  }) => {
    const bob = await (await contextAs(browser, 'bob')).newPage();
    await openHome(bob);
    await openHome(page);

    // Presence: alice sees Bob in the online list once both sockets are up.
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    await expect(
      sidebar.getByRole('list', { name: 'Online now' }).getByText('Bob Brown'),
    ).toBeVisible();

    // Alice writes to Bob from his profile's Message button.
    await page.goto('/u/bob');
    await page.getByRole('link', { name: 'Message', exact: true }).click();
    await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
    const text = `Hello Bob ${Date.now()}`;
    await page.getByRole('textbox', { name: 'Message Bob Brown' }).fill(text);
    await page.keyboard.press('Enter');
    const aliceLog = page.getByRole('log', { name: 'Conversation with Bob Brown' });
    await expect(aliceLog.getByText(text)).toBeVisible();

    // Bob gets it pushed: unread badge in the nav and the conversation list, then reads it.
    await bob.goto('/messages');
    const bobList = bob.getByRole('list', { name: 'Conversations' });
    // Not necessarily first: the phone spec, running alongside, may write to Bob as well.
    await expect(bobList.getByRole('listitem').filter({ hasText: text })).toBeVisible();
    // Anchored: the seeded group's snippet is a system line that names Alice too.
    await bobList.getByRole('link', { name: /^Alice Anderson/ }).click();
    const bobLog = bob.getByRole('log', { name: 'Conversation with Alice Anderson' });
    await expect(bobLog.getByText(text)).toBeVisible();

    // Alice sees the read receipt, then Bob's reply arrives without a reload.
    // A receipt is a second browser's round trip: generous on a loaded machine.
    await expect(aliceLog.getByText(/Seen/)).toBeVisible({ timeout: 15_000 });
    const reply = `Hi Alice ${Date.now()}`;
    await bob.getByRole('textbox', { name: 'Message Alice Anderson' }).fill(reply);
    // Typing is relayed live: alice's thread header says so until the message lands.
    await expect(page.getByText('typing…', { exact: true }).first()).toBeVisible();
    await bob.keyboard.press('Enter');
    await expect(aliceLog.getByText(reply)).toBeVisible();
    await expect(page.getByText('typing…', { exact: true })).toHaveCount(0);

    await bob.context().close();
    // Bob is gone: presence updates for alice.
    await page.goto('/');
    await expect(sidebar.getByRole('list', { name: 'Online now' })).toHaveCount(0);
  });

  test('a message that arrives on another page pops up as a bubble to read and reply from', async ({
    page,
    browser,
  }) => {
    const bob = await (await contextAs(browser, 'bob')).newPage();
    await openHome(page);
    await bob.goto('/messages/with/alice');
    const text = `Bubble ${Date.now()}`;
    await bob.getByRole('textbox', { name: 'Message Alice Anderson' }).fill(text);
    await bob.keyboard.press('Enter');

    // Alice is on her feed: a bubble with the unread count, no navigation.
    const bubble = page.getByRole('button', { name: /^Open chat with Bob Brown, \d+ unread$/ });
    await expect(bubble).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await bubble.click();
    const chat = page.getByRole('dialog', { name: 'Chat with Bob Brown' });
    await expect(chat.getByText(text)).toBeVisible();
    await animationsDone(page);
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(axe.violations, 'axe violations with a chat window open').toEqual([]);

    // Reading in the window is a read: Bob sees it. Replying works from there too.
    await expect(bob.getByText(/Seen/)).toBeVisible({ timeout: 15_000 });
    const reply = `From the bubble ${Date.now()}`;
    await chat.getByRole('textbox', { name: 'Message Bob Brown' }).fill(reply);
    await page.keyboard.press('Enter');
    await expect(
      bob.getByRole('log', { name: 'Conversation with Alice Anderson' }).getByText(reply),
    ).toBeVisible();

    await chat.getByRole('button', { name: 'Minimise chat with Bob Brown' }).click();
    await expect(chat).toBeHidden();
    await expect(page.getByRole('button', { name: 'Open chat with Bob Brown' })).toBeVisible();
    await page.getByRole('button', { name: 'Hide chat with Bob Brown' }).click();
    await expect(page.getByRole('list', { name: 'Chat bubbles' })).toHaveCount(0);
    await bob.context().close();
  });

  test('pictures travel with messages', async ({ page, browser }) => {
    const bob = await (await contextAs(browser, 'bob')).newPage();
    await openHome(bob);
    await bob.goto('/messages/with/alice');
    await openHome(page);
    await page.goto('/messages/with/bob');
    const aliceLog = page.getByRole('log', { name: 'Conversation with Bob Brown' });
    await expect(aliceLog).toBeVisible();

    await page
      .getByLabel('Attach pictures')
      .setInputFiles(path.join(import.meta.dirname, 'fixtures', 'photo.png'));
    await expect(page.getByRole('img', { name: 'Attachment preview' })).toBeVisible();
    const caption = `Look ${Date.now()}`;
    await page.getByRole('textbox', { name: 'Message Bob Brown' }).fill(caption);
    // Send waits for the upload to finish (the button is disabled until then).
    await page.getByRole('button', { name: 'Send' }).click();
    const sent = aliceLog.getByRole('listitem').filter({ hasText: caption });
    await expect(sent.getByRole('button', { name: 'Open picture sent by you' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Attachment preview' })).toHaveCount(0);

    // Bob gets the picture pushed into his open thread.
    const bobLog = bob.getByRole('log', { name: 'Conversation with Alice Anderson' });
    const received = bobLog.getByRole('listitem').filter({ hasText: caption });
    const picture = received.getByRole('button', { name: 'Open picture sent by Alice Anderson' });
    await expect(picture).toBeVisible();
    // A press opens it in the viewer, over the thread.
    await picture.click();
    const viewer = bob.getByRole('dialog', { name: 'Pictures in this conversation' });
    await expect(viewer.getByRole('img', { name: 'Sent by Alice Anderson' })).toBeVisible();
    await bob.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await bob.context().close();
  });

  test('several pictures chosen at once travel as one message, shown as a pile', async ({
    page,
    browser,
  }) => {
    const bob = await (await contextAs(browser, 'bob')).newPage();
    await openHome(bob);
    await bob.goto('/messages/with/alice');
    await openHome(page);
    await page.goto('/messages/with/bob');
    const aliceLog = page.getByRole('log', { name: 'Conversation with Bob Brown' });
    await expect(aliceLog).toBeVisible();

    // The file dialog takes several at once.
    const photo = path.join(import.meta.dirname, 'fixtures', 'photo.png');
    await page.getByLabel('Attach pictures').setInputFiles([photo, photo, photo]);
    const strip = page.getByRole('list', { name: '3 pictures to send' });
    await expect(strip.getByRole('img')).toHaveCount(3);
    const caption = `Three ${Date.now()}`;
    await page.getByRole('textbox', { name: 'Message Bob Brown' }).fill(caption);
    // Send waits for every upload to finish.
    await page.getByRole('button', { name: 'Send' }).click();
    const sent = aliceLog.getByRole('listitem').filter({ hasText: caption });
    await expect(sent.getByRole('button', { name: 'Open 3 pictures sent by you' })).toBeVisible();
    await expect(strip).toHaveCount(0);

    // Bob gets one message with the three: a pile with their number on it.
    const bobLog = bob.getByRole('log', { name: 'Conversation with Alice Anderson' });
    const received = bobLog.getByRole('listitem').filter({ hasText: caption });
    const pile = received.getByRole('button', {
      name: 'Open 3 pictures sent by Alice Anderson',
    });
    await expect(pile).toBeVisible();
    await expect(pile).toHaveText('3');
    // A press opens the viewer on the first; the arrows page through the other two.
    await pile.click();
    const viewer = bob.getByRole('dialog', { name: 'Pictures in this conversation' });
    const shown = viewer.getByRole('img', { name: /^Sent by Alice Anderson, \d+ of \d+$/ });
    await expect(shown).toBeVisible();
    const first = await shown.getAttribute('src');
    await bob.keyboard.press('ArrowRight');
    await expect(shown).not.toHaveAttribute('src', first ?? '');
    await bob.keyboard.press('ArrowRight');
    await expect(shown).toBeVisible();
    await bob.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await bob.context().close();
  });

  test('an admin renames the group and a sender takes a message back, live for the other member', async ({
    page,
    browser,
  }) => {
    const bob = await (await contextAs(browser, 'bob')).newPage();
    await openHome(bob);
    await openHome(page);
    await page.goto('/messages');

    const title = `Admins ${Date.now()}`;
    await page
      .getByRole('complementary', { name: 'Conversations' })
      .getByRole('button', { name: 'New group' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'New group' });
    await dialog.getByLabel('Group name').fill(title);
    await dialog.getByRole('searchbox').fill('bob');
    await dialog.getByRole('button', { name: /Bob Brown/ }).click();
    await dialog.getByRole('button', { name: 'Create group' }).click();
    // Two panes open the newest chat by themselves: wait for the new group's thread, not any.
    await expect(page.getByRole('log', { name: `Group ${title}` })).toBeVisible();
    await bob.goto(page.url());
    await expect(bob.getByRole('log', { name: `Group ${title}` })).toBeVisible();

    // The creator is the admin; Bob has no rename control. The rename reaches Bob's thread
    // together with the system line.
    await expect(bob.getByRole('button', { name: 'Rename group' })).toHaveCount(0);
    const renamed = `${title} renamed`;
    await page.getByRole('button', { name: 'Rename group' }).click();
    await page.getByRole('textbox', { name: 'Group name' }).fill(renamed);
    await page.keyboard.press('Enter');
    const aliceLog = page.getByRole('log', { name: `Group ${renamed}` });
    await expect(aliceLog).toBeVisible();
    await expect(aliceLog.getByText(`You renamed the group to “${renamed}”`)).toBeVisible();
    const bobLog = bob.getByRole('log', { name: `Group ${renamed}` });
    await expect(bobLog).toBeVisible({ timeout: 15_000 });
    await expect(
      bobLog.getByText(`Alice Anderson renamed the group to “${renamed}”`),
    ).toBeVisible();

    // Alice sends and corrects herself: Bob's copy follows, marked "edited".
    const text = `Take back ${Date.now()}`;
    await page.getByRole('textbox', { name: `Message ${renamed}` }).fill(text);
    await page.keyboard.press('Enter');
    await expect(bobLog.getByText(text)).toBeVisible();
    const mine = aliceLog.getByRole('listitem').filter({ hasText: text });
    await mine.hover();
    await mine.getByRole('button', { name: 'Message options' }).click();
    await page.getByRole('menuitem', { name: 'Edit message' }).click();
    await mine.getByLabel('Edit message').fill(`${text} (fixed)`);
    await mine.getByLabel('Edit message').press('Enter');
    await expect(mine.getByText(`${text} (fixed)`)).toBeVisible();
    await expect(mine.getByRole('button', { name: 'edited' })).toBeVisible();
    const bobsCopy = bobLog.getByRole('listitem').filter({ hasText: text });
    await expect(bobsCopy.getByText(`${text} (fixed)`)).toBeVisible({ timeout: 15_000 });
    await expect(bobsCopy.getByRole('button', { name: 'edited' })).toBeVisible();

    // Bob reacts: Alice sees the pill at once.
    await bobsCopy.hover();
    await bobsCopy.getByRole('button', { name: 'Add reaction' }).click();
    await bob.getByRole('button', { name: 'Love' }).click();
    await expect(bobsCopy.getByRole('button', { name: 'Love 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(mine.getByRole('button', { name: 'Love 1' })).toBeVisible({ timeout: 15_000 });

    // Alice takes it back: Bob's copy turns into "Message deleted", reactions and all.
    await mine.hover();
    await mine.getByRole('button', { name: 'Message options' }).click();
    await page.getByRole('menuitem', { name: 'Delete message' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete this message?' });
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(aliceLog.getByText('Message deleted')).toBeVisible();
    await expect(aliceLog.getByText(text)).toHaveCount(0);
    await expect(bobLog.getByText('Message deleted')).toBeVisible({ timeout: 15_000 });
    await expect(bobLog.getByText(text)).toHaveCount(0);
    await expect(bobLog.getByRole('button', { name: 'Love 1' })).toHaveCount(0);

    // A second message keeps its reaction on screen for the audit below.
    const kept = `Kept ${Date.now()}`;
    await page.getByRole('textbox', { name: `Message ${renamed}` }).fill(kept);
    await page.keyboard.press('Enter');
    const keptOnBob = bobLog.getByRole('listitem').filter({ hasText: kept });
    await expect(keptOnBob).toBeVisible({ timeout: 15_000 });
    await keptOnBob.hover();
    await keptOnBob.getByRole('button', { name: 'Add reaction' }).click();
    await bob.getByRole('button', { name: 'Haha' }).click();
    await expect(
      aliceLog
        .getByRole('listitem')
        .filter({ hasText: kept })
        .getByRole('button', { name: 'Haha 1' }),
    ).toBeVisible({ timeout: 15_000 });

    await animationsDone(page);
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      axe.violations,
      'axe violations with a system line, an edited and a deleted message and a reaction',
    ).toEqual([]);
    await bob.context().close();
  });

  test('a group reaches every member live and lists who is in it', async ({ page, browser }) => {
    const bob = await (await contextAs(browser, 'bob')).newPage();
    await openHome(bob);
    await bob.goto('/messages');
    await openHome(page);
    await page.goto('/messages');

    const title = `Trip ${Date.now()}`;
    await page
      .getByRole('complementary', { name: 'Conversations' })
      .getByRole('button', { name: 'New group' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'New group' });
    await dialog.getByLabel('Group name').fill(title);
    await dialog.getByRole('searchbox').fill('bob');
    await dialog.getByRole('button', { name: /Bob Brown/ }).click();
    await dialog.getByRole('button', { name: 'Create group' }).click();
    await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
    const log = page.getByRole('log', { name: `Group ${title}` });
    await expect(log).toBeVisible();

    // Bob's list picks the new group up without a reload, then his thread gets the message.
    const bobList = bob.getByRole('list', { name: 'Conversations' });
    const bobRow = bobList.getByRole('link', { name: new RegExp(title) });
    await expect(bobRow).toBeVisible();
    const text = `Where to? ${Date.now()}`;
    await page.getByRole('textbox', { name: `Message ${title}` }).fill(text);
    await page.keyboard.press('Enter');
    await bobRow.click();
    const bobLog = bob.getByRole('log', { name: `Group ${title}` });
    await expect(bobLog.getByText(text)).toBeVisible();
    await expect(log.getByText('Seen by everyone')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Group members' }).click();
    const members = page
      .getByRole('dialog', { name: title })
      .getByRole('list', { name: 'Members' });
    await expect(members.getByRole('listitem')).toHaveCount(2);
    await expect(members).toContainText('Alice Anderson (you)');
    await expect(members).toContainText('Bob Brown');
    await page.keyboard.press('Escape');
    await bob.context().close();
  });

  test('a post sent from the feed reaches the chat as a card, and leaves a frame once deleted', async ({
    page,
    browser,
  }) => {
    await openHome(page);
    const text = `Worth a look ${Date.now()}`;
    await page.getByLabel('New post').fill(text);
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    const post = page.getByRole('article').filter({ hasText: text }).first();
    await expect(post).toBeVisible();

    await post.getByRole('button', { name: 'Send post' }).click();
    const dialog = page.getByRole('dialog', { name: 'Send post' });
    await dialog.getByRole('searchbox', { name: 'Search chats and people' }).fill('bob');
    await dialog.getByRole('button', { name: /Bob Brown/ }).click();
    await dialog.getByLabel('Message (optional)').fill('For you');
    await animationsDone(page);
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(axe.violations, 'axe violations with the send dialog open').toEqual([]);
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Sent to Bob Brown')).toBeVisible();
    await expect(dialog).toBeHidden();

    const bob = await (await contextAs(browser, 'bob')).newPage();
    await bob.goto('/messages/with/alice');
    const log = bob.getByRole('log', { name: 'Conversation with Alice Anderson' });
    const card = log.getByRole('link', { name: new RegExp(`^Post by Alice Anderson .*${text}`) });
    await expect(card).toBeVisible();
    await expect(log.getByText('For you').last()).toBeVisible();
    await card.click();
    await expect(bob).toHaveURL(/\/p\/[0-9a-f-]{36}$/);
    await expect(bob.getByRole('article').filter({ hasText: text })).toBeVisible();

    // Alice deletes the post; Bob's chat keeps the message with an empty frame.
    await post.getByRole('button', { name: 'Post options' }).click();
    await page.getByRole('menuitem', { name: 'Delete post' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('article').filter({ hasText: text })).toHaveCount(0);
    await bob.goto('/messages/with/alice');
    await expect(log.getByText('This post is unavailable').last()).toBeVisible();
    await expect(card).toHaveCount(0);
    await bob.context().close();
  });

  test('a reply quotes the message it answers, for both sides', async ({ page, browser }) => {
    await openHome(page);
    await page.goto('/messages/with/bob');
    const log = page.getByRole('log', { name: 'Conversation with Bob Brown' });
    const question = `Which trail ${Date.now()}`;
    await page.getByRole('textbox', { name: 'Message Bob Brown' }).fill(question);
    await page.keyboard.press('Enter');
    const asked = log.getByRole('listitem').filter({ hasText: question });
    await expect(log.getByText('Sending…')).toHaveCount(0);

    await asked.hover();
    await asked.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page.getByText('Replying to yourself')).toBeVisible();
    await page.keyboard.type('The ridge one');
    await page.keyboard.press('Enter');
    await expect(
      log.getByRole('button', { name: `Reply to You ${question}`, exact: true }),
    ).toBeVisible();

    const bob = await (await contextAs(browser, 'bob')).newPage();
    await bob.goto('/messages/with/alice');
    const theirs = bob.getByRole('log', { name: 'Conversation with Alice Anderson' });
    await expect(
      theirs.getByRole('button', { name: `Reply to Alice Anderson ${question}`, exact: true }),
    ).toBeVisible();
    await bob.context().close();
  });
});
