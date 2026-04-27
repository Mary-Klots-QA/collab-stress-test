import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

// Etherpad sets only the `name` attribute on its editor iframes — never `id`.
// Use the attribute selector; #ace_outer / #ace_inner never match anything.
export const OUTER_FRAME = 'iframe[name="ace_outer"]';
export const INNER_FRAME = 'iframe[name="ace_inner"]';

export class EtherpadPage {
  constructor(readonly page: Page) {}

  editorBody() {
    return this.page.frameLocator(OUTER_FRAME).frameLocator(INNER_FRAME).locator('body');
  }

  editorLocator(selector: string, options?: { hasText?: string | RegExp }) {
    return this.page.frameLocator(OUTER_FRAME).frameLocator(INNER_FRAME).locator(selector, options);
  }

  // Waits for ace_outer to attach — sufficient for most tests.
  // waitForSelector has its own 30 s default independent of the test timeout;
  // always pass an explicit timeout when targeting WMF servers.
  async waitForReady(timeout = 90_000): Promise<void> {
    await this.page.waitForSelector(OUTER_FRAME, { state: 'attached', timeout });
  }

  // More precise ready signal: #editbar carries class "disabledtoolbar" while
  // the OT engine is initialising; dropping it means the editor accepts edits.
  async waitForEditorEnabled(timeout = 90_000): Promise<void> {
    await this.waitForReady(timeout);
    await this.page.waitForFunction(
      () =>
        document.querySelector('#editbar') !== null &&
        !document.querySelector('#editbar')!.classList.contains('disabledtoolbar'),
      { timeout },
    );
  }

  // One char at a time so each keystroke becomes its own OT operation.
  // Typing the whole string at once produces a single operation — no concurrency to test.
  async typeSlowly(text: string, delay = 80): Promise<void> {
    for (const char of text) {
      await this.page.keyboard.type(char);
      await this.page.waitForTimeout(delay);
    }
  }

  // Types `char` at maximum speed for `durationMs` ms.
  // Returns the exact character count sent — used to assert no silent drops.
  async typeForDuration(char: string, durationMs: number): Promise<number> {
    const deadline = Date.now() + durationMs;
    let total = 0;
    const chunk = char.repeat(20);
    while (Date.now() < deadline) {
      await this.page.keyboard.type(chunk, { delay: 0 });
      total += chunk.length;
    }
    return total;
  }

  // Traverses both iframes and returns the full plain text from body#innerdocbody.
  async getText(): Promise<string> {
    return this.page.evaluate(() => {
      const outer = document.querySelector('iframe[name="ace_outer"]') as HTMLIFrameElement;
      const inner = outer.contentDocument!.querySelector(
        'iframe[name="ace_inner"]',
      ) as HTMLIFrameElement;
      return (inner.contentDocument!.getElementById('innerdocbody') as HTMLElement).innerText;
    });
  }

  async expectText(text: string, timeout = 15_000): Promise<void> {
    await expect(this.editorBody()).toContainText(text, { timeout });
  }
}

// Polls until both editors show identical non-empty text, or throws after `timeout` ms.
// The final expect() produces a readable diff when the timeout fires.
export async function waitForConvergence(
  ep1: EtherpadPage,
  ep2: EtherpadPage,
  timeout = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const [t1, t2] = await Promise.all([ep1.getText(), ep2.getText()]);
    if (t1 === t2 && t1.length > 0) return;
    await ep1.page.waitForTimeout(300);
  }
  const [t1, t2] = await Promise.all([ep1.getText(), ep2.getText()]);
  expect(t1).toBe(t2);
}
