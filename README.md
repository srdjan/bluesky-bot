# GitHub → Bluesky Bot (Deno Deploy + Deno KV)

A tiny webhook service that listens to **GitHub push events** and posts to **Bluesky** **once per
commit** — whenever the head commit message contains a **semantic version** (e.g. `v1.2.3`, `1.2.3`,
or `2.0.0-beta.1`). Add `@publish` if you like an explicit marker, but it’s no longer required. Uses
**Deno KV** for deduplication and verifies webhook signatures for security.

> Single file with the `@atproto/api` SDK. Deploy in minutes via **Deno Deploy**.

---

## Features

- ✅ Post only for **just-pushed head commit**
- ✅ Require a **semantic version** in the commit message (`@publish` is optional)
- ✅ **Exactly-once** per commit via **Deno KV** (`["posted", "<owner>/<repo>", "<sha>"]`)
- ✅ **HMAC-SHA256** GitHub signature verification
- ✅ Optional **LLM condensation** (OpenAI) for short, clear Bluesky posts
- ✅ Health endpoint `/health`

---

## Architecture

```
GitHub (push) ──> Deno Deploy /webhook ──> KV dedupe ──> Bluesky API
                         │
                         └─> /health (GET)
```

- **Entry**: `POST /webhook`
- **Security**: Verify `X-Hub-Signature-256` using `GITHUB_WEBHOOK_SECRET`
- **Gate**: Process **head commit** only, require a semantic version string
- **Dedup**: KV record written after successful post
- **Post**: Bluesky AT Protocol via `@atproto/api` with app password auth

---

## Deploy

### 1) Deno Deploy project

1. Create a new Deno Deploy project and upload `main.ts` from this repo.
2. Add **Environment Variables**:

| Name                    | Required | Description                                                                                 |
| ----------------------- | :------: | ------------------------------------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET` |    ✅    | Shared secret used to verify webhook signatures                                             |
| `BLUESKY_IDENTIFIER`    |    ✅    | Your Bluesky handle or DID                                                                  |
| `BLUESKY_APP_PASSWORD`  |    ✅    | Bluesky [app password](https://account.bsky.app/settings/app-passwords) with posting rights |
| `BLUESKY_SERVICE`       |          | Bluesky service URL (default `https://bsky.social`)                                         |
| `OPENAI_API_KEY`        |          | Enables AI summarization of commit title                                                    |
| `AI_SUMMARY`            |          | `"on"` (default) or `"off"`                                                                 |
| `BRANCH_ONLY`           |          | Optional branch name to restrict posting (e.g. `main`)                                      |
| `REPO_ALLOWLIST`        |          | Comma-separated allowlist: `owner/repo`, `owner/*`, `*/repo`, or `*`                        |

> KV is available automatically on Deno Deploy—no extra binding required.

### 2) GitHub webhook (per repo or org)

- **Payload URL**: `https://<your-deno-deploy-domain>/webhook`
- **Content type**: `application/json`
- **Secret**: the same `GITHUB_WEBHOOK_SECRET`
- **Events**: _Just the push event_

> By default, **only pushes to the repository's `default_branch`** are considered.
>
> Set `BRANCH_ONLY` (e.g., `main`, `release`) to override the default branch filter.

---

## Usage

Add a **semantic version** to the head commit message of your push (`@publish` is optional):

```
feat: introduce streaming CSV export v1.2.3

- Adds /export/csv
- Streams rows in chunks
```

Want the old behaviour? Just include `@publish` alongside the version:

```
feat: introduce streaming CSV export v1.2.3 @publish
```

A Bluesky post like this will be created:

```
introduce streaming CSV export — owner/repo by Alice (3f2a1b9) https://github.com/owner/repo/commit/3f2a1b9… #gh_3f2a1b9
```

- The `#gh_<sha7>` tag helps with traceability and manual audit.
- If the same SHA arrives again, KV prevents a duplicate post.

---

### Per-repo allowlist

Set `REPO_ALLOWLIST` to restrict which repositories can trigger posts.

**Supported patterns**:

- Exact repo: `owner/repo`
- All repos for an owner: `owner/*`
- All owners for a repo name: `*/repo`
- Everything: `*`

**Examples**:

```
REPO_ALLOWLIST="myorg/app1,myorg/*"
REPO_ALLOWLIST="*/docs,*"
REPO_ALLOWLIST=""      # (empty) → allow all repos
```

