// Shared preamble helpers for gstack smithers workflows.
//
// Replaces the build-time {{PREAMBLE}} placeholder from scripts/resolvers/preamble.ts.
// Original: https://github.com/garrytan/gstack/blob/main/scripts/resolvers/preamble.ts
//
// The original preamble was ~850 lines of bash inlined into every SKILL.md. Here we
// split concerns:
//   - behavioral writing rules  -> prompts/preamble.mdx (consumed as a prop)
//   - config reads + env probe  -> gatherPreambleContext() (deterministic Task body)
//   - usage telemetry           -> PreambleContext flows through the workflow output,
//                                  smithers persists it to SQLite for observability.
import path from "node:path";
import { z } from "zod/v4";
import { sh as runShell, resolveGstackBin } from "./shell";

export const preambleConfigSchema = z.object({
  proactive: z.boolean().default(true),
  explainLevel: z.enum(["default", "terse"]).default("default"),
  skillPrefix: z.boolean().default(false),
  questionTuning: z.boolean().default(false),
});

export const preambleContextSchema = z.object({
  /** One of the known gstack skill names, e.g. "retro", "ship". */
  skillName: z.string(),
  /**
   * Writing-intensity tier. 1 = neutral helper, 2 = direct + anchored, 3 = push hard
   * (office-hours, review), 4 = pedantic (ship, cso). Matches the preamble-tier
   * frontmatter from the original SKILL.md.tmpl files.
   */
  tier: z.number().int().min(1).max(4),
  branch: z.string().nullable().default(null),
  repoRoot: z.string().nullable().default(null),
  repoName: z.string().nullable().default(null),
  /** Slug used for keyed storage under ~/.gstack/projects/<slug>/. */
  slug: z.string().nullable().default(null),
  repoMode: z.enum(["single", "team", "worktree", "unknown"]).default("unknown"),
  config: preambleConfigSchema.default(preambleConfigSchema.parse({})),
  /** Message from `gstack-update-check`, if the binary exists and reports one. */
  updateMessage: z.string().nullable().default(null),
  /**
   * Smithers runId, threaded through for cross-task correlation in telemetry.
   * Named `smithersRunId` rather than `runId` because Smithers reserves a
   * `run_id` column on every persisted output table and camelCase → snake
   * collapse would collide.
   */
  smithersRunId: z.string(),
  startedAt: z.string(),
});

export type PreambleContext = z.infer<typeof preambleContextSchema>;
export type PreambleConfig = z.infer<typeof preambleConfigSchema>;

const sh = (cmd: string, args: string[] = []) =>
  runShell(cmd, args, { tolerateFailure: true });

async function resolveRepo(): Promise<{ root: string | null; name: string | null; branch: string | null; slug: string | null }> {
  const root = (await sh("git", ["rev-parse", "--show-toplevel"])).trim() || null;
  const branch = (await sh("git", ["branch", "--show-current"])).trim() || null;
  const name = root ? path.basename(root) : null;
  const remote = (await sh("git", ["config", "--get", "remote.origin.url"])).trim();
  const slug = remote
    ? remote.replace(/\.git$/, "").replace(/^.*[:/]/, "").toLowerCase()
    : name?.toLowerCase() ?? null;
  return { root, name, branch, slug };
}

async function readGstackConfig(): Promise<PreambleConfig> {
  const keys = ["proactive", "explain_level", "skill_prefix", "question_tuning"] as const;
  const values: Record<string, string> = {};
  for (const key of keys) {
    values[key] = (await sh(resolveGstackBin("gstack-config"), ["get", key])).trim();
  }
  return preambleConfigSchema.parse({
    proactive: values.proactive ? values.proactive !== "false" : true,
    explainLevel: values.explain_level === "terse" ? "terse" : "default",
    skillPrefix: values.skill_prefix === "true",
    questionTuning: values.question_tuning === "true",
  });
}

async function detectRepoMode(): Promise<PreambleContext["repoMode"]> {
  const raw = await sh(resolveGstackBin("gstack-repo-mode"), []);
  const match = /REPO_MODE=(\w+)/.exec(raw);
  const mode = match?.[1];
  if (mode === "single" || mode === "team" || mode === "worktree") return mode;
  return "unknown";
}

async function readUpdateMessage(): Promise<string | null> {
  const msg = (await sh(resolveGstackBin("gstack-update-check"), [])).trim();
  return msg.length > 0 ? msg : null;
}

export type GatherPreambleOptions = {
  skillName: string;
  tier: PreambleContext["tier"];
  runId: string;
};

export async function gatherPreambleContext(
  opts: GatherPreambleOptions,
): Promise<PreambleContext> {
  const [repo, config, repoMode, updateMessage] = await Promise.all([
    resolveRepo(),
    readGstackConfig(),
    detectRepoMode(),
    readUpdateMessage(),
  ]);

  return preambleContextSchema.parse({
    skillName: opts.skillName,
    tier: opts.tier,
    branch: repo.branch,
    repoRoot: repo.root,
    repoName: repo.name,
    slug: repo.slug,
    repoMode,
    config,
    updateMessage,
    smithersRunId: opts.runId,
    startedAt: new Date().toISOString(),
  });
}

/**
 * Detect the base branch (main/master/etc). Used by workflows that compare
 * against trunk. Extracted so it can also be used outside a preamble Task.
 */
export async function detectBaseBranch(): Promise<string> {
  const viaGh = (await sh("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])).trim();
  if (viaGh) return viaGh;
  const symref = (await sh("git", ["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
  if (symref) return symref.replace(/^refs\/remotes\/origin\//, "");
  return "main";
}
