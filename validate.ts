#!/usr/bin/env -S deno run --allow-env --allow-read --allow-net

/**
 * @module
 *
 * Bluesky Bot Credential Validator - Tests configuration and credentials.
 *
 * This script validates your Bluesky bot setup by checking:
 * - Presence of .env file
 * - Required environment variables
 * - Credential format validity
 * - Optional: Bluesky API authentication test
 *
 * @example
 * ```bash
 * # Validate configuration only
 * deno run -A jsr:@srdjan/bluesky-bot/validate
 *
 * # Test credentials against Bluesky API
 * deno run -A jsr:@srdjan/bluesky-bot/validate --test-auth
 *
 * # Or use the task
 * deno task validate
 * ```
 */

import { BskyAgent } from "@atproto/api";

// =============== Constants ===============

const DEFAULT_BLUESKY_SERVICE = "https://bsky.social" as const;

// =============== Types ===============

type Ok<T> = { readonly ok: true; readonly value: T };
type Err<E> = { readonly ok: false; readonly error: E };
type Result<T, E> = Ok<T> | Err<E>;

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const err = <E>(error: E): Err<E> => ({ ok: false, error });

type Config = {
  readonly service: string;
  readonly handle: string;
  readonly password: string;
};

type ValidationResult = {
  readonly envFileExists: boolean;
  readonly hasHandle: boolean;
  readonly hasPassword: boolean;
  readonly handleFormat: "valid" | "invalid" | "unknown";
  readonly config?: Config;
};

// =============== Inlined Environment Utilities ===============

function loadDotenv(file: string = ".env"): void {
  try {
    const txt = Deno.readTextFileSync(file);
    for (const rawLine of txt.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      let key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (key.toLowerCase().startsWith("export ")) key = key.slice(7).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (Deno.env.get(key) == null) {
        try {
          Deno.env.set(key, val);
        } catch {
          // ignore if permissions are missing
        }
      }
    }
  } catch {
    // ignore missing .env
  }
}

function firstEnv(
  env: Record<string, string>,
  keys: string[],
  fallback = "",
): string {
  for (const key of keys) {
    const value = env[key];
    if (value && value.length > 0) return value;
  }
  return fallback;
}

// =============== Validation Functions ===============

async function checkEnvFileExists(): Promise<boolean> {
  try {
    await Deno.stat(".env");
    return true;
  } catch {
    return false;
  }
}

function validateHandleFormat(handle: string): "valid" | "invalid" | "unknown" {
  if (!handle) return "unknown";

  // Handle format: either a DID (did:plc:...) or a handle (name.bsky.social)
  if (handle.startsWith("did:")) {
    return handle.match(/^did:[a-z]+:[a-zA-Z0-9._-]+$/) ? "valid" : "invalid";
  }

  // Handle format: must contain at least one dot and valid characters
  if (handle.includes(".") && handle.match(/^[a-zA-Z0-9.-]+$/)) {
    return "valid";
  }

  return "invalid";
}

function loadConfig(env: Record<string, string>): Result<Config, string> {
  const service = firstEnv(env, ["BLUESKY_SERVICE"], DEFAULT_BLUESKY_SERVICE);
  const handle = firstEnv(env, [
    "BSKY_HANDLE",
    "BSKY_IDENTIFIER",
    "BLUESKY_HANDLE",
    "BLUESKY_IDENTIFIER",
  ]);
  const password = firstEnv(env, [
    "BSKY_APP_PASSWORD",
    "BLUESKY_APP_PASSWORD",
  ]);

  if (!handle || !password) {
    return err(
      "Missing required credentials. Set BSKY_HANDLE and BSKY_APP_PASSWORD in .env",
    );
  }

  return ok({ service, handle, password });
}

async function testAuthentication(
  config: Config,
): Promise<Result<string, string>> {
  try {
    const agent = new BskyAgent({ service: config.service });
    const response = await agent.login({
      identifier: config.handle,
      password: config.password,
    });

    return ok(response.data.did);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(message);
  }
}

async function runValidation(): Promise<ValidationResult> {
  const envFileExists = await checkEnvFileExists();

  loadDotenv();
  const env = Deno.env.toObject();

  const configResult = loadConfig(env);

  if (!configResult.ok) {
    return {
      envFileExists,
      hasHandle: false,
      hasPassword: false,
      handleFormat: "unknown",
    };
  }

  const config = configResult.value;
  const handleFormat = validateHandleFormat(config.handle);

  const result: ValidationResult = {
    envFileExists,
    hasHandle: !!config.handle,
    hasPassword: !!config.password,
    handleFormat,
    config,
  };

  return result;
}

