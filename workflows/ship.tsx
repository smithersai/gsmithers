// Ported from https://github.com/garrytan/gstack/blob/main/ship/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import ShipPreflightPrompt from "../prompts/ship-preflight.mdx";
import ShipChangelogPrompt from "../prompts/ship-changelog.mdx";
import ShipPrBodyPrompt from "../prompts/ship-pr-body.mdx";
import ReviewPrompt from "../prompts/review.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
  detectBaseBranch,
} from "../lib/smithers/preamble";
import { readOutput, readOutputMaybe } from "../lib/smithers/ctx";
import { reviewOutputSchema } from "../lib/smithers/review";
import { sh } from "../lib/smithers/shell";

const inputSchema = z.object({
  /**
   * If false (default), the workflow runs through PR creation with
   * needsApproval on the push and pr-create steps — smithers pauses for
   * human approval there. If true, those approvals auto-pass (useful in
   * CI where a bot has already decided).
   */
  autoApprovePush: z.boolean().default(false),
});

const commitSchema = z.object({ hash: z.string(), subject: z.string() });

const preflightSchema = z.object({
  currentBranch: z.string(),
  baseBranch: z.string(),
  cleanWorkingTree: z.boolean(),
  unpushedCommits: z.number(),
  existingPr: z
    .object({ number: z.number(), title: z.string(), url: z.string() })
    .nullable(),
  diff: z.object({
    filesChanged: z.number(),
    insertions: z.number(),
    deletions: z.number(),
    patch: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        status: z.string(),
        additions: z.number(),
        deletions: z.number(),
      }),
    ),
    headSha: z.string(),
    baseBranch: z.string(),
    currentBranch: z.string(),
    empty: z.boolean(),
  }),
  changelogTouched: z.boolean(),
  versionTouched: z.boolean(),
  currentVersion: z.string(),
  commits: z.array(commitSchema),
});

const preflightDecisionSchema = z.object({
  proceed: z.boolean(),
  blockers: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  nextStep: z.string(),
});

const testResultSchema = z.object({
  passed: z.boolean(),
  output: z.string(),
  duration: z.number(),
});

const changelogEntrySchema = z.object({
  version: z.string(),
  entry: z.string(),
  bumpLevel: z.enum(["patch", "minor", "major"]),
});

const prBodySchema = z.object({
  title: z.string(),
  body: z.string(),
});

const releaseWriteSchema = z.object({
  changelogPath: z.string(),
  versionPath: z.string(),
  version: z.string(),
});

const commitSchema2 = z.object({
  sha: z.string(),
  subject: z.string(),
});

const pushResultSchema = z.object({
  pushed: z.boolean(),
  branch: z.string(),
});

const prCreateSchema = z.object({
  prUrl: z.string(),
  prNumber: z.number().nullable(),
  alreadyExisted: z.boolean(),
});

async function shOk(cmd: string, args: string[]): Promise<string> {
  return sh(cmd, args, { tolerateFailure: true });
}

