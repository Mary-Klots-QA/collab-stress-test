# collab-stress-test

Playwright + TypeScript suite that stress-tests concurrent editing on a real Etherpad instance,
proving the server's Operational Transform (OT) engine merges concurrent edit streams without
data loss or divergence.

Built as an SDET interview demo.

---

## What it tests

| Test file | Scenario | Assertion |
|---|---|---|
| **collab-edit** | N users type distinct content in parallel (2, 5, 10 users) | Every user sees every other user's text |
| **format-delete-conflict** | Concurrent bold formatting + deletion on the same text range | Both clients converge to identical state |
| **same-position-concurrent** | Both users type at the same cursor offset at maximum speed for 5 s | Both clients converge; zero characters dropped |

A failing test means the server dropped, duplicated, or mismerged one user's changes.

---

## How to run

**Prerequisites:** Node.js 18+

```bash
npm install
npx playwright install chromium   # first time only
```

**Run all tests (three browsers):**
```bash
npx playwright test
```

**Run Chromium only (faster for iteration):**
```bash
npx playwright test --project=chromium
```

**See the HTML report after a run:**
```bash
npx playwright show-report
```

**Replay a failure trace step-by-step:**
Open the HTML report → click the failed test → click **Trace**.

> Tests run against `etherpad.wikimedia.org`. The server can take 60–90 s to
> initialise the WebSocket connection for a new pad; the test timeout is set to
> 120 s to account for this. Run on a stable network connection.

---

## How the tests were built

**Spec-driven** (`collab-edit`): requirements fully specified in the prompt — user count,
parallelism mechanism, assertion direction. Claude generated the implementation. Fast for
well-understood scenarios; risk is that locators come from training-data memory.

**DOM-first** (`format-delete-conflict`, `same-position-concurrent`): Claude was given
access to the live application via Playwright MCP, inspected the actual DOM, then generated
tests from observed structure. Eliminates selector bugs caused by assumptions about element
ids and attributes. See `PROMPTS.md` for the full methodology log.

---

## What's next

| Area | Description |
|---|---|
| More edit types | Concurrent deletions, overlapping formatting, reconnect after disconnect |
| Local target | Run against a local `docker compose` Etherpad to remove external latency and flakiness |
| Latency assertions | Measure and assert the time between last keystroke and sync becoming visible |
| Pad cleanup | Delete test pads after each run via the Etherpad HTTP API |
| Event-driven sync | Replace `waitForTimeout(2_000)` in format-delete-conflict with convergence polling |
