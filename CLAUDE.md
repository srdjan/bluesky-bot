# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project Overview

A Deno-based JSR package that automatically posts git commits to Bluesky when triggered by a git
hook. Posts are published when commit messages contain either a semantic version (`1.2.3`,
`v2.0.0-beta.1`) or the `@publish` keyword.

**Distribution Model:** JSR package (`@srdjan/bluesky-bot`) installed as a dev dependency.

**Key Features:**

- 🎯 **Smart Hashtags**: Automatically fetches GitHub repository topics and converts them to
  hashtags
- ✅ **Credential Validation**: Built-in validator to test setup before first use
- 🤖 **AI Summarization**: Optional OpenAI integration for concise commit messages
- 🔄 **Local Deduplication**: Prevents duplicate posts
- 🌐 **GitHub Integration**: Automatically adds commit URLs

## Common Development Commands

### Main Tasks

```bash
deno task install                   # Install git hook
deno task setup                     # Install git hook (alias)
deno task validate                  # Validate credentials
deno task post                      # Run bot (posts to Bluesky)
deno task test                      # Dry run (preview without posting)
deno task fmt                       # Format code
deno task lint                      # Lint code
```

### Running Scripts Manually

```bash
# Normal run (posts to Bluesky)
deno run -A mod.ts

# Dry run (preview without posting)
BLUESKY_DRYRUN=on deno run -A mod.ts

# Install hook
deno run -A install.ts

# Validate credentials
deno run -A validate.ts

# Validate with API test
deno run -A validate.ts --test-auth
```

### Hook Management

```bash
# Install to custom hook (e.g., post-commit)
deno run -A install.ts --hook=post-commit

# Install to custom directory
GIT_HOOK_DIR=.githooks deno run -A install.ts

# Force overwrite existing hook
deno run -A install.ts --force
```

## Architecture & Key Patterns

### Publishing Logic Flow

1. **Trigger gates**: Commit must contain `@publish` keyword OR semantic version pattern
2. **Local deduplication**: Posted SHAs are tracked in `.git/aug-bluesky-posted` to prevent
   reposting
3. **GitHub topics fetch**: Fetches repository topics via GitHub API for hashtags
4. **Optional AI summarization**: If `OPENAI_API_KEY` is set and `AI_SUMMARY=on`, OpenAI condenses
   commit messages (skips hashtag generation if topics exist)
5. **Hashtag generation**: Uses GitHub topics as hashtags; falls back to AI-generated hashtags if no
   topics
6. **Sanitization**: Git SHAs are stripped from posts to keep them readable
7. **Repository detection**: Parses `remote.origin.url` to generate GitHub commit URLs

### Core Modules

**`mod.ts`** (main entry point)

- Orchestrates the entire posting workflow
- Self-contained with inlined dependencies (dotenv loader, etc.)
- Git command wrapper: `runGit(args)` with error handling
- Trigger detection: `hasPublishKeyword()` and `hasSemver()`
- Deduplication: `hasSeenSha()` / `markSeenSha()`
- **GitHub topics**: `fetchGitHubTopics()` fetches topics via GitHub API
- **Hashtag conversion**: `topicToHashtag()` converts topics to proper hashtags (TypeScript, etc.)
- Optional AI: `aiCondense(text, hasTopics)` calls OpenAI's API with topic awareness
- Post composition: strips commit hashes, adds topics as hashtags, adds repo URL, truncates to 300
  chars
- Custom dotenv loader: `loadDotenv()` parses `.env` with support for quotes and `export` prefix
- Environment helper: `firstEnv()` resolves first non-empty value from multiple env var names

**`install.ts`** (installer script)

- Installs bash hook script into `.git/hooks/` (or custom location)
- Respects `git config core.hooksPath` and `GIT_HOOK_DIR` env variable
- Handles path resolution (absolute, relative, tilde-home paths)
- Hook script calls `jsr:@srdjan/bluesky-bot` directly
- Creates enhanced `.env` template with comprehensive inline documentation
- Professional error messages and help output
- Includes deno availability check before execution

**`validate.ts`** (credential validator)

- Validates `.env` file presence and format
- Checks required environment variables (BSKY_HANDLE, BSKY_APP_PASSWORD)
- Validates credential format (handle and DID patterns)
- Optional `--test-auth` flag to test credentials against Bluesky API
- Clear, actionable validation output with troubleshooting guidance
- Available via: `deno task validate` or `deno run -A jsr:@srdjan/bluesky-bot/validate`