async function gatherPreflight(): Promise<z.infer<typeof preflightSchema>> {
  const baseBranch = await detectBaseBranch();
  const currentBranch = (await sh("git", ["branch", "--show-current"])).trim();
  const porcelain = (await sh("git", ["status", "--porcelain"])).trim();
  const cleanWorkingTree = porcelain.length === 0;

  await shOk("git", ["fetch", "origin", baseBranch, "--quiet"]);

  const unpushedRaw = await shOk("git", [
    "log",
    `origin/${baseBranch}..HEAD`,
    "--oneline",
  ]);
  const unpushedCommits = unpushedRaw.split("\n").filter(Boolean).length;

  const commitLog = await shOk("git", [
    "log",
    `origin/${baseBranch}..HEAD`,
    "--format=%H|%s",
  ]);
  const commits = commitLog
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, ...rest] = line.split("|");
      return { hash: hash ?? "", subject: rest.join("|") };
    });

  let existingPr: z.infer<typeof preflightSchema>["existingPr"] = null;
  const prRaw = await shOk("gh", ["pr", "view", "--json", "number,title,url"]);
  if (prRaw) {
    try {
      existingPr = JSON.parse(prRaw) as {
        number: number;
        title: string;
        url: string;
      };
    } catch {
      // non-JSON output — no PR
    }
  }

  const statRaw = await shOk("git", [
    "diff",
    `origin/${baseBranch}...HEAD`,
    "--numstat",
  ]);
  const files = statRaw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [addStr, delStr, rawPath] = line.split("\t");
      return {
        path: rawPath ?? "",
        status: "modified",
        additions: Number(addStr) || 0,
        deletions: Number(delStr) || 0,
      };
    })
    .filter((f) => f.path.length > 0);

  const patch = await shOk("git", ["diff", `origin/${baseBranch}...HEAD`]);
  const insertions = files.reduce((s, f) => s + f.additions, 0);
  const deletions = files.reduce((s, f) => s + f.deletions, 0);
  const headSha = (await shOk("git", ["rev-parse", "HEAD"])).trim();
  const changelogTouched = files.some((f) => f.path === "CHANGELOG.md");
  const versionTouched = files.some((f) => f.path === "VERSION");

  const repoRoot = (await shOk("git", ["rev-parse", "--show-toplevel"])).trim();
  let currentVersion = "0.0.0.0";
  if (repoRoot) {
    try {
      currentVersion = (
        await readFile(path.join(repoRoot, "VERSION"), "utf-8")
      ).trim();
    } catch {
      // no VERSION file
    }
  }

  return {
    currentBranch,
    baseBranch,
    cleanWorkingTree,
    unpushedCommits,
    existingPr,
    diff: {
      filesChanged: files.length,
      insertions,
      deletions,
      patch,
      files,
      headSha,
      baseBranch,
      currentBranch,
      empty: currentBranch === baseBranch || files.length === 0,
    },
    changelogTouched,
    versionTouched,
    currentVersion,
    commits,
  };
}

async function runTests(): Promise<z.infer<typeof testResultSchema>> {
  const start = Date.now();
  try {
    const out = await sh("bun", ["test"]);
    return { passed: true, output: out, duration: Date.now() - start };
  } catch (err) {
    return {
      passed: false,
      output: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    };
  }
}

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    preflight: preflightSchema,
    preflightDecision: preflightDecisionSchema,
    tests: testResultSchema,
    review: reviewOutputSchema,
    changelog: changelogEntrySchema,
    prBody: prBodySchema,
    releaseWrite: releaseWriteSchema,
    releaseCommit: commitSchema2,
    push: pushResultSchema,
    prCreate: prCreateSchema,
  },
  {
    readableName: "Ship",
    description: "Flagship release workflow — preflight, test, review, commit, push, PR.",
    dbPath: "./executions/ship.db",
  },
);

