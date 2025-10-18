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
  console.log(
    `Usage: deno run --allow-env --allow-run --allow-read --allow-write install.ts [options]

Options:
  --hook=<name>   Hook filename to create (default: ${hookNameDefault})
  --force         Overwrite existing hook
  -h, --help      Show this help message

Environment:
  GIT_HOOK_DIR    Override target directory (default: core.hooksPath or .git/hooks)
`,
  );
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
    console.error(
      `Hook already exists at ${hookPath}. Re-run with --force to overwrite.`,
    );
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

  console.log("\n=== Installation Summary ===");
  console.log(`Environment:  ${hasEnv ? "✓" : "✗"} ${envPath}`);
  console.log(`Bot package:  ✓ jsr:@srdjan/bluesky-bot`);

  if (!hasEnv) {
    console.log("\n⚠ Next steps:");
    console.log("  1. Edit .env and add your Bluesky credentials:");
    console.log("     BSKY_HANDLE=yourname.bsky.social");
    console.log("     BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx");
    console.log("  2. Get an app password at: https://account.bsky.app/settings/app-passwords");
  }

  if (hasEnv) {
    console.log("\n✓ Installation complete!");
    console.log("\nTest the bot with:");
    console.log("  BLUESKY_DRYRUN=on deno run -A jsr:@srdjan/bluesky-bot");
    console.log("\nMake a commit and push to trigger the hook:");
    console.log("  git commit -m 'feat: new feature v1.0.0'");
    console.log("  git push");
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

    console.log(
      `\nYou can customize the hook directory with 'git config core.hooksPath <path>' or GIT_HOOK_DIR env var.`,
    );
  } catch (error) {
    console.error(
      `Installation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exit(1);
  }
}
