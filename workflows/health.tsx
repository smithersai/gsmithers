// Ported from https://github.com/garrytan/gstack/blob/main/health/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import HealthReportPrompt from "../prompts/health-report.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
  detectBaseBranch,
} from "../lib/smithers/preamble";
import { sh } from "../lib/smithers/shell";

const inputSchema = z.object({});

const healthChecksSchema = z.object({
  testFileCount: z.number(),
  testRatio: z.number().nullable(),
  depCount: z.number().nullable(),
  auditSummary: z.string(),
  ciStatus: z.enum(["passing", "failing", "pending", "unknown"]),
  openPrCount: z.number().nullable(),
  openCriticalIssues: z.number().nullable(),
  uniqueAuthorsLast30d: z.number(),
  branch: z.string(),
});

const healthReportSchema = z.object({
  status: z.enum(["green", "yellow", "red"]),
  summary: z.string(),
  greens: z.array(z.string()).default([]),
  yellows: z
    .array(z.object({ check: z.string(), note: z.string() }))
    .default([]),
  reds: z
    .array(
      z.object({
        check: z.string(),
        note: z.string(),
        actionable: z.string(),
      }),
    )
    .default([]),
  topThree: z.array(z.string()).default([]),
});

const shOk = (cmd: string, args: string[]) =>
  sh(cmd, args, { tolerateFailure: true });

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    checks: healthChecksSchema,
    report: healthReportSchema,
  },
  {
    readableName: "Health",
    description: "Repo health rollup — tests, deps, CI, PRs, bus factor.",
    dbPath: "./executions/health.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="health">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
        {async () =>
          gatherPreambleContext({
            skillName: "health",
            tier: 2,
            runId: ctx.runId,
          })
        }
      </Task>

      <Task id="checks" output={outputs.checks} timeoutMs={120_000}>
        {async () => {
          const base = await detectBaseBranch();

          const testFilesRaw = await shOk("sh", [
            "-c",
            "find . -type f \\( -name '*.test.*' -o -name '*.spec.*' -o -name '*_test.*' \\) -not -path './node_modules/*' | wc -l",
          ]);
          const testFileCount = Number(testFilesRaw.trim()) || 0;

          const repoRoot = (await shOk("git", ["rev-parse", "--show-toplevel"])).trim();
          let depCount: number | null = null;
          if (repoRoot) {
            try {
              const pkg = JSON.parse(
                await readFile(path.join(repoRoot, "package.json"), "utf-8"),
              ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
              depCount =
                Object.keys(pkg.dependencies ?? {}).length +
                Object.keys(pkg.devDependencies ?? {}).length;
            } catch {
              // no package.json — leave depCount null
            }
          }

          const auditSummary = (
            await shOk("sh", ["-c", "bun audit 2>&1 | tail -5 || npm audit --json 2>/dev/null | jq -r '.metadata.vulnerabilities'"])
          ).trim();

          const ciRaw = await shOk("gh", ["run", "list", "-b", base, "-L", "1", "--json", "status,conclusion"]);
          let ciStatus: z.infer<typeof healthChecksSchema>["ciStatus"] = "unknown";
          try {
            const parsed = JSON.parse(ciRaw) as Array<{ status: string; conclusion: string | null }>;
            if (parsed.length > 0) {
              const latest = parsed[0]!;
              if (latest.status !== "completed") ciStatus = "pending";
              else if (latest.conclusion === "success") ciStatus = "passing";
              else ciStatus = "failing";
            }
          } catch {
            // no parseable output — leave unknown
          }

          const prCountRaw = await shOk("gh", ["pr", "list", "--json", "number", "-L", "500"]);
          let openPrCount: number | null = null;
          try {
            const parsed = JSON.parse(prCountRaw) as Array<{ number: number }>;
            openPrCount = parsed.length;
          } catch {
            // gh not authed or no repo
          }

          const issuesRaw = await shOk("gh", [
            "issue",
            "list",
            "--json",
            "number,labels",
            "--label",
            "critical,P0",
            "-L",
            "500",
          ]);
          let openCriticalIssues: number | null = null;
          try {
            const parsed = JSON.parse(issuesRaw) as Array<{ number: number }>;
            openCriticalIssues = parsed.length;
          } catch {
            // gh not authed or no repo
          }

          const authorsRaw = await shOk("git", [
            "log",
            `origin/${base}`,
            "--since=30.days.ago",
            "--format=%aN",
          ]);
          const uniqueAuthorsLast30d = new Set(
            authorsRaw.split("\n").map((s) => s.trim()).filter(Boolean),
          ).size;

          return {
            testFileCount,
            testRatio: null,
            depCount,
            auditSummary: auditSummary.slice(0, 500),
            ciStatus,
            openPrCount,
            openCriticalIssues,
            uniqueAuthorsLast30d,
            branch: base,
          };
        }}
      </Task>

      <Task
        id="report"
        output={outputs.report}
        needs={{ preamble: "preamble", checks: "checks" }}
        deps={{ preamble: preambleContextSchema, checks: healthChecksSchema }}
        agent={agents.smart}
        timeoutMs={300_000}
      >
        {(deps) => (
          <>
            <PreamblePrompt {...deps.preamble} />
            <HealthReportPrompt checks={deps.checks} />
          </>
        )}
    </Task>
  </Workflow>
));
