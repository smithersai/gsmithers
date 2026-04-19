// Ported from https://github.com/garrytan/gstack/blob/main/pair-agent/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
//
// SPECULATIVE: this workflow depends on the gui-side hijacked-session
// primitive (an existing agent conversation is handed to a human who then
// drives the LLM turn-by-turn). smithers' CLI already exposes a `hijack`
// sub-command that points at this shape, but the JSX component is not yet
// public. The `HijackedSession` below is a placeholder that throws — so
// the workflow fails loudly until the real import is wired in. The real
// import is expected to be `import { HijackedSession } from
// "smithers-orchestrator"` once the feature lands.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../../agents";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../../lib/smithers/preamble";

function HijackedSession(_props: {
  id: string;
  output: unknown;
  agent: unknown;
  initialPrompt: string;
  dependsOn?: string[];
}): never {
  throw new Error(
    "pair-agent requires the gui hijacked-session primitive, which is not " +
      "yet exported from smithers-orchestrator. Replace the HijackedSession " +
      "placeholder with the real import once the feature lands.",
  );
}

const inputSchema = z.object({
  partner: z.enum(["codex", "gemini", "claudeSonnet"]).default("codex"),
  initialPrompt: z.string().default("You have the terminal. How can I help?"),
});

const pairSessionSchema = z.object({
  partner: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  turnCount: z.number(),
  /** Full conversation transcript captured by the hijacked session. */
  transcript: z.string(),
  humanTookOverAt: z.array(z.number()).default([]),
});

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    session: pairSessionSchema,
  },
  {
    readableName: "Pair Agent",
    description: "Hand the turn to a second AI and let the human drive the session.",
    dbPath: "./executions/pair-agent.db",
  },
);

export default smithers((ctx) => {
  const partner =
    ctx.input.partner === "codex"
      ? providers.codex
      : ctx.input.partner === "gemini"
      ? providers.gemini
      : providers.claudeSonnet;

  return (
    <Workflow name="pair-agent">
      <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
        {async () =>
          gatherPreambleContext({
            skillName: "pair-agent",
            tier: 2,
            runId: ctx.runId,
          })
        }
      </Task>

      <HijackedSession
        id="session"
        output={outputs.session}
        agent={partner}
        initialPrompt={ctx.input.initialPrompt}
        dependsOn={["preamble"]}
      />
    </Workflow>
  );
});
