# Bluesky Commit Poster (Deno)

A tiny Deno script that takes the most recent git commit and publishes it to **Bluesky** when the
message contains either a **semantic version** (`1.2.3`, `v2.0.0-beta.1`, …) or the `@publish`
keyword. It is designed to run from a local git hook (e.g. `pre-push`) or as an ad-hoc CLI command.
No servers, webhooks, or external state—just your repo, your environment variables, and the Bluesky
app password flow.

---

## How It Works

1. Loads environment variables from `.env` (and your shell).
2. Reads the latest commit metadata using `git` commands.
3. Skips the post unless the commit message includes a semantic version **or** `@publish`.
4. Dedupes locally by storing posted SHAs in `.git/aug-bluesky-posted`.
5. Optionally condenses the commit title with OpenAI (disabled when no key is present).
6. Logs in with `@atproto/api`’s `BskyAgent` and creates a Bluesky post.

If the script is run with `BLUESKY_DRYRUN=on`, it prints the post instead of publishing.

---

## Requirements

- [Deno](https://deno.land/) 2.5+ (for npm interop).
- A Bluesky handle (or DID) and an [app password](https://account.bsky.app/settings/app-passwords).
- Optional: OpenAI API key for AI-powered summaries.

---

## Environment Variables

| Variable                                      | Required | Description                                                 |
| --------------------------------------------- | :------: | ----------------------------------------------------------- |
| `BSKY_HANDLE` \| `BLUESKY_IDENTIFIER`         |    ✅    | Bluesky handle or DID used for posting                      |
| `BSKY_APP_PASSWORD` \| `BLUESKY_APP_PASSWORD` |    ✅    | Bluesky app password with posting rights                    |
| `BLUESKY_SERVICE`                             |          | AT Protocol service URL (defaults to `https://bsky.social`) |
| `BLUESKY_DRYRUN`                              |          | Set to `on` to preview posts without publishing             |
| `AI_SUMMARY`                                  |          | `"on"` (default) or `"off"` to toggle OpenAI condensation   |
| `OPENAI_API_KEY`                              |          | Enables AI summarization when present                       |

Place them in `.env` or export them in your shell. Values from the environment override `.env`.

---

## Installation

### Option 1: JSR Package (Recommended)

Install as a dev dependency in your Deno project:

```bash
# Add to your project
deno add --dev jsr:@srdjan/bluesky-bot

# Run the installer to set up git hook
deno run -A jsr:@srdjan/bluesky-bot/install

# Configure your credentials`
# Edit .env and add BSKY_HANDLE and BSKY_APP_PASSWORD
```

### Option 2: Direct from JSR (No Installation)

Run the installer directly without adding to your project:

```bash
# Install git hook
deno run -A jsr:@srdjan/bluesky-bot/install

# The hook will call jsr:@srdjan/bluesky-bot automatically
```

---

## Quick Start

After installation, test the bot with a dry run:

```bash
# Preview what would be posted
BLUESKY_DRYRUN=on deno run -A jsr:@srdjan/bluesky-bot

# Or use the task (if installed as dev dependency)
deno task test
```

Make a commit with a version or `@publish` keyword:

```bash
git commit -m "feat: new feature v1.0.0"
git push  # Automatically posts to Bluesky!
```

---

## Git Hook Integration

The installer creates a git hook (default: `pre-push`) that automatically runs the bot.

### Custom Hook Name

Install as a different hook (e.g., `post-commit`):

```bash
deno run -A jsr:@srdjan/bluesky-bot/install --hook=post-commit
```

### Force Overwrite

Overwrite an existing hook:

```bash
deno run -A jsr:@srdjan/bluesky-bot/install --force
```

### Advanced Hook Configuration

The installer respects `git config core.hooksPath` and environment variables:

```bash
# Custom hooks directory
GIT_HOOK_DIR=.githooks deno run -A jsr:@srdjan/bluesky-bot/install

# Different hook name
deno run -A jsr:@srdjan/bluesky-bot/install --hook=post-commit

# Force overwrite
deno run -A jsr:@srdjan/bluesky-bot/install --force
```

### Generated Hook Script

For reference, the installer creates this hook script:

```bash
#!/usr/bin/env bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Check if deno is available
if ! command -v deno >/dev/null 2>&1; then
  echo "deno not found; skipping Bluesky post" >&2
  exit 0
fi

# Run the bot from JSR
exec deno run --allow-env --allow-net --allow-run --allow-read --allow-write jsr:@srdjan/bluesky-bot
```

### Hook Behavior

- Posts once per commit (deduped via `.git/aug-bluesky-posted`)
- Requires either a semantic version or `@publish` in the commit message
- Automatically adds GitHub commit URL when available
- Skips gracefully if Deno is not installed

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

## Project Structure

```
mod.ts                # Main bot script (posts commits to Bluesky)
install.ts            # Installer script (sets up git hooks)
deno.json             # JSR package configuration
deno.lock             # Deno lockfile for reproducible runs
LICENSE               # MIT license
.env                  # (git-ignored) Your local credentials
.env.example          # Template for environment variables
```

## Development

If you want to contribute or modify the bot:

```bash
# Clone the repository
git clone https://github.com/srdjan/deno-twitter-webhook-bot.git
cd deno-bsky-bot

# Install dependencies (automatic on first run)
deno cache mod.ts install.ts

# Format code
deno task fmt

# Lint code
deno task lint

# Test locally
BLUESKY_DRYRUN=on deno task post
```

---

Built with ❤️ by Clodey, Gipity & Srdjan

---

## License

MIT