export default smithers((ctx) => {
  const decision = readOutputMaybe(ctx, preflightDecisionSchema, "preflight-decide");
  const tests = readOutputMaybe(ctx, testResultSchema, "tests");
  const blocked =
    decision?.proceed === false || tests?.passed === false;
  const autoApproved = ctx.input.autoApprovePush;

  return (
    <Workflow name="ship">
      <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
        {async () =>
          gatherPreambleContext({
            skillName: "ship",
            tier: 4,
            runId: ctx.runId,
          })
        }
      </Task>

      <Task id="preflight" output={outputs.preflight} timeoutMs={120_000}>
        {async () => gatherPreflight()}
      </Task>

      <Task
        id="preflight-decide"
        output={outputs.preflightDecision}
        needs={{ preamble: "preamble", preflight: "preflight" }}
        deps={{ preamble: preambleContextSchema, preflight: preflightSchema }}
        agent={agents.cheapFast}
        timeoutMs={120_000}
      >
        {(deps) => (
          <>
            <PreamblePrompt {...deps.preamble} />
            <ShipPreflightPrompt preflight={deps.preflight} />
          </>
        )}
      </Task>

      <Task
        id="tests"
        output={outputs.tests}
        timeoutMs={600_000}
        skipIf={decision?.proceed === false}
      >
        {async () => runTests()}
      </Task>

      <Task
        id="review"
        output={outputs.review}
        needs={{ preamble: "preamble", preflight: "preflight" }}
        deps={{ preamble: preambleContextSchema, preflight: preflightSchema }}
        agent={agents.smartTool}
        timeoutMs={1_800_000}
        heartbeatTimeoutMs={600_000}
        skipIf={blocked}
      >
        {(deps) => (
          <>
            <PreamblePrompt {...deps.preamble} />
            <ReviewPrompt
              baseBranch={deps.preflight.baseBranch}
              diffSummary={deps.preflight.diff}
            />
          </>
        )}
      </Task>

      <Task
        id="changelog"
        output={outputs.changelog}
        needs={{ preamble: "preamble", preflight: "preflight" }}
        deps={{ preamble: preambleContextSchema, preflight: preflightSchema }}
        agent={agents.smart}
        timeoutMs={300_000}
        skipIf={blocked}
      >
        {(deps) => (
          <>
            <PreamblePrompt {...deps.preamble} />
            <ShipChangelogPrompt
              preflight={deps.preflight}
              currentVersion={deps.preflight.currentVersion}
              commits={deps.preflight.commits}
              baseVersionReleased={!deps.preflight.changelogTouched}
            />
          </>
        )}
      </Task>

      <Task
        id="pr-body"
        output={outputs.prBody}
        needs={{
          preamble: "preamble",
          preflight: "preflight",
          review: "review",
          changelog: "changelog",
        }}
        deps={{
          preamble: preambleContextSchema,
          preflight: preflightSchema,
          review: reviewOutputSchema,
          changelog: changelogEntrySchema,
        }}
        agent={agents.smart}
        timeoutMs={300_000}
        skipIf={blocked}
      >
        {(deps) => (
          <>
            <PreamblePrompt {...deps.preamble} />
            <ShipPrBodyPrompt
              preflight={deps.preflight}
              commits={deps.preflight.commits}
              review={deps.review}
              changelogEntry={deps.changelog.entry}
            />
          </>
        )}
      </Task>

      <Task
        id="release-write"
        output={outputs.releaseWrite}
        dependsOn={["changelog"]}
        timeoutMs={30_000}
        skipIf={blocked}
      >
        {async () => {
          const changelog = readOutput(ctx, changelogEntrySchema, "changelog");
          const repoRoot = (
            await sh("git", ["rev-parse", "--show-toplevel"])
          ).trim();
          const changelogPath = path.join(repoRoot, "CHANGELOG.md");
          const versionPath = path.join(repoRoot, "VERSION");
          const existing = await readFile(changelogPath, "utf-8").catch(() => "");
          await writeFile(changelogPath, changelog.entry + "\n" + existing);
          await writeFile(versionPath, changelog.version + "\n");
          return {
            changelogPath,
            versionPath,
            version: changelog.version,
          };
        }}
      </Task>

      <Task
        id="release-commit"
        output={outputs.releaseCommit}
        dependsOn={["release-write", "changelog"]}
        timeoutMs={30_000}
        skipIf={blocked}
      >
        {async () => {
          const release = readOutput(ctx, releaseWriteSchema, "release-write");
          const changelog = readOutput(ctx, changelogEntrySchema, "changelog");
          await sh("git", ["add", release.changelogPath, release.versionPath]);
          const subject = `chore(release): ${changelog.version}`;
          await sh("git", ["commit", "-m", subject]);
          const sha = (await sh("git", ["rev-parse", "HEAD"])).trim();
          return { sha, subject };
        }}
      </Task>

      <Task
        id="push"
        output={outputs.push}
        dependsOn={["preflight", "release-commit"]}
        timeoutMs={120_000}
        needsApproval={!autoApproved}
        skipIf={blocked}
      >
        {async () => {
          const preflight = readOutput(ctx, preflightSchema, "preflight");
          await sh("git", ["push", "-u", "origin", preflight.currentBranch]);
          return { pushed: true, branch: preflight.currentBranch };
        }}
      </Task>

      <Task
        id="pr-create"
        output={outputs.prCreate}
        dependsOn={["preflight", "pr-body", "push"]}
        timeoutMs={120_000}
        needsApproval={!autoApproved}
        skipIf={blocked}
      >
        {async () => {
          const preflight = readOutput(ctx, preflightSchema, "preflight");
          const prBody = readOutput(ctx, prBodySchema, "pr-body");
          // Idempotency: if a PR already exists on this branch, return it
          // instead of opening a duplicate — this Task may re-run on resume.
          if (preflight.existingPr) {
            return {
              prUrl: preflight.existingPr.url,
              prNumber: preflight.existingPr.number,
              alreadyExisted: true,
            };
          }
          const prOut = await sh("gh", [
            "pr",
            "create",
            "--title",
            prBody.title,
            "--body",
            prBody.body,
          ]);
          const prUrl = prOut.trim().split("\n").pop() ?? "";
          const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
          const prNumber = prNumberMatch ? Number(prNumberMatch[1]) : null;
          return { prUrl, prNumber, alreadyExisted: false };
        }}
      </Task>
    </Workflow>
  );
});
