// Ported from https://github.com/garrytan/gstack/blob/main/design-consultation/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import DesignConsultationPrompt from "../prompts/design-consultation.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";

const inputSchema = z.object({
  brief: z.string(),
});

const consultationSchema = z.object({
  path: z.string(),
  personalityOneWord: z.string(),
  headline: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    consultation: consultationSchema,
  },
  {
    readableName: "Design Consultation",
    description: "Ground-up design system generation from a product brief.",
    dbPath: "./executions/design-consultation.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="design-consultation">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "design-consultation",
          tier: 3,
          runId: ctx.runId,
        })
      }
    </Task>

    <Task
      id="consultation"
      output={outputs.consultation}
      needs={{ preamble: "preamble" }}
      deps={{ preamble: preambleContextSchema }}
      agent={agents.smart}
      timeoutMs={1_800_000}
      heartbeatTimeoutMs={600_000}
    >
      {(deps) => (
        <>
          <PreamblePrompt {...deps.preamble} />
          <DesignConsultationPrompt
            brief={ctx.input.brief}
            slug={deps.preamble.slug ?? "unknown"}
          />
        </>
      )}
    </Task>
  </Workflow>
));
