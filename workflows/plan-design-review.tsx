// Ported from https://github.com/garrytan/gstack/blob/main/plan-design-review/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { readFile } from "node:fs/promises";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import PlanDesignReviewPrompt from "../prompts/plan-design-review.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { reviewOutputSchema } from "../lib/smithers/review";

const inputSchema = z
  .object({
    planPath: z.string().nullable().default(null),
    planText: z.string().nullable().default(null),
  })
  .refine((v) => v.planPath || v.planText, {
    message: "Either planPath or planText must be provided",
  });

const loadedPlanSchema = z.object({
  planText: z.string(),
  source: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    plan: loadedPlanSchema,
    review: reviewOutputSchema,
  },
  {
    readableName: "Plan Review — Design",
    description: "Designer's eye review — scores design dimensions and proposes edits.",
    dbPath: "./executions/plan-design-review.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="plan-design-review">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "plan-design-review",
          tier: 3,
          runId: ctx.runId,
        })
      }
    </Task>

    <Task id="plan" output={outputs.plan} timeoutMs={15_000}>
      {async () => {
        if (ctx.input.planText) {
          return { planText: ctx.input.planText, source: "inline" };
        }
        const planText = await readFile(ctx.input.planPath!, "utf-8");
        return { planText, source: ctx.input.planPath! };
      }}
    </Task>

    <Task
      id="review"
      output={outputs.review}
      needs={{ preamble: "preamble", plan: "plan" }}
      deps={{ preamble: preambleContextSchema, plan: loadedPlanSchema }}
      agent={agents.smart}
      timeoutMs={1_800_000}
      heartbeatTimeoutMs={600_000}
    >
      {(deps) => (
        <>
          <PreamblePrompt {...deps.preamble} />
          <PlanDesignReviewPrompt
            planText={deps.plan.planText}
            planPath={ctx.input.planPath}
          />
        </>
      )}
    </Task>
  </Workflow>
));
