// Ported from https://github.com/garrytan/gstack/blob/main/context-restore/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import ContextRestorePrompt from "../prompts/context-restore.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { readOutput } from "../lib/smithers/ctx";
import { sh } from "../lib/smithers/shell";

const inputSchema = z.object({
  userRequest: z.string().nullable().default(null),
});

const savedEntrySchema = z.object({
  file: z.string(),
  mtime: z.string(),
  title: z.string().nullable(),
});

const savedListSchema = z.object({
  slug: z.string(),
  saved: z.array(savedEntrySchema),
});

const currentStateSchema = z.object({
  branch: z.string(),
  dirty: z.boolean(),
  lastCommit: z.string().nullable(),
});

const restoreResultSchema = z.object({
  loadedFile: z.string().nullable(),
  summary: z.string(),
  nextSteps: z.array(z.string()).default([]),
});

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    saved: savedListSchema,
    state: currentStateSchema,
    restore: restoreResultSchema,
  },
  {
    readableName: "Context Restore",
    description: "Resume from a saved session context.",
    dbPath: "./executions/context-restore.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="context-restore">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "context-restore",
          tier: 2,
          runId: ctx.runId,
        })
      }
    </Task>

    <Task
      id="saved"
      output={outputs.saved}
      dependsOn={["preamble"]}
      timeoutMs={15_000}
    >
      {async () => {
        const preamble = readOutput(ctx, preambleContextSchema, "preamble");
        const slug = preamble.slug ?? "unknown";
        const saveDir = path.join(process.env.HOME ?? "", ".gstack", "projects", slug);
        const entries: z.infer<typeof savedEntrySchema>[] = [];
        try {
          const files = await readdir(saveDir);
          for (const name of files) {
            if (!name.startsWith("context-")) continue;
            const full = path.join(saveDir, name);
            const st = await stat(full);
            let title: string | null = null;
            try {
              const text = await readFile(full, "utf-8");
              const match = /^## Working on: (.*)$/m.exec(text);
              title = match?.[1]?.trim() ?? null;
            } catch {
              // skip unreadable files
            }
            entries.push({
              file: full,
              mtime: st.mtime.toISOString(),
              title,
            });
          }
        } catch {
          // no saves directory — return empty list
        }
        entries.sort((a, b) => (a.mtime > b.mtime ? -1 : 1));
        return { slug, saved: entries };
      }}
    </Task>

    <Task id="state" output={outputs.state} timeoutMs={10_000}>
      {async () => {
        const branch = (
          await sh("git", ["branch", "--show-current"], { tolerateFailure: true })
        ).trim() || "unknown";
        const porcelain = (
          await sh("git", ["status", "--porcelain"], { tolerateFailure: true })
        ).trim();
        const lastCommit = (
          await sh("git", ["log", "-1", "--format=%s"], { tolerateFailure: true })
        ).trim() || null;
        return { branch, dirty: porcelain.length > 0, lastCommit };
      }}
    </Task>

    <Task
      id="restore"
      output={outputs.restore}
      needs={{ preamble: "preamble", saved: "saved", state: "state" }}
      deps={{
        preamble: preambleContextSchema,
        saved: savedListSchema,
        state: currentStateSchema,
      }}
      agent={agents.smart}
      timeoutMs={300_000}
    >
      {(deps) => (
        <>
          <PreamblePrompt {...deps.preamble} />
          <ContextRestorePrompt
            saved={deps.saved.saved}
            state={deps.state}
            userRequest={ctx.input.userRequest}
          />
        </>
      )}
    </Task>
  </Workflow>
));
