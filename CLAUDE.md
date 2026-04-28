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

## OnlyOffice vs Etherpad — architectural differences for test automation

### Canvas vs DOM: the selector strategy changes entirely

Etherpad renders document text into real DOM nodes:

```
iframe[name="ace_outer"] → iframe[name="ace_inner"] → body#innerdocbody
```

`innerText` on `body#innerdocbody` returns the full document text. Every convergence
assertion in the Etherpad tests works because content exists as readable DOM nodes.

OnlyOffice renders to canvas — one iframe boundary, then pixels:

```
iframe[name="frameEditor"]
  ├── canvas#id_viewer          ← document painted here as pixels
  ├── canvas#id_viewer_overlay  ← receives mouse events
  └── textarea#area_id          ← off-screen keyboard shim (left:-100px top:-50px, transparent)
```

There are no text nodes. `document.querySelector('anything').textContent` returns `""`.
This is not a bug — it is the architecture. Every selector you would write for a DOM-rendered
editor silently fails here with an empty string, not an error.

### Verified ready-state selectors (confirmed live, 2026-04-27)

`label#label-action` has three observed states on a fresh load:

| Text | Meaning |
|---|---|
| `"Loading data..."` | WebSocket handshake in progress — NOT ready |
| `""` | Session established, no edits yet — READY |
| `"All changes saved"` | Post-edit autosave confirmed — READY |

`label#label-pages` shows `"Page N of M"` once the document is rendered into the canvas.
Empty during SDK initialisation; populates within ~3 s of navigation.

Both conditions must be true before sending input:

```typescript
await page.frame({ name: 'frameEditor' })!.waitForFunction(
  ({ pageId, actionId }) => {
    const pageText   = document.getElementById(pageId)?.textContent?.trim()   ?? '';
    const actionText = document.getElementById(actionId)?.textContent?.trim() ?? '';
    return pageText.includes('Page') && !actionText.includes('Loading');
  },
  { pageId: 'label-pages', actionId: 'label-action' },
  { timeout: 90_000 },
);
```

**Critical trap:** `page.waitForFunction()` runs in the outer page context. Accessing
`iframe.contentDocument` from there is transiently `null` while the frame is loading —
the poll silently returns `false` for the entire timeout. Always use
`page.frame({ name: 'frameEditor' }).waitForFunction()` to evaluate inside the frame's
own document context.

### Why standard DOM text verification doesn't work — and what to use instead

You cannot assert `"Hello from Alice"` appeared in the document by querying the DOM.
Three alternatives, in order of implementation cost:

**1. Save-triggered file read via the download API** (highest fidelity)

The example app exposes `/example/download?fileName=...`. After `#label-action` shows
"All changes saved", fetch the `.docx`, unzip it (it's a ZIP), and search `word/document.xml`
for the expected string. This reads what DocumentServer actually persisted on disk.

**2. Screenshot pixel diffing**

`expect(page).toHaveScreenshot()` catches visual regressions but cannot assert that a
specific string was merged correctly. Brittle to antialiasing, font rendering, and cursor
position. Use for rendering regression tests, not OT convergence.

**3. WebSocket OT operation interception** (highest precision for collab assertions)

DocumentServer sends JSON-encoded changesets over WebSocket. Intercept them:

```typescript
page.on('websocket', ws => {
  ws.on('framereceived', ({ payload }) => {
    // payload contains JSON with OT changeset operations
    // Assert both users' insert operations appear in the merge log
  });
});
```

This asserts convergence at the protocol layer with no UI dependency. It is also the
layer where OT bugs actually live. Requires understanding the DocumentServer wire format.

### The JS/C++ bridge — what it means for root-cause analysis

DocumentServer runs `doctrenderer`, which embeds V8 (Chrome's JS engine) inside a C++
process. The edit pipeline spans two runtimes:

```
Browser JS (WASM/JS SDK) → WebSocket → Node.js server → C++ doctrenderer (V8)
```

When a test fails with missing or corrupted text, the root cause can be in any layer.
Playwright traces show the browser JS side only. The C++ side logs to
`documentserver/logs/` on the host. A failure that looks like "text went missing" from
the test perspective may be a V8 GC pause in the C++ layer causing a missed changeset
acknowledgement — nothing visible in the browser trace.

Rule of thumb: after two failed fixes from the browser side, read the DocumentServer logs.

### Bot swarm testing — why Playwright is the wrong tool for load

Playwright launches full Chromium instances: ~100 MB RAM each, ~50 ms to spawn. At 50
concurrent users you are at 5 GB RAM and the test runner is the bottleneck, not the server.

OnlyOffice's protocol is WebSocket + JSON changesets. The browser is not required for
load. A k6 swarm targets the same server logic at ~2 MB per virtual user:

```javascript
// k6 WebSocket load test sketch
import ws from 'k6/ws';
export default function () {
  ws.connect('ws://localhost/doc/DOCID', {}, (socket) => {
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token: JWT })));
    socket.on('message', msg => { /* record changeset ack latency */ });
  });
}
```

Use Playwright for: correctness tests, rendering assertions, convergence of 2–5 clients.
Use k6 + WebSocket clients for: 50+ users, latency SLOs, changeset throughput limits.

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
