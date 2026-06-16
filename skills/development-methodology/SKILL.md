<!-- #core -->
---
name: development-methodology
description: |
  Three-agent build methodology for implementing code from an approved EIS.
  CEO orchestrator delegates to Maintainer, Builder, and Police subagents.
  Loaded during the dev phase to guide the dev agent's execution strategy.
---

# Development Methodology

Three-agent build methodology where a CEO orchestrator delegates all implementation work to specialized subagents. The CEO never writes code directly -- only delegates, verifies results, and makes decisions.

## 1. Three-Agent Build Methodology

The dev agent operates as a CEO that spawns three types of subagents:

| Role | Purpose | Writes Code? | Opens Browser? |
|------|---------|-------------|----------------|
| **Maintainer** | Infrastructure, planning, task assignment | No (config only) | Yes (manages tabs) |
| **Builder** | Implements scoped code tasks | Yes | No |
| **Police** | Functional and visual verification | No | Yes (auditor-browser) |

The CEO never implements code. Maximum one direct edit per cycle, and only for trivial fixes (typos, config values). Everything else is delegated.

## 2. Launch Order

Launch order is strict and sequential by role type:

1. **Maintainer first** -- Stands up infrastructure before anyone else starts:
   - Start dev server
   - Create test accounts (if needed)
   - Read all specs + revisions
   - Create implementation plan with scoped tasks
   - Assign browser tabs for builders (if applicable)

2. **Builders second (parallel)** -- Launch after Maintainer completes:
   - Each Builder receives a scoped task on non-overlapping files
   - Multiple Builders run in parallel
   - Builders only touch their assigned files

3. **Police last** -- Launch after all Builders finish:
   - Verifies Builder output against the spec
   - Runs functional and visual tests
   - Reports pass/fail per FR

## 3. Maintainer Role

The Maintainer is the first agent launched and the fastest to complete. Responsibilities:

- Read the `implementation-spec.md` and all files in `revisions/` (if any)
- Start the dev server and confirm it is ready
- Create test accounts via admin API if the app requires authentication
- Produce a task breakdown: which files need changes, what each Builder should do
- Assign scoped tasks to Builders with **exact file paths, line numbers, and code snippets**
- Manage browser tab assignments for any agents that need browser access

The Maintainer does NOT write application code. It writes plans and configuration only.

## 4. Builder Role

Builders receive a scoped task from the Maintainer and implement exactly what is specified. Rules:

- **Scope is fixed.** A Builder cannot expand its own scope or modify files outside its assignment.
- **Prompts must be specific.** Vague instructions like "clean up unused stuff" cause loops. Every Builder prompt needs:
  - Exact file paths to modify
  - Line numbers or function names to target
  - Code snippets showing the expected change
- **Builders write code, Police tests it.** A Builder may run `tsc` or equivalent for compilation checks, but functional/visual verification is Police-only.
- **No browser access.** Builders do not open browsers, navigate pages, or take screenshots.
- **No DOM manipulation.** Builders must never use `browser_evaluate` to programmatically inject behavior that bypasses real UI flows.

If a Builder is going in circles (stuck, looping, not making progress), **kill it and spawn a fresh agent** with tighter instructions. Fire and replace is faster than nudging.

## 5. Police Role

Police agents verify that Builder output matches the spec. They run after all Builders complete.

- **Functional verification:** Test each FR by interacting with the running app
- **Visual verification:** Screenshot key screens and compare against expected behavior
- **Cross-cutting issues:** Catch runtime bugs (missing config, wrong bucket settings, broken integrations) that no single Builder would find
- **Report format:** Pass/fail per FR with evidence (screenshots, error logs)

**Police Round 2:** After fixes are applied, run Police again as cheap insurance. A few targeted tests confirm the fix works. Do not skip this step.

Police must follow tab assignments exactly. If told "use tab 1", verify the correct tab before proceeding.

## 6. CEO Role

The CEO (the dev agent itself) orchestrates but does not implement:

- Spawn Maintainer, wait for plan
- Spawn Builders with scoped tasks from the plan
- Monitor Builder progress (check every 1-2 minutes)
- Spawn Police after Builders complete
- Review Police report
- If fixes needed: spawn new Builders for fixes, then Police Round 2
- Maximum **one direct edit per cycle** -- only for trivial config/typo fixes

The CEO makes decisions: which agents to spawn, when to fire and replace, when to declare dev complete.

## 7. Blocker Protocol

If any agent encounters an issue it cannot resolve (missing API keys, unclear requirements, external service down):

1. Write a blocker `.md` file to `spec/<name>/blockers/` with:
   - What is blocked
   - What was attempted
   - What information or action is needed to unblock
2. EXIT immediately. Do not attempt workarounds or creative solutions.
3. The FSM will detect the blocker file and trigger an outbound call to resolve it.

## 8. Revision Handling

When the dev agent is respawned after an audit failure or user rejection:

- Read ALL files in `spec/<name>/revisions/` as additive context
- Revisions override conflicting sections of the original `implementation-spec.md`
- The original spec remains the base; revisions are patches on top
- Address every item in the revision before declaring dev complete

## 9. Exit Criteria

The dev loop is complete when:
- All FRs from the implementation spec are implemented
- Police passes all checks with no failures
- No new blocker files have been written
- All revision items (if any) have been addressed

## Key Failures to Avoid

- **Agents bypassing UI with DOM manipulation** -- When testing, agents must click real buttons and use real file choosers, not shortcut via `browser_evaluate` to programmatically inject behavior.
- **Agents ignoring tab assignments** -- If a tab assignment is given, the agent must verify it is on the correct tab before proceeding. Operating on the wrong tab (or an unrelated page) invalidates all testing.
- **Renaming roles** -- The structure is Maintainer / Builder / Police, always. Do not rename them to "Investigator A/B/C" or collapse roles. Adapt the scope of each role to the task, not the roles themselves. Without Maintainer standing up infra, Builder has no environment and Police has nothing to verify.

## Pipeline Integration

The pipeline hooks automatically detect when the dev phase completes by checking for new blockers at the end of each agent turn. When all FRs are implemented and Police passes:
- The Stop hook will detect completion (no new blocker files) and fire `DEV_COMPLETE`
- The pipeline will transition to the audit phase automatically
- The auditor agent will be invoked to verify the implementation

Use `/status` to check the current pipeline state if uncertain about where things stand.
