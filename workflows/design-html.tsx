// Ported from https://github.com/garrytan/gstack/blob/main/design-html/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { readFile } from "node:fs/promises";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import DesignHtmlPrompt from "../prompts/design-html.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { readLatest } from "../lib/smithers/ctx";

const inputSchema = z.object({
  brief: z.string(),
  maxIterations: z.number().default(1),
  /**
   * When the workflow re-fires (manual re-invocation), the user passes new
   * feedback as input.nextFeedback. The iteration reads the previous HTML and
   * applies the feedback. An empty value stops the loop.
   */
  nextFeedback: z.string().nullable().default(null),
});

const iterationSchema = z.object({
  path: z.string(),
  // Named `iterationNumber` — Smithers reserves an `iteration` column on every
  // persisted output table, so a top-level `iteration` field would collide.
  iterationNumber: z.number(),
  oneLineDescription: z.string(),
});

const previousHtmlSchema = z.object({
  html: z.string().nullable(),
});

const { Workflow, Task, Loop, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    previousHtml: previousHtmlSchema,
    iteration: iterationSchema,
  },
  {
    readableName: "Design HTML",
    description: "Iterative standalone HTML mockup for a design brief.",
    dbPath: "./executions/design-html.db",
  },
);

export default smithers((ctx) => {
  const latestIter = readLatest(ctx, iterationSchema, "iterate");
  const count = ctx.iterationCount(iterationSchema, "iterate");
  const done =
    count > 0 && (!ctx.input.nextFeedback || count >= ctx.input.maxIterations);

  return (
    <Workflow name="design-html">
      <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
        {async () =>
          gatherPreambleContext({
            skillName: "design-html",
            tier: 2,
            runId: ctx.runId,
          })
        }
      </Task>

      <Loop until={done} maxIterations={ctx.input.maxIterations}>
        <Task id="previous-html" output={outputs.previousHtml} timeoutMs={15_000}>
          {async () => {
            if (!latestIter?.path) return { html: null };
            try {
              return { html: await readFile(latestIter.path, "utf-8") };
            } catch {
              return { html: null };
            }
          }}
        </Task>

        <Task
          id="iterate"
          output={outputs.iteration}
          needs={{ preamble: "preamble", prev: "previous-html" }}
          deps={{ preamble: preambleContextSchema, prev: previousHtmlSchema }}
          agent={agents.smart}
          timeoutMs={900_000}
          heartbeatTimeoutMs={300_000}
        >
          {(deps) => (
            <>
              <PreamblePrompt {...deps.preamble} />
              <DesignHtmlPrompt
                brief={ctx.input.brief}
                iteration={count + 1}
                previousIterationHtml={deps.prev.html}
                userFeedback={ctx.input.nextFeedback}
              />
            </>
          )}
        </Task>
      </Loop>
    </Workflow>
  );
});
