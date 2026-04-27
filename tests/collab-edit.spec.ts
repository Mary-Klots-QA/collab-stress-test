/**
 * Scenario 1: Specification-driven test
 * Generated from explicit requirements.
 * Tests basic multi-user consistency (happy path).
 */

import { test, chromium } from '@playwright/test';
import { EtherpadPage } from './helpers/etherpad';

async function runCollabTest(numUsers: number): Promise<void> {
  const padUrl = `https://etherpad.wikimedia.org/p/collab-test-${Math.random().toString(36).slice(2)}`;
  const browser = await chromium.launch();

  try {
    const pages = await Promise.all(
      Array.from({ length: numUsers }, async () =>
        (await browser.newContext()).newPage()
      )
    );
    const users = pages.map(page => new EtherpadPage(page));
    const userTexts = users.map((_, i) => `Hello from User ${i + 1}`);

    // 'load' not 'networkidle': Socket.IO long-polls indefinitely, so networkidle never resolves.
    await Promise.all(users.map(u => u.page.goto(padUrl, { waitUntil: 'load' })));

    // Etherpad creates the iframe after a WebSocket handshake — can exceed Playwright's 30 s default on WMF servers.
    await Promise.all(users.map(u => u.waitForReady()));

    // Each user claims a dedicated line before concurrent typing starts.
    // Without this, all cursors land at the same position and OT interleaves characters
    // from different users (e.g. "HHHelloello" instead of "Hello...Hello...").
    // 300 ms lets each Enter propagate to all other clients before the next user moves their cursor.
    for (const u of users) {
      await u.editorBody().click();
      await u.page.keyboard.press('Control+End');
      await u.page.keyboard.press('Enter');
      await u.page.waitForTimeout(300);
    }

    // All users type simultaneously — this is what stresses the OT merge logic.
    await Promise.all(users.map((u, i) => u.typeSlowly(userTexts[i])));

    await Promise.all(users.map(u => u.page.waitForTimeout(2_000)));

    // Every user must see every user's text — N² cross-checks covering all sync directions.
    await Promise.all(
      users.flatMap(u => userTexts.map(text => u.expectText(text)))
    );
  } finally {
    await browser.close();
  }
}

test('2 users can type concurrently and both see each other\'s text', async () => {
  await runCollabTest(2);
});

test('5 users can type concurrently and all see each other\'s text', async () => {
  await runCollabTest(5);
});

test('10 users can type concurrently and all see each other\'s text', async () => {
  await runCollabTest(10);
});
