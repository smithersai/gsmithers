// Ported from https://github.com/garrytan/gstack/blob/main/setup-deploy/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
//
// Showcases smithers' Approval / needsApproval primitive for one-time-setup
// workflows: detect → confirm-with-user → persist.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import SetupDeployConfirmPrompt from "../prompts/setup-deploy-confirm.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";
import { readOutput, readOutputMaybe } from "../lib/smithers/ctx";
import { sh } from "../lib/smithers/shell";

const inputSchema = z.object({
  /** Confidence threshold above which detection is auto-confirmed. */
  autoConfirmThreshold: z.number().default(8),
});

const detectedSchema = z.object({
  platform: z.string().nullable(),
  command: z.string().nullable(),
  stagingUrl: z.string().nullable(),
  productionUrl: z.string().nullable(),
  confidence: z.number().min(0).max(10),
  evidence: z.array(z.string()).default([]),
});

const confirmationSchema = z.object({
  confirmedPlatform: z.string(),
  confirmedCommand: z.string(),
  confirmedStagingUrl: z.string().nullable(),
  confirmedProductionUrl: z.string().nullable(),
  userOverrode: z.boolean(),
});

const persistResultSchema = z.object({
  configPath: z.string(),
  keysWritten: z.array(z.string()),
});

async function detectDeploy(): Promise<z.infer<typeof detectedSchema>> {
  const evidence: string[] = [];
  const repoRoot = (
    await sh("git", ["rev-parse", "--show-toplevel"], { tolerateFailure: true })
  ).trim();
  if (!repoRoot) {
    return {
      platform: null,
      command: null,
      stagingUrl: null,
      productionUrl: null,
      confidence: 0,
      evidence: ["Not inside a git repo — can't detect deploy setup"],
    };
  }

  const pkgJsonPath = path.join(repoRoot, "package.json");
  let pkg: { scripts?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(await readFile(pkgJsonPath, "utf-8"));
  } catch {
    // no package.json
  }

  // Vercel
  try {
    await readFile(path.join(repoRoot, "vercel.json"), "utf-8");
    evidence.push("vercel.json present at repo root");
    return {
      platform: "vercel",
      command: "vercel deploy --prod",
      stagingUrl: null,
      productionUrl: null,
      confidence: 8,
      evidence,
    };
  } catch {
    // not vercel
  }

  // Netlify
  try {
    await readFile(path.join(repoRoot, "netlify.toml"), "utf-8");
    evidence.push("netlify.toml present at repo root");
    return {
      platform: "netlify",
      command: "netlify deploy --prod",
      stagingUrl: null,
      productionUrl: null,
      confidence: 8,
      evidence,
    };
  } catch {
    // not netlify
  }

  // Fly
  try {
    await readFile(path.join(repoRoot, "fly.toml"), "utf-8");
    evidence.push("fly.toml present at repo root");
    return {
      platform: "fly",
      command: "fly deploy",
      stagingUrl: null,
      productionUrl: null,
      confidence: 9,
      evidence,
    };
  } catch {
    // not fly
  }

  // Railway
  try {
    await readFile(path.join(repoRoot, "railway.toml"), "utf-8");
    evidence.push("railway.toml present at repo root");
    return {
      platform: "railway",
      command: "railway up",
      stagingUrl: null,
      productionUrl: null,
      confidence: 8,
      evidence,
    };
  } catch {
    // not railway
  }

  // Heuristic: a package.json deploy script
  if (pkg.scripts?.deploy) {
    evidence.push(`package.json has a \"deploy\" script: ${pkg.scripts.deploy}`);
    return {
      platform: "custom",
      command: "bun run deploy",
      stagingUrl: null,
      productionUrl: null,
      confidence: 5,
      evidence,
    };
  }

  evidence.push("No vercel.json / netlify.toml / fly.toml / railway.toml / deploy script detected");
  return {
    platform: null,
    command: null,
    stagingUrl: null,
    productionUrl: null,
    confidence: 1,
    evidence,
  };
}

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    detected: detectedSchema,
    confirmation: confirmationSchema,
    persist: persistResultSchema,
  },
  {
    readableName: "Setup Deploy",
    description: "Detect the deploy platform, confirm, and persist to ~/.gstack/config.yaml.",
    dbPath: "./executions/setup-deploy.db",
  },
);

export default smithers((ctx) => {
  const detected = readOutputMaybe(ctx, detectedSchema, "detect");
  const autoConfirm =
    detected !== undefined &&
    detected.confidence >= ctx.input.autoConfirmThreshold &&
    detected.command !== null;

  return (
    <Workflow name="setup-deploy">
      <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
        {async () =>
          gatherPreambleContext({
            skillName: "setup-deploy",
            tier: 2,
            runId: ctx.runId,
          })
        }
      </Task>

      <Task id="detect" output={outputs.detected} timeoutMs={15_000}>
        {async () => detectDeploy()}
      </Task>

      <Task
        id="confirm"
        output={outputs.confirmation}
        needs={{ preamble: "preamble", detected: "detect" }}
        deps={{ preamble: preambleContextSchema, detected: detectedSchema }}
        agent={agents.cheapFast}
        timeoutMs={300_000}
        // High-confidence auto-confirm skips the approval prompt entirely;
        // low-confidence requires the human to ratify what the agent decides.
        needsApproval={!autoConfirm}
      >
        {(deps) => (
          <>
            <PreamblePrompt {...deps.preamble} />
            <SetupDeployConfirmPrompt detected={deps.detected} />
          </>
        )}
      </Task>

      <Task
        id="persist"
        output={outputs.persist}
        dependsOn={["confirm"]}
        timeoutMs={15_000}
      >
        {async () => {
          const confirmation = readOutput(ctx, confirmationSchema, "confirm");
          const configDir = path.join(process.env.HOME ?? "", ".gstack");
          await mkdir(configDir, { recursive: true });
          const configPath = path.join(configDir, "config.yaml");
          let existing = "";
          try {
            existing = await readFile(configPath, "utf-8");
          } catch {
            // first run — no existing config
          }
          const keys = {
            deploy_platform: confirmation.confirmedPlatform,
            deploy_command: confirmation.confirmedCommand,
            staging_url: confirmation.confirmedStagingUrl ?? "",
            production_url: confirmation.confirmedProductionUrl ?? "",
          };
          let next = existing;
          for (const [k, v] of Object.entries(keys)) {
            const line = `${k}: ${JSON.stringify(v)}`;
            if (next.includes(`${k}:`)) {
              next = next.replace(new RegExp(`^${k}:.*$`, "m"), line);
            } else {
              next += (next.endsWith("\n") || next.length === 0 ? "" : "\n") + line + "\n";
            }
          }
          await writeFile(configPath, next);
          return {
            configPath,
            keysWritten: Object.keys(keys),
          };
        }}
      </Task>
    </Workflow>
  );
});
