#!/usr/bin/env -S deno run --allow-env --allow-net --allow-run --allow-read --allow-write

/**
 * @module
 *
 * Bluesky Commit Poster - Automatically posts git commits to Bluesky.
 *
 * Posts commits to Bluesky when the commit message contains either:
 * - A semantic version (e.g., `1.2.3`, `v2.0.0-beta.1`)
 * - The `@publish` keyword
 *
 * Designed to run from git hooks (pre-push, post-commit) or as a CLI command.
 *
 * ## Features
 * - **Trigger-based posting**: Only posts when commit contains semver or @publish
 * - **Local deduplication**: Tracks posted commits in `.git/aug-bluesky-posted`
 * - **AI summarization**: Optional OpenAI integration for condensed messages
 * - **Dry-run mode**: Preview posts without publishing
 * - **GitHub integration**: Automatically adds commit URLs to posts
 *
 * ## Environment Variables
 *
 * **Required:**
 * - `BSKY_HANDLE` - Your Bluesky handle (e.g., "yourname.bsky.social") or DID
 * - `BSKY_APP_PASSWORD` - App password from Bluesky settings
 *
 * **Optional:**
 * - `BLUESKY_SERVICE` - AT Protocol service URL (default: https://bsky.social)
 * - `BLUESKY_DRYRUN=on` - Preview mode, doesn't actually post
 * - `BLUESKY_FORCE=on` - Bypass trigger gates (useful for testing, always shows preview)
 * - `OPENAI_API_KEY` - Enables AI-powered commit message summarization
 * - `AI_SUMMARY=on|off` - Control AI summarization (default: on if key present)
 *
 * @example
 * ```bash
 * # Run manually with dry-run
 * BLUESKY_DRYRUN=on deno run -A jsr:@srdjan/bluesky-bot
 *
 * # Run from git hook (installed via install.ts)
 * git commit -m "feat: new feature v1.0.0"
 * git push  # Automatically posts to Bluesky
 * ```
 */

import { type AppBskyEmbedExternal, BskyAgent, RichText } from "@atproto/api";

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

type ConfigError = { readonly type: "MissingCredentials"; readonly message: string };

// Domain types
type Config = {
  readonly service: string;
  readonly handle: string;
  readonly password: string;
  readonly dryRun: boolean;
};

type RepoData = {
  readonly topics: readonly string[];
  readonly name: string;
  readonly description: string;
  readonly htmlUrl: string;
  readonly homepage?: string;
};

type CommitInfo = {
  readonly sha: string;
  readonly message: string;
  readonly author: string;
  readonly branch: string;
  readonly repo: string;
  readonly commitUrl: string;
  readonly repoData?: RepoData;
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

function topicToHashtag(topic: string): string {
  // Special cases for common tech brands
  const specialCases: Record<string, string> = {
    "typescript": "TypeScript",
    "javascript": "JavaScript",
    "nodejs": "NodeJS",
    "github": "GitHub",
    "webassembly": "WebAssembly",
    "postgresql": "PostgreSQL",
    "mongodb": "MongoDB",
    "graphql": "GraphQL",
  };

  // Check if topic is a special case
  const lowerTopic = topic.toLowerCase();
  if (specialCases[lowerTopic]) {
    return "#" + specialCases[lowerTopic];
  }

  // Convert topic to hashtag with PascalCase
  // Examples: "bluesky-client" → "#BlueskyClient", "deno" → "#Deno"
  return "#" + topic
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

async function fetchGitHubRepoData(repo: string): Promise<RepoData | undefined> {
  if (!repo) return undefined;

  try {
    const response = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "bluesky-bot",
      },
    });

    if (!response.ok) return undefined;

    const data = await response.json();

    // Extract homepage URL if present and non-empty
    const homepage =
      data.homepage && typeof data.homepage === "string" && data.homepage.trim().length > 0
        ? data.homepage.trim()
        : undefined;

    return {
      topics: (data.topics ?? []) as string[],
      name: data.name ?? repo.split("/")[1] ?? repo,
      description: data.description ?? "",
      htmlUrl: data.html_url ?? `https://github.com/${repo}`,
      homepage,
    };
  } catch {
    return undefined;
  }
}

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
  let repoData: RepoData | undefined = undefined;

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
      // Fetch full repo data from GitHub API
      repoData = await fetchGitHubRepoData(repo);
    }
  }

  return ok({ sha, message, author: authorName, branch, repo, commitUrl, repoData });
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

