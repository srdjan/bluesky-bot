# Bluesky Commit Poster (Deno)

A tiny Deno script that takes the most recent git commit and publishes it to **Bluesky** when the
message contains either a **semantic version** (`1.2.3`, `v2.0.0-beta.1`, …) or the `@publish`
keyword. It is designed to run from a local git hook (e.g. `pre-push`) or as an ad-hoc CLI command.
No servers, webhooks, or external state—just your repo, your environment variables, and the Bluesky
app password flow.

---

## How It Works

1. Loads environment variables from `.env` (and your shell) via `scripts/shared/env.ts`.
2. Reads the latest commit metadata using `git` commands.
3. Skips the post unless the commit message includes a semantic version **or** `@publish`.
4. Dedupes locally by storing posted SHAs in `.git/aug-bluesky-posted`.
5. Optionally condenses the commit title with OpenAI (disabled when no key is present).
6. Logs in with `@atproto/api`’s `BskyAgent` and creates a Bluesky post.

If the script is run with `BLUESKY_DRYRUN=on`, it prints the post instead of publishing.

---

## Requirements

- [Deno](https://deno.land/) 1.41+ (for npm interop).
- A Bluesky handle (or DID) and an [app password](https://account.bsky.app/settings/app-passwords).
- Optional: OpenAI API key for AI-powered summaries.

---

## Environment Variables

| Variable                | Required | Description                                                                 |
| ----------------------- | :------: | --------------------------------------------------------------------------- |
| `BSKY_HANDLE` \| `BLUESKY_IDENTIFIER` | ✅ | Bluesky handle or DID used for posting                                    |
| `BSKY_APP_PASSWORD` \| `BLUESKY_APP_PASSWORD` | ✅ | Bluesky app password with posting rights                          |
| `BLUESKY_SERVICE`       |          | AT Protocol service URL (defaults to `https://bsky.social`)                 |
| `BLUESKY_DRYRUN`        |          | Set to `on` to preview posts without publishing                            |
| `AI_SUMMARY`            |          | `"on"` (default) or `"off"` to toggle OpenAI condensation                   |
| `OPENAI_API_KEY`        |          | Enables AI summarization when present                                      |

Place them in `.env` or export them in your shell. Values from the environment override `.env`.

---

## Quick Start

```bash
# install deps (handled automatically by Deno the first run)
deno run \
  --allow-env --allow-net --allow-run --allow-read --allow-write \
  scripts/bluesky-post.ts
```

For a dry run:

```bash
BLUESKY_DRYRUN=on deno run --allow-env --allow-net --allow-run --allow-read --allow-write scripts/bluesky-post.ts
```

---

## Git Hook Integration

Install the helper hook into your local repository (defaults to `.git/hooks/pre-push`):

```bash
deno task install-hook
```

The installer respects `git config core.hooksPath`, and you can override the destination when needed:

- `deno task install-hook -- --hook=post-commit` installs a different hook name.
- `GIT_HOOK_DIR=.githooks deno task install-hook` targets a custom hooks directory.
- Append `-- --force` to overwrite an existing hook.

For reference (or if you prefer to manage hooks manually), the generated script is:

```bash
#!/usr/bin/env bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
if ! command -v deno >/dev/null 2>&1; then
  echo "deno not found; skipping Bluesky post" >&2
  exit 0
fi
exec deno run --allow-env --allow-net --allow-run --allow-read --allow-write scripts/bluesky-post.ts
```

**What the hook does**

- Posts once per commit (deduped via `.git/aug-bluesky-posted`).
- Requires either a semantic version or `@publish` in the commit title/body.
- Inserts a GitHub commit URL when it can infer `owner/repo` from `remote.origin.url`.

---

## Post Composition Rules

- Uses the first line of the commit message (optionally condensed with OpenAI).
- Removes obvious git SHAs to keep the post tidy.
- Appends the repository URL when available.
- Truncates to Bluesky’s 300-character limit, adding an ellipsis if necessary.

---

## Troubleshooting

- **Missing credentials**: the script exits with an error if handle or app password is absent.
- **Git command failures**: errors now include stderr output for easier debugging.
- **Duplicate posts**: delete or edit `.git/aug-bluesky-posted` if you intentionally need to repost.
- **AI summary issues**: set `AI_SUMMARY=off` or unset `OPENAI_API_KEY` to skip condensation.

---

## Project Layout

```
scripts/
  bluesky-post.ts     # main CLI / hook script
  shared/env.ts       # dotenv loader & env helpers
deno.json             # project tasks and import map (@atproto/api via npm)
deno.lock             # Deno lockfile for reproducible runs
.env                  # (optional) local secrets, read at runtime
```

---

## License

MIT
