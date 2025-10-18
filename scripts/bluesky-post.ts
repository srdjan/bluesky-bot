// scripts/bluesky-post.ts
// Post latest commit to Bluesky when commit message contains "@publish" and a semantic version.
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

// Service base (can be overridden via env)
const BLUESKY_SERVICE = Deno.env.get("BLUESKY_SERVICE") ?? "https://bsky.social";

// --------------- Helpers ---------------
const hasPublishKeyword = (msg: string) => /\B@publish\b/i.test(msg);
const hasSemver = (msg: string) =>
  /\b(?:v|V)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\b/
    .test(
      msg,
    );
const shortSha = (sha: string) => sha.slice(0, 7);

async function runGit(args: string[]): Promise<string> {
  const { success, stdout } = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!success) throw new Error(`git ${args.join(" ")} failed`);
  return new TextDecoder().decode(stdout).trim();
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

async function markSeenSha(sha: string): Promise<void> {
  try {
    await Deno.writeTextFile(".git/aug-bluesky-posted", `${sha}\n`, { append: true });
  } catch (_) {
    // ignore
  }
}

// --------------- Bluesky client ---------------
async function createSession(handle: string, appPassword: string) {
  const res = await fetch(`${BLUESKY_SERVICE}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  });
  if (!res.ok) throw new Error(`createSession ${res.status}: ${await res.text()}`);
  return await res.json() as { accessJwt: string; did: string };
}

async function bskyPost(accessJwt: string, did: string, text: string) {
  const res = await fetch(`${BLUESKY_SERVICE}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessJwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repo: did,
      collection: "app.bsky.feed.post",
      record: {
        $type: "app.bsky.feed.post",
        text,
        createdAt: new Date().toISOString(),
      },
    }),
  });
  if (!res.ok) throw new Error(`post ${res.status}: ${await res.text()}`);
  return await res.json();
}

// --------------- Main ---------------
if (import.meta.main) {
  const env = Deno.env.toObject();
  const BSKY_HANDLE = env.BSKY_HANDLE || env.BSKY_IDENTIFIER || "";
  const BSKY_APP_PASSWORD = env.BSKY_APP_PASSWORD || "";
  const BLUESKY_DRYRUN = env.BLUESKY_DRYRUN || "";
  if (!BSKY_HANDLE || !BSKY_APP_PASSWORD) {
    console.error("Missing BSKY_HANDLE/BSKY_IDENTIFIER or BSKY_APP_PASSWORD env.");
    Deno.exit(1);
  }

  const { sha, message, author, branch: _branch, repo, commitUrl } = await latestCommitInfo();

  // Gate 1: @publish + semver
  if (!hasPublishKeyword(message) || !hasSemver(message)) {
    console.log(`[skip] ${shortSha(sha)} — missing @publish or semver`);
    Deno.exit(0);
  }

  // Gate 2: dedupe
  if (await hasSeenSha(sha)) {
    console.log(`[skip] ${shortSha(sha)} — already posted locally`);
    Deno.exit(0);
  }

  const firstLine = message.split("\n")[0].trim();
  const tag = `#gh_${shortSha(sha)}`;
  const byline = repo ? `${repo} by ${author}` : author;
  const suffix = [commitUrl, tag].filter(Boolean).join(" ");
  const text = [firstLine, `— ${byline} (${shortSha(sha)})`, suffix]
    .filter(Boolean)
    .join(" ");

  if (BLUESKY_DRYRUN.toLowerCase() === "on") {
    console.log(`[dryrun] would post: ${text}`);
    Deno.exit(0);
  }

  try {
    const { accessJwt, did } = await createSession(BSKY_HANDLE, BSKY_APP_PASSWORD);
    const result = await bskyPost(accessJwt, did, text);
    await markSeenSha(sha);
    console.log(`[bsky] posted ${shortSha(sha)} —`, result?.uri ?? "ok");
  } catch (err) {
    console.error("Bluesky post failed:", err);
    Deno.exit(1);
  }
}
