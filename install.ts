#!/usr/bin/env -S deno run --allow-env --allow-run --allow-read --allow-write

/**
 * @module
 *
 * Bluesky Bot Installer - Sets up git hooks for automatic Bluesky posting.
 *
 * This installer creates a git hook (default: pre-push) that automatically posts
 * commits to Bluesky when they contain semantic versions or the @publish keyword.
 *
 * @example
 * ```bash
 * # Install with default settings (pre-push hook)
 * deno run -A jsr:@srdjan/bluesky-bot/install
 *
 * # Install as post-commit hook
 * deno run -A jsr:@srdjan/bluesky-bot/install --hook=post-commit
 *
 * # Force overwrite existing hook
 * deno run -A jsr:@srdjan/bluesky-bot/install --force
 * ```
 */

import { join } from "@std/path";

const decoder = new TextDecoder();

// =============== CLI Arguments ===============

const hookNameDefault = "pre-push";
let hookName = hookNameDefault;
let force = false;

for (const arg of Deno.args) {
  if (arg === "--force") {
    force = true;
  } else if (arg.startsWith("--hook=")) {
    const value = arg.slice("--hook=".length).trim();
    if (value.length === 0) {
      console.error("Missing value for --hook argument.");
      Deno.exit(1);
    }
    hookName = value;
  } else if (arg === "--help" || arg === "-h") {
    printHelp();
    Deno.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    printHelp();
    Deno.exit(1);
  }
}

// =============== Helper Functions ===============

async function runCommand(cmd: string, args: string[]): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
}> {
  const command = new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await command.output();
  return {
    success: code === 0,
    stdout: decoder.decode(stdout).trim(),
    stderr: decoder.decode(stderr).trim(),
  };
}

async function getRepoRoot(): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"]);
  if (!result.success) {
    throw new Error(`git rev-parse failed: ${result.stderr}`);
  }
  return result.stdout;
}

async function resolveHookDir(repoRoot: string): Promise<string> {
  const envOverride = Deno.env.get("GIT_HOOK_DIR");
  if (envOverride && envOverride.length > 0) {
    return resolvePath(repoRoot, envOverride);
  }

  const hooksPath = await getGitConfig("core.hooksPath");
  if (hooksPath) {
    return resolvePath(repoRoot, hooksPath);
  }

  return join(repoRoot, ".git", "hooks");
}

function resolvePath(repoRoot: string, pathValue: string): string {
  if (pathValue.startsWith("/")) {
    return pathValue;
  }
  if (pathValue.startsWith("~")) {
    const home = Deno.env.get("HOME");
    if (!home) {
      throw new Error("HOME environment variable is not set.");
    }
    const relative = pathValue.slice(1).replace(/^\/+/, "");
    return join(home, relative);
  }
  return join(repoRoot, pathValue);
}

async function getGitConfig(key: string): Promise<string | undefined> {
  const result = await runCommand("git", ["config", "--get", key]);
  return result.success ? result.stdout : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

function printHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║          Bluesky Bot Installer - Help                          ║
╚════════════════════════════════════════════════════════════════╝

USAGE:
  deno run -A jsr:@srdjan/bluesky-bot/install [OPTIONS]

  Or with the task (if installed as dev dependency):
  deno task install [OPTIONS]

OPTIONS:
  --hook=<name>   Specify which git hook to install
                  Default: ${hookNameDefault}
                  Examples: post-commit, pre-push, post-merge

  --force         Overwrite existing hook without prompting
                  Use with caution!

  -h, --help      Show this help message

ENVIRONMENT VARIABLES:
  GIT_HOOK_DIR    Override hook installation directory
                  Default: Uses git config core.hooksPath or .git/hooks
                  Example: GIT_HOOK_DIR=.githooks

EXAMPLES:
  # Install with default settings (pre-push hook)
  deno run -A jsr:@srdjan/bluesky-bot/install

  # Install as post-commit hook
  deno run -A jsr:@srdjan/bluesky-bot/install --hook=post-commit

  # Force overwrite existing hook
  deno run -A jsr:@srdjan/bluesky-bot/install --force

  # Custom hooks directory
  GIT_HOOK_DIR=.githooks deno run -A jsr:@srdjan/bluesky-bot/install

WHAT IT DOES:
  1. Creates .env template if it doesn't exist
  2. Installs git hook script to call the bot
  3. Makes hook executable
  4. Validates installation

NEXT STEPS AFTER INSTALLATION:
  1. Configure credentials in .env
  2. Validate setup: deno task validate --test-auth
  3. Test with dry-run: deno task test

For more information, visit:
  https://jsr.io/@srdjan/bluesky-bot
`);
}

// =============== Installation Logic ===============

function detectBotLocation(): string {
  // For JSR distribution, we don't need to detect location
  // The hook script will call jsr:@srdjan/bluesky-bot directly
  // This function is kept for compatibility but returns empty string
  return "";
}

async function installEnvExample(repoRoot: string, _botDir: string) {
  const envPath = join(repoRoot, ".env");

  if (await pathExists(envPath)) {
    console.log(`✓ .env already exists at repository root`);
    return;
  }

  // Create .env with template content
  const envTemplate = `# Bluesky Credentials (required)
BSKY_HANDLE=your-handle.bsky.social
BSKY_APP_PASSWORD=your-app-password

# Optional: Bluesky service URL (defaults to https://bsky.social)
# BLUESKY_SERVICE=https://bsky.social

# Optional: Enable dry-run mode (preview posts without publishing)
# BLUESKY_DRYRUN=on

# Optional: OpenAI API key for AI-powered commit message summarization
# OPENAI_API_KEY=sk-...

# Optional: Control AI summarization (on by default if OPENAI_API_KEY is set)
# AI_SUMMARY=on
`;

  await Deno.writeTextFile(envPath, envTemplate);
  console.log(`✓ Created .env template at repository root`);
  console.log(`  Please edit ${envPath} and add your Bluesky credentials`);
  console.log(`  Get an app password at: https://account.bsky.app/settings/app-passwords`);
}

