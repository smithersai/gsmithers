// Ported from https://github.com/garrytan/gstack/blob/main/autoplan/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { readFile } from "node:fs/promises";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import AutoplanSynthesizePrompt from "../prompts/autoplan-synthesize.mdx";
import PlanCeoReviewPrompt from "../prompts/plan-ceo-review.mdx";
import PlanEngReviewPrompt from "../prompts/plan-eng-review.mdx";
import PlanDesignReviewPrompt from "../prompts/plan-design-review.mdx";
import PlanDevexReviewPrompt from "../prompts/plan-devex-review.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { readOutput, readOutputMaybe } from "../lib/smithers/ctx";
import { reviewOutputSchema } from "../lib/smithers/review";

const inputSchema = z
  .object({
    planPath: z.string().nullable().default(null),
    planText: z.string().nullable().default(null),
    ceoMode: z
      .enum(["scope_expansion", "selective_expansion", "hold_scope", "scope_reduction"])
      .default("hold_scope"),
    devexMode: z.enum(["dx_expansion", "dx_polish", "dx_triage"]).default("dx_polish"),
  })
  .refine((v) => v.planPath || v.planText, {
    message: "Either planPath or planText must be provided",
  });

const loadedPlanSchema = z.object({ planText: z.string(), source: z.string() });

const autoplanDecisionSchema = z.object({
  unifiedVerdict: z.enum([
    "ship",
    "ship_with_changes",
    "revise_substantially",
    "hold",
  ]),
  summary: z.string(),
  autoAppliedFixes: z.array(z.string()).default([]),
  needsUserApproval: z
    .array(
      z.object({
        finding: z.string(),
        reviewers: z.array(z.enum(["ceo", "eng", "design", "devex"])),
        framing: z.string(),
      }),
    )
    .default([]),
});

// Clone reviewOutputSchema per reviewer — smithers resolves output targets by
// object identity, so using the same schema for multiple keys collapses them
// to one table (last write wins). Extending with an empty shape gives each
// reviewer its own distinct row in the output store.
const ceoReviewSchema = reviewOutputSchema.extend({});
const engReviewSchema = reviewOutputSchema.extend({});
const designReviewSchema = reviewOutputSchema.extend({});
const devexReviewSchema = reviewOutputSchema.extend({});

const { Workflow, Task, Parallel, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    plan: loadedPlanSchema,
    ceo: ceoReviewSchema,
    eng: engReviewSchema,
    design: designReviewSchema,
    devex: devexReviewSchema,
    decision: autoplanDecisionSchema,
  },
  {
    readableName: "Autoplan",
    description: "Auto-review pipeline (CEO + Eng + Design + DX) in parallel.",
    dbPath: "./executions/autoplan.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="autoplan">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "autoplan",
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

    <Parallel>
      <Task
        id="ceo"
        output={outputs.ceo}
        needs={{ preamble: "preamble", plan: "plan" }}
        deps={{ preamble: preambleContextSchema, plan: loadedPlanSchema }}
        agent={agents.smart}
        timeoutMs={1_800_000}
        heartbeatTimeoutMs={600_000}
        continueOnFail
      >
        {(deps) => (
          <>
            <PreamblePrompt {...deps.preamble} />
            <PlanCeoReviewPrompt
              mode={ctx.input.ceoMode}
              planText={deps.plan.planText}
              planPath={ctx.input.planPath}
            />
          </>
        )}
      </Task>

      <Task
        id="eng"
        output={outputs.eng}
        needs={{ preamble: "preamble", plan: "plan" }}
        deps={{ preamble: preambleContextSchema, plan: loadedPlanSchema }}
        agent={agents.smart}
        timeoutMs={1_800_000}
        heartbeatTimeoutMs={600_000}
        continueOnFail
      >
        {(deps) => (
          <>
            <PreamblePrompt {...deps.preamble} />
            <PlanEngReviewPrompt
              planText={deps.plan.planText}
              planPath={ctx.input.planPath}
            />
          </>
        )}
      </Task>

      <Task
        id="design"
        output={outputs.design}
        needs={{ preamble: "preamble", plan: "plan" }}
        deps={{ preamble: preambleContextSchema, plan: loadedPlanSchema }}
        agent={agents.smart}
        timeoutMs={1_800_000}
        heartbeatTimeoutMs={600_000}
        continueOnFail
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

      <Task
        id="devex"
        output={outputs.devex}
        needs={{ preamble: "preamble", plan: "plan" }}
        deps={{ preamble: preambleContextSchema, plan: loadedPlanSchema }}
        agent={agents.smart}
        timeoutMs={1_800_000}
        heartbeatTimeoutMs={600_000}
        continueOnFail
      >
        {(deps) => (
          <>
            <PreamblePrompt {...deps.preamble} />
            <PlanDevexReviewPrompt
              mode={ctx.input.devexMode}
              planText={deps.plan.planText}
              planPath={ctx.input.planPath}
            />
          </>
        )}
      </Task>
    </Parallel>

    <Task
      id="decision"
      output={outputs.decision}
      // dependsOn (not needs/deps) so synthesis runs even when some reviewers
      // `continueOnFail`. We read each review via `outputMaybe` and surface
      // missing reviewers to the prompt explicitly.
      dependsOn={["preamble", "plan", "ceo", "eng", "design", "devex"]}
      agent={agents.smart}
      timeoutMs={600_000}
    >
      {() => {
        const preamble = readOutput(ctx, preambleContextSchema, "preamble");
        const plan = readOutput(ctx, loadedPlanSchema, "plan");
        const ceo = readOutputMaybe(ctx, ceoReviewSchema, "ceo");
        const eng = readOutputMaybe(ctx, engReviewSchema, "eng");
        const design = readOutputMaybe(ctx, designReviewSchema, "design");
        const devex = readOutputMaybe(ctx, devexReviewSchema, "devex");
        return (
          <>
            <PreamblePrompt {...preamble} />
            <AutoplanSynthesizePrompt
              planSource={plan.source}
              ceo={ceo}
              eng={eng}
              design={design}
              devex={devex}
            />
          </>
        );
      }}
    </Task>
  </Workflow>
));
