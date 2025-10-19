# Bluesky Commit Poster (Deno)

A tiny Deno script that takes the most recent git commit and publishes it to **Bluesky** when the
message contains either a **semantic version** (`1.2.3`, `v2.0.0-beta.1`, …) or the `@publish`
keyword. It is designed to run from a local git hook (e.g. `pre-push`) or as an ad-hoc CLI command.
No servers, webhooks, or external state—just your repo, your environment variables, and the Bluesky
app password flow.

## Key Features

- 🎯 **Smart Hashtags**: Automatically uses GitHub repository topics as hashtags
- 🤖 **AI Summarization**: Optional OpenAI integration for concise commit messages
- ✅ **Credential Validation**: Test your setup before first use
- 🔄 **Local Deduplication**: Prevents duplicate posts
- 🌐 **GitHub Integration**: Automatically adds commit URLs
- 🧪 **Dry-Run Mode**: Preview posts without publishing

---

## How It Works

1. Loads environment variables from `.env` (and your shell).
2. Reads the latest commit metadata using `git` commands.
3. Skips the post unless the commit message includes a semantic version **or** `@publish`.
4. Dedupes locally by storing posted SHAs in `.git/aug-bluesky-posted`.
5. **Fetches GitHub repository topics** and converts them to hashtags (e.g., `deno` → `#Deno`).
6. Optionally condenses the commit title with OpenAI (disabled when no key is present).
7. Logs in with `@atproto/api`'s `BskyAgent` and creates a Bluesky post with hashtags.

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

After installation, validate your credentials and test the bot:

```bash
# 1. Validate your configuration
deno task validate --test-auth

# 2. Preview what would be posted (dry-run)
deno task test

# 3. Make a commit with a version or @publish keyword
git commit -m "feat: new feature v1.0.0"
git push  # Automatically posts to Bluesky!
```

### First-Time Setup Checklist

- [ ] Install the bot: `deno run -A jsr:@srdjan/bluesky-bot/install`
- [ ] Edit `.env` and add your Bluesky credentials
- [ ] Validate credentials: `deno task validate --test-auth`
- [ ] (Optional) Set GitHub repository topics for hashtags
- [ ] Test with dry-run: `deno task test`
- [ ] Push a commit with `v1.0.0` or `@publish`

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
- **Automatically appends hashtags from GitHub repository topics** (if available).
- Falls back to AI-generated hashtags if repository has no topics.
- Appends the repository URL when available.
- Truncates to Bluesky's 300-character limit, adding an ellipsis if necessary.

---

## GitHub Topics as Hashtags

The bot automatically fetches your repository's GitHub topics and converts them to hashtags in your
posts.

### How It Works

**If your repository has topics set:**

```
GitHub Topics: ["deno", "typescript", "bluesky-client"]
Post includes: #Deno #TypeScript #BlueskyClient
```

**If your repository has no topics:**

- The AI (if enabled) generates contextual hashtags based on the commit message
- Or posts without hashtags if AI is disabled

### Setting GitHub Topics

1. Go to your repository on GitHub
2. Click "⚙️ Settings" (or edit the About section)
3. Add topics like: `deno`, `typescript`, `cli-tool`, etc.
4. The bot automatically fetches and converts them to proper hashtags

### Hashtag Formatting

The bot intelligently formats topics into hashtags:

- **Special brands**: `typescript` → `#TypeScript`, `javascript` → `#JavaScript`
- **Hyphenated topics**: `bluesky-client` → `#BlueskyClient`
- **Single words**: `deno` → `#Deno`

**Supported special cases:**

- TypeScript, JavaScript, NodeJS, GitHub
- PostgreSQL, MongoDB, GraphQL, WebAssembly

### Example Post

```
Commit: "Add validation feature v1.2.0 @publish"
Topics: ["deno", "typescript", "cli-tool"]

Posted to Bluesky:
───────────────────
Added credential validation in v1.2.0 - users can now test their
setup before first use!

#Deno #TypeScript #CliTool
https://github.com/yourname/yourrepo
```

