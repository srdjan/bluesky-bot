// scripts/shared/env.ts
// Utilities for loading .env files and resolving environment variables.

export function loadDotenv(file: string = ".env"): void {
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

/** Returns the first non-empty environment value from the provided keys. */
export function firstEnv(
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
