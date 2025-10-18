// main.ts
// Deno Deploy webhook for GitHub push → Tweet on X/Twitter.
// - Tweets only if head_commit message contains "@publish"
// - Exactly-once per commit via Deno KV
// - Verifies GitHub webhook signature (HMAC-SHA256)
// - Optional AI condensation via OpenAI
//
// Deploy: Deno Deploy (default export handler).
// Local dev: `deno serve --allow-env --allow-net main.ts` then POST sample payloads.

type Commit = {
  id: string;                 // full sha
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

type TweetRecord = {
  tweetedAt: string; // ISO
  tweetId: string;
  statusPreview: string;
};

const kv = await Deno.openKv();

// ---------------- Config ----------------
const {
  GITHUB_WEBHOOK_SECRET = "", // GitHub webhook "secret"
  OPENAI_API_KEY = "",
  AI_SUMMARY = "on",
  X_API_KEY = "",
  X_API_SECRET = "",
  X_ACCESS_TOKEN = "",
  X_ACCESS_TOKEN_SECRET = "",
  BRANCH_ONLY = "", // optional: if set, only tweet when ref matches refs/heads/<BRANCH_ONLY>
  REPO_ALLOWLIST = "", // optional: comma-separated allowlist patterns: owner/repo, owner/*, */repo, or *
} = Deno.env.toObject();


// --------------- Allowlist (per-repo) ---------------
// Patterns: "owner/repo", "owner/*", "*/repo", or "*" (match all).
// Empty allowlist => allow all.
const ALLOW_PATTERNS = new Set(
  REPO_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
);

function repoMatchPattern(pattern: string, repo: string): boolean {
  if (pattern === "*") return true;
  const [po, pr] = pattern.split("/");
  const [ro, rr] = repo.split("/");
  const ownerOk = (po === "*" || po === ro);
  const repoOk = (pr === "*" || pr === rr);
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
function percentEncode(s: string) {
  return encodeURIComponent(s).replace(/[!*()']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function randomString(len = 32) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/[^a-zA-Z0-9]/g, "").slice(0, len);
}
async function hmacSha256Hex(key: string, payload: Uint8Array): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, payload);
  const bytes = new Uint8Array(sig);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacSha1Base64(key: string, base: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(base));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function oauth1Header(method: "POST" | "GET", url: string, params: Record<string, string>) {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: X_API_KEY!,
    oauth_nonce: randomString(16),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: X_ACCESS_TOKEN!,
    oauth_version: "1.0",
  };
  const all: [string, string][] = [];
  for (const [k, v] of Object.entries({ ...params, ...oauthParams })) {
    all.push([percentEncode(k), percentEncode(v)]);
  }
  all.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const paramString = all.map(([k, v]) => `${k}=${v}`).join("&");
  const baseString = [method, percentEncode(url), percentEncode(paramString)].join("&");
  const signingKey = `${percentEncode(X_API_SECRET!)}&${percentEncode(X_ACCESS_TOKEN_SECRET!)}`;
  const signature = await hmacSha1Base64(signingKey, baseString);
  const header = "OAuth " + [
    `oauth_consumer_key="${percentEncode(oauthParams.oauth_consumer_key)}"`,
    `oauth_nonce="${percentEncode(oauthParams.oauth_nonce)}"`,
    `oauth_signature="${percentEncode(signature)}"`,
    `oauth_signature_method="HMAC-SHA1"`,
    `oauth_timestamp="${oauthParams.oauth_timestamp}"`,
    `oauth_token="${percentEncode(oauthParams.oauth_token)}"`,
    `oauth_version="1.0"`,
  ].join(", ");
  return header;
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

// --------------- Twitter/X client ---------------
async function xPostStatus(status: string): Promise<{ id_str: string }> {
  const endpoint = "https://api.twitter.com/1.1/statuses/update.json";
  const auth = await oauth1Header("POST", endpoint, { status });
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": auth,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: `status=${percentEncode(status)}`,
  });
  if (!res.ok) throw new Error(`Twitter ${res.status}: ${await res.text()}`);
  return await res.json();
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
        { role: "user", content: `Condense to ~20 words, human and specific, no hashtags or quotes:\\n"${text}"` },
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
const hasPublishKeyword = (msg: string) => /\B@publish\b/i.test(msg);
const hasSemver = (msg: string) => /\b(?:v|V)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\b/.test(msg);
const shortSha = (sha: string) => sha.slice(0, 7);
const fitTweet = (s: string, max = 280) => (s.length <= max ? s : s.slice(0, max - 1) + "…");

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

  // Gate 1: @publish required
  const fullMsg = hc.message ?? "";
  if (!hasPublishKeyword(fullMsg)) {
    console.log(`[skip] ${repo} ${shortSha(hc.id)} — no @publish`);
    return { status: "skip", reason: "no_publish_keyword" };
  }

  const sha = hc.id;
  const tag = `#gh_${shortSha(sha)}`;
  const key = ["tweeted", repo, sha];

  // Gate 2: dedupe with KV
  const already = await kv.get<TweetRecord>(key);
  if (already.value) {
    console.log(`[skip] ${repo} ${shortSha(sha)} — already tweeted at ${already.value.tweetedAt}`);
    return { status: "skip", reason: "already_tweeted", tweetId: already.value.tweetId };
  }

  // Build tweet
  const firstLine = fullMsg.split("\\n")[0].trim();
  const condensed = await aiCondense(firstLine);
  const commitUrl = ${push.repository.html_url}/commit/${sha};
  const author = hc.author?.name ?? "unknown";
  const status = fitTweet(${condensed} — ${repo} by ${author} (${shortSha(sha)}) ${commitUrl} ${tag});

  // Post
  const tw = await xPostStatus(status);

  // Persist
  const rec: TweetRecord = { tweetedAt: new Date().toISOString(), tweetId: tw.id_str, statusPreview: status };
  await kv.set(key, rec); // Optionally add TTL with { expireIn: ms }

  console.log(`[tweeted] ${repo} ${shortSha(sha)} — id=${{}}tw.id_str`);
  return { status: "tweeted", tweetId: tw.id_str };
}

// --------------- HTTP router ---------------
async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return new Response(JSON.stringify({ ok: true, now: new Date().toISOString() }), { headers: { "content-type": "application/json" } });
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
    return new Response(JSON.stringify(result, null, 2), { headers: { "content-type": "application/json" } });
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
