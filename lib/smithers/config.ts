// Direct reader for ~/.gstack/config.yaml.
//
// Why not `gstack-config get`? Its get path pipes through `awk '{print $2}'`,
// which returns only the second whitespace-delimited token. So a value like
// `deploy_command: "vercel deploy --prod"` comes back as `"vercel` — fine for
// single-token config like `explain_level: terse`, but silently wrong for
// anything with spaces (deploy commands, quoted URLs). Fixing gstack-config
// would ripple into every existing SKILL.md consumer, so workflows that read
// multi-token values do it directly here.
import { readFile } from "node:fs/promises";
import path from "node:path";

// Lazy — HOME is read each call so tests can override it per invocation.
const configPath = () =>
  path.join(process.env.HOME ?? "", ".gstack", "config.yaml");

/**
 * Read the full value for a single top-level key from ~/.gstack/config.yaml.
 * Returns `null` when the key is missing or its value is the empty string.
 *
 * Supports:
 *   key: bare value
 *   key: "quoted value with spaces"
 *   key: 'single quoted'
 *
 * Does NOT support nested keys or multi-line values — gstack-config itself
 * only writes flat key/value lines.
 */
export async function readGstackConfigValue(key: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9_]+$/.test(key)) {
    throw new Error(`readGstackConfigValue: invalid key ${JSON.stringify(key)}`);
  }
  let text: string;
  try {
    text = await readFile(configPath(), "utf-8");
  } catch {
    return null;
  }
  // Walk in reverse so later overrides win (gstack-config's `set` uses
  // in-place sed for existing keys, but defensive parsing matches anyway).
  const lines = text.split("\n").reverse();
  const prefix = `${key}:`;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) continue;
    if (!trimmed.startsWith(prefix)) continue;
    const raw = trimmed.slice(prefix.length).trim();
    const value = parseScalar(raw);
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Parse a YAML-style scalar:
 *   - `"..."` — JSON.parse so escapes like `\"`, `\n`, and literal `#` work.
 *     `setup-deploy.tsx` writes values via JSON.stringify, so this is the
 *     common case.
 *   - `'...'` — YAML single-quote semantics (literal contents, no escapes
 *     except `''` → `'`).
 *   - bare value — strip trailing comment ONLY when `#` is preceded by
 *     whitespace (YAML rule). A `#` inside a URL fragment like
 *     `https://x/#/dashboard` is part of the value, not a comment.
 */
function parseScalar(raw: string): string {
  if (raw.length === 0) return "";
  const first = raw[0];
  if (first === '"') {
    const end = findQuotedEnd(raw, '"');
    if (end === -1) return raw;
    try {
      return JSON.parse(raw.slice(0, end + 1)) as string;
    } catch {
      // Malformed — fall through to bare interpretation.
    }
  }
  if (first === "'") {
    const end = findQuotedEnd(raw, "'");
    if (end === -1) return raw;
    return raw.slice(1, end).replace(/''/g, "'");
  }
  // Bare: trim only at whitespace-then-`#` so URL fragments survive.
  return stripBareComment(raw);
}

function findQuotedEnd(value: string, quote: '"' | "'"): number {
  if (quote === '"') {
    for (let i = 1; i < value.length; i++) {
      if (value[i] === "\\") {
        i += 1;
        continue;
      }
      if (value[i] === '"') return i;
    }
    return -1;
  }
  // Single-quoted: `''` is a literal `'`, any other `'` ends the value.
  for (let i = 1; i < value.length; i++) {
    if (value[i] === "'") {
      if (value[i + 1] === "'") {
        i += 1;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function stripBareComment(value: string): string {
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "#") continue;
    // YAML: `#` only starts a comment when preceded by whitespace (or is
    // the first char). Otherwise it's part of the value (e.g. URL fragments,
    // CSS anchors, color codes).
    if (i === 0 || /\s/.test(value[i - 1]!)) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}
