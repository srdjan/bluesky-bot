#!/usr/bin/env -S deno run --allow-env --allow-run --allow-read --allow-write

// .githooks/bluesky-bot/install.ts
// Installs the Bluesky commit poster git hook into the current repository.
// This script is designed to be run from within the .githooks/bluesky-bot/ directory
// or from a remote location via `deno run -A <url>`.

import { dirname, join, resolve } from "jsr:@std/path@1.0.8";

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

async function detectBotLocation(): Promise<string> {
  // Determine where the bot files are located
  const scriptPath = resolve(dirname(new URL(import.meta.url).pathname));

  // Check if we're running from .githooks/bluesky-bot/
  if (scriptPath.endsWith(".githooks/bluesky-bot") || scriptPath.endsWith(".githooks\\bluesky-bot")) {
    return scriptPath;
  }

  // If running remotely or from elsewhere, we can't determine location
  // User will need to have copied the files first
  throw new Error(
    "Could not detect bot location. Please copy .githooks/bluesky-bot/ to your repository first.",
  );
}

async function installEnvExample(repoRoot: string, botDir: string) {
  const envPath = join(repoRoot, ".env");
  const envExampleSource = join(botDir, ".env.example");

  if (await pathExists(envPath)) {
    console.log(`✓ .env already exists at repository root`);
    return;
  }

  if (!(await pathExists(envExampleSource))) {
    console.warn(`⚠ .env.example not found, skipping environment setup`);
    return;
  }

  const exampleContent = await Deno.readTextFile(envExampleSource);
  await Deno.writeTextFile(envPath, exampleContent);
  console.log(`✓ Created .env from .env.example`);
  console.log(`  Please edit ${envPath} and add your Bluesky credentials`);
}

async function installHook(hookDir: string, hookName: string, botDir: string, force: boolean) {
  const hookPath = join(hookDir, hookName);

  await Deno.mkdir(hookDir, { recursive: true });

  if (!force && (await pathExists(hookPath))) {
    console.error(
      `Hook already exists at ${hookPath}. Re-run with --force to overwrite.`,
    );
    Deno.exit(1);
  }

  // Create a hook script that references the bot's location
  const hookScript = `#!/usr/bin/env bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Check if deno is available
if ! command -v deno >/dev/null 2>&1; then
  echo "deno not found; skipping Bluesky post" >&2
  exit 0
fi

# Run the bot from its location
exec deno run --allow-env --allow-net --allow-run --allow-read --allow-write .githooks/bluesky-bot/mod.ts
`;

  await Deno.writeTextFile(hookPath, hookScript);

  if (Deno.build.os !== "windows") {
    await Deno.chmod(hookPath, 0o755);
  }

  console.log(`✓ Installed ${hookName} hook at ${hookPath}`);
}

async function validateInstallation(repoRoot: string) {
  const envPath = join(repoRoot, ".env");
  const botPath = join(repoRoot, ".githooks/bluesky-bot/mod.ts");

  const hasEnv = await pathExists(envPath);
  const hasBot = await pathExists(botPath);

  console.log("\n=== Installation Summary ===");
  console.log(`Bot script:   ${hasBot ? "✓" : "✗"} ${botPath}`);
  console.log(`Environment:  ${hasEnv ? "✓" : "✗"} ${envPath}`);

  if (!hasEnv) {
    console.log("\n⚠ Next steps:");
    console.log("  1. Edit .env and add your Bluesky credentials:");
    console.log("     BSKY_HANDLE=yourname.bsky.social");
    console.log("     BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx");
  }

  if (hasEnv && hasBot) {
    console.log("\n✓ Installation complete!");
    console.log("\nTest the bot with:");
    console.log("  BLUESKY_DRYRUN=on deno run --allow-env --allow-net --allow-run --allow-read --allow-write .githooks/bluesky-bot/mod.ts");
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
    console.error(`Installation failed: ${error.message}`);
    Deno.exit(1);
  }
}
