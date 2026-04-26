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
see both strings), and required interview-ready comments.

> "Write a Playwright TypeScript test that opens two browser contexts in the same
> test as two different users. Both navigate to the same Etherpad URL. User A types
> 'Hello from Alice' slowly, user B types 'Hello from Bob' slowly — in parallel
> using Promise.all. After both finish, assert that both users see both pieces of
> text in the pad. Add helpful comments so I can explain this code in an interview.
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
> editors? Explain in plain English so I can describe it in an interview."

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
user counts for interview demo.

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
