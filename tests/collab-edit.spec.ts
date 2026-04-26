/**
 * Scenario 1: Specification-driven test
 * Generated from explicit requirements.
 * Tests basic multi-user consistency (happy path).
 */

import { test, expect, chromium } from '@playwright/test';

// Etherpad sets only the `name` attribute on its editor iframes — never `id`.
// Use the attribute selector; #ace_outer / #ace_inner never match anything.
const OUTER_FRAME = 'iframe[name="ace_outer"]';
const INNER_FRAME = 'iframe[name="ace_inner"]';

// One char at a time so each keystroke becomes its own OT operation.
// Typing the whole string at once would produce a single operation — no concurrency to test.
async function typeSlowly(
  page: import('@playwright/test').Page,
  text: string,
): Promise<void> {
  for (const char of text) {
    await page.keyboard.type(char);
    await page.waitForTimeout(80);
  }
}

async function waitForTextInPad(
  page: import('@playwright/test').Page,
  text: string,
): Promise<void> {
  await expect(
    page.frameLocator(OUTER_FRAME).frameLocator(INNER_FRAME).locator('body')
  ).toContainText(text, { timeout: 15_000 });
}

async function runCollabTest(numUsers: number): Promise<void> {
  const padUrl = `https://etherpad.wikimedia.org/p/collab-test-${Math.random().toString(36).slice(2)}`;
  const browser = await chromium.launch();

  try {
    const pages = await Promise.all(
      Array.from({ length: numUsers }, async () =>
        (await browser.newContext()).newPage()
      )
    );

    const userTexts = pages.map((_, i) => `Hello from User ${i + 1}`);

    // 'load' not 'networkidle': Socket.IO long-polls indefinitely, so networkidle never resolves.
    await Promise.all(pages.map(page => page.goto(padUrl, { waitUntil: 'load' })));

    // Etherpad creates the iframe after a WebSocket handshake — can exceed Playwright's 30 s default on WMF servers.
    await Promise.all(pages.map(page =>
      page.waitForSelector(OUTER_FRAME, { state: 'attached', timeout: 90_000 })
    ));

    // Each user claims a dedicated line before concurrent typing starts.
    // Without this, all cursors land at the same position and OT interleaves characters
    // from different users (e.g. "HHHelloello" instead of "Hello...Hello...").
    // 300 ms lets each Enter propagate to all other clients before the next user moves their cursor.
    for (const page of pages) {
      await page.frameLocator(OUTER_FRAME).frameLocator(INNER_FRAME).locator('body').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
    }

    // All users type simultaneously — this is what stresses the OT merge logic.
    await Promise.all(pages.map((page, i) => typeSlowly(page, userTexts[i])));

    await Promise.all(pages.map(page => page.waitForTimeout(2_000)));

    // Every user must see every user's text — N² cross-checks covering all sync directions.
    await Promise.all(
      pages.flatMap(page => userTexts.map(text => waitForTextInPad(page, text)))
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
