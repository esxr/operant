#!/usr/bin/env node
/**
 * @module cli/poll-github
 *
 * Background poller for GitHub issues labeled "feedback".
 * Writes trigger files to pending/ for any new issues above the cursor.
 *
 * Usage:
 *   node lib/cli/poll-github.js          # continuous polling
 *   node lib/cli/poll-github.js --once   # single cycle, then exit
 */
export {};
