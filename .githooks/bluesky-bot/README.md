# Bluesky Bot - Git Hook Integration

Automatically post your git commits to Bluesky when they contain a semantic version or `@publish` keyword. Perfect for release announcements and project updates!

## Features

- 🎯 **Smart Triggers**: Posts only when commit contains semantic version (`v1.2.3`) or `@publish` keyword
- 🔒 **Local Deduplication**: Tracks posted commits in `.git/aug-bluesky-posted` to prevent duplicates
- 🤖 **AI Summarization**: Optional OpenAI-powered commit message condensation
- 🔗 **Auto-linking**: Automatically includes GitHub repository and commit URLs
- 🏃 **Zero Dependencies**: Self-contained script, just needs Deno
- 🧪 **Dry Run Mode**: Test posts before they go live

## Quick Start

### 1. Install the Bot

Copy the `.githooks/bluesky-bot/` folder to your repository, then run:

```bash
deno run --allow-env --allow-run --allow-read --allow-write .githooks/bluesky-bot/install.ts
```

This will:
- ✅ Install the pre-push git hook
- ✅ Create `.env` from `.env.example` (if it doesn't exist)
- ✅ Validate the installation

### 2. Configure Credentials

Edit `.env` in your repository root:

```bash
BSKY_HANDLE=yourname.bsky.social
BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

**Important**: Generate an app password at [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords) - don't use your account password!

### 3. Test It

Run a dry-run test:

```bash
BLUESKY_DRYRUN=on deno run --allow-env --allow-net --allow-run --allow-read --allow-write .githooks/bluesky-bot/mod.ts
```

If you see output like `[dryrun] would post: ...`, you're all set!

## Usage

Once installed, the bot runs automatically on git push (via the `pre-push` hook). Posts are created when:

1. **Commit contains a semantic version**: `v1.2.3`, `2.0.0-beta.1`, etc.
2. **OR commit contains `@publish`**: Anywhere in the commit message

### Example Commit Messages That Trigger Posts

```bash
git commit -m "Release v1.0.0 - Initial public release"
git commit -m "Shipped the new dashboard feature @publish"
git commit -m "2.1.0: Added user authentication"
```

### Example Commit Messages That DON'T Trigger Posts

```bash
git commit -m "Fix typo in README"
git commit -m "WIP: refactoring auth module"
git commit -m "Updated dependencies"
```

## Configuration Options

All configuration is done via environment variables in `.env`:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BSKY_HANDLE` | ✅ | - | Your Bluesky handle or DID |
| `BSKY_APP_PASSWORD` | ✅ | - | Bluesky app password |
| `BLUESKY_SERVICE` | ❌ | `https://bsky.social` | AT Protocol service URL |
| `BLUESKY_DRYRUN` | ❌ | `off` | Set to `on` to preview without posting |
| `AI_SUMMARY` | ❌ | `on` | Enable/disable AI summarization |
| `OPENAI_API_KEY` | ❌ | - | Enables AI-powered message condensation |

## Advanced Installation Options

### Install to a Different Hook

Install to `post-commit` instead of `pre-push`:

```bash
deno run -A .githooks/bluesky-bot/install.ts --hook=post-commit
```

### Custom Hook Directory

If your repository uses a custom hooks directory:

```bash
git config core.hooksPath .githooks
deno run -A .githooks/bluesky-bot/install.ts
```

Or set it via environment variable:

```bash
GIT_HOOK_DIR=.githooks deno run -A .githooks/bluesky-bot/install.ts
```

### Force Overwrite Existing Hook

```bash
deno run -A .githooks/bluesky-bot/install.ts --force
```

## How It Works

1. **Hook Trigger**: Git hook runs on push
2. **Commit Check**: Reads latest commit message
3. **Gate 1**: Checks for semantic version OR `@publish` keyword
4. **Gate 2**: Checks if commit SHA was already posted (deduplication)
5. **Sanitization**: Strips git SHAs from message
6. **AI Summary** (optional): Condenses message via OpenAI
7. **Post Composition**: Adds repo URL, truncates to 300 chars
8. **Publishing**: Posts to Bluesky via AT Protocol
9. **Tracking**: Saves SHA to `.git/aug-bluesky-posted`

## Post Composition Rules

- **Uses first line only**: Multi-line commits only use the first line
- **Removes git SHAs**: Strips 7-40 character hex hashes
- **Adds repository URL**: When GitHub remote is detected
- **AI condensation** (if enabled): Creates ~20-word first-person summary
- **300-character limit**: Truncates with ellipsis if needed

## Troubleshooting

### Hook not running

Check that:
1. Hook file is executable: `ls -la .git/hooks/pre-push`
2. Deno is in PATH: `which deno`
3. Hook is in the right directory: `git config core.hooksPath`

### Duplicate posts

The bot tracks posted commits in `.git/aug-bluesky-posted`. To repost a commit:

```bash
# Remove the SHA from the tracking file
nano .git/aug-bluesky-posted
```

### Missing credentials error

Ensure `.env` exists in repository root with:
- `BSKY_HANDLE` or `BLUESKY_IDENTIFIER`
- `BSKY_APP_PASSWORD` or `BLUESKY_APP_PASSWORD`

### AI summary not working

Either:
- Set `AI_SUMMARY=off` to disable
- Ensure `OPENAI_API_KEY` is set correctly
- Check OpenAI API quota and credentials

## Manual Posting

You can run the bot manually anytime:

```bash
# Normal run
deno run --allow-env --allow-net --allow-run --allow-read --allow-write .githooks/bluesky-bot/mod.ts

# Dry run
BLUESKY_DRYRUN=on deno run --allow-env --allow-net --allow-run --allow-read --allow-write .githooks/bluesky-bot/mod.ts
```

## Security Notes

- **App Password**: Always use an app password, never your main Bluesky password
- **Environment File**: Add `.env` to `.gitignore` to avoid committing secrets
- **Permissions**: The bot needs `--allow-env`, `--allow-net`, `--allow-run`, `--allow-read`, `--allow-write`
- **OpenAI Key**: Optional, only needed for AI summarization feature

## Requirements

- [Deno](https://deno.land/) 2.5+
- Git repository
- Bluesky account with app password

## Files in This Package

```
.githooks/bluesky-bot/
├── mod.ts           # Main bot script (self-contained)
├── install.ts       # Installation script
├── .env.example     # Environment variable template
├── deno.json        # Deno configuration (imports)
└── README.md        # This file
```

## License

MIT

## Support

For issues, questions, or contributions, please visit the [source repository](https://github.com/YOUR-USERNAME/deno-bsky-bot).
