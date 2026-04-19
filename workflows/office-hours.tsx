// Ported from https://github.com/garrytan/gstack/blob/main/office-hours/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { agents } from "../agents";
import ModeSelectPrompt from "../prompts/office-hours-mode-select.mdx";
import StartupPrompt from "../prompts/office-hours-startup.mdx";
import BuilderPrompt from "../prompts/office-hours-builder.mdx";
import DesignDocPrompt from "../prompts/office-hours-design-doc.mdx";
import PreamblePrompt from "../prompts/preamble.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { readOutputMaybe } from "../lib/smithers/ctx";
import { sh } from "../lib/smithers/shell";

const inputSchema = z.object({
  userRequest: z.string().default("Help me think through this project."),
});

const contextSchema = z.object({
  repoName: z.string(),
  slug: z.string(),
  recentCommits: z.number(),
  lastCommitDate: z.string().nullable(),
  topReadme: z.string().nullable(),
  priorDesignCount: z.number(),
});

const modeDecisionSchema = z.object({
  mode: z.enum(["startup", "builder"]),
  stage: z
    .enum(["pre_product", "has_users", "has_paying_customers"])
    .nullable()
    .default(null),
  rationale: z.string(),
});

// Single flat ZodObject — discriminatedUnion isn't accepted as a createSmithers
// output target (the API requires ZodObject<ZodRawShape>). `mode` discriminates
// between startup vs builder variants; variant-specific fields are nullable so
// one variant's absence doesn't invalidate the row.
const diagnosticSchema = z.object({
  mode: z.enum(["startup", "builder"]),
  // startup-only fields
  demandEvidence: z.string().nullable().default(null),
  statusQuoCompetitor: z.string().nullable().default(null),
  wedgeCandidate: z.string().nullable().default(null),
  biggestRisk: z.string().nullable().default(null),
  assignment: z.string().nullable().default(null),
  // builder-only fields
  kernel: z.string().nullable().default(null),
  minimumDemo: z.string().nullable().default(null),
  surprise: z.string().nullable().default(null),
  hardestPart: z.string().nullable().default(null),
  targetDelight: z.string().nullable().default(null),
  learningGoal: z.string().nullable().default(null),
  // Nullable so startup runs (which leave builder fields unused) validate.
  firstSessionPlan: z.array(z.string()).nullable().default(null),
});

const designDocSchema = z.object({
  path: z.string(),
  summary: z.string(),
});

async function gatherContext(): Promise<z.infer<typeof contextSchema>> {
  const repoRoot = (
    await sh("git", ["rev-parse", "--show-toplevel"], { tolerateFailure: true })
  ).trim();
  const repoName = repoRoot ? path.basename(repoRoot) : "unknown";
  const remoteUrl = (
    await sh("git", ["config", "--get", "remote.origin.url"], {
      tolerateFailure: true,
    })
  ).trim();
  const slug = remoteUrl
    ? remoteUrl.replace(/\.git$/, "").replace(/^.*[:/]/, "").toLowerCase()
    : repoName.toLowerCase();

  const logOut = await sh("git", ["log", "--oneline", "-30"], {
    tolerateFailure: true,
  });
  const recentCommits = logOut.split("\n").filter(Boolean).length;
  const lastDate =
    (
      await sh("git", ["log", "-1", "--format=%ai"], { tolerateFailure: true })
    ).trim() || null;

  let topReadme: string | null = null;
  if (repoRoot) {
    for (const name of ["README.md", "README", "readme.md"]) {
      try {
        const text = await readFile(path.join(repoRoot, name), "utf-8");
        topReadme = text.split("\n").slice(0, 20).join("\n");
        break;
      } catch {
        // no README under this name, try next
      }
    }
  }

  let priorDesignCount = 0;
  const designDir = path.join(process.env.HOME ?? "", ".gstack", "projects", slug);
  try {
    const entries = await readdir(designDir);
    priorDesignCount = entries.filter((n) => /-design-.*\.md$/.test(n)).length;
  } catch {
    // directory doesn't exist yet — first run for this project
  }

  return {
    repoName,
    slug,
    recentCommits,
    lastCommitDate: lastDate,
    topReadme,
    priorDesignCount,
  };
}

const { Workflow, Task, Branch, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    context: contextSchema,
    mode: modeDecisionSchema,
    diagnostic: diagnosticSchema,
    designDoc: designDocSchema,
  },
  {
    readableName: "Office Hours",
    description: "YC-style startup diagnostic or builder brainstorm with design doc output.",
    dbPath: "./executions/office-hours.db",
  },
);

export default smithers((ctx) => {
  const modeDecision = readOutputMaybe(ctx, modeDecisionSchema, "mode-select");
  const mode = modeDecision?.mode;

  return (
    <Workflow name="office-hours">
      <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
        {async () =>
          gatherPreambleContext({
            skillName: "office-hours",
            tier: 3,
            runId: ctx.runId,
          })
        }
      </Task>

      <Task id="context" output={outputs.context} timeoutMs={30_000}>
        {async () => gatherContext()}
      </Task>

      <Task
        id="mode-select"
        output={outputs.mode}
        needs={{ preamble: "preamble", context: "context" }}
        deps={{ preamble: preambleContextSchema, context: contextSchema }}
        agent={agents.cheapFast}
        timeoutMs={300_000}
      >
        {(deps) => (
          <>
            <PreamblePrompt {...deps.preamble} />
            <ModeSelectPrompt
              context={deps.context}
              userRequest={ctx.input.userRequest}
            />
          </>
        )}
      </Task>

      <Branch
        if={mode === "startup"}
        skipIf={mode === undefined}
        then={
          <Task
            id="diagnostic"
            output={outputs.diagnostic}
            needs={{ preamble: "preamble", modeDecision: "mode-select" }}
            deps={{
              preamble: preambleContextSchema,
              modeDecision: modeDecisionSchema,
            }}
            agent={agents.smart}
            timeoutMs={1_800_000}
            heartbeatTimeoutMs={600_000}
          >
            {(deps) => (
              <>
                <PreamblePrompt {...deps.preamble} />
                <StartupPrompt
                  stage={deps.modeDecision.stage ?? "pre_product"}
                  userRequest={ctx.input.userRequest}
                />
              </>
            )}
          </Task>
        }
        else={
          <Task
            id="diagnostic"
            output={outputs.diagnostic}
            needs={{ preamble: "preamble" }}
            deps={{ preamble: preambleContextSchema }}
            agent={agents.smart}
            timeoutMs={1_800_000}
            heartbeatTimeoutMs={600_000}
          >
            {(deps) => (
              <>
                <PreamblePrompt {...deps.preamble} />
                <BuilderPrompt userRequest={ctx.input.userRequest} />
              </>
            )}
          </Task>
        }
      />

      <Task
        id="design-doc"
        output={outputs.designDoc}
        needs={{
          preamble: "preamble",
          context: "context",
          modeDecision: "mode-select",
          diagnostic: "diagnostic",
        }}
        deps={{
          preamble: preambleContextSchema,
          context: contextSchema,
          modeDecision: modeDecisionSchema,
          diagnostic: diagnosticSchema,
        }}
        agent={agents.smart}
        timeoutMs={600_000}
      >
        {(deps) => (
          <>
            <PreamblePrompt {...deps.preamble} />
            <DesignDocPrompt
              mode={deps.modeDecision.mode}
              stage={deps.modeDecision.stage}
              userRequest={ctx.input.userRequest}
              context={deps.context}
              slug={deps.context.slug}
              diagnostic={deps.diagnostic}
            />
          </>
        )}
      </Task>
    </Workflow>
  );
});
