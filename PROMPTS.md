# Prompt Library — collab-stress-test

Live prompting log from an AI-assisted SDET project. Each entry records the
prompt, the constraint applied, and what it produced. Kept as evidence of
methodological prompting decisions.

---

## Prompt patterns (TL;DR)

| Pattern | When to use |
|---|---|
| **"ONE fix only"** | Failure triage — forces prioritisation, makes result easy to evaluate |
| **"Strip the previous fix first"** | After a fix doesn't work — prevents patch accumulation |
| **"The test fails on these exact lines"** | When error message is vague — constrains solution space |
| **"How do you get your information about X?"** ⭐ | When stuck in a loop — surfaces unverified assumptions. Most valuable pattern in this project. |
| **"Simplest version that still proves the concept"** | After root cause fixed — removes noise from the solution |
| **"Give me reasoning before changing"** | Before any non-obvious decision — ensures the change is justified |
| **"What are you assuming vs. what have you verified?"** | N-user failure triage — forces the AI to flag uncertainty |

---

## Two test-generation approaches in this project

**Spec-driven** (collab-edit): You fully specify the behaviour — user count, parallelism
mechanism, assertion direction. Claude generates the implementation. Fast for well-understood
scenarios; risk is that locators come from training-data memory, which may be stale or wrong.

**DOM-first** (format-delete-conflict, same-position-concurrent): Claude is given access to
the live application via Playwright MCP, inspects the actual DOM, then generates tests from
what it observed. Eliminates the class of selector failures that consumed most of the
debugging time in this project.

---

## 1. Initial test generation

**Context:** Generate the full two-user concurrent editing test from scratch.

**Constraints applied:** Specified the exact parallelism mechanism (`Promise.all`),
the typing strategy (slowly, per character), the assertion direction (both users
see both strings), and required comments.

> "Write a Playwright TypeScript test that opens two browser contexts in the same
> test as two different users. Both navigate to the same Etherpad URL. User A types
> 'Hello from Alice' slowly, user B types 'Hello from Bob' slowly — in parallel
> using Promise.all. After both finish, assert that both users see both pieces of
> text in the pad. Add helpful comments so I can understand this code.
> Then tell me where I should inspect the output if it fails."

**Result:** Working scaffold. The test structure and helpers (`typeSlowly`,
`waitForTextInPad`) came from this prompt. Root selector bug introduced here
(`#ace_outer` assumed from memory, not verified).

---

## 2. Failure triage loop

**Context:** Test timed out on `.click()`. Three sequential fix attempts, each
evaluated cleanly before the next.

**Discipline:** Each prompt asked for ONE fix. When a fix didn't resolve the
error, the next prompt explicitly stripped it before trying again. This prevented
patch accumulation and kept each hypothesis independent.

**Prompts used in sequence:**

> "The test failed with: Click locator('#ace_outer')... collab-edit.spec.ts:100.
> Check the error files. What went wrong and what is ONE fix? Explain the problem
> and explain the fix. Why does this specific problem happen in collaborative
> editors? Explain in plain English."

→ Identified `waitUntil: 'networkidle'` as incorrect for Socket.IO apps. Fix
applied. Notification overlay theory investigated (wrong).

> "After the last fix the same error persists. Strip the previous fix because it
> wasn't the cause and check the same error files as in the previous prompt."

→ Removed notification dismissal code. Kept focus on the original failure, not
symptoms of the attempted fix.

> "The test still fails with the same error. Strip your last fix — it touches code
> that is not reached in execution yet. The test fails on these lines every time:
> [exact lines]. Do you have any other ideas why it might not be able to access
> those?"

→ Diagnosed `waitForSelector` default timeout (30 s) as a candidate. Applied
`{ timeout: 90_000 }`. Test still failed — because the selector itself was wrong,
not the timeout.

**Key discipline:** Pointing at the exact line where execution stops is more
useful than describing the error message. It constrains the solution space
immediately.

---

## 3. Break the loop — question the methodology ⭐

**Context:** Three or four fix cycles produced the same failure. Stuck.

**Constraint applied:** Stopped asking for a fix entirely. Asked a meta-question
about the information source behind the implementation.

> "I keep seeing the same error. I need to analyse. How do you get the information
> about the source code of Etherpad on which you base the test automation?"

**Result:** Forced acknowledgement that selectors were written from memory, not
from verified source. Led directly to fetching `ace.js` from GitHub, which showed
`outerFrame.name = 'ace_outer'` with no `.id`. Fixed the root cause in one step.