---

## Validation and Testing

### Validate Your Configuration

Before using the bot, validate your setup:

```bash
# Check configuration only
deno task validate

# Test credentials against Bluesky API
deno task validate --test-auth
```

The validator checks:

- ✅ `.env` file exists
- ✅ Required environment variables are set
- ✅ Credential format is valid
- ✅ (Optional) Credentials work with Bluesky API

### Example Validation Output

```
=== Bluesky Bot Configuration Validation ===

✓ .env file: found
✓ BSKY_HANDLE: set
  ✓ Format: valid (yourname.bsky.social)
✓ BSKY_APP_PASSWORD: set
✓ Service: https://bsky.social

✓ Authentication: SUCCESS
  DID: did:plc:xxxxxxxxxxxxx

=== Summary ===

✓ Configuration is valid!
```

---

## Troubleshooting

### Common Issues

**Missing credentials**

- Run `deno task validate --test-auth` to identify missing variables
- Check that `.env` file exists and has correct values
- Get app password at: https://account.bsky.app/settings/app-passwords

**Git command failures**

- Errors now include stderr output for easier debugging
- Ensure you're in a git repository
- Check that `git` is installed and in PATH

**Duplicate posts**

- Delete or edit `.git/aug-bluesky-posted` to clear posted commit history
- This is safe - it's just a local deduplication file

**AI summary issues**

- Set `AI_SUMMARY=off` in `.env` to disable AI summarization
- Or unset `OPENAI_API_KEY` to skip condensation
- Bot works fine without AI - it uses commit message as-is

**No hashtags appearing**

- Check if your repository has GitHub topics set
- Run: `curl https://api.github.com/repos/owner/repo | grep topics`
- If no topics, enable AI or manually add topics to your repository

**Hook not firing**

- Check hook is executable: `ls -la .git/hooks/pre-push`
- Verify deno is in PATH: `which deno`
- Check hook logs in terminal during `git push`

---

## Project Structure

```
mod.ts                # Main bot script (posts commits to Bluesky)
install.ts            # Installer script (sets up git hooks)
validate.ts           # Credential validation script
deno.json             # JSR package configuration & tasks
deno.lock             # Deno lockfile for reproducible runs
LICENSE               # MIT license
.env                  # (git-ignored) Your local credentials
.env.example          # Enhanced template with inline documentation
CLAUDE.md             # Project documentation for AI assistants
README.md             # This file
```

### Available Tasks

```bash
deno task install     # Install git hook (same as setup)
deno task setup       # Install git hook (alias for install)
deno task validate    # Validate credentials and configuration
deno task post        # Post latest commit to Bluesky
deno task test        # Dry-run mode (preview without posting)
deno task fmt         # Format code
deno task lint        # Lint code
```

## Development

If you want to contribute or modify the bot:

```bash
# Clone the repository
git clone https://github.com/srdjan/bluesky-bot.git
cd bluesky-bot

# Install dependencies (automatic on first run)
deno cache mod.ts install.ts validate.ts

# Format code
deno task fmt

# Lint code
deno task lint

# Validate configuration
deno task validate --test-auth

# Test locally (dry-run)
deno task test

# Run the bot
deno task post
```

### Development Workflow

1. Make changes to `mod.ts`, `install.ts`, or `validate.ts`
2. Format: `deno task fmt`
3. Lint: `deno task lint`
4. Test with dry-run: `deno task test`
5. Validate: `deno task validate --test-auth`
6. Commit and push

### Key Architecture

- **Light FP pattern**: Pure functions, Result types, minimal side effects
- **No external dependencies**: Custom dotenv parser, minimal npm imports
- **GitHub API integration**: Fetches repository topics for hashtags
- **Bluesky API**: Uses `@atproto/api` for posting
- **Local state**: Deduplication via `.git/aug-bluesky-posted`

---

Built with ❤️ by Clodey, Gipity & Srdjan

---

## License

MIT
