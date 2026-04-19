// Ported from https://github.com/garrytan/gstack/blob/main/investigate/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import InvestigateHypothesisPrompt from "../prompts/investigate-hypothesis.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { readLatest } from "../lib/smithers/ctx";

const inputSchema = z.object({
  problem: z.string(),
  maxHypotheses: z.number().default(5),
});

const hypothesisResultSchema = z.object({
  hypothesis: z.string(),
  test: z.string(),
  evidence: z.string(),
  confirmed: z.boolean().nullable(),
  nextHypothesis: z.string().nullable().default(null),
  rootCauseReady: z.boolean(),
});

const { Workflow, Task, Loop, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    hypothesis: hypothesisResultSchema,
  },
  {
    readableName: "Investigate",
    description: "Iterative hypothesis → test → rule-out loop for root-cause debugging.",
    dbPath: "./executions/investigate.db",
  },
);

export default smithers((ctx) => {
  const latest = readLatest(ctx, hypothesisResultSchema, "hypothesis");
  // until = success predicate only; Loop.maxIterations handles the ceiling.
  const done = latest?.rootCauseReady === true;
  const evidenceSoFar = latest?.evidence ? [latest.evidence] : [];

  return (
    <Workflow name="investigate">
      <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
        {async () =>
          gatherPreambleContext({
            skillName: "investigate",
            tier: 2,
            runId: ctx.runId,
          })
        }
      </Task>

      <Loop until={done} maxIterations={ctx.input.maxHypotheses}>
        <Task
          id="hypothesis"
          output={outputs.hypothesis}
          needs={{ preamble: "preamble" }}
          deps={{ preamble: preambleContextSchema }}
          agent={agents.smartTool}
          timeoutMs={900_000}
          heartbeatTimeoutMs={300_000}
        >
          {(deps) => (
            <>
              <PreamblePrompt {...deps.preamble} />
              <InvestigateHypothesisPrompt
                problem={ctx.input.problem}
                iteration={
                  ctx.iterationCount(hypothesisResultSchema, "hypothesis") + 1
                }
                previousIteration={latest}
                evidenceSoFar={evidenceSoFar}
              />
            </>
          )}
        </Task>
      </Loop>
    </Workflow>
  );
});
