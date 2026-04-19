// Ported from https://github.com/garrytan/gstack/blob/main/plan-ceo-review/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { readFile } from "node:fs/promises";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import PlanCeoReviewPrompt from "../prompts/plan-ceo-review.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { reviewOutputSchema } from "../lib/smithers/review";

const inputSchema = z
  .object({
    planPath: z.string().nullable().default(null),
    planText: z.string().nullable().default(null),
    mode: z
      .enum(["scope_expansion", "selective_expansion", "hold_scope", "scope_reduction"])
      .default("hold_scope"),
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
    readableName: "Plan Review — CEO",
    description: "Founder-mode plan review across scope expansion / hold / reduction modes.",
    dbPath: "./executions/plan-ceo-review.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="plan-ceo-review">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "plan-ceo-review",
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
        if (ctx.input.planPath) {
          const planText = await readFile(ctx.input.planPath, "utf-8");
          return { planText, source: ctx.input.planPath };
        }
        throw new Error("No plan input provided");
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
          <PlanCeoReviewPrompt
            mode={ctx.input.mode}
            planText={deps.plan.planText}
            planPath={ctx.input.planPath}
          />
        </>
      )}
    </Task>
  </Workflow>
));
