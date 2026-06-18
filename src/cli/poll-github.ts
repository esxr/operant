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

import {
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import https from "node:https";
import {
  getDataDir,
  ensureDataDir,
  getGitHubRepo,
  getGitHubToken,
  getGitHubPollInterval,
} from "../config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURSOR_FILE = "github-cursor.txt";
const LABEL_FILTER = "feedback";
const LOG_PREFIX = "[poll-github]";

// ---------------------------------------------------------------------------
// Cursor I/O
// ---------------------------------------------------------------------------

function readCursor(dataDir: string): number {
  const cursorPath = join(dataDir, CURSOR_FILE);
  try {
    const raw = readFileSync(cursorPath, "utf-8").trim();
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

function writeCursorAtomic(dataDir: string, cursor: number): void {
  const cursorPath = join(dataDir, CURSOR_FILE);
  const tmpPath = cursorPath + ".tmp";
  writeFileSync(tmpPath, String(cursor) + "\n");
  renameSync(tmpPath, cursorPath);
}

// ---------------------------------------------------------------------------
// GitHub API Client
// ---------------------------------------------------------------------------

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  html_url: string;
  labels: Array<{ name: string }>;
  created_at: string;
}

interface GitHubResponse {
  issues: GitHubIssue[];
  rateLimitRemaining: number;
}

function fetchIssues(
  owner: string,
  repo: string,
  token: string,
): Promise<GitHubResponse> {
  return new Promise((resolve, reject) => {
    const path = `/repos/${owner}/${repo}/issues?labels=${LABEL_FILTER}&state=open&sort=created&direction=asc&per_page=100`;

    const req = https.request(
      {
        hostname: "api.github.com",
        port: 443,
        path,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "operant-poll-github/1.0",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk; });
        res.on("end", () => {
          const rateLimitRemaining = parseInt(
            (res.headers["x-ratelimit-remaining"] as string) ?? "5000",
            10,
          );

          if (res.statusCode === 403 || res.statusCode === 429) {
            reject(new Error(`Rate limited (${res.statusCode}). Retry next cycle.`));
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`GitHub API error ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }

          try {
            const issues = JSON.parse(data) as GitHubIssue[];
            resolve({ issues, rateLimitRemaining });
          } catch {
            reject(new Error("Failed to parse GitHub API response"));
          }
        });
      },
    );
    req.on("error", (err) => reject(new Error(`GitHub API request failed: ${err.message}`)));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Idempotency Check
// ---------------------------------------------------------------------------

function triggerExists(dataDir: string, issueNumber: number): boolean {
  const pendingDir = join(dataDir, "pending");
  const processedDir = join(dataDir, "processed");

  for (const dir of [pendingDir, processedDir]) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir);
    if (files.some((f) => f.startsWith(`github-${issueNumber}-`))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Trigger File Writer
// ---------------------------------------------------------------------------

function writeTriggerFile(issue: GitHubIssue, dataDir: string): string {
  const pendingDir = join(dataDir, "pending");
  mkdirSync(pendingDir, { recursive: true });

  const ts = Date.now();
  const filename = `github-${issue.number}-${ts}.json`;
  const triggerPath = join(pendingDir, filename);

  const triggerData = {
    source: "github",
    github_issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      author: issue.user.login,
      url: issue.html_url,
      labels: issue.labels.map((l) => l.name),
      created_at: issue.created_at,
    },
    created_at: new Date().toISOString(),
  };

  writeFileSync(triggerPath, JSON.stringify(triggerData, null, 2));
  return filename;
}

// ---------------------------------------------------------------------------
// Poll Cycle
// ---------------------------------------------------------------------------

async function pollOnce(): Promise<number> {
  const dataDir = getDataDir();
  const { owner, name } = getGitHubRepo();
  const token = getGitHubToken();

  if (!token) {
    process.stderr.write(`${LOG_PREFIX} GITHUB_TOKEN not set. Cannot poll.\n`);
    process.exit(1);
  }

  let cursor = readCursor(dataDir);
  let newCount = 0;

  try {
    const { issues, rateLimitRemaining } = await fetchIssues(owner, name, token);

    if (rateLimitRemaining < 100) {
      process.stderr.write(
        `${LOG_PREFIX} WARNING: GitHub API rate limit low (${rateLimitRemaining} remaining)\n`,
      );
    }

    for (const issue of issues) {
      if (issue.number <= cursor) continue;
      if (triggerExists(dataDir, issue.number)) {
        process.stderr.write(`${LOG_PREFIX} Skipped #${issue.number} (trigger exists)\n`);
        cursor = Math.max(cursor, issue.number);
        continue;
      }

      const filename = writeTriggerFile(issue, dataDir);
      process.stderr.write(`${LOG_PREFIX} Wrote trigger: ${filename}\n`);
      cursor = Math.max(cursor, issue.number);
      newCount++;
    }

    writeCursorAtomic(dataDir, cursor);
  } catch (err) {
    process.stderr.write(`${LOG_PREFIX} Error: ${(err as Error).message}\n`);
  }

  process.stderr.write(
    `${LOG_PREFIX} Checked at ${new Date().toISOString()}. Found ${newCount} new issue(s).\n`,
  );
  return newCount;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const once = process.argv.includes("--once");

ensureDataDir();
await pollOnce();

if (!once) {
  const interval = getGitHubPollInterval();
  process.stderr.write(`${LOG_PREFIX} Polling every ${interval}ms\n`);
  setInterval(pollOnce, interval);
}
