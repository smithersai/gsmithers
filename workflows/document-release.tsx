// Ported from https://github.com/garrytan/gstack/blob/main/document-release/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import DocumentReleasePrompt from "../prompts/document-release.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
  detectBaseBranch,
} from "../lib/smithers/preamble";
import { sh } from "../lib/smithers/shell";

const inputSchema = z.object({
  prUrl: z.string().nullable().default(null),
  baseOverride: z.string().nullable().default(null),
});

const releaseContextSchema = z.object({
  shippedVersion: z.string(),
  filesChanged: z.array(z.string()),
  baseBranch: z.string(),
});

const docAuditSchema = z.object({
  autoAppliedEdits: z
    .array(z.object({ file: z.string(), summary: z.string() }))
    .default([]),
  openQuestions: z
    .array(z.object({ file: z.string(), question: z.string() }))
    .default([]),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    release: releaseContextSchema,
    audit: docAuditSchema,
  },
  {
    readableName: "Document Release",
    description: "Post-ship doc sync — audit every user-facing doc for accuracy.",
    dbPath: "./executions/document-release.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="document-release">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "document-release",
          tier: 2,
          runId: ctx.runId,
        })
      }
    </Task>

    <Task id="release" output={outputs.release} timeoutMs={30_000}>
      {async () => {
        const baseBranch = ctx.input.baseOverride ?? (await detectBaseBranch());
        const repoRoot = (
          await sh("git", ["rev-parse", "--show-toplevel"], {
            tolerateFailure: true,
          })
        ).trim();
        const versionText = repoRoot
          ? (
              await readFile(path.join(repoRoot, "VERSION"), "utf-8").catch(() => "")
            ).trim()
          : "";
        const filesRaw = await sh(
          "git",
          ["diff", `origin/${baseBranch}...HEAD`, "--name-only"],
          { tolerateFailure: true },
        );
        const filesChanged = filesRaw
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        return {
          shippedVersion: versionText || "unknown",
          filesChanged,
          baseBranch,
        };
      }}
    </Task>

    <Task
      id="audit"
      output={outputs.audit}
      needs={{ preamble: "preamble", release: "release" }}
      deps={{
        preamble: preambleContextSchema,
        release: releaseContextSchema,
      }}
      agent={agents.smart}
      timeoutMs={1_800_000}
      heartbeatTimeoutMs={600_000}
    >
      {(deps) => (
        <>
          <PreamblePrompt {...deps.preamble} />
          <DocumentReleasePrompt
            shippedVersion={deps.release.shippedVersion}
            prUrl={ctx.input.prUrl}
            filesChanged={deps.release.filesChanged}
          />
        </>
      )}
    </Task>
  </Workflow>
));
