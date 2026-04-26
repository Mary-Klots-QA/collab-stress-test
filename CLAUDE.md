# collab-stress-test

Playwright + TypeScript suite that stress-tests concurrent editing on a real
Etherpad instance. Three test files cover different OT failure modes:

- **collab-edit** — N users type distinct content in parallel; all see all changes (2/5/10 users)
- **format-delete-conflict** — concurrent bold + deletion on overlapping text; both clients converge
- **same-position-concurrent** — both users type at the exact same cursor offset at maximum speed; asserts convergence with zero character drops

Built as an SDET interview demo.

---

## Non-obvious decisions

### Selectors — the most dangerous assumption in this codebase

```typescript
const OUTER_FRAME = 'iframe[name="ace_outer"]';
const INNER_FRAME = 'iframe[name="ace_inner"]';
```

Etherpad creates both iframes with **only a `name` attribute, never an `id`**.
Confirmed in ace.js source:

```javascript
outerFrame.name = 'ace_outer';   // no .id
iframe.name     = 'ace_inner';   // no .id
```

`#ace_outer` will never match. Always use the attribute form. This was the root
cause of every failure during initial development.

### `waitUntil: 'load'` not `'networkidle'`

Socket.IO's long-poll fallback fires a new HTTP request every ~25 s indefinitely.
`networkidle` (no requests for 500 ms) can never be satisfied. Use `'load'`.

### `waitForSelector` has its own 30 s default

`page.waitForSelector()` has an internal default timeout of 30 s that is
**independent of the test timeout**. The WMF server can take longer than 30 s to
complete its WebSocket handshake and create `ace_outer`. Always pass
`{ timeout: 90_000 }` explicitly.

### `#editbar.disabledtoolbar` — more precise editor-ready signal

`#editbar` carries class `disabledtoolbar` while the OT engine is initialising.
It drops when the editor is ready to accept edits. More precise than waiting for
`ace_outer` to attach alone — confirmed by live DOM inspection.

```typescript
page.waitForFunction(
  () => !document.querySelector('#editbar')?.classList.contains('disabledtoolbar'),
  { timeout: 90_000 }
)
```

### Same-position concurrent inserts cause character interleaving

With 5+ users all pressing `Control+End` and typing simultaneously, all cursors
land at the **same character position**. Etherpad's OT serialises concurrent
inserts at that position character-by-character, producing `"HHHelloello"` instead
of `"Hello...Hello..."`. The assertion never resolves because the substring is
permanently scrambled — it is not a timing issue.

Fix: in the sequential setup loop, each user presses `Enter` after `Control+End`
and waits 300 ms for that Enter to propagate via OT before the next user moves
their cursor. Each user then types on their own dedicated line and their text
stays contiguous.

### WMF welcome text contains 2 uppercase A's

Every new WMF pad is pre-seeded with text including "**A**ll Etherpads…" and
"**A**ny content…". Any `/A/g` match on the full document will be off by 2.
Scope character-count assertions to text after a unique seed marker:

```typescript
const afterSeed = finalText.split(SEED)[1] ?? '';
expect((afterSeed.match(/A/g) ?? []).length).toBe(countA);
```

---

## Dead ends — do not re-investigate

- **WMF notification overlay (`x` element in ARIA snapshot)** — dismissed, did not
  fix the click failure. The real cause was the wrong selector.
- **`pointer-events: none` on the editor body** — not confirmed. With correct
  selectors, `.click()` works.
- **`waitForSelector` inheriting the test timeout** — it does not. It has its own
  30 s default.

---

## What still needs to be built

- **More edit scenarios** — concurrent deletions, reconnect after disconnect.
- **Event-driven sync assertion** — `waitForConvergence` in same-position-concurrent
  already polls until both clients agree; `format-delete-conflict` still uses a fixed
  `waitForTimeout(2_000)` and should be updated.
- **Local Etherpad target** — `docker compose up` to remove WMF's 40–90 s
  WebSocket init time and external dependency.
- **Latency assertions** — measure and assert time from last keystroke to sync
  visible in both clients.
- **Pad cleanup** — call Etherpad's delete API in `afterAll` or use a fixed pad
  name cleared in `beforeEach`.

---

## Debugging rule of thumb

When a test against an external service fails repeatedly on the same step:

1. Strip the last fix before adding a new one.
2. Identify the exact line where execution stops — not just the error type.
3. ARIA snapshots do not show HTML attributes. They cannot confirm selector
   correctness.
4. Go to primary source (GitHub, DevTools, `playwright codegen`) before assuming
   an element's id, name, or class.
5. After two failed fixes, ask "what am I assuming vs. what have I verified?"
