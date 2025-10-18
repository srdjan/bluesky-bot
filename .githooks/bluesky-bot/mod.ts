#!/usr/bin/env -S deno run --allow-env --allow-net --allow-run --allow-read --allow-write

// .githooks/bluesky-bot/mod.ts
// Post latest commit to Bluesky when commit message contains "@publish" or a semantic version.
// Intended to be run from a local git hook (e.g., pre-push or post-commit).
//
// Required env:
//   BSKY_HANDLE          e.g. "yourname.bsky.social" (or DID)
//   BSKY_APP_PASSWORD    app password from Bluesky settings
// Optional env:
//   BLUESKY_DRYRUN=on    don't post, just print
//   AI_SUMMARY=on/off    enable/disable OpenAI summarization (default: on if key present)
//   OPENAI_API_KEY       enables AI-powered summary
//   BLUESKY_SERVICE      AT Protocol service URL (default: https://bsky.social)
//
// Deduplication: Uses .git/aug-bluesky-posted to track posted commit SHAs locally.

import { BskyAgent } from "@atproto/api";

// =============== Constants ===============

const DEDUPE_FILE_PATH = ".git/aug-bluesky-posted" as const;
const DEFAULT_BLUESKY_SERVICE = "https://bsky.social" as const;
const OPENAI_MODEL = "gpt-4o-mini" as const;
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions" as const;
const SEMVER_REGEX =
  /\b(?:v|V)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\b/;
const PUBLISH_KEYWORD_REGEX = /\B@publish\b/i;

// =============== Types ===============

// Result type for explicit error handling (Light FP pattern)
type Ok<T> = { readonly ok: true; readonly value: T };
type Err<E> = { readonly ok: false; readonly error: E };
type Result<T, E> = Ok<T> | Err<E>;

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const err = <E>(error: E): Err<E> => ({ ok: false, error });

// Error types
type GitError =
  | { readonly type: "CommandFailed"; readonly stderr: string; readonly command: string }
  | { readonly type: "ParseError"; readonly message: string };

type BlueskyError =
  | { readonly type: "AuthFailed"; readonly message: string }
  | { readonly type: "PostFailed"; readonly message: string };

type ConfigError =
  | { readonly type: "MissingCredentials"; readonly message: string };

// Domain types
type Config = {
  readonly service: string;
  readonly handle: string;
  readonly password: string;
  readonly dryRun: boolean;
};

type CommitInfo = {
  readonly sha: string;
  readonly message: string;
  readonly author: string;
  readonly branch: string;
  readonly repo: string;
  readonly commitUrl: string;
};

// =============== Inlined Environment Utilities ===============

function loadDotenv(file: string = ".env"): void {
  try {
    const txt = Deno.readTextFileSync(file);
    for (const rawLine of txt.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      let key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (key.toLowerCase().startsWith("export ")) key = key.slice(7).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (Deno.env.get(key) == null) {
        try {
          Deno.env.set(key, val);
        } catch {
          // ignore if permissions are missing
        }
      }
    }
  } catch {
    // ignore missing .env
  }
}

function firstEnv(
  env: Record<string, string>,
  keys: string[],
  fallback = "",
): string {
  for (const key of keys) {
    const value = env[key];
    if (value && value.length > 0) return value;
  }
  return fallback;
}

// =============== Configuration ===============

const textDecoder = new TextDecoder();

// =============== Utility Functions ===============

function stripCommitHashes(input: string): string {
  // remove likely git SHAs (7 to 40 hex chars)
  const noShas = input.replace(/\b[0-9a-f]{7,40}\b/gi, "");
  return noShas.replace(/\s{2,}/g, " ").trim();
}

const hasPublishKeyword = (msg: string): boolean => PUBLISH_KEYWORD_REGEX.test(msg);
const hasSemver = (msg: string): boolean => SEMVER_REGEX.test(msg);
const shortSha = (sha: string): string => sha.slice(0, 7);

