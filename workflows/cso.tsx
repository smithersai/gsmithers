// Ported from https://github.com/garrytan/gstack/blob/main/cso/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import CsoOwaspPrompt from "../prompts/cso-owasp.mdx";
import CsoStridePrompt from "../prompts/cso-stride.mdx";
import CsoSynthesizePrompt from "../prompts/cso-synthesize.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
  detectBaseBranch,
} from "../lib/smithers/preamble";
import { readOutputMaybe } from "../lib/smithers/ctx";
import { reviewOutputSchema } from "../lib/smithers/review";
import { sh } from "../lib/smithers/shell";

const inputSchema = z.object({
  baseBranch: z.string().nullable().default(null),
});

const diffSummarySchema = z.object({
  baseBranch: z.string(),
  filesChanged: z.number(),
  insertions: z.number(),
  deletions: z.number(),
  patch: z.string(),
});

// Per-pass schema clones so OWASP, STRIDE, and the merged report each persist
// to distinct output tables. Smithers resolves output targets by object
// identity — a single shared reviewOutputSchema would collapse them.
const owaspReviewSchema = reviewOutputSchema.extend({});
const strideReviewSchema = reviewOutputSchema.extend({});
const mergedReportSchema = reviewOutputSchema.extend({});

const { Workflow, Task, Parallel, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    diff: diffSummarySchema,
    owasp: owaspReviewSchema,
    stride: strideReviewSchema,
    report: mergedReportSchema,
  },
  {
    readableName: "CSO",
    description: "OWASP Top 10 + STRIDE audits run in parallel over a branch diff.",
    dbPath: "./executions/cso.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="cso">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "cso",
          tier: 2,
          runId: ctx.runId,
        })
      }
    </Task>

    <Task id="diff" output={outputs.diff} timeoutMs={60_000}>
      {async () => {
        const baseBranch = ctx.input.baseBranch ?? (await detectBaseBranch());
        await sh("git", ["fetch", "origin", baseBranch, "--quiet"], {
          tolerateFailure: true,
        });
        const statRaw = await sh("git", [
          "diff",
          `origin/${baseBranch}...HEAD`,
          "--numstat",
        ]);
        const files = statRaw.split("\n").filter(Boolean);
        const insertions = files.reduce(
          (sum, line) => sum + (Number(line.split("\t")[0]) || 0),
          0,
        );
        const deletions = files.reduce(
          (sum, line) => sum + (Number(line.split("\t")[1]) || 0),
          0,
        );
        const patch = await sh("git", ["diff", `origin/${baseBranch}...HEAD`]);
        return {
          baseBranch,
          filesChanged: files.length,
          insertions,
          deletions,
          patch,
        };
      }}
    </Task>

    <Parallel>
      <Task
        id="owasp"
        output={outputs.owasp}
        needs={{ preamble: "preamble", diff: "diff" }}
        deps={{ preamble: preambleContextSchema, diff: diffSummarySchema }}
        agent={agents.smart}
        timeoutMs={1_800_000}
        heartbeatTimeoutMs={600_000}
        continueOnFail
      >
        {(deps) => (
          <>
            <PreamblePrompt {...deps.preamble} />
            <CsoOwaspPrompt diff={deps.diff} />
          </>
        )}
      </Task>

      <Task
        id="stride"
        output={outputs.stride}
        needs={{ preamble: "preamble", diff: "diff" }}
        deps={{ preamble: preambleContextSchema, diff: diffSummarySchema }}
        agent={agents.smart}
        timeoutMs={1_800_000}
        heartbeatTimeoutMs={600_000}
        continueOnFail
      >
        {(deps) => (
          <>
            <PreamblePrompt {...deps.preamble} />
            <CsoStridePrompt diff={deps.diff} />
          </>
        )}
      </Task>
    </Parallel>

    <Task
      id="report"
      output={outputs.report}
      needs={{ preamble: "preamble" }}
      deps={{ preamble: preambleContextSchema }}
      // dependsOn (not needs/deps) so merge runs even when one pass fails
      // via `continueOnFail`. We read each audit with `outputMaybe` and let
      // the prompt flag missing passes.
      dependsOn={["preamble", "owasp", "stride"]}
      agent={agents.smart}
      timeoutMs={600_000}
    >
      {(deps) => {
        const owasp = readOutputMaybe(ctx, owaspReviewSchema, "owasp");
        const stride = readOutputMaybe(ctx, strideReviewSchema, "stride");
        return (
          <>
            <PreamblePrompt {...deps.preamble} />
            <CsoSynthesizePrompt owasp={owasp} stride={stride} />
          </>
        );
      }}
    </Task>
  </Workflow>
));
