# collab-stress-test

Playwright + TypeScript test that simulates two users editing the same document
at the same time and asserts neither user's changes are lost.

---

## What it does

Opens two isolated browser sessions on the same Etherpad pad. Both users type
different text simultaneously using `Promise.all`. After the edits propagate via
Socket.IO, the test asserts that each user's view contains both pieces of text.

This exercises the server's **Operational Transform (OT)** engine — the algorithm
responsible for merging concurrent edits without conflicts or data loss. A failing
test means the server dropped or duplicated one user's changes.

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

## What's next

| Area | Description |
|---|---|
| More users | Scale to 3+ simultaneous editors — failure modes in OT typically appear above two users |
| More edit types | Concurrent deletions, overlapping formatting, reconnect after disconnect |
| Local target | Run against a local `docker compose` Etherpad to remove external latency and flakiness |
| Latency assertions | Measure and assert the time between last keystroke and sync becoming visible |
| Pad cleanup | Delete test pads after each run via the Etherpad HTTP API |
