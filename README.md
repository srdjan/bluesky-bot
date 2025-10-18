# GitHub → Twitter Bot (Deno Deploy + Deno KV)

A tiny webhook service that listens to **GitHub push events** and posts to **X/Twitter** **once per commit** — but **only** when the head commit message contains `@publish` **and** a **semantic version** (e.g. `v1.2.3`, `1.2.3`, or `2.0.0-beta.1`). Uses **Deno KV** for deduplication and verifies webhook signatures for security.

> Single file, no deps. Deploy in minutes via **Deno Deploy**.

---

## Features

- ✅ Post only for **just-pushed head commit**
- ✅ Require **`@publish`** in the commit message
- ✅ **Exactly-once** per commit via **Deno KV** (`["tweeted", "<owner>/<repo>", "<sha>"]`)
- ✅ **HMAC-SHA256** GitHub signature verification
- ✅ Optional **LLM condensation** (OpenAI) for short, clear tweets
- ✅ Health endpoint `/health`

---

## Architecture

```
GitHub (push) ──> Deno Deploy /webhook ──> KV dedupe ──> X/Twitter API
                         │
                         └─> /health (GET)
```

- **Entry**: `POST /webhook`
- **Security**: Verify `X-Hub-Signature-256` using `GITHUB_WEBHOOK_SECRET`
- **Gate**: Process **head commit** only, require `@publish`
- **Dedup**: KV record written after successful tweet
- **Tweet**: OAuth 1.0a user-context post to `statuses/update.json`

---

## Deploy

### 1) Deno Deploy project

1. Create a new Deno Deploy project and upload `main.ts` from this repo.
2. Add **Environment Variables**:

| Name | Required | Description |
|---|:---:|---|
| `GITHUB_WEBHOOK_SECRET` | ✅ | Shared secret used to verify webhook signatures |
| `X_API_KEY` | ✅ | X/Twitter API key |
| `X_API_SECRET` | ✅ | X/Twitter API key secret |
| `X_ACCESS_TOKEN` | ✅ | X access token (user context, write perms) |
| `X_ACCESS_TOKEN_SECRET` | ✅ | X access token secret |
| `OPENAI_API_KEY` |  | Enables AI summarization of commit title |
| `AI_SUMMARY` |  | `"on"` (default) or `"off"` |
| `BRANCH_ONLY` |  | Optional branch name to restrict posting (e.g. `main`) |
| `REPO_ALLOWLIST` |  | Comma-separated allowlist: `owner/repo`, `owner/*`, `*/repo`, or `*` |

> KV is available automatically on Deno Deploy—no extra binding required.

### 2) GitHub webhook (per repo or org)

- **Payload URL**: `https://<your-deno-deploy-domain>/webhook`
- **Content type**: `application/json`
- **Secret**: the same `GITHUB_WEBHOOK_SECRET`
- **Events**: *Just the push event*

> By default, **only pushes to the repository's `default_branch`** are considered.
>
> Set `BRANCH_ONLY` (e.g., `main`, `release`) to override the default branch filter.

---

## Usage

Add `@publish` **and a semantic version** to the head commit message of your push:

```
feat: introduce streaming CSV export v1.2.3 @publish

- Adds /export/csv
- Streams rows in chunks
```

A tweet like this will be posted:

```
introduce streaming CSV export — owner/repo by Alice (3f2a1b9) https://github.com/owner/repo/commit/3f2a1b9… #gh_3f2a1b9
```

- The `#gh_<sha7>` tag helps with traceability and manual audit.
- If the same SHA arrives again, KV prevents a duplicate tweet.

---


### Per-repo allowlist

Set `REPO_ALLOWLIST` to restrict which repositories can trigger tweets.

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
export X_API_KEY=key
export X_API_SECRET=secret
export X_ACCESS_TOKEN=token
export X_ACCESS_TOKEN_SECRET=tokensecret
export AI_SUMMARY=off

# Start server (uses Deno KV locally)
deno serve --allow-net --allow-env main.ts
```

Then simulate a GitHub push:

```bash
# Prepare a sample payload (already included under payloads/push.sample.json)
payload=payloads/push.sample.json
sig="sha256=$(echo -n "$(cat ${payload})" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" -binary | xxd -p -c 256)"

curl -i -X POST http://localhost:8000/webhook   -H "content-type: application/json"   -H "x-github-event: push"   -H "x-hub-signature-256: $sig"   --data @"$payload"
```

Health check:

```bash
curl http://localhost:8000/health
```

---

## Configuration & Behavior

- **Exactly-once**: KV key `["tweeted", "<owner>/<repo>", "<sha>"]` is written after success. You can add TTL:
  ```ts
  await kv.set(key, rec, { expireIn: 1000 * 60 * 60 * 24 * 365 * 2 });
  ```

- **Branch filtering**: Set `BRANCH_ONLY` to restrict posting to that branch.

- **AI condensation**: Toggle with `AI_SUMMARY=on|off`. Uses `gpt-4o-mini` for a terse, specific first line.

- **Tweet composition**:
  - compressed first line
  - `— <owner/repo> by <author> (<sha7>) <commit-url> #gh_<sha7>`
  - truncated to 280 characters

---

## Security Notes

- **Webhook signature** is required; requests without a valid `X-Hub-Signature-256` are **401**.
- Keep your **Twitter credentials** write-scoped and rotate if compromised.
- Consider setting `BRANCH_ONLY` (e.g. `main`) to prevent unintended tweets from topic branches.
- Limit who can push to the tweeting branch.

---

## Extending

| Need | How |
|---|---|
| Tweet for every `@publish` commit in a push | Iterate `payload.commits` and run the same KV-guarded post for each |
| Include PR number/title | Resolve PR via GitHub API when message suggests a merge/squash |
| Multi-network syndication | Add Mastodon/Bluesky adapters (token-only flows) |
| Structured logs | Write tweet attempts/outcomes to KV or external sink |

---

## License

MIT