// =============== Output Functions ===============

function printValidationReport(
  result: ValidationResult,
  authResult?: Result<string, string>,
): void {
  console.log("\n=== Bluesky Bot Configuration Validation ===\n");

  // Check .env file
  console.log(
    `${result.envFileExists ? "✓" : "✗"} .env file: ${
      result.envFileExists ? "found" : "NOT FOUND"
    }`,
  );

  if (!result.envFileExists) {
    console.log(
      "  → Create .env file in repository root (see .env.example)",
    );
  }

  // Check handle
  console.log(
    `${result.hasHandle ? "✓" : "✗"} BSKY_HANDLE: ${result.hasHandle ? "set" : "NOT SET"}`,
  );

  if (result.hasHandle && result.config) {
    const formatSymbol = result.handleFormat === "valid"
      ? "✓"
      : result.handleFormat === "invalid"
      ? "✗"
      : "?";
    console.log(
      `  ${formatSymbol} Format: ${result.handleFormat} (${result.config.handle})`,
    );

    if (result.handleFormat === "invalid") {
      console.log(
        "  → Handle should be like: yourname.bsky.social or did:plc:...",
      );
    }
  } else if (!result.hasHandle) {
    console.log("  → Set BSKY_HANDLE in .env (e.g., yourname.bsky.social)");
  }

  // Check password
  console.log(
    `${result.hasPassword ? "✓" : "✗"} BSKY_APP_PASSWORD: ${
      result.hasPassword ? "set" : "NOT SET"
    }`,
  );

  if (!result.hasPassword) {
    console.log(
      "  → Get app password at: https://account.bsky.app/settings/app-passwords",
    );
  }

  // Check service
  if (result.config) {
    console.log(`✓ Service: ${result.config.service}`);
  }

  // Authentication test result
  if (authResult) {
    console.log();
    if (authResult.ok) {
      console.log(`✓ Authentication: SUCCESS`);
      console.log(`  DID: ${authResult.value}`);
    } else {
      console.log(`✗ Authentication: FAILED`);
      console.log(`  Error: ${authResult.error}`);
      console.log(
        "  → Check your credentials at: https://account.bsky.app/settings/app-passwords",
      );
    }
  }

  // Summary
  console.log("\n=== Summary ===\n");

  const allChecks = result.hasHandle && result.hasPassword &&
    result.handleFormat === "valid";

  if (allChecks && (!authResult || authResult.ok)) {
    console.log("✓ Configuration is valid!");
    if (!authResult) {
      console.log(
        "\nRun with --test-auth to verify credentials against Bluesky API",
      );
    }
    console.log("\nTest the bot with:");
    console.log("  BLUESKY_DRYRUN=on deno run -A jsr:@srdjan/bluesky-bot");
  } else {
    console.log("✗ Configuration has issues. Please fix the errors above.");
    console.log("\nNext steps:");

    if (!result.envFileExists) {
      console.log("  1. Create .env file (copy from .env.example)");
    }
    if (!result.hasHandle) {
      console.log("  2. Set BSKY_HANDLE in .env");
    }
    if (!result.hasPassword) {
      console.log("  3. Set BSKY_APP_PASSWORD in .env");
    }
    if (result.handleFormat === "invalid") {
      console.log("  4. Fix BSKY_HANDLE format");
    }
  }

  console.log();
}

// =============== Main Entry Point ===============

async function run(): Promise<number> {
  const testAuth = Deno.args.includes("--test-auth");

  if (Deno.args.includes("--help") || Deno.args.includes("-h")) {
    console.log(`Usage: deno run -A jsr:@srdjan/bluesky-bot/validate [options]

Options:
  --test-auth     Test credentials against Bluesky API
  -h, --help      Show this help message

This script validates your Bluesky bot configuration by checking:
- Presence of .env file
- Required environment variables (BSKY_HANDLE, BSKY_APP_PASSWORD)
- Credential format validity
- Optional: Bluesky API authentication test
`);
    return 0;
  }

  try {
    const result = await runValidation();

    let authResult: Result<string, string> | undefined;

    if (testAuth && result.config) {
      console.log("Testing authentication with Bluesky API...");
      authResult = await testAuthentication(result.config);
    }

    printValidationReport(result, authResult);

    // Exit with error if validation failed
    const isValid = result.hasHandle && result.hasPassword &&
      result.handleFormat === "valid" &&
      (!authResult || authResult.ok);

    return isValid ? 0 : 1;
  } catch (error) {
    console.error(
      "Validation failed:",
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await run();
  Deno.exit(exitCode);
}
