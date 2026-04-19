// Ported from https://github.com/garrytan/gstack/blob/main/qa-only/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import QaOnlyPrompt from "../prompts/qa-only-test.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { reviewFindingSchema } from "../lib/smithers/review";

const inputSchema = z.object({
  targetUrl: z.string(),
  tier: z.enum(["quick", "standard", "exhaustive"]).default("standard"),
  testPlan: z.array(z.string()).default([]),
});

const qaReportSchema = z.object({
  findings: z.array(reviewFindingSchema).default([]),
  allClear: z.boolean(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    report: qaReportSchema,
  },
  {
    readableName: "QA-Only",
    description: "Report-only QA — finds issues without applying any fixes.",
    dbPath: "./executions/qa-only.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="qa-only">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "qa-only",
          tier: 4,
          runId: ctx.runId,
        })
      }
    </Task>

    <Task
      id="report"
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
          <QaOnlyPrompt
            targetUrl={ctx.input.targetUrl}
            tier={ctx.input.tier}
            testPlan={ctx.input.testPlan}
          />
        </>
      )}
    </Task>
  </Workflow>
));
