// Ported from https://github.com/garrytan/gstack/blob/main/plan-devex-review/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { readFile } from "node:fs/promises";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import PlanDevexReviewPrompt from "../prompts/plan-devex-review.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { reviewOutputSchema } from "../lib/smithers/review";

const inputSchema = z
  .object({
    planPath: z.string().nullable().default(null),
    planText: z.string().nullable().default(null),
    mode: z.enum(["dx_expansion", "dx_polish", "dx_triage"]).default("dx_polish"),
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
    readableName: "Plan Review — DevEx",
    description: "Developer experience audit: onboarding, errors, docs, magical moments.",
    dbPath: "./executions/plan-devex-review.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="plan-devex-review">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "plan-devex-review",
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
          <PlanDevexReviewPrompt
            mode={ctx.input.mode}
            planText={deps.plan.planText}
            planPath={ctx.input.planPath}
          />
        </>
      )}
    </Task>
  </Workflow>
));
