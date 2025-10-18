# Distribution Guide: Bluesky Bot Package

This guide explains how to package and distribute the Bluesky bot to other repositories.

## What's Been Created

The bot has been refactored into a **self-contained, portable package** under `.githooks/bluesky-bot/`:

```
.githooks/bluesky-bot/
├── mod.ts           # Main bot script (self-contained, no local imports)
├── install.ts       # Smart installer script
├── .env.example     # Environment variable template
├── deno.json        # Minimal Deno config (just imports)
└── README.md        # Complete user documentation
```

**Key Features:**
- ✅ All dependencies inlined (no local imports)
- ✅ Self-contained in single directory
- ✅ Works from any repository
- ✅ Smart installer handles setup automatically
- ✅ Complete documentation included

## Distribution Methods

### Method 1: Direct Copy (Recommended)

**Best for:** Private use, customization per project, version control

Users copy the entire `.githooks/bluesky-bot/` folder to their repository:

```bash
# From your repository
cd /path/to/their-repo
cp -r /path/to/deno-bsky-bot/.githooks/bluesky-bot .githooks/

# Install
deno task bluesky:install
# OR
deno run --allow-env --allow-run --allow-read --allow-write .githooks/bluesky-bot/install.ts
```

**Pros:**
- Code is version controlled in their repo
- Easy to customize per project
- No external dependencies at runtime
- Transparent and auditable

**Cons:**
- Manual updates required
- Each repo has its own copy

### Method 2: GitHub/GitLab Template Repository

**Best for:** Distributing across teams, easy discovery

Create a template repository or add this to your existing template:

1. Push `.githooks/bluesky-bot/` to a GitHub repo
2. Users click "Use this template" or clone
3. Run installation command

```bash
git clone https://github.com/YOUR-USERNAME/repo-with-bluesky-bot.git
cd repo-with-bluesky-bot
deno task bluesky:install
```

### Method 3: Remote Installation Script

**Best for:** One-liner installation, always-up-to-date

Users can install directly from a remote URL:

```bash
# Install directly from your repo
deno run -A https://raw.githubusercontent.com/YOUR-USERNAME/deno-bsky-bot/main/.githooks/bluesky-bot/install.ts
```

**Note:** This requires modifying `install.ts` to handle remote installation (downloading files first).

### Method 4: Archive/Release Bundle

**Best for:** Official releases, offline distribution

Create a downloadable archive:

```bash
# Create a distributable archive
cd .githooks
tar -czf bluesky-bot-v1.0.0.tar.gz bluesky-bot/

# Users extract and install
tar -xzf bluesky-bot-v1.0.0.tar.gz
deno run --allow-env --allow-run --allow-read --allow-write bluesky-bot/install.ts
```

### Method 5: Git Submodule (Advanced)

**Best for:** Shared updates across projects, centralized maintenance

```bash
# In user's repo
git submodule add https://github.com/YOUR-USERNAME/deno-bsky-bot.git .githooks/bluesky-bot
cd .githooks/bluesky-bot
deno run -A install.ts

# Updates
git submodule update --remote
```

**Pros:**
- Easy to keep updated
- Shared across repos
- Version pinning

**Cons:**
- More complex setup
- Submodule learning curve

## Installation Flow for End Users

Regardless of distribution method, the installation process is the same:

1. **Get the files** (copy, clone, or download `.githooks/bluesky-bot/`)
2. **Run installer**: `deno task bluesky:install`
3. **Configure credentials**: Edit `.env` with Bluesky credentials
4. **Test**: `deno task bluesky:test` (dry run)
5. **Use**: Commit and push!

## What the Installer Does

When users run `install.ts`, it:

1. ✅ Detects repository root via git
2. ✅ Copies `.env.example` to repo root (if `.env` doesn't exist)
3. ✅ Installs git hook to `.git/hooks/pre-push` (or custom location)
4. ✅ Makes hook executable
5. ✅ Validates installation
6. ✅ Shows next steps

## Customization Options

Users can customize installation:

```bash
# Install to different hook
deno run -A .githooks/bluesky-bot/install.ts --hook=post-commit

# Use custom hooks directory
git config core.hooksPath .githooks
deno run -A .githooks/bluesky-bot/install.ts

# Force overwrite existing hook
deno run -A .githooks/bluesky-bot/install.ts --force
```

## Convenient Tasks (Already Added)

The root `deno.json` now includes these tasks:

```json
{
  "tasks": {
    "bluesky:install": "deno run -A .githooks/bluesky-bot/install.ts",
    "bluesky:post": "deno run -A .githooks/bluesky-bot/mod.ts",
    "bluesky:test": "BLUESKY_DRYRUN=on deno run -A .githooks/bluesky-bot/mod.ts"
  }
}
```

Users with these tasks can simply run:
- `deno task bluesky:install` - Install the hook
- `deno task bluesky:test` - Test without posting
- `deno task bluesky:post` - Post manually

## Publishing to JSR (Optional Future Enhancement)

For maximum discoverability, consider publishing to JSR:

```bash
# In .githooks/bluesky-bot/deno.json, add:
{
  "name": "@yourname/bluesky-bot",
  "version": "1.0.0",
  "exports": "./mod.ts"
}

# Publish
deno publish
```

Users could then:
```bash
deno install -A jsr:@yourname/bluesky-bot/install
```

## Recommended Distribution Strategy

**For this project, I recommend Method 1 (Direct Copy)** because:

1. ✅ Simple for users to understand
2. ✅ They can see and modify the code
3. ✅ No complex infrastructure needed
4. ✅ Works offline after initial setup
5. ✅ Easy to add to existing repos

## Example Distribution README

Here's what you could include in your main README:

````markdown
## Adding to Your Repository

1. **Copy the bot folder to your repo:**
   ```bash
   cp -r /path/to/deno-bsky-bot/.githooks/bluesky-bot .githooks/
   ```

2. **Install the hook:**
   ```bash
   deno run --allow-env --allow-run --allow-read --allow-write .githooks/bluesky-bot/install.ts
   ```

3. **Configure your credentials:**
   Edit `.env` and add:
   ```
   BSKY_HANDLE=yourname.bsky.social
   BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
   ```

4. **Test it:**
   ```bash
   BLUESKY_DRYRUN=on deno run -A .githooks/bluesky-bot/mod.ts
   ```

That's it! Now your commits with semantic versions or `@publish` will post to Bluesky automatically.
````

## Next Steps for Distribution

To make this package available to others:

1. **Create a dedicated repository** (optional):
   ```bash
   mkdir bluesky-bot
   cp -r .githooks/bluesky-bot/* bluesky-bot/
   cd bluesky-bot
   git init
   git add .
   git commit -m "Initial release"
   git remote add origin https://github.com/YOUR-USERNAME/bluesky-bot.git
   git push -u origin main
   ```

2. **Add documentation** to the repository:
   - Include the README.md (already created)
   - Add CHANGELOG.md for version history
   - Add LICENSE file

3. **Create releases** on GitHub:
   - Tag versions: `git tag v1.0.0`
   - Create GitHub releases with archives
   - Include installation instructions

4. **Share it**:
   - Blog post about the bot
   - Share on Bluesky (meta!)
   - Submit to awesome-deno lists

## Maintenance

When you update the bot:

1. Update version in `.githooks/bluesky-bot/deno.json`
2. Update CHANGELOG.md
3. Create a new git tag
4. Create GitHub release with updated archive
5. Users can download and replace their `.githooks/bluesky-bot/` folder

## Testing the Package

Before distributing, test the package in a fresh repository:

```bash
# Create test repo
mkdir /tmp/test-repo
cd /tmp/test-repo
git init

# Copy bot
cp -r /path/to/deno-bsky-bot/.githooks/bluesky-bot .githooks/

# Test installation
deno run -A .githooks/bluesky-bot/install.ts

# Verify files created
ls -la .env
ls -la .git/hooks/pre-push

# Test dry run
BLUESKY_DRYRUN=on deno run -A .githooks/bluesky-bot/mod.ts
```

## Summary

✅ **Package is ready for distribution**
✅ **Self-contained and portable**
✅ **Multiple distribution methods available**
✅ **Smart installer handles setup**
✅ **Complete documentation included**

The `.githooks/bluesky-bot/` folder is now a standalone, distributable package that can be easily added to any Git repository!