async function aiCondense(text: string, hasTopics: boolean): Promise<string> {
  const env = Deno.env.toObject();
  const aiSummary = firstEnv(env, ["AI_SUMMARY"], "on").toLowerCase();
  const openaiApiKey = firstEnv(env, ["OPENAI_API_KEY"], "");

  if (!openaiApiKey || aiSummary === "off") return text;

  // Adjust prompt based on whether we have repository topics
  const systemPrompt = hasTopics
    ? "You are a concise release/commit summarizer for social media. Write in first-person, author's commentary voice. Be specific and human. Exclude git commit hashes/SHAs. Keep semantic version identifiers if present. DO NOT add hashtags (they will be added from repository topics). No quotes."
    : "You are a concise release/commit summarizer for social media. Write in first-person, author's commentary voice. Be specific and human. Exclude git commit hashes/SHAs. Keep semantic version identifiers if present. Add 2-4 relevant hashtags at the end based on the content (e.g., #TypeScript #Deno #OpenSource #WebDev #Release). No quotes.";

  const userPrompt = hasTopics
    ? `Summarize as a short first-person commentary (~20 words). Do not include any git hashes/SHAs or hashtags. Keep semver if present:\n"${text}"`
    : `Summarize as a short first-person commentary (~20 words), then add 2-4 relevant hashtags. Do not include any git hashes/SHAs. Keep semver if present:\n"${text}"`;

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
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 100,
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

async function shouldPost(commit: CommitInfo, env: Record<string, string>): Promise<boolean> {
  const force = firstEnv(env, ["BLUESKY_FORCE"]).toLowerCase() === "on";

  // Force mode bypasses all gates (useful for testing)
  if (force) {
    console.log(`[force] bypassing trigger gates for testing`);
    return true;
  }

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

function createExternalEmbed(
  repoData: RepoData,
): AppBskyEmbedExternal.Main {
  // Use homepage URL if available, otherwise fall back to GitHub repository URL
  const uri = repoData.homepage ?? repoData.htmlUrl;

  return {
    $type: "app.bsky.embed.external",
    external: {
      uri,
      title: repoData.name,
      description: repoData.description || "GitHub repository",
    },
  };
}

async function composePost(commit: CommitInfo): Promise<string> {
  const firstLine = commit.message.split("\n")[0].trim();
  const sanitized = stripCommitHashes(firstLine);
  const hasTopics = (commit.repoData?.topics.length ?? 0) > 0;

  // AI condense with topic awareness (won't add hashtags if we have topics)
  const condensed = await aiCondense(sanitized, hasTopics);

  // Add repository topics as hashtags
  const topicHashtags = hasTopics && commit.repoData
    ? "\n" + commit.repoData.topics.map(topicToHashtag).join(" ")
    : "";

  // URL will be in the embed card, so don't include it in the text
  // Compose final post: text + topics (URL in embed card)
  const parts = [condensed, topicHashtags].filter(Boolean);
  return parts.join("\n").trim();
}

async function publishPost(
  config: Config,
  commit: CommitInfo,
  text: string,
): Promise<Result<void, BlueskyError>> {
  // Create embed card if we have repo data
  const embed = commit.repoData ? createExternalEmbed(commit.repoData) : undefined;

  if (config.dryRun) {
    console.log(`[dryrun] would post: ${text}`);
    if (embed) {
      console.log(`[dryrun] with embed card:`);
      console.log(`  Title: ${embed.external.title}`);
      console.log(`  URL: ${embed.external.uri}`);
      console.log(`  Description: ${embed.external.description}`);
    }
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

    // Use RichText to detect and create facets for URLs, mentions, etc.
    const richText = new RichText({ text });
    await richText.detectFacets(agent);

    const result = await agent.post({
      text: richText.text,
      facets: richText.facets,
      embed,
      createdAt: new Date().toISOString(),
    });

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
    if (!(await shouldPost(commit, env))) {
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
