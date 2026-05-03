// Ported from https://github.com/garrytan/gstack/blob/main/design-shotgun/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import DesignShotgunVariantPrompt from "../prompts/design-shotgun-variant.mdx";
import DesignShotgunComparePrompt from "../prompts/design-shotgun-compare.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { readOutputMaybe } from "../lib/smithers/ctx";

const inputSchema = z.object({
  brief: z.string(),
});

const variantShape = {
  variantName: z.string(),
  imagePath: z.string(),
  oneLineDescription: z.string(),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
} as const;
// Per-variant schema clones — smithers resolves output targets by object
// identity, so reusing one variantSchema collapses the four parallel tasks
// into one table.
const boldVariantSchema = z.object(variantShape);
const softVariantSchema = z.object(variantShape);
const editorialVariantSchema = z.object(variantShape);
const minimalVariantSchema = z.object(variantShape);

const compareResultSchema = z.object({
  winner: z.string(),
  rationale: z.string(),
  nextStep: z.enum(["ship", "iterate", "re_shotgun"]),
  iterateNotes: z.string().nullable().default(null),
});

const variantsByName = {
  bold: boldVariantSchema,
  soft: softVariantSchema,
  editorial: editorialVariantSchema,
  minimal: minimalVariantSchema,
} as const;

const angles: Array<{
  variant: keyof typeof variantsByName;
  description: string;
}> = [
  { variant: "bold", description: "High-contrast, confident, typographic hero. Not afraid of empty space." },
  { variant: "soft", description: "Warm, approachable, rounded forms, generous padding. Quieter personality." },
  { variant: "editorial", description: "Magazine-style, image-led, considered type hierarchy, narrative pacing." },
  { variant: "minimal", description: "Strip every non-essential element. Type + one accent. Form is the feature." },
];

const { Workflow, Task, Parallel, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    bold: boldVariantSchema,
    soft: softVariantSchema,
    editorial: editorialVariantSchema,
    minimal: minimalVariantSchema,
    compare: compareResultSchema,
  },
  {
    readableName: "Design Shotgun",
    description: "Generate four visual variants in parallel and pick a winner.",
    dbPath: "./executions/design-shotgun.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="design-shotgun">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "design-shotgun",
          tier: 2,
          runId: ctx.runId,
        })
      }
    </Task>

    <Parallel>
      {angles.map((angle) => (
        <Task
          key={angle.variant}
          id={`variant:${angle.variant}`}
          output={outputs[angle.variant]}
          needs={{ preamble: "preamble" }}
          deps={{ preamble: preambleContextSchema }}
          agent={agents.smartTool}
          timeoutMs={900_000}
          heartbeatTimeoutMs={300_000}
          continueOnFail
        >
          {(deps) => (
            <>
              <PreamblePrompt {...deps.preamble} />
              <DesignShotgunVariantPrompt
                brief={ctx.input.brief}
                variant={angle.variant}
                angleDescription={angle.description}
                totalVariants={angles.length}
              />
            </>
          )}
        </Task>
      ))}
    </Parallel>

    <Task
      id="compare"
      output={outputs.compare}
      needs={{ preamble: "preamble" }}
      deps={{ preamble: preambleContextSchema }}
      // dependsOn (not needs/deps) so compare runs even when some variants
      // failed via `continueOnFail`. Missing variants are filtered out.
      dependsOn={[
        "preamble",
        "variant:bold",
        "variant:soft",
        "variant:editorial",
        "variant:minimal",
      ]}
      agent={agents.smart}
      timeoutMs={300_000}
    >
      {(deps) => {
        const variants = (
          [
            readOutputMaybe(ctx, boldVariantSchema, "variant:bold"),
            readOutputMaybe(ctx, softVariantSchema, "variant:soft"),
            readOutputMaybe(ctx, editorialVariantSchema, "variant:editorial"),
            readOutputMaybe(ctx, minimalVariantSchema, "variant:minimal"),
          ] as const
        ).filter((v): v is NonNullable<typeof v> => v !== undefined);
        return (
          <>
            <PreamblePrompt {...deps.preamble} />
            <DesignShotgunComparePrompt variants={variants} />
          </>
        );
      }}
    </Task>
  </Workflow>
));
