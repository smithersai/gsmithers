// Ported from https://github.com/garrytan/gstack/blob/main/codex/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import CodexPrompt from "../prompts/codex.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";

const inputSchema = z.object({
  question: z.string(),
  claudeTake: z.string().nullable().default(null),
});

const codexResultSchema = z.object({
  codexResponse: z.string(),
  agreements: z.array(z.string()).default([]),
  disagreements: z
    .array(
      z.object({
        topic: z.string(),
        claudePosition: z.string(),
        codexPosition: z.string(),
        leans: z.enum(["claude", "codex", "neither"]),
      }),
    )
    .default([]),
  missedByClaude: z.array(z.string()).default([]),
  missedByCodex: z.array(z.string()).default([]),
  synthesis: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    result: codexResultSchema,
  },
  {
    readableName: "Codex",
    description: "Second opinion via OpenAI Codex CLI — divergent perspective.",
    dbPath: "./executions/codex.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="codex">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "codex",
          tier: 3,
          runId: ctx.runId,
        })
      }
    </Task>

    <Task
      id="result"
      output={outputs.result}
      needs={{ preamble: "preamble" }}
      deps={{ preamble: preambleContextSchema }}
      // Pin to Codex only — fallback to Claude would silently defeat the
      // product contract of "independent second opinion."
      agent={providers.codex}
      timeoutMs={1_800_000}
      heartbeatTimeoutMs={600_000}
    >
      {(deps) => (
        <>
          <PreamblePrompt {...deps.preamble} />
          <CodexPrompt
            question={ctx.input.question}
            claudeTake={ctx.input.claudeTake}
          />
        </>
      )}
    </Task>
  </Workflow>
));
