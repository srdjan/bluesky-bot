// Minimal Bluesky auth test based on https://docs.bsky.app/docs/get-started
// Usage: deno run --allow-env --allow-net --allow-read scripts/test-bluesky-auth.ts

// Reuse the same .env loader from bluesky-post.ts
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
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (Deno.env.get(key) == null) {
        try { Deno.env.set(key, val); } catch { /* ignore if no permission */ }
      }
    }
  } catch { /* ignore missing .env */ }
}

async function testAuth() {
  loadDotenv();
  const env = Deno.env.toObject();
  const service = env.BLUESKY_SERVICE || "https://bsky.social";
  const identifier = env.BSKY_IDENTIFIER || env.BSKY_HANDLE || env.BLUESKY_IDENTIFIER || env.BLUESKY_HANDLE || "";
  const password = env.BSKY_APP_PASSWORD || env.BLUESKY_APP_PASSWORD || "";

  if (!identifier || !password) {
    console.error("[auth] missing BSKY_IDENTIFIER (or BSKY_HANDLE/BLUESKY_*) and/or BSKY_APP_PASSWORD (or BLUESKY_APP_PASSWORD)");
    Deno.exit(1);
  }

  console.log(`[auth] service=${service} identifier=${identifier}`);

  try {
    const res = await fetch(`${service}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[auth] failed status=${res.status} body=${body}`);
      Deno.exit(1);
    }

    const data = await res.json() as { did?: string; accessJwt?: string };
    console.log(`[auth] success did=${data.did ?? "(unknown)"} jwt=${data.accessJwt ? "(received)" : "(missing)"}`);
  } catch (err) {
    console.error("[auth] error:", err);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await testAuth();
}

