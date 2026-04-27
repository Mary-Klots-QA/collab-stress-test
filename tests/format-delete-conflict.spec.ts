import { test, expect, chromium } from '@playwright/test';
import { EtherpadPage } from './helpers/etherpad';

test(
  'concurrent bold + delete on overlapping text: both clients converge on the same state',
  async () => {
    const padUrl = `https://etherpad.wikimedia.org/p/conflict-test-${Math.random()
      .toString(36)
      .slice(2)}`;

    const browser = await chromium.launch();

    try {
      // newContext() gives each user independent cookies/storage — isolated sessions.
      const user1 = new EtherpadPage(await (await browser.newContext()).newPage());
      const user2 = new EtherpadPage(await (await browser.newContext()).newPage());

      // 'load' not 'networkidle': Socket.IO long-polls fire indefinitely,
      // so networkidle (no requests for 500 ms) can never be satisfied.
      await Promise.all([
        user1.page.goto(padUrl, { waitUntil: 'load' }),
        user2.page.goto(padUrl, { waitUntil: 'load' }),
      ]);

      // ace_outer is created after the WebSocket handshake. WMF can take 50–90 s;
      // waitForSelector has its own 30 s default independent of the test timeout.
      await Promise.all([user1.waitForReady(), user2.waitForReady()]);

      // Seed a known string so both clients share the same OT revision before
      // the concurrent phase. Block until user 2 sees it.
      const SEED_TEXT = 'The quick brown fox';
      await user1.editorBody().click();
      await user1.page.keyboard.press('Control+End');
      await user1.page.keyboard.type(SEED_TEXT);
      await user2.expectText(SEED_TEXT);

      await Promise.all([
        // User 1 — bold via page.evaluate() directly on the inner frame.
        //
        // Ctrl+B and toolbar clicks both lose the inner-frame selection across
        // the double iframe boundary — confirmed: neither produced <b> tags.
        // page.evaluate() reaches the inner document directly, sets a programmatic
        // Range, and calls execCommand('bold'). Etherpad's MutationObserver converts
        // the <b> insertion into an OT attribute changeset.
        (async () => {
          await user1.page.evaluate(() => {
            const outer = document.querySelector('iframe[name="ace_outer"]') as HTMLIFrameElement;
            const inner = outer.contentDocument!.querySelector(
              'iframe[name="ace_inner"]',
            ) as HTMLIFrameElement;
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
          await user2.editorBody().click();
          await user2.page.keyboard.press('Control+End');
          for (let i = 0; i < 3; i++) {
            await user2.page.keyboard.press('Backspace');
            await user2.page.waitForTimeout(50);
          }
        })(),
      ]);

      // 2 s for Socket.IO to round-trip both changesets to the server
      // and push the merged result back to both clients.
      await Promise.all([
        user1.page.waitForTimeout(2_000),
        user2.page.waitForTimeout(2_000),
      ]);

      // User 2 deleted "fox" — must be absent from both clients.
      await expect(user1.editorBody()).not.toContainText('fox', { timeout: 10_000 });
      await expect(user2.editorBody()).not.toContainText('fox', { timeout: 10_000 });

      // "brown" was outside the deletion range — must still be present in both.
      await user1.expectText('brown');
      await user2.expectText('brown');

      // User 1's bold changeset must appear in both clients.
      // Scoped to hasText to avoid strict-mode errors when the welcome text is also bolded.
      await expect(user1.editorLocator('b', { hasText: 'brown' })).toBeVisible({ timeout: 10_000 });
      await expect(user2.editorLocator('b', { hasText: 'brown' })).toBeVisible({ timeout: 10_000 });
    } finally {
      await browser.close();
    }
  },
);
