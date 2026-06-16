<!-- #core -->
---
name: audit-methodology
description: |
  Visual and functional verification methodology for auditing implemented
  features against an approved implementation spec. Uses an isolated headless
  Playwright browser (auditor-browser MCP) to navigate the running app,
  capture evidence, and produce a pass/fail verdict.
  Loaded during the audit phase after dev completes.
---

# Audit Methodology

Visual and functional verification of implemented features against the approved implementation spec. The auditor navigates the running application, tests each functional requirement, captures screenshot evidence, and produces a pass/fail verdict.

## 1. Auditor Browser

The auditor uses the `mcp__auditor-browser__*` MCP tools -- an isolated headless Playwright instance. **Never use `mcp__my-browser__*` tools** (those connect to the user's Chrome session and cause tab conflicts).

The auditor-browser configuration:
- **Headless mode** -- no visible browser window
- **Viewport:** 1280x720
- **Output directory:** `proof-of-working/videos/` (for video recordings)
- **Capabilities:** `core,devtools` (supports video recording and console inspection)

This gives the auditor a clean, isolated browser with no shared state from other agents.

## 2. Video Recording

Start video recording at the beginning of every audit session:

1. Call `mcp__auditor-browser__browser_start_video` immediately after navigating to the first page
2. The video saves automatically to `proof-of-working/videos/` when the browser context closes
3. Use `mcp__auditor-browser__browser_video_chapter` to mark sections of the recording (e.g., one chapter per FR being tested)

Video provides continuous evidence of the entire audit flow, complementing individual screenshots.

## 3. Dev Server Management

The audit assumes the dev server is already running. If it is not:

1. Start the dev server (e.g., `npm run dev`, `pnpm dev`)
2. Wait for the ready state -- check that the server responds to requests
3. Use `waitUntil: 'domcontentloaded'` for page navigations (NOT `networkidle`, which may never resolve if the app uses persistent WebSocket connections like Supabase Realtime)

## 4. Verification Process

For each functional requirement (FR) in the `implementation-spec.md`:

1. **Navigate** to the relevant page or screen
2. **Perform the action** described in the FR (click buttons, fill forms, trigger flows)
3. **Observe the result** -- check that the expected behavior occurs
4. **Screenshot the result** as evidence
5. **Record pass or fail** with specific details

### What to Check

- **Functional requirements:** Every FR listed in the implementation spec
- **Visual correctness:** UI elements render properly, layouts are not broken
- **Error states:** Invalid inputs show appropriate error messages
- **Mobile viewport:** If the spec requires responsive behavior, resize to mobile dimensions and re-test key flows
- **Console errors:** Use `mcp__auditor-browser__browser_console_messages` to check for JavaScript errors

### Navigation Tips

- Use `mcp__auditor-browser__browser_snapshot` to get the current page state (accessibility tree) before interacting
- Use `mcp__auditor-browser__browser_click` with `ref` values from the snapshot for reliable element targeting
- For forms, use `mcp__auditor-browser__browser_fill_form` to populate multiple fields at once

## 5. Evidence Collection

Save screenshots to `proof-of-working/<spec-name>/`:

- **Naming convention:** `FR-<N>-<short-description>.png`
  - Example: `FR-01-login-form-renders.png`
  - Example: `FR-03-upload-success-toast.png`
- **Capture both success and failure states** -- failures need evidence too
- Use `mcp__auditor-browser__browser_take_screenshot` for individual screenshots
- Include the full page when relevant, or target specific elements for detail shots

## 6. Verdict Format

After testing all FRs, produce a verdict:

### PASS

All functional requirements met. Output:

```
VERDICT: PASS

Tested: [N] functional requirements
All passed. Evidence saved to proof-of-working/<spec-name>/

Summary:
- FR-1: [description] -- PASS
- FR-2: [description] -- PASS
- ...
```

### FAIL

One or more FRs failed. Write a revision file to `spec/<name>/revisions/`:

**Revision file format:**

```markdown
# Revision: Audit Failure [Date]

## Failed Requirements

### FR-[N]: [Title]

**Expected:** [What the spec says should happen]

**Observed:** [What actually happened]

**Evidence:** `proof-of-working/<spec-name>/FR-<N>-<description>.png`

**Fix Guidance:** [Specific suggestions for what to change]

---

### FR-[M]: [Next failure...]

[Same structure]
```

The revision file is the input for the next dev cycle. Be specific about what failed and why -- vague revision descriptions lead to vague fixes.

## 7. Exit Criteria

The audit is complete when:

- Every FR in the implementation spec has been tested
- Every test has a screenshot saved as evidence
- A pass/fail determination has been made for each FR
- If any FR failed: a revision file has been written to `spec/<name>/revisions/`
- If all FRs passed: the verdict is PASS and no revision file is needed
- Video recording captures the full audit session

## Pipeline Integration

The pipeline hooks automatically detect audit outcomes:
- **PASS:** The Stop hook checks for new revision files. If none exist, it fires `AUDIT_PASSED` and the pipeline transitions to the confirmation phase (outbound call to user).
- **FAIL:** When you write a revision file to `spec/<name>/revisions/`, the PostToolUse hook detects it and fires `AUDIT_FAILED`, transitioning back to the dev phase for fixes.

Use `/status` to check the current pipeline state if uncertain about where things stand.
