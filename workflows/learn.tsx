// Ported from https://github.com/garrytan/gstack/blob/main/learn/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import LearnPrompt from "../prompts/learn.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";

const inputSchema = z.object({
  lesson: z.string(),
  /** Which skill/scope the lesson applies to. Defaults to "global". */
  scope: z.string().default("global"),
});

const learnResultSchema = z.object({
  path: z.string(),
  storedLine: z.string(),
  duplicatesFound: z.array(z.string()).default([]),
});

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    learn: learnResultSchema,
  },
  {
    readableName: "Learn",
    description: "Persist a one-line lesson for future gstack workflows to surface.",
    dbPath: "./executions/learn.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="learn">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "learn",
          tier: 2,
          runId: ctx.runId,
        })
      }
    </Task>

    <Task
      id="learn"
      output={outputs.learn}
      needs={{ preamble: "preamble" }}
      deps={{ preamble: preambleContextSchema }}
      agent={agents.cheapFast}
      timeoutMs={60_000}
    >
      {(deps) => (
        <>
          <PreamblePrompt {...deps.preamble} />
          <LearnPrompt lesson={ctx.input.lesson} scope={ctx.input.scope} />
        </>
      )}
    </Task>
  </Workflow>
));
