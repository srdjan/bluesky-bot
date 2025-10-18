#!/usr/bin/env -S deno run --allow-env --allow-run --allow-read --allow-write

// Installs the Bluesky commit poster git hook into the current repository.
// Respects core.hooksPath when set and falls back to .git/hooks.

import { join } from "https://deno.land/std/path/mod.ts";

const decoder = new TextDecoder();

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

const repoRoot = await getRepoRoot();
const hookDir = await resolveHookDir(repoRoot);
const hookPath = join(hookDir, hookName);

await Deno.mkdir(hookDir, { recursive: true });

if (!force && (await pathExists(hookPath))) {
  console.error(
    `Hook already exists at ${hookPath}. Re-run with --force to overwrite.`,
  );
  Deno.exit(1);
}

const hookScript = `#!/usr/bin/env bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
if ! command -v deno >/dev/null 2>&1; then
  echo "deno not found; skipping Bluesky post" >&2
  exit 0
fi
exec deno run --allow-env --allow-net --allow-run --allow-read --allow-write scripts/bluesky-post.ts
`;

await Deno.writeTextFile(hookPath, hookScript);

if (Deno.build.os !== "windows") {
  await Deno.chmod(hookPath, 0o755);
}

console.log(`Installed ${hookName} hook at ${hookPath}.`);
console.log(
  `You can set a custom hook directory with 'git config core.hooksPath <path>' or rerun with GIT_HOOK_DIR.`,
);

function printHelp() {
  console.log(
    `Usage: deno run --allow-env --allow-run --allow-read --allow-write scripts/install-hook.ts [options]

Options:
  --hook=<name>   Hook filename to create (default: ${hookNameDefault})
  --force         Overwrite existing hook
  -h, --help      Show this help message

Environment:
  GIT_HOOK_DIR    Override target directory (default: core.hooksPath or .git/hooks)
`,
  );
}

async function getRepoRoot(): Promise<string> {
  const command = new Deno.Command("git", {
    args: ["rev-parse", "--show-toplevel"],
  });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    const error = decoder.decode(stderr).trim();
    throw new Error(`git rev-parse failed: ${error}`);
  }
  return decoder.decode(stdout).trim();
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
  const command = new Deno.Command("git", {
    args: ["config", "--get", key],
  });
  const { code, stdout } = await command.output();
  if (code !== 0) {
    return undefined;
  }
  return decoder.decode(stdout).trim();
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
