// Shared shell helpers for deterministic Tasks.
// Also exports `shQuote` for scripts we write to disk that must survive any
// user-controlled characters in their arguments.
//
//
// Uses smithers' `bashTool` when a ToolContext is present (so we pick up
// sandboxing, output caps, and tool-call observability), falling back to a
// plain spawn when called outside any runtime — useful for scripts and tests.
//
// `bashTool` requires the run to be invoked with `--allowNetwork` for git/gh/
// curl commands to work. See workflows/README.md for the invocation note.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { bashTool, getToolContext } from "smithers-orchestrator/tools";

export type ShellOptions = {
  /** When true, non-zero exit returns output instead of throwing. */
  tolerateFailure?: boolean;
  cwd?: string;
};

/**
 * Resolve a `gstack-*` bin (gstack-config, gstack-repo-mode, etc.) to an
 * absolute path. Search order:
 *   1. `$GSTACK_ROOT/bin/<name>` if env is set
 *   2. `<package>/bin/<name>` (this package — walks up from __dirname)
 *   3. `~/.claude/skills/gstack/bin/<name>` (global install)
 *   4. Bare name — trust PATH
 *
 * Why: gstack's bins aren't installed to PATH. In this repo they live at
 * `bin/`, and in a global install they live under `~/.claude/skills/gstack/bin`.
 * Calling `sh("gstack-config", ...)` by bare name silently returns empty
 * through `tolerateFailure`, which masks broken deploy config reads.
 */
let cachedGstackBinRoot: string | null | undefined;
export function resolveGstackBin(name: string): string {
  if (cachedGstackBinRoot === undefined) {
    cachedGstackBinRoot = findGstackBinRoot();
  }
  if (cachedGstackBinRoot) {
    const candidate = path.join(cachedGstackBinRoot, name);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

function findGstackBinRoot(): string | null {
  const envRoot = process.env.GSTACK_ROOT;
  if (envRoot) {
    const bin = path.join(envRoot, "bin");
    if (existsSync(bin)) return bin;
  }
  // Walk up from this file (lib/smithers/shell.ts) to find a bin/ sibling.
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "bin");
    if (existsSync(path.join(candidate, "gstack-config"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const globalBin = path.join(
    process.env.HOME ?? "",
    ".claude",
    "skills",
    "gstack",
    "bin",
  );
  if (existsSync(path.join(globalBin, "gstack-config"))) return globalBin;
  return null;
}

/**
 * Quote a value so it's safe to interpolate into a /bin/sh single-quoted
 * literal. Use this whenever we generate shell scripts on disk that will
 * embed arbitrary filesystem paths — JSON.stringify is NOT shell-safe
 * because `$`, backticks, and command substitution all expand inside
 * double quotes.
 */
export function shQuote(value: string): string {
  // Close the single quote, insert an escaped literal quote, reopen.
  // E.g. `can't` → `'can'\''t'`.
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Run a command and return combined stdout+stderr. Throws on non-zero exit
 * unless `tolerateFailure: true`.
 */
export async function sh(
  cmd: string,
  args: string[] = [],
  opts: ShellOptions = {},
): Promise<string> {
  if (getToolContext()) {
    try {
      return await bashTool(cmd, args, opts.cwd ? { cwd: opts.cwd } : undefined);
    } catch (err) {
      if (opts.tolerateFailure) {
        // bashTool attaches output to the error; surface it as empty string
        const smithersErr = err as { details?: { output?: string } };
        return smithersErr.details?.output ?? "";
      }
      throw err;
    }
  }
  return spawnFallback(cmd, args, opts);
}

/** Returns output + exit code without throwing, for callers that need both. */
export async function shResult(
  cmd: string,
  args: string[] = [],
  opts: ShellOptions = {},
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("close", (code) => {
      resolve({ stdout: stdout + stderr, exitCode: code ?? 0 });
    });
    proc.on("error", (e) => reject(e));
  });
}

function spawnFallback(
  cmd: string,
  args: string[],
  opts: ShellOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("close", (code) => {
      if (code !== 0 && !opts.tolerateFailure) {
        reject(new Error(`${cmd} ${args.join(" ")} failed: ${err || out}`));
      } else {
        resolve(out + err);
      }
    });
    proc.on("error", (e) => {
      if (opts.tolerateFailure) resolve("");
      else reject(e);
    });
  });
}
