// Ported from https://github.com/garrytan/gstack/blob/main/design-review/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import DesignAuditPrompt from "../prompts/design-review-audit.mdx";
import DesignFixPrompt from "../prompts/design-review-fix.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { readLatest } from "../lib/smithers/ctx";
import { reviewFindingSchema } from "../lib/smithers/review";

const inputSchema = z.object({
  targetUrl: z.string(),
  maxIterations: z.number().default(3),
  tier: z.enum(["standard", "exhaustive"]).default("standard"),
});

const auditReportSchema = z.object({
  findings: z.array(reviewFindingSchema).default([]),
  regressionsFromPrevious: z.array(reviewFindingSchema).default([]),
  allClear: z.boolean(),
  summary: z.string(),
});

const fixResultSchema = z.object({
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
  ready_to_reverify: z.boolean(),
});

const { Workflow, Task, Loop, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    report: auditReportSchema,
    fixes: fixResultSchema,
  },
  {
    readableName: "Design Review",
    description: "Live site visual audit + fix loop.",
    dbPath: "./executions/design-review.db",
  },
);

export default smithers((ctx) => {
  const report = readLatest(ctx, auditReportSchema, "audit");
  // until = success predicate only; Loop.maxIterations handles the ceiling.
  const done = report?.allClear === true;
  const previousFindings = report?.findings ?? [];

  return (
    <Workflow name="design-review">
      <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
        {async () =>
          gatherPreambleContext({
            skillName: "design-review",
            tier: 4,
            runId: ctx.runId,
          })
        }
      </Task>

      <Loop until={done} maxIterations={ctx.input.maxIterations}>
        <Task
          id="audit"
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
              <DesignAuditPrompt
                targetUrl={ctx.input.targetUrl}
                iteration={ctx.iterationCount(auditReportSchema, "audit") + 1}
                previousFindings={previousFindings}
              />
            </>
          )}
        </Task>

        <Task
          id="fix"
          output={outputs.fixes}
          needs={{ preamble: "preamble", report: "audit" }}
          deps={{ preamble: preambleContextSchema, report: auditReportSchema }}
          agent={agents.smart}
          timeoutMs={1_800_000}
          heartbeatTimeoutMs={600_000}
          skipIf={report?.allClear === true}
        >
          {(deps) => (
            <>
              <PreamblePrompt {...deps.preamble} />
              <DesignFixPrompt findings={deps.report.findings} />
            </>
          )}
        </Task>
      </Loop>
    </Workflow>
  );
});
