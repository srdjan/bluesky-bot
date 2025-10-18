// main.ts
// Deno Deploy webhook for GitHub push → Post on Bluesky.
// - Posts only if head_commit message contains a semantic version
// - Exactly-once per commit via Deno KV
// - Verifies GitHub webhook signature (HMAC-SHA256)
// - Optional AI condensation via OpenAI
//
// Deploy: Deno Deploy (default export handler).
// Local dev: `deno serve --allow-env --allow-net main.ts` then POST sample payloads.

import { BskyAgent } from "@atproto/api";

type Commit = {
  id: string; // full sha
  message: string;
  author?: { name?: string | null } | null;
};

type GitHubPush = {
  ref: string; // e.g., "refs/heads/main"
  repository: {
    full_name: string; // "owner/repo"
    html_url: string;
    default_branch: string;
  };
  head_commit: Commit | null;
};

type PostRecord = {
  postedAt: string; // ISO
  postUri: string;
  statusPreview: string;
};

const kv = await Deno.openKv();

// ---------------- Config ----------------
const {
  GITHUB_WEBHOOK_SECRET = "", // GitHub webhook "secret"
  OPENAI_API_KEY = "",
  AI_SUMMARY = "on",
  BLUESKY_IDENTIFIER = "",
  BLUESKY_APP_PASSWORD = "",
  BLUESKY_SERVICE = "https://bsky.social",
  BRANCH_ONLY = "", // optional: if set, only post when ref matches refs/heads/<BRANCH_ONLY>
  REPO_ALLOWLIST = "", // optional: comma-separated allowlist patterns: owner/repo, owner/*, */repo, or *
} = Deno.env.toObject();

// --------------- Allowlist (per-repo) ---------------
// Patterns: "owner/repo", "owner/*", "*/repo", or "*" (match all).
// Empty allowlist => allow all.
const ALLOW_PATTERNS = new Set(
  REPO_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean),
);

function repoMatchPattern(pattern: string, repo: string): boolean {
  if (pattern === "*") return true;
  const [po, pr] = pattern.split("/");
  const [ro, rr] = repo.split("/");
  const ownerOk = po === "*" || po === ro;
  const repoOk = pr === "*" || pr === rr;
  return ownerOk && repoOk;
}

function repoAllowed(repo: string): boolean {
  if (ALLOW_PATTERNS.size === 0) return true;
  for (const p of ALLOW_PATTERNS) {
    if (repoMatchPattern(p, repo)) return true;
  }
  return false;
}

// --------------- Utilities ---------------
async function hmacSha256Hex(key: string, payload: Uint8Array): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = payload.slice().buffer;
  const sig = await crypto.subtle.sign("HMAC", k, data);
  const bytes = new Uint8Array(sig);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const POST_CHAR_LIMIT = 300;

// --------------- Bluesky client ---------------
let bskyAgent: BskyAgent | null = null;
let agentInit: Promise<BskyAgent> | null = null;

async function getBskyAgent(): Promise<BskyAgent> {
  if (bskyAgent) return bskyAgent;
  if (!BLUESKY_IDENTIFIER || !BLUESKY_APP_PASSWORD) {
    throw new Error("Missing Bluesky credentials");
  }
  if (!agentInit) {
    agentInit = (async () => {
      const agent = new BskyAgent({ service: BLUESKY_SERVICE });
      await agent.login({ identifier: BLUESKY_IDENTIFIER, password: BLUESKY_APP_PASSWORD });
      return agent;
    })();
  }
  try {
    bskyAgent = await agentInit;
    return bskyAgent;
  } catch (err) {
    agentInit = null;
    bskyAgent = null;
    throw err;
  }
}

async function blueskyPostStatus(status: string): Promise<{ uri: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const agent = await getBskyAgent();
      const res = await agent.post({ text: status });
      return { uri: res.uri };
    } catch (err) {
      agentInit = null;
      bskyAgent = null;
      if (attempt === 1) throw err;
    }
  }
  throw new Error("Unable to post to Bluesky");
}

// --------------- GitHub signature verify ---------------
async function verifyGitHubSignature(req: Request, raw: Uint8Array): Promise<boolean> {
  const sig = req.headers.get("x-hub-signature-256");
  if (!sig || !sig.startsWith("sha256=")) return false;
  const their = sig.slice("sha256=".length);
  const ours = await hmacSha256Hex(GITHUB_WEBHOOK_SECRET, raw);
  // constant time compare
  if (their.length !== ours.length) return false;
  let ok = 0;
  for (let i = 0; i < their.length; i++) ok |= their.charCodeAt(i) ^ ours.charCodeAt(i);
  return ok === 0;
}

