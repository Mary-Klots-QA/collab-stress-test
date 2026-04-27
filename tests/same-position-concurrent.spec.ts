/**
 * Scenario 2: Exploration-driven test
 * Generated via Playwright MCP — Claude inspected
 * the live DOM before generating locators.
 * Tests sync engine under maximum write contention.
 * Adversarial: designed to find failures, not confirm success.
 */

import { test, expect, chromium } from '@playwright/test';
import { EtherpadPage, waitForConvergence } from './helpers/etherpad';

test(
  'same-position concurrent typing for 5 s: both clients converge on identical text with no dropped characters',
  async () => {
    const padUrl = `https://etherpad.wikimedia.org/p/same-pos-${Math.random()
      .toString(36)
      .slice(2)}`;

    const browser = await chromium.launch();

    try {
      // newContext() gives each user independent cookies/storage — isolated sessions.
      const user1 = new EtherpadPage(await (await browser.newContext()).newPage());
      const user2 = new EtherpadPage(await (await browser.newContext()).newPage());

      // 'load' not 'networkidle': Socket.IO long-polls fire indefinitely.
      await Promise.all([
        user1.page.goto(padUrl, { waitUntil: 'load' }),
        user2.page.goto(padUrl, { waitUntil: 'load' }),
      ]);

      // ace_outer is created after the WebSocket handshake. WMF can take 50–90 s;
      // waitForSelector has its own 30 s default independent of the test timeout.
      // waitForEditorEnabled adds the #editbar check — a more precise ready signal.
      await Promise.all([user1.waitForEditorEnabled(), user2.waitForEditorEnabled()]);

      // Seed a unique marker so both clients share the same OT revision before
      // the concurrent phase. Block until user 2 sees it.
      const SEED = `seed-${Date.now()}`;
      await user1.editorBody().click();
      await user1.page.keyboard.press('Control+End');
      await user1.page.keyboard.type(`\n${SEED}\n`);
      await expect(user2.editorBody()).toContainText(SEED, { timeout: 30_000 });

      // Both cursors at Control+End — same character offset.
      // Same-position inserts are the hardest OT case: the server serialises
      // characters from both streams producing interleaved but complete output.
      await Promise.all([
        (async () => { await user1.editorBody().click(); await user1.page.keyboard.press('Control+End'); })(),
        (async () => { await user2.editorBody().click(); await user2.page.keyboard.press('Control+End'); })(),
      ]);

      // Type simultaneously at maximum speed for 5 s.
      // Different chars (A/B) let us count each user's contribution independently.
      const [countA, countB] = await Promise.all([
        user1.typeForDuration('A', 5_000),
        user2.typeForDuration('B', 5_000),
      ]);

      await waitForConvergence(user1, user2, 30_000);

      const finalText = await user1.getText();
      expect(finalText).toContain(SEED);

      // Scope to afterSeed: WMF welcome text contains 2 uppercase A's
      // ("All Etherpads", "Any content") that would otherwise inflate the count.
      const afterSeed = finalText.split(SEED)[1] ?? '';
      expect((afterSeed.match(/A/g) ?? []).length).toBe(countA);
      expect((afterSeed.match(/B/g) ?? []).length).toBe(countB);
    } finally {
      await browser.close();
    }
  },
);
