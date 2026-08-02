// Ported from https://github.com/garrytan/gstack/blob/main/devex-review/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import DevexReviewPrompt from "../prompts/devex-review.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { reviewOutputSchema } from "../lib/smithers/review";

const inputSchema = z.object({
  target: z.object({
    name: z.string(),
    installCommand: z.string(),
    docsUrl: z.string().nullable().default(null),
    installCount: z.number().nullable().default(null),
  }),
});

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    review: reviewOutputSchema,
  },
  {
    readableName: "DevEx Review",
    description: "Live audit of a shipped developer tool — install, --help, error paths, docs.",
    dbPath: "./executions/devex-review.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="devex-review">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "devex-review",
          tier: 3,
          runId: ctx.runId,
        })
      }
    </Task>

    <Task
      id="review"
      output={outputs.review}
      needs={{ preamble: "preamble" }}
      deps={{ preamble: preambleContextSchema }}
      agent={agents.smartTool}
      timeoutMs={1_800_000}
      heartbeatTimeoutMs={600_000}
    >
      {(deps) => (
        <>
          <PreamblePrompt {...deps.preamble} />
          <DevexReviewPrompt target={ctx.input.target} />
        </>
      )}
    </Task>
  </Workflow>
));
