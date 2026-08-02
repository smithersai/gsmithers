// Ported from https://github.com/garrytan/gstack/blob/main/context-save/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import ContextSavePrompt from "../prompts/context-save.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { readOutput } from "../lib/smithers/ctx";
import { sh } from "../lib/smithers/shell";

const inputSchema = z.object({
  title: z.string().nullable().default(null),
  sessionStartIso: z.string().nullable().default(null),
});

const stateSchema = z.object({
  branch: z.string(),
  dirty: z.boolean(),
  commitsAhead: z.number(),
  lastCommit: z.string().nullable(),
  savedCount: z.number(),
});

const saveResultSchema = z.object({
  path: z.string(),
  title: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    state: stateSchema,
    save: saveResultSchema,
  },
  {
    readableName: "Context Save",
    description: "Capture the current session into a handoff note for later restore.",
    dbPath: "./executions/context-save.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="context-save">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "context-save",
          tier: 2,
          runId: ctx.runId,
        })
      }
    </Task>

    <Task
      id="state"
      output={outputs.state}
      dependsOn={["preamble"]}
      timeoutMs={15_000}
    >
      {async () => {
        const preamble = readOutput(ctx, preambleContextSchema, "preamble");
        const branch = (
          await sh("git", ["branch", "--show-current"], { tolerateFailure: true })
        ).trim() || "unknown";
        const porcelain = (
          await sh("git", ["status", "--porcelain"], { tolerateFailure: true })
        ).trim();
        const aheadRaw = await sh(
          "git",
          ["rev-list", "--count", "@{upstream}..HEAD"],
          { tolerateFailure: true },
        );
        const commitsAhead = Number(aheadRaw.trim()) || 0;
        const lastCommit = (
          await sh("git", ["log", "-1", "--format=%s"], { tolerateFailure: true })
        ).trim() || null;

        const slug = preamble.slug ?? "unknown";
        const saveDir = path.join(process.env.HOME ?? "", ".gstack", "projects", slug);
        let savedCount = 0;
        try {
          const entries = await readdir(saveDir);
          savedCount = entries.filter((n) => n.startsWith("context-")).length;
        } catch {
          // no saved contexts yet
        }

        return {
          branch,
          dirty: porcelain.length > 0,
          commitsAhead,
          lastCommit,
          savedCount,
        };
      }}
    </Task>

    <Task
      id="save"
      output={outputs.save}
      needs={{ preamble: "preamble", state: "state" }}
      deps={{ preamble: preambleContextSchema, state: stateSchema }}
      agent={agents.smart}
      timeoutMs={300_000}
    >
      {(deps) => {
        const startIso = ctx.input.sessionStartIso ?? deps.preamble.startedAt;
        const sessionMinutes =
          (Date.now() - new Date(startIso).getTime()) / 60_000;
        return (
          <>
            <PreamblePrompt {...deps.preamble} />
            <ContextSavePrompt
              state={deps.state}
              title={ctx.input.title}
              slug={deps.preamble.slug ?? "unknown"}
              sessionMinutes={sessionMinutes}
            />
          </>
        );
      }}
    </Task>
  </Workflow>
));
