import { test, expect, chromium } from '@playwright/test';

// Both iframes have `name` only — never `id`. `#ace_outer` never matches.
const OUTER_FRAME = 'iframe[name="ace_outer"]';
const INNER_FRAME = 'iframe[name="ace_inner"]';

function editorBody(page: import('@playwright/test').Page) {
  return page.frameLocator(OUTER_FRAME).frameLocator(INNER_FRAME).locator('body');
}

async function waitForText(
  page: import('@playwright/test').Page,
  text: string,
  timeout = 15_000,
): Promise<void> {
  await expect(editorBody(page)).toContainText(text, { timeout });
}

test(
  'concurrent bold + delete on overlapping text: both clients converge on the same state',
  async () => {
    const padUrl = `https://etherpad.wikimedia.org/p/conflict-test-${Math.random()
      .toString(36)
      .slice(2)}`;

    const browser = await chromium.launch();

    try {
      // newContext() gives each user independent cookies/storage — isolated sessions.
      const ctx1 = await browser.newContext();
      const ctx2 = await browser.newContext();
      const page1 = await ctx1.newPage();
      const page2 = await ctx2.newPage();

      // 'load' not 'networkidle': Socket.IO long-polls fire indefinitely,
      // so networkidle (no requests for 500 ms) can never be satisfied.
      await Promise.all([
        page1.goto(padUrl, { waitUntil: 'load' }),
        page2.goto(padUrl, { waitUntil: 'load' }),
      ]);

      // ace_outer is created after the WebSocket handshake. WMF can take 50–90 s;
      // waitForSelector has its own 30 s default independent of the test timeout.
      await Promise.all([
        page1.waitForSelector(OUTER_FRAME, { state: 'attached', timeout: 90_000 }),
        page2.waitForSelector(OUTER_FRAME, { state: 'attached', timeout: 90_000 }),
      ]);

      // Seed a known string so both clients share the same OT revision before
      // the concurrent phase. Block until user 2 sees it.
      const SEED_TEXT = 'The quick brown fox';
      await editorBody(page1).click();
      await page1.keyboard.press('Control+End');
      await page1.keyboard.type(SEED_TEXT);
      await waitForText(page2, SEED_TEXT);

      await Promise.all([
        // User 1 — bold via page.evaluate() directly on the inner frame.
        //
        // Ctrl+B and toolbar clicks both lose the inner-frame selection across
        // the double iframe boundary — confirmed: neither produced <b> tags.
        // page.evaluate() reaches the inner document directly, sets a programmatic
        // Range, and calls execCommand('bold'). Etherpad's MutationObserver converts
        // the <b> insertion into an OT attribute changeset.
        (async () => {
          await page1.evaluate(() => {
            const outer = document.querySelector('iframe[name="ace_outer"]') as HTMLIFrameElement;
            const inner = outer.contentDocument!.querySelector('iframe[name="ace_inner"]') as HTMLIFrameElement;
            const innerDoc = inner.contentDocument!;
            const body = innerDoc.body;

            inner.contentWindow!.focus();
            body.focus();

            const range = innerDoc.createRange();
            range.selectNodeContents(body);
            const sel = inner.contentWindow!.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);

            innerDoc.execCommand('bold', false, null!);
          });
        })(),

        // User 2 — delete the last word ("fox", 3 chars) via Backspace.
        // 50 ms between presses generates three separate OT delete operations.
        (async () => {
          await editorBody(page2).click();
          await page2.keyboard.press('Control+End');
          for (let i = 0; i < 3; i++) {
            await page2.keyboard.press('Backspace');
            await page2.waitForTimeout(50);
          }
        })(),
      ]);

      // 2 s for Socket.IO to round-trip both changesets to the server
      // and push the merged result back to both clients.
      await Promise.all([
        page1.waitForTimeout(2_000),
        page2.waitForTimeout(2_000),
      ]);

      // User 2 deleted "fox" — must be absent from both clients.
      await expect(editorBody(page1)).not.toContainText('fox', { timeout: 10_000 });
      await expect(editorBody(page2)).not.toContainText('fox', { timeout: 10_000 });

      // "brown" was outside the deletion range — must still be present in both.
      await waitForText(page1, 'brown');
      await waitForText(page2, 'brown');

      // User 1's bold changeset must appear in both clients.
      // Scoped to hasText to avoid strict-mode errors when the welcome text is also bolded.
      const boldWithBrown = (pg: import('@playwright/test').Page) =>
        pg.frameLocator(OUTER_FRAME).frameLocator(INNER_FRAME).locator('b', { hasText: 'brown' });

      await expect(boldWithBrown(page1)).toBeVisible({ timeout: 10_000 });
      await expect(boldWithBrown(page2)).toBeVisible({ timeout: 10_000 });
    } finally {
      await browser.close();
    }
  },
);