**Lesson:** After two failed fixes, asking "what are you assuming vs. what have
you verified?" breaks the loop faster than any additional fix.

---

## 4. Simplify after root cause resolved

**Context:** Test passed. Code had accumulated workarounds from failed attempts.

> "Taking into account this last discovery and fix that actually got the test to
> pass, strip the test of all the previous wrong fixes if they are not needed.
> Leave the simplest possible version of this test that would pass and prove the
> concept works. Write that, with comments."

**Result:** Test reduced from ~200 lines to 70. All speculative workarounds
removed. Comments kept only where the WHY is non-obvious.

**Lesson:** After a debugging session, always do a simplification pass. Working
code with accumulated patches is harder to explain than working code with only
load-bearing lines.

---

## 5. Refactor to parameterised N-user function

**Context:** Test was hardcoded for Alice and Bob. Needed to scale to arbitrary
user counts.

**Constraint applied:** Specified the function contract — takes `numUsers`, creates
N contexts, each types distinct content, all assert consistency.

> "Refactor to a function that takes numUsers as param, creates N browser contexts,
> each types different content, asserts consistency."

**Result:** `runCollabTest(numUsers)` extracted. Test cases become one-liners.
`pages.flatMap(...)` produces N² cross-user assertions automatically.

**Lesson:** Stating the function contract (inputs, what it creates, what it
asserts) in the prompt is faster than describing the desired output in prose.

---

## 6. Investigate N-user failure — ONE fix

**Context:** 2-user test passed; 5- and 10-user tests failed. Failure showed
character-interleaved output that never resolved even after 15 s of retries.

**Constraint applied:** Asked for ONE fix. Provided `error-context.md` files and
terminal output as evidence. Asked explicitly to separate assumed from verified.

> "I ran 3 tests: for 2 users - passed, for 5 and 10 users - failed. Investigate
> the reason for failure, you can see failure details in @terminal and test-results
> folder. What is the ONE fix for this issue. Give me explanation in plain English.
> Also, transparently mention what you are assuming and what is verified."

**Result:** Identified that all cursors land at the same character position,
causing OT to interleave characters permanently. Fix: press `Enter` per user in
the setup loop with a 300 ms propagation wait before the next user types.

**Lesson:** Asking to separate "assumed" from "verified" forces the AI to flag
uncertainty. The 15-second assertion retry in the error log was the key evidence
that ruled out a timing fix — worth pointing at directly rather than letting the
AI guess.

---

## 7. DOM-first test generation via Playwright MCP

**Context:** Generate a test for a new adversarial scenario (same-position
concurrent typing) without pre-specifying any locators.

**Approach:** Two-phase. Give Claude access to the live application via MCP and
ask it to explore the actual DOM before writing any code. Then specify the scenario.

> "You have access to a live Playwright browser via MCP.
> Open two instances of Etherpad. Explore the editor — inspect the DOM, find where
> text is entered, find any visible sync indicators or connection status elements.
> Then generate a test for THIS scenario: both users type at the same cursor position
> simultaneously at maximum speed for 5 seconds. After typing stops, assert that both
> users see identical content — no dropped characters, no duplicates.
> Base your locators on what you actually find in the DOM, not on assumptions. Show me
> the locators you chose and why."

