# collab-stress-test

Playwright + TypeScript suite stress-testing OT-based collaborative editors.
Etherpad is the instrumented proxy — text in real DOM, convergence directly assertable.
OnlyOffice is the actual target: canvas-based, which breaks standard DOM assertions.
This project shows both the methodology and where it breaks down.
Built as an SDET demo for the IONOS Euro-Office team.
---
## What it tests

### Etherpad

| Test | Scenario | Assertion |
|---|---|---|
| **collab-edit** | N users type in parallel (2, 5, 10 users) | Every user sees every other user's text via `innerText` |
| **format-delete-conflict** | Concurrent bold + deletion on overlapping text | Both clients converge to identical DOM state |
| **same-position-concurrent** | Both users type at the same cursor offset at max speed for 5 s | Identical text on both clients; zero characters dropped |

### OnlyOffice DocumentServer

| Test | Scenario | Assertion |
|---|---|---|
| **editor loads** | Navigate to document; wait for co-auth session to initialise | Canvas present; status past "Loading data..." phase |
| **two-user concurrent** | Two users type distinct strings in parallel | Both changesets committed; undo stack enabled on both clients |
| **canvas limitation proof** | Type a string; attempt DOM text readback | Proves the text is NOT in the DOM — documents the gap and the alternatives |

---
## Methodology: DOM-first, never spec-driven

All OnlyOffice selectors came from Claude inspecting the live app via Playwright MCP —
not from documentation or assumptions. See [`PROMPTS.md`](PROMPTS.md) for the full log.

For Etherpad, assumptions produced `#ace_outer` (wrong — `name` attribute, not `id`).
For OnlyOffice they produce DOM text assertions returning `""` silently — no error, just
a test that always passes vacuously against a canvas element.

---
## OnlyOffice-specific challenges

**Canvas rendering.** Text lives on `canvas#id_viewer`, not in DOM nodes. Convergence
paths: `.docx` download API, WebSocket changeset interception, or internal JS SDK.
See [`CLAUDE.md`](CLAUDE.md).

**JS/C++ bridge.** `doctrenderer` runs V8 inside C++. A corruption bug that survives
browser-side debugging may live in the C++ layer. Playwright traces cover the browser;
`documentserver/logs/` covers the other.

---

## What I'd build next on the real system

**k6 + WebSocket bot swarm.** Playwright at 50 users is 5 GB RAM. OnlyOffice speaks
WebSocket + JSON changesets; k6 reaches the same server code at ~2 MB per user.
Latency SLOs and throughput limits live here, not in browser tests.

**WebSocket OT interception.** `page.on('websocket')` exposes every changeset frame.
Asserting both operations appear in the merge log beats any DOM check and is
rendering-architecture independent.

**LLM-powered failure classification.** Playwright traces + server logs → Claude API
→ OT bug / UI change / infra flake / convergence failure. One engineer reviews
classifications instead of reading every trace — "one engineer at team scale."

**CI on every PR** with multi-user scenarios blocking merge. Load tests nightly.

---

## How to run

```bash
npm install && npx playwright install chromium
npx playwright test                                   # all tests, all browsers
npx playwright test --project=chromium                # faster iteration
npx playwright test tests/onlyoffice-collab.spec.ts   # OnlyOffice only
npx playwright show-report                            # traces on failure
```

> Etherpad tests run against `etherpad.wikimedia.org`.
> OnlyOffice tests require DocumentServer at `http://localhost`.