async function runGit(args: string[]): Promise<Result<string, GitError>> {
  try {
    const { success, stdout, stderr } = await new Deno.Command("git", {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();

    if (!success) {
      return err({
        type: "CommandFailed",
        stderr: textDecoder.decode(stderr).trim(),
        command: `git ${args.join(" ")}`,
      });
    }

    return ok(textDecoder.decode(stdout).trim());
  } catch (e) {
    return err({
      type: "CommandFailed",
      stderr: e instanceof Error ? e.message : String(e),
      command: `git ${args.join(" ")}`,
    });
  }
}

async function latestCommitInfo(): Promise<Result<CommitInfo, GitError>> {
  // Batch git operations: get SHA, message, and author in one call
  // Format: SHA\n---MESSAGE-SEPARATOR---\nMESSAGE\n---AUTHOR-SEPARATOR---\nAUTHOR
  const batchResult = await runGit([
    "log",
    "-1",
    "--pretty=%H%n---MESSAGE-SEPARATOR---\n%B---AUTHOR-SEPARATOR---\n%an",
  ]);

  if (!batchResult.ok) {
    return err(batchResult.error);
  }

  const batchOutput = batchResult.value;
  const parts = batchOutput.split("---MESSAGE-SEPARATOR---\n");

  if (parts.length < 2) {
    return err({
      type: "ParseError",
      message: "Failed to parse git log output",
    });
  }

  const sha = parts[0].trim();
  const messagePart = parts[1];
  const messageParts = messagePart.split("---AUTHOR-SEPARATOR---\n");

  if (messageParts.length < 2) {
    return err({
      type: "ParseError",
      message: "Failed to parse message and author from git log",
    });
  }

  const messageBody = messageParts[0];
  const author = messageParts[1];
  const message = messageBody.trim();
  const authorName = author.trim();

  // Get branch separately (requires different git command)
  const branchResult = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branchResult.ok) {
    return err(branchResult.error);
  }
  const branch = branchResult.value;

  let repo = "";
  let commitUrl = "";

  const remoteResult = await runGit(["config", "--get", "remote.origin.url"]);
  if (remoteResult.ok) {
    const remoteUrl = remoteResult.value;
    // Parse GitHub SSH/HTTPS URLs → owner/repo
    // Supports formats like:
    //  - git@github.com:owner/repo.git
    //  - https://github.com/owner/repo.git
    const m = remoteUrl.match(/github.com[:/](.+?)\/(.+?)(?:\.git)?$/);
    if (m) {
      repo = `${m[1]}/${m[2]}`;
      commitUrl = `https://github.com/${repo}/commit/${sha}`;
    }
  }

  return ok({ sha, message, author: authorName, branch, repo, commitUrl });
}

// =============== Deduplication (local file) ===============

async function hasSeenSha(sha: string): Promise<boolean> {
  try {
    const data = await Deno.readTextFile(DEDUPE_FILE_PATH);
    return data.split("\n").some((l) => l.trim() === sha);
  } catch (_) {
    return false;
  }
}

async function markSeenSha(sha: string): Promise<void> {
  try {
    await Deno.writeTextFile(DEDUPE_FILE_PATH, `${sha}\n`, {
      append: true,
    });
  } catch (_) {
    // ignore
  }
}

// =============== Optional AI Condense ===============

async function aiCondense(text: string): Promise<string> {
  const env = Deno.env.toObject();
  const aiSummary = firstEnv(env, ["AI_SUMMARY"], "on").toLowerCase();
  const openaiApiKey = firstEnv(env, ["OPENAI_API_KEY"], "");

  if (!openaiApiKey || aiSummary === "off") return text;
  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a concise release/commit summarizer. Write in first-person, author's commentary voice. Be specific and human. Exclude git commit hashes/SHAs. Keep semantic version identifiers if present. No hashtags or quotes.",
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

// =============== Bluesky Client ===============

async function createAgent(
  service: string,
  identifier: string,
  password: string,
): Promise<Result<BskyAgent, BlueskyError>> {
  try {
    const agent = new BskyAgent({ service });
    await agent.login({ identifier, password });
    return ok(agent);
  } catch (e) {
    return err({
      type: "AuthFailed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

// =============== Main Workflow Functions ===============

function loadConfig(env: Record<string, string>): Result<Config, ConfigError> {
  const service = firstEnv(env, ["BLUESKY_SERVICE"], DEFAULT_BLUESKY_SERVICE);
  const handle = firstEnv(env, [
    "BSKY_HANDLE",
    "BSKY_IDENTIFIER",
    "BLUESKY_HANDLE",
    "BLUESKY_IDENTIFIER",
  ]);
  const password = firstEnv(env, [
    "BSKY_APP_PASSWORD",
    "BLUESKY_APP_PASSWORD",
  ]);
  const dryRun = firstEnv(env, ["BLUESKY_DRYRUN"]).toLowerCase() === "on";

  if (!handle || !password) {
    return err({
      type: "MissingCredentials",
      message:
        "Missing BSKY_HANDLE/BSKY_IDENTIFIER (or BLUESKY_*) and BSKY_APP_PASSWORD (or BLUESKY_APP_PASSWORD) env.",
    });
  }

  return ok({ service, handle, password, dryRun });
}

async function shouldPost(commit: CommitInfo): Promise<boolean> {
  // Gate 1: @publish OR semver
  if (!hasPublishKeyword(commit.message) && !hasSemver(commit.message)) {
    console.log(
      `[skip] ${shortSha(commit.sha)} — missing both @publish and semver`,
    );
    return false;
  }

  // Gate 2: dedupe
  if (await hasSeenSha(commit.sha)) {
    console.log(`[skip] ${shortSha(commit.sha)} — already posted locally`);
    return false;
  }

  return true;
}

async function composePost(commit: CommitInfo): Promise<string> {
  const firstLine = commit.message.split("\n")[0].trim();
  const sanitized = stripCommitHashes(firstLine);
  const condensed = await aiCondense(sanitized);
  const repoUrl = commit.repo ? `https://github.com/${commit.repo}` : "";
  return (repoUrl ? `${condensed}\n${repoUrl}` : condensed).trim();
}

async function publishPost(
  config: Config,
  commit: CommitInfo,
  text: string,
): Promise<Result<void, BlueskyError>> {
  if (config.dryRun) {
    console.log(`[dryrun] would post: ${text}`);
    return ok(undefined);
  }

  const agentResult = await createAgent(
    config.service,
    config.handle,
    config.password,
  );

  if (!agentResult.ok) {
    return err(agentResult.error);
  }

  try {
    const agent = agentResult.value;
    const result = await agent.post({ text });
    await markSeenSha(commit.sha);
    console.log(`[bsky] posted ${shortSha(commit.sha)} —`, result?.uri ?? "ok");
    return ok(undefined);
  } catch (e) {
    return err({
      type: "PostFailed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

// =============== Main Entry Point ===============

async function run(): Promise<number> {
  try {
    loadDotenv();
    const env = Deno.env.toObject();

    // Load configuration
    const configResult = loadConfig(env);
    if (!configResult.ok) {
      console.error(
        `[error] Configuration failed: ${configResult.error.message}`,
      );
      return 1;
    }
    const config = configResult.value;

    console.log(
      `[bluesky] service=${config.service} identifier=${config.handle}`,
    );

    // Get commit info
    const commitResult = await latestCommitInfo();
    if (!commitResult.ok) {
      const { error } = commitResult;
      if (error.type === "CommandFailed") {
        console.error(
          `[error] Git command failed: ${error.command}\n${error.stderr}`,
        );
      } else {
        console.error(`[error] Parse error: ${error.message}`);
      }
      return 1;
    }
    const commit = commitResult.value;

    // Check if we should post
    if (!(await shouldPost(commit))) {
      return 0;
    }

    // Compose post text
    const text = await composePost(commit);

    // Publish the post
    const publishResult = await publishPost(config, commit, text);
    if (!publishResult.ok) {
      const { error } = publishResult;
      if (error.type === "AuthFailed") {
        console.error(`[error] Authentication failed: ${error.message}`);
      } else {
        console.error(`[error] Post failed: ${error.message}`);
      }
      return 1;
    }

    return 0;
  } catch (err) {
    console.error("Unexpected error:", err);
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await run();
  Deno.exit(exitCode);
}
