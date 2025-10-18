// scripts/bluesky-post.ts
// Post latest commit to Bluesky when commit message contains "@publish" or a semantic version.
// Intended to be run from a local git hook (e.g., pre-push or post-commit).
//
// Usage (from repo root):
//   deno run --allow-env --allow-net --allow-run --allow-read --allow-write scripts/bluesky-post.ts
//
// Required env:
//   BSKY_HANDLE          e.g. "yourname.bsky.social" (or DID)
//   BSKY_APP_PASSWORD    app password from Bluesky settings
// Optional env:
//   BLUESKY_DRYRUN=on    don't post, just print
//
// Notes:
// - Minimal dedupe via .git/aug-bluesky-posted file to avoid reposting the same SHA locally.

import { BskyAgent } from "@atproto/api";
import { firstEnv, loadDotenv } from "./shared/env.ts";

loadDotenv();
const envSnapshot = Deno.env.toObject();
const DEFAULT_BLUESKY_SERVICE = "https://bsky.social";

// Optional AI summarization
const AI_SUMMARY = firstEnv(envSnapshot, ["AI_SUMMARY"], "on").toLowerCase();
const OPENAI_API_KEY = firstEnv(envSnapshot, ["OPENAI_API_KEY"], "");
const textDecoder = new TextDecoder();

function stripCommitHashes(input: string): string {
  // remove likely git SHAs (7 to 40 hex chars)
  const noShas = input.replace(/\b[0-9a-f]{7,40}\b/gi, "");
  return noShas.replace(/\s{2,}/g, " ").trim();
}

// --------------- Helpers ---------------
const hasPublishKeyword = (msg: string) => /\B@publish\b/i.test(msg);
const hasSemver = (msg: string) =>
  /\b(?:v|V)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\b/
    .test(
      msg,
    );
const shortSha = (sha: string) => sha.slice(0, 7);

async function runGit(args: string[]): Promise<string> {
  const { success, stdout, stderr } = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!success) {
    const err = textDecoder.decode(stderr).trim();
    throw new Error(
      `git ${args.join(" ")} failed${err.length ? `: ${err}` : ""}`,
    );
  }
  return textDecoder.decode(stdout).trim();
}

async function latestCommitInfo() {
  const sha = await runGit(["rev-parse", "HEAD"]);
  const message = await runGit(["log", "-1", "--pretty=%B"]);
  const author = await runGit(["log", "-1", "--pretty=%an"]);
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  let repo = "";
  let commitUrl = "";
  try {
    const remoteUrl = await runGit(["config", "--get", "remote.origin.url"]);
    // Parse GitHub SSH/HTTPS URLs → owner/repo
    // Supports formats like:
    //  - git@github.com:owner/repo.git
    //  - https://github.com/owner/repo.git
    const m = remoteUrl.match(/github.com[:/](.+?)\/(.+?)(?:\.git)?$/);
    if (m) {
      repo = `${m[1]}/${m[2]}`;
      commitUrl = `https://github.com/${repo}/commit/${sha}`;
    }
  } catch (_) {
    // ignore
  }
  return { sha, message, author, branch, repo, commitUrl };
}

// --------------- Dedupe (local file) ---------------
async function hasSeenSha(sha: string): Promise<boolean> {
  try {
    const data = await Deno.readTextFile(".git/aug-bluesky-posted");
    return data.split("\n").some((l) => l.trim() === sha);
  } catch (_) {
    return false;
  }
}

// --------------- Optional AI condense ---------------
async function aiCondense(text: string): Promise<string> {
  if (!OPENAI_API_KEY || AI_SUMMARY === "off") return text;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a concise release/commit summarizer. Write in first-person, author’s commentary voice. Be specific and human. Exclude git commit hashes/SHAs. Keep semantic version identifiers if present. No hashtags or quotes.",
          },
          {
            role: "user",
            content:
              `Summarize as a short first-person commentary (~20 words). Do not include any git hashes/SHAs. Keep semver if present:\n"${text}"`,
          },
        ],
        temperature: 0.3,
        max_tokens: 80,
      }),
    });
    if (!res.ok) {
      console.warn("AI summary failed:", await res.text());
      return text;
    }
    const data = await res.json();
    return (data.choices?.[0]?.message?.content ?? text).trim();
  } catch (_) {
    return text;
  }
}

async function markSeenSha(sha: string): Promise<void> {
  try {
    await Deno.writeTextFile(".git/aug-bluesky-posted", `${sha}\n`, { append: true });
  } catch (_) {
    // ignore
  }
}

// --------------- Bluesky client ---------------
async function createAgent(service: string, identifier: string, password: string) {
  const agent = new BskyAgent({ service });
  await agent.login({ identifier, password });
  return agent;
}

// --------------- Main ---------------
if (import.meta.main) {
  const env = Deno.env.toObject();
  const service = firstEnv(env, ["BLUESKY_SERVICE"], DEFAULT_BLUESKY_SERVICE);
  const BSKY_HANDLE = firstEnv(env, [
    "BSKY_HANDLE",
    "BSKY_IDENTIFIER",
    "BLUESKY_HANDLE",
    "BLUESKY_IDENTIFIER",
  ]);
  const BSKY_APP_PASSWORD = firstEnv(env, [
    "BSKY_APP_PASSWORD",
    "BLUESKY_APP_PASSWORD",
  ]);
  const BLUESKY_DRYRUN = firstEnv(env, ["BLUESKY_DRYRUN"]);
  if (!BSKY_HANDLE || !BSKY_APP_PASSWORD) {
    console.error(
      "Missing BSKY_HANDLE/BSKY_IDENTIFIER (or BLUESKY_*) and BSKY_APP_PASSWORD (or BLUESKY_APP_PASSWORD) env.",
    );
    Deno.exit(1);
  }
  console.log(`[bluesky] service=${service} identifier=${BSKY_HANDLE}`);

  const { sha, message, author, branch: _branch, repo, commitUrl } = await latestCommitInfo();

  // Gate 1: @publish OR semver
  if (!hasPublishKeyword(message) && !hasSemver(message)) {
    console.log(`[skip] ${shortSha(sha)} — missing both @publish and semver`);
    Deno.exit(0);
  }

  // Gate 2: dedupe
  if (await hasSeenSha(sha)) {
    console.log(`[skip] ${shortSha(sha)} — already posted locally`);
    Deno.exit(0);
  }

  const firstLine = message.split("\n")[0].trim();
  const sanitized = stripCommitHashes(firstLine);
  const condensed = await aiCondense(sanitized);
  const repoUrl = repo ? `https://github.com/${repo}` : "";
  const text = (repoUrl ? `${condensed}\n${repoUrl}` : condensed).trim();
  if (BLUESKY_DRYRUN.toLowerCase() === "on") {
    console.log(`[dryrun] would post: ${text}`);
    Deno.exit(0);
  }

  try {
    const agent = await createAgent(service, BSKY_HANDLE, BSKY_APP_PASSWORD);
    const result = await agent.post({ text });
    await markSeenSha(sha);
    console.log(`[bsky] posted ${shortSha(sha)} —`, result?.uri ?? "ok");
  } catch (err) {
    console.error("Bluesky post failed:", err);
    Deno.exit(1);
  }
}
