---
description: Manually process a call trigger file through the pipeline
argument-hint: [trigger-file-path]
allowed-tools: Bash(node:*), Read, Write, Agent
---

Process the trigger file at the given path through the pipeline:

1. Read and parse the trigger file (this also creates the spec directory and REQUIREMENTS.md):
!`node ${CLAUDE_PLUGIN_ROOT}/lib/cli/process-trigger.js "$1"`

2. Based on the classification result in the JSON output:
   - **requirements**: The spec directory and REQUIREMENTS.md are already created. Invoke the `operant:sdlc-writer` agent with the spec directory path to produce the first artifact (intent-and-constraints.md). The agent will STOP after one artifact. The `detect-artifact.sh` hook will detect the write, transition to `sdlc_review`, and trigger a review gate (mock or real).
   - **confirmation**: FSM already advanced to complete. Report success.
   - **unknown**: Report the classification failure and ask the user for guidance.

3. After the sdlc-writer agent stops, the review gate runs automatically. When the review gate resolves (approved/rejected), the inject-context hook will tell you what to do next on the next user prompt.

Report the result including the classification, spec directory created, and next pipeline state.
