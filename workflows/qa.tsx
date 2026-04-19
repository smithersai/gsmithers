// Ported from https://github.com/garrytan/gstack/blob/main/qa/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import QaTestPrompt from "../prompts/qa-test.mdx";
import QaFixPrompt from "../prompts/qa-fix.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { readLatest } from "../lib/smithers/ctx";
import { reviewFindingSchema } from "../lib/smithers/review";
import { sh } from "../lib/smithers/shell";

const inputSchema = z.object({
  targetUrl: z.string(),
  tier: z.enum(["quick", "standard", "exhaustive"]).default("standard"),
  maxIterations: z.number().default(3),
  testPlan: z.array(z.string()).default([]),
});

const preconditionsSchema = z.object({
  cleanWorkingTree: z.boolean(),
  currentBranch: z.string(),
});

const qaReportSchema = z.object({
  findings: z.array(reviewFindingSchema).default([]),
  regressionsFromPrevious: z.array(reviewFindingSchema).default([]),
  allClear: z.boolean(),
  summary: z.string(),
});

const qaFixResultSchema = z.object({
  fixesApplied: z
    .array(
      z.object({
        findingId: z.string(),
        commitSha: z.string(),
        filesChanged: z.array(z.string()),
      }),
    )
    .default([]),
  fixesSkipped: z
    .array(z.object({ findingId: z.string(), reason: z.string() }))
    .default([]),
  openQuestions: z.array(z.string()).default([]),
  ready_to_retest: z.boolean(),
});

const { Workflow, Task, Loop, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    preconditions: preconditionsSchema,
    report: qaReportSchema,
    fixes: qaFixResultSchema,
  },
  {
    readableName: "QA",
    description: "Test → fix → verify loop for web applications.",
    dbPath: "./executions/qa.db",
  },
);

export default smithers((ctx) => {
  const report = readLatest(ctx, qaReportSchema, "test");
  // until = success predicate only; Loop.maxIterations handles the ceiling.
  const done = report?.allClear === true;
  const previousFindings = report?.findings ?? [];

  return (
    <Workflow name="qa">
      <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
        {async () =>
          gatherPreambleContext({
            skillName: "qa",
            tier: 4,
            runId: ctx.runId,
          })
        }
      </Task>

      <Task id="preconditions" output={outputs.preconditions} timeoutMs={10_000}>
        {async () => {
          const porcelain = (await sh("git", ["status", "--porcelain"])).trim();
          const currentBranch = (await sh("git", ["branch", "--show-current"])).trim();
          return {
            cleanWorkingTree: porcelain.length === 0,
            currentBranch,
          };
        }}
      </Task>

      <Loop until={done} maxIterations={ctx.input.maxIterations}>
        <Task
          id="test"
          output={outputs.report}
          needs={{ preamble: "preamble" }}
          deps={{ preamble: preambleContextSchema }}
          agent={agents.smartTool}
          timeoutMs={1_800_000}
          heartbeatTimeoutMs={600_000}
        >
          {(deps) => (
            <>
              <PreamblePrompt {...deps.preamble} />
              <QaTestPrompt
                targetUrl={ctx.input.targetUrl}
                tier={ctx.input.tier}
                iteration={ctx.iterationCount(qaReportSchema, "test") + 1}
                previousFindings={previousFindings}
                testPlan={ctx.input.testPlan}
              />
            </>
          )}
        </Task>

        <Task
          id="fix"
          output={outputs.fixes}
          needs={{ preamble: "preamble", report: "test" }}
          deps={{ preamble: preambleContextSchema, report: qaReportSchema }}
          agent={agents.smart}
          timeoutMs={1_800_000}
          heartbeatTimeoutMs={600_000}
          skipIf={report?.allClear === true}
        >
          {(deps) => (
            <>
              <PreamblePrompt {...deps.preamble} />
              <QaFixPrompt tier={ctx.input.tier} findings={deps.report.findings} />
            </>
          )}
        </Task>
      </Loop>
    </Workflow>
  );
});
