// Ported from https://github.com/garrytan/gstack/blob/main/land-and-deploy/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import LandAndDeployReadinessPrompt from "../prompts/land-and-deploy-readiness.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
  detectBaseBranch,
} from "../lib/smithers/preamble";
import { readOutput, readOutputMaybe } from "../lib/smithers/ctx";
import { sh } from "../lib/smithers/shell";
import { readGstackConfigValue } from "../lib/smithers/config";

const inputSchema = z.object({
  prNumber: z.number().nullable().default(null),
  /**
   * When false (default), merge and deploy tasks fire with needsApproval so
   * smithers pauses for a human gate. When true, they auto-pass. Intended
   * for CI where a bot has already decided.
   */
  autoApprove: z.boolean().default(false),
});

const prInfoSchema = z.object({
  number: z.number(),
  title: z.string(),
  branch: z.string(),
  baseBranch: z.string(),
  url: z.string(),
});

const ciStatusSchema = z.object({
  state: z.enum(["passing", "failing", "pending", "unknown"]),
  passingChecks: z.number(),
  failingChecks: z.number(),
  pendingChecks: z.number(),
});

const reviewStalenessSchema = z.object({
  staleness: z.enum(["fresh", "stale", "never_reviewed"]),
  /**
   * gh's reviewDecision: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED,
   * or null when no review has been requested. Fetched *and used* —
   * the gate blocks merge on CHANGES_REQUESTED regardless of staleness.
   */
  decision: z
    .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", "none"])
    .default("none"),
});

const deployTargetSchema = z.object({
  command: z.string().nullable(),
  stagingUrl: z.string().nullable(),
  productionUrl: z.string().nullable(),
});

const readinessGateSchema = z.object({
  readyToMerge: z.boolean(),
  readyToDeploy: z.boolean(),
  mergeBlockers: z.array(z.string()).default([]),
  deployBlockers: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  requiresConfirmation: z.boolean(),
  confirmationPrompt: z.string().nullable().default(null),
});

const mergeResultSchema = z.object({
  merged: z.boolean(),
  sha: z.string().nullable(),
  summary: z.string(),
});

const deployResultSchema = z.object({
  deployed: z.boolean(),
  target: z.enum(["staging", "production", "none"]),
  deployUrl: z.string().nullable(),
  summary: z.string(),
});

const shOk = (cmd: string, args: string[]) =>
  sh(cmd, args, { tolerateFailure: true });

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    pr: prInfoSchema,
    ci: ciStatusSchema,
    review: reviewStalenessSchema,
    deploy: deployTargetSchema,
    gate: readinessGateSchema,
    merge: mergeResultSchema,
    deployResult: deployResultSchema,
  },
  {
    readableName: "Land and Deploy",
    description: "Merge the PR, deploy to the detected target, verify.",
    dbPath: "./executions/land-and-deploy.db",
  },
);