## Local Development

You can run this locally for manual testing:

```bash
# Set env (example)
export GITHUB_WEBHOOK_SECRET=devsecret
export BLUESKY_IDENTIFIER=example.bsky.social
export BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
export BLUESKY_SERVICE=https://bsky.social
export AI_SUMMARY=off

# Start server (uses Deno KV locally)
deno serve --allow-net --allow-env main.ts
```

Then simulate a GitHub push:

```bash
# Prepare a sample payload
cat <<'EOF' > /tmp/push.sample.json
{
  "ref": "refs/heads/main",
  "repository": {
    "full_name": "owner/repo",
    "html_url": "https://github.com/owner/repo",
    "default_branch": "main"
  },
  "head_commit": {
    "id": "3f2a1b9abc1234567890def0123456789abcdeff",
    "message": "feat: add streaming CSV export v1.2.3\n\n- endpoint /export/csv\n- streams rows",
    "author": {
      "name": "Alice"
    }
  }
}
EOF

payload=/tmp/push.sample.json
sig="sha256=$(echo -n "$(cat ${payload})" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" -binary | xxd -p -c 256)"

curl -i -X POST http://localhost:8000/webhook   -H "content-type: application/json"   -H "x-github-event: push"   -H "x-hub-signature-256: $sig"   --data @"$payload"
```

Health check:

```bash
curl http://localhost:8000/health
```

---

## Local Git Hook (Bluesky, no GitHub webhook)

If you prefer posting to Bluesky from your local machine without using a GitHub webhook, use the
provided CLI script and a local git hook.

1. Configure environment (e.g., in your shell profile or a local .env you source)

```bash
export BSKY_IDENTIFIER="yourname.bsky.social"   # or DID
env | grep -q BSKY_APP_PASSWORD || export BSKY_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
# Optional
export BLUESKY_SERVICE="https://bsky.social"
export BLUESKY_DRYRUN=off
```

2. Install a pre-push hook that calls the script

Create .git/hooks/pre-push and make it executable (chmod +x .git/hooks/pre-push):

```bash
#!/usr/bin/env bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
if ! command -v deno >/dev/null 2>&1; then
  echo "deno not found; skipping Bluesky post" >&2
  exit 0
fi
# The script handles @publish + semver gating and dedupe
# Requires: --allow-env --allow-net --allow-run --allow-read --allow-write
exec deno run --allow-env --allow-net --allow-run --allow-read --allow-write scripts/bluesky-post.ts
```

3. Behavior

- Runs on git push from your local machine
- Posts when the latest commit message contains @publish OR a semantic version (e.g., v1.2.3)
- Stores seen SHAs in .git/aug-bluesky-posted to avoid duplicates locally
- Best-effort: if remote is GitHub, the post includes a commit URL

> Note: Git hooks run locally and are not shared; consider committing a template under .githooks/
> and instruct contributors to enable core.hooksPath.

---

## Configuration & Behavior

- **Exactly-once**: KV key `["posted", "<owner>/<repo>", "<sha>"]` is written after success. You can
  add TTL:
  ```ts
  await kv.set(key, rec, { expireIn: 1000 * 60 * 60 * 24 * 365 * 2 });
  ```

- **Branch filtering**: Set `BRANCH_ONLY` to restrict posting to that branch.

- **AI condensation**: Toggle with `AI_SUMMARY=on|off`. Uses `gpt-4o-mini` for a terse, specific
  first line.

- **Post composition**:
  - compressed first line
  - `— <owner/repo> by <author> (<sha7>) <commit-url> #gh_<sha7>`
  - truncated to 300 characters (Bluesky post limit)

---

## Security Notes

- **Webhook signature** is required; requests without a valid `X-Hub-Signature-256` are **401**.
- Keep your **Bluesky credentials** write-scoped and rotate if compromised.
- Consider setting `BRANCH_ONLY` (e.g. `main`) to prevent unintended posts from topic branches.
- Limit who can push to the posting branch.

---

## Extending

| Need                                             | How                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Post for every semantic-version commit in a push | Iterate `payload.commits` and run the same KV-guarded post for each |
| Include PR number/title                          | Resolve PR via GitHub API when message suggests a merge/squash      |
| Multi-network syndication                        | Add Mastodon/other adapters (token-only flows)                      |
| Structured logs                                  | Write post attempts/outcomes to KV or external sink                 |

---

## License

MIT
