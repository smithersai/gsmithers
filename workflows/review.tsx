// Ported from https://github.com/garrytan/gstack/blob/main/review/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import ReviewPrompt from "../prompts/review.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
  detectBaseBranch,
} from "../lib/smithers/preamble";
import { reviewOutputSchema } from "../lib/smithers/review";
import { sh, shResult } from "../lib/smithers/shell";

const inputSchema = z.object({
  baseBranch: z.string().nullable().default(null),
});

const diffFileSchema = z.object({
  path: z.string(),
  status: z.enum(["modified", "uncommitted", "untracked"]),
  additions: z.number(),
  deletions: z.number(),
});

const diffSummarySchema = z.object({
  baseBranch: z.string(),
  headSha: z.string(),
  filesChanged: z.number(),
  insertions: z.number(),
  deletions: z.number(),
  files: z.array(diffFileSchema),
  patch: z.string(),
  currentBranch: z.string(),
  empty: z.boolean(),
});

async function collectDiff(
  baseOverride: string | null,
): Promise<z.infer<typeof diffSummarySchema>> {
  const baseBranch = baseOverride ?? (await detectBaseBranch());
  const currentBranch = (await sh("git", ["branch", "--show-current"])).trim();
  const headSha = (await sh("git", ["rev-parse", "HEAD"])).trim();

  await sh("git", ["fetch", "origin", baseBranch, "--quiet"], {
    tolerateFailure: true,
  });

  // Committed changes vs base — the normal PR diff case.
  const committedStat = await sh(
    "git",
    ["diff", `origin/${baseBranch}...HEAD`, "--numstat"],
    { tolerateFailure: true },
  );
  const committedFiles = committedStat
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [addStr, delStr, rawPath] = line.split("\t");
      return {
        path: rawPath ?? "",
        status: "modified" as const,
        additions: Number(addStr) || 0,
        deletions: Number(delStr) || 0,
      };
    })
    .filter((f) => f.path.length > 0);

  // Uncommitted changes — staged + unstaged. Reviewing only-committed would
  // silently miss work in progress, including runs on the base branch where
  // the diff-vs-base is empty but the worktree is dirty.
  const uncommittedStat = await sh(
    "git",
    ["diff", "HEAD", "--numstat"],
    { tolerateFailure: true },
  );
  const uncommittedFiles = uncommittedStat
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [addStr, delStr, rawPath] = line.split("\t");
      return {
        path: rawPath ?? "",
        status: "uncommitted" as const,
        additions: Number(addStr) || 0,
        deletions: Number(delStr) || 0,
      };
    })
    .filter((f) => f.path.length > 0);

  // Untracked files — treated as all-insertions. Each file gets a real
  // line count and its body is appended to the patch via `git diff
  // --no-index` so the agent reviews code, not just file names.
  const untrackedRaw = await sh(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { tolerateFailure: true },
  );
  const untrackedPaths = untrackedRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const untrackedFiles: Array<z.infer<typeof diffFileSchema>> = [];
  const untrackedPatches: string[] = [];
  for (const relPath of untrackedPaths) {
    // Skip binaries and oversized files — they bloat context and usually
    // aren't what a human would want in a review. `git diff --no-index`
    // handles the binary sniff for us; a 1MB cap keeps any one file from
    // drowning the prompt.
    const { stdout, exitCode } = await shResult("git", [
      "diff",
      "--no-index",
      "--",
      "/dev/null",
      relPath,
    ]);
    // git diff --no-index exits 0 when equal, 1 when different — "different"
    // is expected for any new file vs /dev/null. Higher codes (128, …) mean
    // error; skip those.
    if (exitCode !== 0 && exitCode !== 1) continue;
    if (!stdout || stdout.length > 1_048_576) continue;
    // git prints `Binary files /dev/null and b/foo differ` when it detects a
    // binary file — exit code is 1 in that case, same as a text diff, so we
    // can't rely on exit codes to skip binaries. Sniff the stdout marker.
    if (/^Binary files .* differ$/m.test(stdout)) continue;
    const added = stdout
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .length;
    untrackedFiles.push({
      path: relPath,
      status: "untracked" as const,
      additions: added,
      deletions: 0,
    });
    untrackedPatches.push(stdout);
  }

  const files = [...committedFiles, ...uncommittedFiles, ...untrackedFiles];
  const insertions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);

  // Patch includes both committed and uncommitted portions; untracked files
  // are surfaced by path only (sending every new file's body into the diff
  // would blow context).
  const committedPatch = await sh(
    "git",
    ["diff", `origin/${baseBranch}...HEAD`],
    { tolerateFailure: true },
  );
  const uncommittedPatch = await sh("git", ["diff", "HEAD"], {
    tolerateFailure: true,
  });
  const patch = [committedPatch, uncommittedPatch, ...untrackedPatches]
    .filter(Boolean)
    .join("\n");
  const empty = files.length === 0;

  return {
    baseBranch,
    headSha,
    filesChanged: files.length,
    insertions,
    deletions,
    files,
    patch,
    currentBranch,
    empty,
  };
}

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    diff: diffSummarySchema,
    review: reviewOutputSchema,
  },
  {
    readableName: "Review",
    description: "Pre-landing PR review — SQL, LLM trust, side effects, security, back-compat.",
    dbPath: "./executions/review.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="review">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "review",
          tier: 4,
          runId: ctx.runId,
        })
      }
    </Task>

    <Task id="diff" output={outputs.diff} timeoutMs={60_000}>
      {async () => collectDiff(ctx.input.baseBranch)}
    </Task>

    <Task
      id="review"
      output={outputs.review}
      needs={{ preamble: "preamble", diff: "diff" }}
      deps={{ preamble: preambleContextSchema, diff: diffSummarySchema }}
      agent={agents.smartTool}
      timeoutMs={1_800_000}
      heartbeatTimeoutMs={600_000}
    >
      {(deps) =>
        deps.diff.empty ? (
          <>
            Nothing to review — current branch has no diff against origin/
            {deps.diff.baseBranch}.
          </>
        ) : (
          <>
            <PreamblePrompt {...deps.preamble} />
            <ReviewPrompt
              baseBranch={deps.diff.baseBranch}
              diffSummary={deps.diff}
            />
          </>
        )
      }
    </Task>
  </Workflow>
));
