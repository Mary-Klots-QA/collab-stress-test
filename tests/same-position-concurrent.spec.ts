/**
 * Scenario 2: Exploration-driven test  
 * Generated via Playwright MCP — Claude inspected 
 * the live DOM before generating locators.
 * Tests sync engine under maximum write contention.
 * Adversarial: designed to find failures, not confirm success.
 */

// Adversarial OT test: both users type at the same cursor position simultaneously
// at maximum speed. Asserts convergence with zero character drops.

import { test, expect, chromium } from '@playwright/test';
import type { Page } from '@playwright/test';

// Both iframes have `name` only — never `id`. `#ace_outer` never matches.
const OUTER_FRAME = 'iframe[name="ace_outer"]';
const INNER_FRAME = 'iframe[name="ace_inner"]';

// body#innerdocbody has contenteditable="false"; Etherpad handles input via its
// own JS layer — clicks and keyboard.press() still work.
function editorBody(page: Page) {
  return page.frameLocator(OUTER_FRAME).frameLocator(INNER_FRAME).locator('body');
}

// Traverses both iframes and returns the full plain text from body#innerdocbody.
async function getEditorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const outer = document.querySelector('iframe[name="ace_outer"]') as HTMLIFrameElement;
    const inner = outer.contentDocument!.querySelector('iframe[name="ace_inner"]') as HTMLIFrameElement;
    return (inner.contentDocument!.getElementById('innerdocbody') as HTMLElement).innerText;
  });
}

// Types `char` at maximum speed (delay: 0) for `durationMs` ms.
// Returns the exact character count sent — used to assert no silent drops.
async function typeForDuration(page: Page, char: string, durationMs: number): Promise<number> {
  const deadline = Date.now() + durationMs;
  let total = 0;
  const chunk = char.repeat(20);
  while (Date.now() < deadline) {
    await page.keyboard.type(chunk, { delay: 0 });
    total += chunk.length;
  }
  return total;
}

// Polls until both editors show identical non-empty text, or throws after `timeout` ms.
// The final expect() produces a readable diff when the timeout fires.
async function waitForConvergence(page1: Page, page2: Page, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const [t1, t2] = await Promise.all([getEditorText(page1), getEditorText(page2)]);
    if (t1 === t2 && t1.length > 0) return;
    await page1.waitForTimeout(300);
  }
  const [t1, t2] = await Promise.all([getEditorText(page1), getEditorText(page2)]);
  expect(t1).toBe(t2);
}

test(
  'same-position concurrent typing for 5 s: both clients converge on identical text with no dropped characters',
  async () => {
    const padUrl = `https://etherpad.wikimedia.org/p/same-pos-${Math.random()
      .toString(36)
      .slice(2)}`;

    const browser = await chromium.launch();

    try {
      // newContext() gives each user independent cookies/storage — isolated sessions.
      const ctx1 = await browser.newContext();
      const ctx2 = await browser.newContext();
      const page1 = await ctx1.newPage();
      const page2 = await ctx2.newPage();

      // 'load' not 'networkidle': Socket.IO long-polls fire indefinitely.
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

      // #editbar carries class "disabledtoolbar" while the OT engine is initialising;
      // dropping it is a more precise "ready" signal than ace_outer attachment alone.
      await Promise.all([
        page1.waitForFunction(
          () => document.querySelector('#editbar') !== null &&
                !document.querySelector('#editbar')!.classList.contains('disabledtoolbar'),
          { timeout: 90_000 },
        ),
        page2.waitForFunction(
          () => document.querySelector('#editbar') !== null &&
                !document.querySelector('#editbar')!.classList.contains('disabledtoolbar'),
          { timeout: 90_000 },
        ),
      ]);

      // Seed a unique marker so both clients share the same OT revision before
      // the concurrent phase. Block until user 2 sees it.
      const SEED = `seed-${Date.now()}`;
      await editorBody(page1).click();
      await page1.keyboard.press('Control+End');
      await page1.keyboard.type(`\n${SEED}\n`);
      await expect(editorBody(page2)).toContainText(SEED, { timeout: 30_000 });

      // Both cursors at Control+End — same character offset.
      // Same-position inserts are the hardest OT case: the server serialises
      // characters from both streams producing interleaved but complete output.
      await Promise.all([
        (async () => { await editorBody(page1).click(); await page1.keyboard.press('Control+End'); })(),
        (async () => { await editorBody(page2).click(); await page2.keyboard.press('Control+End'); })(),
      ]);

      // Type simultaneously at maximum speed for 5 s.
      // Different chars (A/B) let us count each user's contribution independently.
      const [countA, countB] = await Promise.all([
        typeForDuration(page1, 'A', 5_000),
        typeForDuration(page2, 'B', 5_000),
      ]);

      await waitForConvergence(page1, page2, 30_000);

      const finalText = await getEditorText(page1);
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