export default smithers((ctx) => {
  const gate = readOutputMaybe(ctx, readinessGateSchema, "gate");
  const merge = readOutputMaybe(ctx, mergeResultSchema, "merge");
  const review = readOutputMaybe(ctx, reviewStalenessSchema, "review");
  const ci = readOutputMaybe(ctx, ciStatusSchema, "ci");
  // autoApprove ONLY bypasses approval when the gate is also satisfied that
  // confirmation isn't required. A gate that asks for a human keeps needing
  // one even in CI — otherwise `autoApprove` quietly defeats the entire
  // readiness check.
  const autoApproved =
    ctx.input.autoApprove && gate?.requiresConfirmation !== true;
  // Deterministic guards. The agent-emitted gate is the main signal, but we
  // also code-enforce the non-negotiables: CI must be passing, review must
  // not be CHANGES_REQUESTED, and deploy requires an actual merge (not
  // merely an absent merge output, which would be `undefined` before the
  // task runs — that's how we accidentally deploy-before-merge).
  const ciPassing = ci?.state === "passing";
  const reviewOk = review?.decision !== "CHANGES_REQUESTED";
  const mergeAllowed = gate?.readyToMerge === true && ciPassing && reviewOk;
  const deployAllowed =
    gate?.readyToDeploy === true && merge?.merged === true && ciPassing && reviewOk;

  return (
    <Workflow name="land-and-deploy">
      <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
        {async () =>
          gatherPreambleContext({
            skillName: "land-and-deploy",
            tier: 4,
            runId: ctx.runId,
          })
        }
      </Task>

      <Task id="pr" output={outputs.pr} timeoutMs={30_000}>
        {async () => {
          const args = ctx.input.prNumber
            ? [
                "pr",
                "view",
                String(ctx.input.prNumber),
                "--json",
                "number,title,headRefName,baseRefName,url",
              ]
            : [
                "pr",
                "view",
                "--json",
                "number,title,headRefName,baseRefName,url",
              ];
          const raw = await sh("gh", args);
          const parsed = JSON.parse(raw) as {
            number: number;
            title: string;
            headRefName: string;
            baseRefName: string;
            url: string;
          };
          return {
            number: parsed.number,
            title: parsed.title,
            branch: parsed.headRefName,
            baseBranch: parsed.baseRefName || (await detectBaseBranch()),
            url: parsed.url,
          };
        }}
      </Task>

      <Task
        id="ci"
        output={outputs.ci}
        dependsOn={["pr"]}
        timeoutMs={30_000}
      >
        {async () => {
          const pr = readOutput(ctx, prInfoSchema, "pr");
          // gh pr checks exposes `bucket` (pass/fail/pending/skipping/cancel),
          // NOT `conclusion`. Using the wrong field fails JSON parse and the
          // gate silently reports "unknown" — the merge gate would miss
          // actually-failing checks. Bucket is authoritative.
          const raw = await shOk("gh", [
            "pr",
            "checks",
            String(pr.number),
            "--json",
            "bucket,state,name",
          ]);
          let passingChecks = 0;
          let failingChecks = 0;
          let pendingChecks = 0;
          try {
            const checks = JSON.parse(raw) as Array<{
              bucket: string;
              state: string;
              name: string;
            }>;
            for (const check of checks) {
              switch (check.bucket) {
                case "pass":
                  passingChecks += 1;
                  break;
                case "fail":
                case "cancel":
                  failingChecks += 1;
                  break;
                case "pending":
                  pendingChecks += 1;
                  break;
                // "skipping" — neither pass nor fail; don't count
              }
            }
          } catch {
            // no parseable output — leave counts at zero
          }
          const state =
            failingChecks > 0
              ? "failing"
              : pendingChecks > 0
              ? "pending"
              : passingChecks > 0
              ? "passing"
              : "unknown";
          return { state, passingChecks, failingChecks, pendingChecks };
        }}
      </Task>

      <Task
        id="review"
        output={outputs.review}
        dependsOn={["pr"]}
        timeoutMs={15_000}
      >
        {async () => {
          const pr = readOutput(ctx, prInfoSchema, "pr");
          const raw = await shOk("gh", [
            "pr",
            "view",
            String(pr.number),
            "--json",
            "reviewDecision,latestReviews",
          ]);
          let staleness: "fresh" | "stale" | "never_reviewed" = "never_reviewed";
          let decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "none" =
            "none";
          try {
            const parsed = JSON.parse(raw) as {
              reviewDecision: string | null;
              latestReviews: Array<{ submittedAt: string }>;
            };
            if (parsed.latestReviews && parsed.latestReviews.length > 0) {
              const latest = parsed.latestReviews[0]!.submittedAt;
              const ageMs = Date.now() - new Date(latest).getTime();
              staleness = ageMs < 24 * 60 * 60 * 1000 ? "fresh" : "stale";
            }
            if (
              parsed.reviewDecision === "APPROVED" ||
              parsed.reviewDecision === "CHANGES_REQUESTED" ||
              parsed.reviewDecision === "REVIEW_REQUIRED"
            ) {
              decision = parsed.reviewDecision;
            }
          } catch {
            // not reviewable — leave as never_reviewed / none
          }
          return { staleness, decision };
        }}
      </Task>

      <Task id="deploy" output={outputs.deploy} timeoutMs={10_000}>
        {async () => {
          // Read ~/.gstack/config.yaml directly. gstack-config get truncates
          // multi-word values at the first whitespace (awk '{print $2}'), so
          // a deploy_command like "vercel deploy --prod" would come back as
          // "vercel" and silently execute the wrong binary.
          const [command, stagingUrl, productionUrl] = await Promise.all([
            readGstackConfigValue("deploy_command"),
            readGstackConfigValue("staging_url"),
            readGstackConfigValue("production_url"),
          ]);
          return { command, stagingUrl, productionUrl };
        }}
      </Task>

      <Task
        id="gate"
        output={outputs.gate}
        needs={{
          preamble: "preamble",
          pr: "pr",
          ci: "ci",
          review: "review",
          deploy: "deploy",
        }}
        deps={{
          preamble: preambleContextSchema,
          pr: prInfoSchema,
          ci: ciStatusSchema,
          review: reviewStalenessSchema,
          deploy: deployTargetSchema,
        }}
        agent={agents.smart}
        timeoutMs={300_000}
      >
        {(deps) => (
          <>
            <PreamblePrompt {...deps.preamble} />
            <LandAndDeployReadinessPrompt
              pr={deps.pr}
              ci={deps.ci}
              review={deps.review}
              deploy={deps.deploy}
              docReleaseDone={false}
            />
          </>
        )}
      </Task>

      <Task
        id="merge"
        output={outputs.merge}
        dependsOn={["pr", "gate"]}
        // 30-minute cap — `--auto` waits on CI + branch protection to
        // clear before landing. Lower if your CI is fast.
        timeoutMs={1_800_000}
        skipIf={!mergeAllowed}
        needsApproval={!autoApproved}
      >
        {async () => {
          const pr = readOutput(ctx, prInfoSchema, "pr");
          // `gh pr merge --auto` does NOT mean "merge now" — the gh CLI
          // docs say it enables auto-merge once required checks pass (or
          // adds to the merge queue if one is configured). Returning
          // `merged: true` right after that call would let the deploy
          // Task run before the PR actually landed.
          //
          // Trigger auto-merge, then poll `gh pr view` until state flips
          // to MERGED. Return the real merge commit SHA, not local HEAD.
          await sh("gh", [
            "pr",
            "merge",
            String(pr.number),
            "--squash",
            "--auto",
          ]);
          const pollIntervalMs = 10_000;
          const deadline = Date.now() + 1_700_000;
          let state: string | null = null;
          let mergeCommit: string | null = null;
          while (Date.now() < deadline) {
            const raw = await shOk("gh", [
              "pr",
              "view",
              String(pr.number),
              "--json",
              "state,mergeCommit",
            ]);
            try {
              const parsed = JSON.parse(raw) as {
                state?: string;
                mergeCommit?: { oid?: string } | null;
              };
              state = parsed.state ?? null;
              mergeCommit = parsed.mergeCommit?.oid ?? null;
            } catch {
              // occasional non-JSON output (rate limiting) — keep polling
            }
            if (state === "MERGED" && mergeCommit) break;
            if (state === "CLOSED") {
              throw new Error(
                `land-and-deploy: PR #${pr.number} closed without merging`,
              );
            }
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          }
          if (state !== "MERGED" || !mergeCommit) {
            throw new Error(
              `land-and-deploy: auto-merge didn't land PR #${pr.number} in time (last state: ${state ?? "unknown"}). Deploy gate will not proceed.`,
            );
          }
          return {
            merged: true,
            sha: mergeCommit,
            summary: `Merged PR #${pr.number} at ${mergeCommit.slice(0, 10)}`,
          };
        }}
      </Task>

      <Task
        id="deployResult"
        output={outputs.deployResult}
        dependsOn={["deploy", "merge", "gate"]}
        timeoutMs={600_000}
        skipIf={!deployAllowed}
        needsApproval={!autoApproved}
      >
        {async () => {
          const deploy = readOutput(ctx, deployTargetSchema, "deploy");
          if (!deploy.command) {
            return {
              deployed: false,
              target: "none",
              deployUrl: null,
              summary: "No deploy command configured — skipping.",
            };
          }
          // Deploy commands like `vercel deploy --prod` or `pnpm --filter web
          // deploy` routinely use quoting, env var expansion, and flags that
          // a naive split(" ") mangles. `sh -c` runs the full line through
          // the user's shell with proper tokenization. `-lc` was tempting
          // but isn't portable across every /bin/sh (dash, busybox ash).
          await sh("sh", ["-c", deploy.command]);
          const target: "staging" | "production" = deploy.stagingUrl
            ? "staging"
            : "production";
          const deployUrl =
            target === "staging"
              ? deploy.stagingUrl
              : deploy.productionUrl;
          return {
            deployed: true,
            target,
            deployUrl,
            summary: `Deployed to ${target}: ${deployUrl ?? "(no URL)"}`,
          };
        }}
      </Task>
    </Workflow>
  );
});