// --------------- Optional AI condense ---------------
async function aiCondense(text: string): Promise<string> {
  if (!OPENAI_API_KEY || AI_SUMMARY.toLowerCase() === "off") return text;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a concise release/commit summarizer." },
        {
          role: "user",
          content: `Condense to ~20 words, human and specific, no hashtags or quotes:\\n"${text}"`,
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
}

// --------------- Main push handling ---------------
const hasSemver = (msg: string) =>
  /\b(?:v|V)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\b/
    .test(msg);
const shortSha = (sha: string) => sha.slice(0, 7);
const fitPost = (s: string, max = POST_CHAR_LIMIT) => (
  s.length <= max ? s : s.slice(0, max - 1) + "…"
);

async function handlePush(push: GitHubPush) {
  const repo = push.repository.full_name;
  if (!repoAllowed(repo)) {
    console.log(`[skip] ${repo} — not in allowlist`);
    return { status: "skip", reason: "repo_not_allowed" };
  }
  const hc = push.head_commit;
  if (!hc) {
    console.log(`[skip] ${repo} — no head_commit`);
    return { status: "skip", reason: "no_head_commit" };
  }

  // Branch filter: default to repository.default_branch, unless BRANCH_ONLY is set
  const targetBranch = BRANCH_ONLY || push.repository.default_branch;
  const expected = `refs/heads/${targetBranch}`;
  if (push.ref !== expected) {
    console.log(`[skip] ${repo} — ref ${push.ref} != ${expected}`);
    return { status: "skip", reason: "wrong_branch", ref: push.ref, expected };
  }

  // Gate 1: semantic version required
  const fullMsg = hc.message ?? "";
  if (!hasSemver(fullMsg)) {
    console.log(`[skip] ${repo} ${shortSha(hc.id)} — no semantic version`);
    return { status: "skip", reason: "no_semver" };
  }

  const sha = hc.id;
  const tag = `#gh_${shortSha(sha)}`;
  const key = ["posted", repo, sha];

  // Gate 2: dedupe with KV
  const already = await kv.get<PostRecord>(key);
  if (already.value) {
    console.log(`[skip] ${repo} ${shortSha(sha)} — already posted at ${already.value.postedAt}`);
    return { status: "skip", reason: "already_posted", postUri: already.value.postUri };
  }

  // Build post
  const firstLine = fullMsg.split("\n")[0].trim();
  const condensed = await aiCondense(firstLine);
  const commitUrl = `${push.repository.html_url}/commit/${sha}`;
  const author = hc.author?.name ?? "unknown";
  const status = fitPost(
    `${condensed} — ${repo} by ${author} (${shortSha(sha)}) ${commitUrl} ${tag}`,
  );

  // Post
  const bsky = await blueskyPostStatus(status);

  // Persist
  const rec: PostRecord = {
    postedAt: new Date().toISOString(),
    postUri: bsky.uri,
    statusPreview: status,
  };
  await kv.set(key, rec); // Optionally add TTL with { expireIn: ms }

  console.log(`[posted] ${repo} ${shortSha(sha)} — uri=${bsky.uri}`);
  return { status: "posted", postUri: bsky.uri };
}

// --------------- HTTP router ---------------
async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return new Response(JSON.stringify({ ok: true, now: new Date().toISOString() }), {
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "POST" && url.pathname === "/webhook") {
    const raw = new Uint8Array(await req.arrayBuffer());

    if (!GITHUB_WEBHOOK_SECRET) return new Response("Missing secret", { status: 500 });
    const ok = await verifyGitHubSignature(req, raw);
    if (!ok) return new Response("Bad signature", { status: 401 });

    const event = req.headers.get("x-github-event");
    if (event !== "push") return new Response("Ignored event", { status: 202 });

    const payload = JSON.parse(new TextDecoder().decode(raw)) as GitHubPush;
    const result = await handlePush(payload);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "content-type": "application/json" },
    });
  }

  return new Response("Not found", { status: 404 });
}

// Default export for Deno Deploy
const handler = { fetch: route } satisfies Deno.ServeDefaultExport;
export default handler;

// Local dev: also support manual serve if run as a script.
if (import.meta.main) {
  Deno.serve(route);
}