### Environment Variables

Required for posting:

- `BSKY_HANDLE` or `BLUESKY_IDENTIFIER` - Bluesky handle/DID
- `BSKY_APP_PASSWORD` or `BLUESKY_APP_PASSWORD` - App password

Optional:

- `BLUESKY_SERVICE` - AT Protocol service (defaults to https://bsky.social)
- `BLUESKY_DRYRUN=on` - Preview mode without posting
- `AI_SUMMARY` - Toggle AI summarization (`on` by default if OpenAI key present)
- `OPENAI_API_KEY` - Enables AI-powered commit message condensation

### Key Implementation Details

**Git Command Execution**

- Uses `Deno.Command` with piped stdout/stderr
- Error messages include stderr output for debugging
- Commit metadata: SHA, message, author, branch, remote URL

**Semantic Version Detection**

- Regex: matches versions like `1.2.3`, `v2.0.0`, `1.0.0-beta.1`, etc.
- Follows standard semver pattern with optional prefix, prerelease, and build metadata

**Post Composition Rules**

- Uses first line of commit message only
- Removes git SHAs (7-40 hex characters)
- **Fetches GitHub topics and converts to hashtags** (e.g., `typescript` → `#TypeScript`)
- If topics exist, AI skips hashtag generation; if no topics, AI generates contextual hashtags
- AI summary (if enabled) creates ~20-word first-person commentary
- Adds GitHub commit URL when `remote.origin.url` is a GitHub repo
- Truncates to Bluesky's 300-character limit

**Hashtag Conversion Examples:**

- `typescript` → `#TypeScript` (special case)
- `bluesky-client` → `#BlueskyClient` (PascalCase)
- `deno` → `#Deno` (capitalize)
- `javascript` → `#JavaScript`, `nodejs` → `#NodeJS`, `graphql` → `#GraphQL`

**Error Handling**

- Missing credentials: exits with error code 1
- Already posted SHA: exits silently (code 0)
- Missing trigger patterns: exits silently (code 0)
- Bluesky API failures: exits with error code 1
- Git command failures: throws with stderr details

## Development Notes

- **No external dependencies for core logic**: Custom dotenv parser, no testing framework configured
- **Permissions required**: `--allow-env`, `--allow-net`, `--allow-run`, `--allow-read`,
  `--allow-write`
- **npm package usage**: `@atproto/api` for Bluesky interaction (via npm specifier in imports)
- **Deno lockfile**: `deno.lock` should be committed for reproducible runs
- **Hook safety**: Generated hook checks for deno availability before running

## Testing Strategy

### Validate Credentials

Use the built-in validator to test your setup:

```bash
# Validate configuration only
deno task validate

# Test credentials against Bluesky API
deno task validate --test-auth
```

### Dry-Run Mode

Use the dry-run mode to preview posts without publishing:

```bash
# Test with dry-run
BLUESKY_DRYRUN=on deno task post

# Or directly
BLUESKY_DRYRUN=on deno run -A mod.ts
```

### Testing Workflow

1. **Validate setup**: `deno task validate --test-auth`
2. **Preview post**: `deno task test` (dry-run mode)
3. **Check topics**: `curl https://api.github.com/repos/owner/repo | grep topics`
4. **Make test commit**: `git commit --allow-empty -m "Test v1.0.0 @publish"`
5. **Verify output**: Check dry-run output for hashtags and formatting

## Troubleshooting

- **Missing credentials**: Run `deno task validate --test-auth` to identify and fix credential
  issues
- **Hook not firing**: Check hook is executable (`chmod +x .git/hooks/pre-push`) and deno is in PATH
- **Duplicate posts**: Delete or edit `.git/aug-bluesky-posted` to clear history
- **AI summary errors**: Set `AI_SUMMARY=off` or unset `OPENAI_API_KEY` to disable
- **No hashtags appearing**: Check repository has GitHub topics set via GitHub API or web interface
- **Wrong hashtag format**: Review `topicToHashtag()` special cases in mod.ts
- **Git command failures**: Error messages now include stderr output for debugging
- **Validation failures**: Check `.env` file format and ensure no trailing spaces or quotes issues