**What the live inspection found (not assumed):**
- `body#innerdocbody` — the text container; `contenteditable="false"` (Etherpad's own input layer)
- `#editbar.disabledtoolbar` — a more precise "editor ready" signal than `ace_outer` attachment
- `#connectivity .connected` / `.userdup` — session-state indicators in the main page DOM
- WMF welcome text has 2 uppercase A's → assertions must be scoped to content after a seed marker

**Debugging in the same session:**
Test failed because `/A/g` on the full document matched the welcome text A's, always returning
`countA + 2`. Cause confirmed by live `evaluate()` call: `text.match(/A/g).length === 2` on a
blank pad. Fixed by scoping to `finalText.split(SEED)[1]`. One fix, one run, all 3 browsers passed.

**Why DOM-first over spec-driven:**

| | Spec-driven | DOM-first |
|---|---|---|
| Locator source | Claude's training data | Live DOM inspection |
| Risk | Selectors may be stale or wrong | Requires live app access |
| Root cause of past failures | `#ace_outer` from memory, not verified | Not applicable |

Give Claude MCP access to the live app whenever generating tests for an application
you haven't hand-inspected. The locator quality difference eliminates the class of
failures that consumed most of the debugging time in this project.

---

## 8. OnlyOffice pivot — DOM-first exploration of a canvas-based editor

**Context:** Extend the project to cover OnlyOffice DocumentServer (the actual target
system for the IONOS Euro-Office SDET role). No prior knowledge of OnlyOffice's internal
DOM structure. A spec-driven approach would generate plausible-looking but wrong selectors —
OnlyOffice's editing surface is nothing like Etherpad's, and the failure mode is worse.

**Constraint applied:** No test code until after live DOM inspection. Claude given access
to a local DocumentServer via Playwright MCP and asked to explore and report findings.
Code generation was explicitly blocked until the report was reviewed.

**Exact prompts used:**

> "You have access to a live Playwright browser via MCP. I have OnlyOffice DocumentServer
> running at http://localhost/example. Do the following exploration and report back — do
> NOT generate any test code yet: navigate to the example page, open the sample document,
> inspect the DOM carefully (editing surface structure, ready-state selector, text input
> mechanism, save state indicators, WebSocket status). Take an ARIA snapshot. Try clicking
> inside the editor and typing one character. Show me exactly what you found. Quote actual
> DOM elements and attributes. Do NOT assume anything from training data."

Then, after receiving and reviewing the DOM report:

> "Based on your DOM findings above, create a new test file: tests/onlyoffice-collab.spec.ts.
> Base ALL selectors on what you actually observed. Flag any selector you're not 100% certain
> about with a // VERIFY: comment."

**What the live inspection found (not assumed):**

- **Editing surface: canvas, not DOM.** `canvas#id_viewer` (2174×1052 px) renders the document.
  `canvas#id_viewer_overlay` receives mouse events. Zero `contenteditable` elements.
  No text nodes containing document content — anywhere.

- **Keyboard input shim.** `<textarea id="area_id">` at `left:-100px top:-50px`, fully
  transparent. The ONLY input path. Its parent `#area_id_parent` is repositioned
  dynamically to track cursor x/y on screen. Confirmed: pressing `X` with `area_id` focused
  produced `area_id.value = "X"`, cursor moved 17.5 px, undo button enabled.

- **Two distinct status signals — NEITHER behaves as expected from documentation:**
  - `label#label-pages` → "Page 1 of 1" once the canvas is populated. The correct "editor
    loaded" signal. Correct only because it was observed directly; documentation would have
    suggested `#label-action`.
  - `label#label-action` → empty on fresh load. Shows "Loading data..." during WebSocket
    handshake, `""` when ready, "All changes saved" post-edit. NOT a load signal — using
    it as one times out every test before the first edit is made.

- **Cross-frame access trap.** `page.waitForFunction()` + `iframe.contentDocument` is
  transiently `null` during frame load → silent poll failure for 90 s. Correct pattern:
  `page.frame({ name: 'frameEditor' }).waitForFunction()`.

- **Three-state `label-action` revealed only under parallel load.** When three tests ran
  in parallel with cold document loads, Test 1 saw `label-action = "Loading data..."` —
  a state not visible in the sequential MCP session. Required two live test runs to discover.

**Key lesson:**

Canvas-based editors break the core assumption of DOM-based test automation — that
document content exists as readable text nodes. A spec-driven approach generates
assertions like `body.innerText` or `document.querySelector('.editor').textContent`
that return `""` silently. No locator error fires; the test appears to pass; the
assertion is vacuously true. This failure mode is strictly worse than the Etherpad
`#ace_outer` bug, which at least produced a visible timeout.

The MCP DOM-first approach revealed the canvas architecture in the first inspection
call. Every selector in `onlyoffice-collab.spec.ts` came from live observation.
The three-state `label-action` behaviour — and the correct two-step ready signal —
was only discoverable by running tests against a live server and reading the failures.

| | Etherpad | OnlyOffice |
|---|---|---|
| Wrong selector failure mode | Locator timeout (visible error) | Empty string assertion (silent pass) |
| Content assertion | `innerText` on `body#innerdocbody` | No DOM text — needs download API or WS interception |
| Ready signal | `#editbar` loses `.disabledtoolbar` | `#label-pages` contains "Page" AND `#label-action` not "Loading" |
| Discovered via | GitHub source (`ace.js`) | Live MCP DOM inspection + parallel test run |

The same discipline — MCP-first, never assume selectors — applies more critically to
OnlyOffice than to Etherpad. The surface area of wrong assumptions is larger, and the
wrong assumptions fail silently.