async function installHook(hookDir: string, hookName: string, _botDir: string, force: boolean) {
  const hookPath = join(hookDir, hookName);

  await Deno.mkdir(hookDir, { recursive: true });

  if (!force && (await pathExists(hookPath))) {
    console.error(`\n✗ Installation Failed`);
    console.error("─".repeat(64));
    console.error(`\nA ${hookName} hook already exists at:`);
    console.error(`  ${hookPath}`);
    console.error("\nOptions:");
    console.error("  1. Use --force to overwrite the existing hook:");
    console.error(`     deno run -A jsr:@srdjan/bluesky-bot/install --force`);
    console.error();
    console.error("  2. Choose a different hook name:");
    console.error(`     deno run -A jsr:@srdjan/bluesky-bot/install --hook=post-commit`);
    console.error();
    console.error("  3. Manually review the existing hook before proceeding");
    console.error();
    Deno.exit(1);
  }

  // Create a hook script that calls the JSR package
  const hookScript = `#!/usr/bin/env bash
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
`;

  await Deno.writeTextFile(hookPath, hookScript);

  if (Deno.build.os !== "windows") {
    await Deno.chmod(hookPath, 0o755);
  }

  console.log(`✓ Installed ${hookName} hook at ${hookPath}`);
}

async function validateInstallation(repoRoot: string) {
  const envPath = join(repoRoot, ".env");
  const hasEnv = await pathExists(envPath);

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║              Installation Summary                              ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`Environment:  ${hasEnv ? "✓" : "✗"} ${envPath}`);
  console.log(`Bot package:  ✓ jsr:@srdjan/bluesky-bot`);

  if (!hasEnv) {
    console.log("\n⚠  Configuration Required");
    console.log("─".repeat(64));
    console.log("\nYour .env file has been created but needs credentials.");
    console.log("\nNext steps:");
    console.log("  1. Get an app password:");
    console.log("     → Visit: https://account.bsky.app/settings/app-passwords");
    console.log("     → Click 'Add App Password'");
    console.log("     → Copy the generated password (format: xxxx-xxxx-xxxx-xxxx)");
    console.log();
    console.log("  2. Edit .env and add your credentials:");
    console.log(`     → Open: ${envPath}`);
    console.log("     → Set BSKY_HANDLE=yourname.bsky.social");
    console.log("     → Set BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx");
    console.log();
    console.log("  3. Validate your configuration:");
    console.log("     → Run: deno task validate --test-auth");
    console.log();
  }

  if (hasEnv) {
    console.log("\n✓ Installation Complete!");
    console.log("─".repeat(64));
    console.log("\nRecommended next steps:");
    console.log();
    console.log("  1. Validate your credentials:");
    console.log("     deno task validate --test-auth");
    console.log();
    console.log("  2. Test with a dry-run (preview without posting):");
    console.log("     deno task test");
    console.log();
    console.log("  3. Make a commit and push to trigger the hook:");
    console.log("     git commit -m 'feat: new feature v1.0.0'");
    console.log("     git push");
    console.log();
    console.log("Tip: The bot posts commits with semantic versions (v1.0.0) or @publish");
    console.log();
  }
}

// =============== Main Entry Point ===============

if (import.meta.main) {
  try {
    const repoRoot = await getRepoRoot();
    console.log(`Installing Bluesky bot hook into: ${repoRoot}\n`);

    const botDir = await detectBotLocation();
    const hookDir = await resolveHookDir(repoRoot);

    // Install .env.example if needed
    await installEnvExample(repoRoot, botDir);

    // Install the git hook
    await installHook(hookDir, hookName, botDir, force);

    // Validate and show summary
    await validateInstallation(repoRoot);

    console.log();
    console.log("Advanced Configuration:");
    console.log(`  Customize hook directory with:`);
    console.log(`    git config core.hooksPath <path>`);
    console.log(`  Or use environment variable:`);
    console.log(`    GIT_HOOK_DIR=<path> deno run -A jsr:@srdjan/bluesky-bot/install`);
  } catch (error) {
    console.error("\n✗ Installation Error");
    console.error("─".repeat(64));
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    console.error();
    console.error("Common issues:");
    console.error("  • Not in a git repository? Run 'git init' first");
    console.error("  • Permission denied? Check file system permissions");
    console.error("  • Git not installed? Install git and try again");
    console.error();
    console.error("Need help? Visit: https://jsr.io/@srdjan/bluesky-bot");
    console.error();
    Deno.exit(1);
  }
}
