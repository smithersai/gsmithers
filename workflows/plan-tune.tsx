// Ported from https://github.com/garrytan/gstack/blob/main/plan-tune/SKILL.md.tmpl
// See workflows/README.md for the full port changelog.
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { agents } from "../agents";
import PreamblePrompt from "../prompts/preamble.mdx";
import PlanTunePrompt from "../prompts/plan-tune.mdx";
import {
  gatherPreambleContext,
  preambleContextSchema,
} from "../lib/smithers/preamble";

const inputSchema = z.object({
  userRequest: z.string().default("Show my profile."),
});

const profileStatsSchema = z.object({
  profileEntries: z.number(),
  recentQuestions: z.number(),
});

const planTuneActionSchema = z.object({
  intent: z.enum([
    "inspect_profile",
    "stop_asking",
    "always_ask",
    "disable_tuning",
    "enable_tuning",
    "show_vibe",
    "unknown",
  ]),
  summary: z.string(),
  configChanges: z
    .array(
      z.object({
        key: z.string(),
        oldValue: z.string().nullable(),
        newValue: z.string(),
      }),
    )
    .default([]),
  questionPreferenceChange: z
    .object({
      questionId: z.string(),
      preference: z.enum(["never_ask", "always_ask", "default"]),
    })
    .nullable()
    .default(null),
});

async function readProfileStats(): Promise<z.infer<typeof profileStatsSchema>> {
  const home = process.env.HOME ?? "";
  const profileDir = path.join(home, ".gstack", "profile");
  const questionsLog = path.join(home, ".gstack", "analytics", "questions.jsonl");

  let profileEntries = 0;
  try {
    const entries = await readdir(profileDir);
    profileEntries = entries.filter((n) => n.endsWith(".json")).length;
  } catch {
    // profile dir doesn't exist yet
  }

  let recentQuestions = 0;
  try {
    const text = await readFile(questionsLog, "utf-8");
    const threshold = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { ts?: string };
        if (entry.ts && new Date(entry.ts).getTime() >= threshold) {
          recentQuestions += 1;
        }
      } catch {
        // skip malformed entries
      }
    }
  } catch {
    // no log file yet
  }

  return { profileEntries, recentQuestions };
}

const { Workflow, Task, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    preamble: preambleContextSchema,
    profile: profileStatsSchema,
    action: planTuneActionSchema,
  },
  {
    readableName: "Plan Tune",
    description: "Question sensitivity + developer profile inspector.",
    dbPath: "./executions/plan-tune.db",
  },
);

export default smithers((ctx) => (
  <Workflow name="plan-tune">
    <Task id="preamble" output={outputs.preamble} timeoutMs={15_000}>
      {async () =>
        gatherPreambleContext({
          skillName: "plan-tune",
          tier: 2,
          runId: ctx.runId,
        })
      }
    </Task>

    <Task id="profile" output={outputs.profile} timeoutMs={10_000}>
      {async () => readProfileStats()}
    </Task>

    <Task
      id="action"
      output={outputs.action}
      needs={{ preamble: "preamble", profile: "profile" }}
      deps={{ preamble: preambleContextSchema, profile: profileStatsSchema }}
      agent={agents.smart}
      timeoutMs={300_000}
    >
      {(deps) => (
        <>
          <PreamblePrompt {...deps.preamble} />
          <PlanTunePrompt
            config={deps.preamble.config}
            profileEntries={deps.profile.profileEntries}
            recentQuestions={deps.profile.recentQuestions}
            userRequest={ctx.input.userRequest}
          />
        </>
      )}
    </Task>
  </Workflow>
));
